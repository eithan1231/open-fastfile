// Bots on a real map: dome's navigation, baked the way a game server bakes it,
// walked by a bot in a match against dome's real collision.
//
// The load goes through `WorldRegistry` and `NavBaker` exactly as an order's
// does, with only the api faked (its routes read the same files off disk), so
// the bake that finishes here is the one a game on dome would get: sliced,
// yielding between slices, and equal to the one-shot bake navBake.test.ts pins.
// A bot then walks it with a controller that plans with A* and follows with the
// follower the bake validated every link with.
//
// Skips a world that has not been exported, as the other imported-map tests do.

import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { catalogueViewOf } from "@3d/shared/game/catalogueView.js";
import { DEFAULT_GAMETYPE } from "@3d/shared/game/gametypes/registry.js";
import { defaultGametype } from "@3d/shared/game/gametypes/default.js";
import { createPath, NavSearch } from "@3d/shared/nav/astar.js";
import type { NavGraph } from "@3d/shared/nav/graph.js";
import { EYE_HEIGHT, type Vec3 } from "@3d/shared/sim/movement.js";
import { idleInput } from "@3d/shared/sim/input.js";
import { chaseGametype, CHASE_GAMETYPE } from "@3d/shared/game/gametypes/chase.js";
import type { Script } from "@3d/shared/game/hooks.js";
import type { PlayerSnapshot } from "@3d/shared/net/messages/snapshot.js";
import { scriptsFor } from "@3d/shared/game/registry.js";
import { HORDE_SIZE } from "@3d/shared/game/scripts/chase.js";
import { isBotId } from "@3d/shared/net/messages/fields.js";
import { CATALOG_VERSION, WeaponRegistry } from "@3d/shared/sim/weaponRegistry.js";
import type { WorldSource } from "@3d/shared/worlds/source.js";
import type { Api } from "../src/api.js";
import { NO_BODIES } from "../src/bodies.js";
import { config } from "../src/config.js";
import { Games } from "../src/games.js";
import { Match } from "../src/match/match.js";
import { NavBaker, describeBake } from "../src/nav.js";
import type { Physics } from "../src/physics.js";
import type { Weapons } from "../src/weapons.js";
import { WorldRegistry, type LoadedWorld } from "../src/worlds.js";
import { ALL_ABILITIES, GotoPoint } from "./gotoPoint.js";

const SLUG = "dome-mw3";
const WORLDS = path.resolve(import.meta.dirname, "../../../worlds");
const DIR = path.join(WORLDS, SLUG);
const TICK_RATE = config.tickRate;
const exported = ["assets/collision.glb", "assets/nav.bin", "navigation.world"].every((f) => fs.existsSync(path.join(DIR, f)));

function read(file: string): Promise<Uint8Array | undefined> {
  return Promise.resolve(fs.existsSync(file) ? new Uint8Array(fs.readFileSync(file)) : undefined);
}

/** The api, as far as a world's load asks anything of it: the world's own files, and the catalogue's. */
function diskApi(): Api {
  const source: WorldSource = {
    describe: DIR,
    payload: () =>
      Promise.resolve({
        entryPath: "world.world",
        sources: Object.fromEntries(
          fs
            .readdirSync(DIR)
            .filter((f) => f.endsWith(".world"))
            .map((f) => [f, fs.readFileSync(path.join(DIR, f), "utf8")]),
        ),
      }),
    asset: (rel) => read(path.join(DIR, rel)),
  };
  return {
    worlds: { world: () => source },
    client: {
      catalogFile: (ref: { kind: string; game: string; id: string; rest: string }) => read(path.join(WORLDS, "catalog", ref.kind, ref.game, ref.id, ref.rest)),
    },
  } as unknown as Api;
}

let baker: NavBaker;
let loaded: LoadedWorld;
let graph: NavGraph;
/** The longest any timer waited past its time while the bake ran, ms: how long a tick could have been held up. */
let worstLateness = 0;
let worstHoldCpuMs = 0;
let bakeWallMs = 0;

function newMatch(): Match {
  return new Match(loaded.collision, loaded.world, TICK_RATE, 8, new WeaponRegistry([]), {
    map: SLUG,
    gametype: defaultGametype,
    catalogue: catalogueViewOf({ version: CATALOG_VERSION }, new WeaponRegistry([])),
    bodies: NO_BODIES,
    nav: loaded.nav,
  });
}

function feetOf(m: Match, id: string): Vec3 {
  return { ...m.step().players.find((p) => p.id === id)!.state.movement.feet };
}

const horizontal = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.z - b.z);

/** A bot standing where the match spawned it, settled onto the floor with no target yet. */
function settledBot(m: Match): { id: string; controller: GotoPoint; feet: Vec3 } {
  const controller = new GotoPoint(null);
  const id = m.addBot({ controller });
  for (let i = 0; i < TICK_RATE; i++) {
    m.step();
  }
  return { id, controller, feet: feetOf(m, id) };
}

/**
 * The first usable node, by index, about `metres` from `from` and reachable from
 * the node nearest it — or, with `reachable` false, the first usable node A*
 * cannot reach at all. Chosen from the graph rather than hard-coded, so a
 * re-export that moves a node does not break the test's premise.
 */
function destination(from: Vec3, metres: number, reachable = true): { point: Vec3; cost: number; links: number } {
  const search = new NavSearch(graph);
  const found = createPath();
  const start = graph.nearestNode(from, 2, 8);
  expect(start).toBeGreaterThanOrEqual(0);
  for (let node = 0; node < graph.nodeCount; node++) {
    if (!graph.usable[node]) {
      continue;
    }
    const point = { x: graph.feet[node * 3]!, y: graph.feet[node * 3 + 1]!, z: graph.feet[node * 3 + 2]! };
    const status = search.find(start, node, { abilities: ALL_ABILITIES }, found);
    if (reachable ? status === "found" && Math.abs(horizontal(from, point) - metres) < 1.5 && found.links.length >= 3 : status === "unreachable") {
      return { point, cost: found.cost, links: found.links.length };
    }
  }
  throw new Error(`no ${reachable ? "reachable" : "unreachable"} node ${metres} m from the spawn`);
}

/** Walk a settled bot to a point ~20 m away and return where it was each tick. */
function walkTwentyMetres(): { trail: Vec3[]; status: string; ticks: number; distance: number; budget: number } {
  const m = newMatch();
  const { id, controller, feet } = settledBot(m);
  const target = destination(feet, 20);
  controller.target = target.point;
  // Twice the time the bake says the path takes, and three seconds to spare.
  const budget = Math.ceil((2 * target.cost + 3) * TICK_RATE);
  const trail: Vec3[] = [];
  let ticks = 0;
  while (controller.status !== "arrived" && ticks < budget) {
    trail.push(feetOf(m, id));
    ticks++;
  }
  const last = trail[trail.length - 1]!;
  return { trail, status: controller.status, ticks, distance: horizontal(last, target.point), budget };
}

const HUMAN = "survivor";
/** Caught: this close, m, horizontally. The brain stops at 1.5 m. */
const CAUGHT = 2;
/** Near enough, at the end of a chase, m. */
const NEAR = 3;
/** How long a chase is given, s. */
const CHASE_SECONDS = 60;

const fmt = (n: number) => (Number.isFinite(n) ? n.toFixed(1) : "-");
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? NaN;

/** A chase on dome, with the registry's scripts for it, and any a test adds in front. */
function chaseMatch(extra: Script[] = []): Match {
  return new Match(loaded.collision, loaded.world, TICK_RATE, 8, new WeaponRegistry([]), {
    map: SLUG,
    gametype: chaseGametype,
    catalogue: catalogueViewOf({ version: CATALOG_VERSION }, new WeaponRegistry([])),
    bodies: NO_BODIES,
    nav: loaded.nav,
    scripts: [...extra, ...scriptsFor(CHASE_GAMETYPE, SLUG)],
  });
}

function hordeOf(m: Match): string[] {
  return m
    .step()
    .players.map((p) => p.id)
    .filter(isBotId);
}

/** A person who stands where they are: one idle input a tick, as a client that has let go of the keys sends. */
class Stander {
  private seq = 0;
  constructor(private readonly m: Match) {}
  step(): PlayerSnapshot[] {
    this.m.receive(HUMAN, {
      seq: ++this.seq,
      dt: 1 / TICK_RATE,
      input: idleInput(0, 0),
      claim: { x: 0, y: 0, z: 0 },
      drawn: { tick: this.m.tick & 0xffff, frac: 0 },
    });
    return this.m.step().players;
  }
}

/** Run a chase for `seconds`: when each bot first came within CAUGHT of the survivor, where each ended, and their trails a second apart. */
function chase(seconds = CHASE_SECONDS) {
  const m = chaseMatch();
  const first = m.step();
  const horde = first.players.filter((p) => isBotId(p.id));
  expect(horde.every((p) => p.state.team === chaseGametype.teams.indexOf("horde"))).toBe(true);
  m.join(HUMAN);
  const person = new Stander(m);
  const ids = horde.map((p) => p.id);
  const at = (players: PlayerSnapshot[], id: string) => players.find((p) => p.id === id)!.state;
  const joined = person.step();
  expect(at(joined, HUMAN).team).toBe(chaseGametype.teams.indexOf("survivors"));
  const startDistance = Math.min(...ids.map((id) => horizontal(at(joined, id).movement.feet, at(joined, HUMAN).movement.feet)));

  const caught: (number | null)[] = ids.map(() => null);
  const trails: Vec3[][] = ids.map(() => []);
  let last = joined;
  for (let tick = 1; tick <= seconds * TICK_RATE; tick++) {
    last = person.step();
    const human = at(last, HUMAN).movement.feet;
    ids.forEach((id, i) => {
      const feet = at(last, id).movement.feet;
      if (caught[i] === null && horizontal(feet, human) <= CAUGHT) {
        caught[i] = tick / TICK_RATE;
      }
      if (tick % TICK_RATE === 0) {
        trails[i]!.push({ ...feet });
      }
    });
  }
  const human = at(last, HUMAN).movement.feet;
  return { horde: ids.length, caught, startDistance, final: ids.map((id) => horizontal(at(last, id).movement.feet, human)), trails };
}

describe.skipIf(!exported)("bots on dome-mw3", () => {
  beforeAll(async () => {
    baker = new NavBaker();
    await baker.start();
    const registry = new WorldRegistry(diskApi(), baker);
    const started = performance.now();
    loaded = await registry.acquire(SLUG);
    expect(loaded.nav).toBeDefined();
    // Loaded and joinable before the bake is done: nothing waits for it.
    expect(loaded.nav!.ready).toBe(false);
    expect(loaded.nav!.graph).toBeNull();

    // A timer due every 5 ms, as the tick's is every 16. The CPU the process used
    // between two turns of it is how long a slice held the event loop; how late
    // it fired is that plus however long the OS left the process unscheduled,
    // which a loaded machine makes seconds, so only the CPU is asserted on.
    let due = performance.now() + 5;
    let cpu = process.cpuUsage();
    const probe = setInterval(() => {
      const now = performance.now();
      const spent = process.cpuUsage(cpu);
      cpu = process.cpuUsage();
      worstLateness = Math.max(worstLateness, now - due);
      worstHoldCpuMs = Math.max(worstHoldCpuMs, (spent.user + spent.system) / 1000);
      due = now + 5;
    }, 5);
    const baked = await loaded.nav!.settled;
    clearInterval(probe);
    bakeWallMs = performance.now() - started;
    expect(baked).not.toBeNull();
    graph = baked!;
  }, 600_000);

  afterAll(async () => {
    await baker?.stop();
  });

  it("bakes through the world's load, in slices, to the graph a one-shot bake makes", () => {
    const nav = loaded.nav!;
    expect(nav.ready).toBe(true);
    const summary = nav.summary!;
    console.log(
      `  ${describeBake(SLUG, summary, nav.wallMs!)}; ${Math.round(bakeWallMs)}ms from acquire; a timer waited at most ${worstLateness.toFixed(1)}ms (${worstHoldCpuMs.toFixed(1)}ms of CPU)`,
    );
    // navBake.test.ts's numbers, from a bake run in one go: slicing changes nothing.
    expect({ usable: summary.usable, valid: summary.valid, invalid: summary.invalid, derived: summary.derived }).toEqual({
      usable: 508,
      valid: 4148,
      invalid: 2798,
      derived: { pairs: 3471, candidates: 6940, probed: 4147, valid: 4144 },
    });
    // A slice is NAV_SLICE_MS and one link's simulation past it; a garbage
    // collection can add to that, a whole bake held in one go would be seconds.
    expect(worstHoldCpuMs).toBeLessThan(100);
    expect(baker.backlog).toBe(0);
  });

  it("walks a bot to a node about 20 m away", () => {
    const run = walkTwentyMetres();
    console.log(`  reached in ${run.ticks} ticks (budget ${run.budget}), ${run.distance.toFixed(2)} m off`);
    expect(run.status).toBe("arrived");
    expect(run.distance).toBeLessThan(0.5);
  }, 60_000);

  it("walks the same way twice", () => {
    const one = walkTwentyMetres();
    const two = walkTwentyMetres();
    expect(two.trail).toEqual(one.trail);
  }, 60_000);

  it("stands still where it has no path", () => {
    const m = newMatch();
    const { id, controller, feet } = settledBot(m);
    controller.target = destination(feet, 0, false).point;
    for (let i = 0; i < 3 * TICK_RATE; i++) {
      m.step();
    }
    expect(controller.status).toBe("noPath");
    expect(horizontal(feetOf(m, id), feet)).toBeLessThan(0.01);
  });

  it("replans when a link on its path is shut", () => {
    const m = newMatch();
    const { id, controller, feet } = settledBot(m);
    const target = destination(feet, 20);
    controller.target = target.point;
    let ticks = 0;
    while (controller.leg < 1 && ticks < 10 * TICK_RATE) {
      m.step();
      ticks++;
    }
    expect(controller.plans).toBe(1);
    const ahead = controller.path.links[controller.leg + 1]!;
    expect(ahead).toBeDefined();
    const shut = m.navigation!.state.addBlocker("door", { links: [ahead] });
    expect(shut).toEqual([ahead]);

    const budget = Math.ceil((3 * target.cost + 5) * TICK_RATE);
    for (let i = 0; i < budget && controller.status === "moving"; i++) {
      m.step();
    }
    expect(controller.plans).toBe(2);
    // Around the door, or nowhere; never through it.
    expect(controller.path.links).not.toContain(ahead);
    expect(["arrived", "noPath"]).toContain(controller.status);
    if (controller.status === "arrived") {
      expect(horizontal(feetOf(m, id), target.point)).toBeLessThan(0.5);
    }
  }, 60_000);

  it("chases: matchStart adds the horde, and it runs down a person standing still", () => {
    const run = chase();
    console.log(
      `  chase: ${run.caught.filter((t) => t !== null).length}/${HORDE_SIZE} within ${CAUGHT} m of the survivor, ` +
        `first after ${fmt(Math.min(...run.caught.filter((t): t is number => t !== null)))} s, ` +
        `median ${fmt(median(run.caught.filter((t): t is number => t !== null)))} s (start ${fmt(run.startDistance)} m away); ` +
        `final distances ${run.final.map((d) => d.toFixed(1)).join(" ")} m`,
    );
    expect(run.horde).toBe(HORDE_SIZE);
    // Most of the horde gets there. A body may take a traversal the others did
    // not, or be stuck behind a prop, and still be on its way when time is up.
    expect(run.final.filter((d) => d <= NEAR).length).toBeGreaterThanOrEqual(HORDE_SIZE - 2);
  }, 120_000);

  it("chases the same way twice", () => {
    const one = chase(20);
    const two = chase(20);
    expect(two.trails).toEqual(one.trails);
  }, 120_000);

  it("stands the horde still when the person is somewhere no path goes", () => {
    const m = chaseMatch();
    m.step();
    const bots = hordeOf(m);
    // The first usable node the horde cannot reach. A person standing on it is
    // grounded to it (it is the nearest node to their feet), so no path leads there.
    const from = graph.nearestNode(feetOf(m, bots[0]!), 2, 8);
    const search = new NavSearch(graph);
    const found = createPath();
    let island = -1;
    for (let node = 0; node < graph.nodeCount && island < 0; node++) {
      if (graph.usable[node] && search.find(from, node, { abilities: ALL_ABILITIES }, found) === "unreachable") {
        island = node;
      }
    }
    expect(island).toBeGreaterThanOrEqual(0);
    const at = { x: graph.feet[island * 3]!, y: graph.feet[island * 3 + 1]!, z: graph.feet[island * 3 + 2]! };

    // Put the survivor there as a script would, the moment they are in.
    const place: Script = {
      id: "place",
      server: {
        tick: (ctx) => {
          const state = ctx.state(HUMAN);
          if (state && Math.hypot(state.feet.x - at.x, state.feet.z - at.z) > 0.5) {
            ctx.spawn(HUMAN, { position: { x: at.x, y: at.y + EYE_HEIGHT, z: at.z }, look: { x: at.x, y: at.y + EYE_HEIGHT, z: at.z - 1 }, start: false });
          }
        },
      },
    };
    const n = chaseMatch([place]);
    n.step();
    n.join(HUMAN);
    const person = new Stander(n);
    for (let i = 0; i < 2 * TICK_RATE; i++) {
      person.step();
    }
    const settled = hordeOf(n).map((id) => feetOf(n, id));
    expect(horizontal(feetOf(n, HUMAN), at)).toBeLessThan(0.5);
    for (let i = 0; i < 5 * TICK_RATE; i++) {
      person.step();
    }
    const moved = hordeOf(n).map((id, i) => horizontal(feetOf(n, id), settled[i]!));
    console.log(`  a survivor on node ${island}, which the horde cannot reach: the horde moved at most ${Math.max(...moved).toFixed(3)} m in 5 s`);
    expect(Math.max(...moved)).toBeLessThan(0.05);
  }, 60_000);

  it("keeps no game alive and fills no seat", async () => {
    let clock = 1_000_000;
    const registry = { loaded: [SLUG], acquire: async () => loaded, release: () => {} } as unknown as WorldRegistry;
    const weapons = {
      all: new WeaponRegistry([]),
      hash: new WeaponRegistry([]).hash,
      catalogue: catalogueViewOf({ version: CATALOG_VERSION }, new WeaponRegistry([])),
      load: async () => {},
    } as unknown as Weapons;
    const physics = { available: false, load: async () => {}, create: () => undefined } as unknown as Physics;
    const games = new Games(registry, weapons, NO_BODIES, physics, () => clock);
    const game = (await games.create({ gameId: "g-bots", map: SLUG, gametype: DEFAULT_GAMETYPE, maxPlayers: 1, durationSeconds: 600, players: [] }))!;
    // The world's graph reached the match through the order.
    expect(game.match.navigation?.graph).toBe(graph);

    game.match.addBot({ controller: new GotoPoint(null) });
    game.match.addBot({ controller: new GotoPoint(null) });
    game.match.step();
    expect(game.match.size).toBe(2);
    expect(game.match.full).toBe(false);
    expect(games.players).toBe(0);

    clock += config.joinGraceMs;
    expect(games.finished(clock).map((over) => over.ending)).toEqual(["unattended"]);
  });
});
