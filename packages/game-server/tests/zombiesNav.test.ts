// Theater's doors against its own graph: baked once with every removable part
// absent, a door is then a blocker over the links it fills. With every door
// shut the start room is cut off from the rest of the map; opening one door
// reaches exactly the rooms behind it.
//
// Skips a world that has not been exported, as the other imported-map tests do.

import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { LINK_STATUS, type NavGraph } from "@3d/shared/nav/graph.js";
import type { WorldSource } from "@3d/shared/worlds/source.js";
import type { Api } from "../src/api.js";
import { NavBaker } from "../src/nav.js";
import { NavMatchState } from "@3d/shared/nav/dynamic.js";
import { actorMover } from "@3d/shared/nav/mover.js";
import { ALL_ABILITIES, NavPlanner } from "@3d/shared/game/bots/planner.js";
import { Motor } from "@3d/shared/game/bots/motor.js";
import type { CollisionWorld } from "@3d/shared/collision/world.js";
import { testApp } from "@3d/api/testing/app.js";
import type { ActorGait, ActorState } from "@3d/shared/game/actors/actor.js";
import { ZOMBIE_KIND } from "@3d/shared/game/actors/kinds.js";
import { ZOMBIE } from "@3d/shared/game/bots/brains/zombie.js";
import { SEEK_NEAREST } from "@3d/shared/game/bots/brains/seekNearest.js";
import { catalogueViewOf, type CatalogueView } from "@3d/shared/game/catalogueView.js";
import { defaultGametype } from "@3d/shared/game/gametypes/default.js";
import { zombiesGametype } from "@3d/shared/game/gametypes/zombies.js";
import { FIRST_ROUND_DELAY, ROUND_BREAK, zombiesScript } from "@3d/shared/game/scripts/zombies/base.js";
import type { Script } from "@3d/shared/game/hooks.js";
import { createApiClient } from "@3d/shared/protocol/api.js";
import type { HttpFetch } from "@3d/shared/protocol/http.js";
import { idleInput } from "@3d/shared/sim/input.js";
import { WeaponRegistry } from "@3d/shared/sim/weaponRegistry.js";
import { presenceFor } from "@3d/shared/worlds/presence.js";
import { NO_BODIES } from "../src/bodies.js";
import { Match } from "../src/match/match.js";
import { zombiePistols } from "./zombiePistols.js";
import { WorldRegistry, type LoadedWorld } from "../src/worlds.js";

const SLUG = "theater-bo1";
const WORLDS = path.resolve(import.meta.dirname, "../../../worlds");
const DIR = path.join(WORLDS, SLUG);
const exported = ["assets/collision.glb", "assets/nav.bin", "volumes.world"].every((f) => fs.existsSync(path.join(DIR, f)));

function read(file: string): Promise<Uint8Array | undefined> {
  return Promise.resolve(fs.existsSync(file) ? new Uint8Array(fs.readFileSync(file)) : undefined);
}

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

/** The nodes reachable from `from` over valid links, none of them in `shut`. */
function reach(from: number, shut: ReadonlySet<number>): Set<number> {
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length > 0) {
    const n = queue.pop()!;
    for (let l = graph.first[n]!; l < graph.first[n + 1]!; l++) {
      const t = graph.target[l]!;
      if (graph.status[l] === LINK_STATUS.VALID && !shut.has(l) && !seen.has(t)) {
        seen.add(t);
        queue.push(t);
      }
    }
  }
  return seen;
}

/** The usable node nearest a point, by straight-line distance. */
function nearestNode(p: { x: number; y: number; z: number }): number {
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < graph.nodeCount; i++) {
    if (!graph.usable[i]) {
      continue;
    }
    const d = Math.hypot(graph.feet[i * 3]! - p.x, graph.feet[i * 3 + 1]! - p.y, graph.feet[i * 3 + 2]! - p.z);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** Every link the solids tagged `tag` shut. */
function shutBy(tags: readonly string[]): Set<number> {
  const out = new Set<number>();
  loaded.world.solids.forEach((s, i) => {
    if (s.tags.some((t) => tags.includes(t))) {
      for (const l of loaded.nav!.partLinks[i] ?? []) {
        out.add(l);
      }
    }
  });
  return out;
}

describe.skipIf(!exported)("theater's doors on its navigation graph", () => {
  beforeAll(async () => {
    baker = new NavBaker();
    await baker.start();
    loaded = await new WorldRegistry(diskApi(), baker).acquire(SLUG);
    graph = (await loaded.nav!.settled)!;
    expect(graph).not.toBeNull();
  }, 600_000);

  afterAll(async () => {
    await baker?.stop();
  });

  const DOORS = [
    "foyer_top_door",
    "foyer_bottom_door",
    "vip_top_door",
    "alley_door2",
    "backstage_door",
    "dress_door",
    "dining_room_door",
    "alleyway_fencedoor",
    "theater_to_foyer_door",
  ];

  it("shuts links through every door", () => {
    for (const door of DOORS) {
      expect(shutBy([door]).size, door).toBeGreaterThan(0);
    }
  });

  it("cuts the start room off with every door shut, and a door reaches more of the map", () => {
    const start = nearestNode(loaded.world.spawnPoints.find((s) => s.start)!.position);
    const everything = reach(start, new Set());
    const allShut = reach(start, shutBy(DOORS));
    console.log(`  from the start: ${everything.size} nodes with every part absent, ${allShut.size} with every door shut`);
    expect(allShut.size).toBeLessThan(everything.size / 2);

    // The two doors out of the foyer: each reaches rooms the other does not.
    for (const open of ["foyer_top_door", "foyer_bottom_door"]) {
      const opened = reach(start, shutBy(DOORS.filter((d) => d !== open)));
      console.log(`  ${open} open: ${opened.size} nodes`);
      expect(opened.size, open).toBeGreaterThan(allShut.size);
    }
  });

  /** The window clips: solids that stop only an actor, bar the dog clips. */
  function windowClips(): number[] {
    const surfaces = loaded.surfaces as CollisionWorld;
    return loaded.world.solids.flatMap((s, i) =>
      surfaces.partBounds(i) === undefined && surfaces.partBounds(i, "ai") !== undefined && !s.tags.includes("dog_clips") ? [i] : [],
    );
  }

  /** An actor's planner with each solid present or not, as a match's parts would register it. */
  function actorPlanner(present: (solid: number) => boolean): NavPlanner {
    const state = new NavMatchState(graph);
    loaded.world.solids.forEach((s, i) => {
      const links = loaded.nav!.actorPartLinks[i] ?? [];
      if (links.length > 0) {
        state.addBlocker(`part:${s.part}`, { links }, present(i));
      }
    });
    return new NavPlanner(graph, state, ALL_ABILITIES, actorMover(graph));
  }

  it("sends an actor from every foyer spawner through a window to the start room, once its window clip is gone", () => {
    const windows = new Set(windowClips());
    console.log(`  ${windows.size} window clips; actor links shut by parts: ${loaded.nav!.actorPartLinks.reduce((n, l) => n + l.length, 0)}`);
    expect(windows.size).toBe(22);
    // Each window clip shuts a window's climb for an actor, and nothing for a player.
    for (const i of windows) {
      expect(loaded.nav!.partLinks[i] ?? [], loaded.world.solids[i]!.part).toEqual([]);
      const shut = loaded.nav!.actorPartLinks[i] ?? [];
      expect(
        shut.some((l) => graph.kind[l] === 1),
        loaded.world.solids[i]!.part,
      ).toBe(true);
    }

    const start = loaded.world.spawnPoints.find((s) => s.start)!.position;
    const spawners = loaded.world.points.filter((p) => p.tags.includes("foyer_zone_spawners") && p.tags.includes("zombie_spawner"));
    expect(spawners.length).toBeGreaterThan(0);
    const open = actorPlanner((i) => !windows.has(i)); // doors shut, windows clear
    const shut = actorPlanner(() => true); // doors shut, windows boarded
    const player = new NavPlanner(graph, new NavMatchState(graph));
    let reached = 0;
    for (const spawner of spawners) {
      const route = open.route(spawner.position, start);
      const blocked = shut.route(spawner.position, start);
      const bot = player.route(spawner.position, start);
      const traversals = route ? route.links.filter((l) => graph.kind[l] === 1).length : 0;
      console.log(
        `  spawner ${spawner.id} at (${spawner.position.x}, ${spawner.position.y}, ${spawner.position.z}): ` +
          `windows clear ${route ? `${route.links.length} links, ${traversals} traversal(s), ${route.cost.toFixed(1)} s` : "no route"}; ` +
          `boarded ${blocked ? `${blocked.links.length} links` : "no route"}; a player's graph ${bot ? `${bot.links.length} links` : "no route"}`,
      );
      expect(route, `spawner ${spawner.id}`).not.toBeNull();
      expect(traversals, `spawner ${spawner.id}`).toBeGreaterThan(0);
      expect(blocked, `spawner ${spawner.id}`).toBeNull();
      reached++;
    }
    expect(reached).toBe(spawners.length);
  });

  /** The catalogue this checkout serves, its actors only: the zombie's look and clips. */
  async function creatures(): Promise<CatalogueView> {
    const { app } = testApp();
    const client = createApiClient({ fetch: app.request.bind(app) as HttpFetch });
    const index = (await client.catalogIndex()) as { version: number; actors?: unknown[]; animations?: unknown[] };
    return catalogueViewOf({ version: index.version, actors: index.actors, animations: index.animations }, new WeaponRegistry([]));
  }

  /**
   * A match on theater as `Games` stands one up, with a player on a start spawn
   * and one zombie spawned at a foyer spawner (or `from`) as the match starts,
   * every window clip removed then too — or, `open`, every part at all, doors
   * included. What each tick's snapshot says the zombie was doing.
   */
  function hunt(
    catalogue: CatalogueView,
    seconds: number,
    boarded = false,
    { from, open = false }: { from?: string; open?: boolean } = {},
  ): { states: ActorState[]; firstBlow: number | null } {
    const surfaces = loaded.surfaces as CollisionWorld;
    const presence = presenceFor(loaded.world, undefined);
    const clear = open ? loaded.world.solids.map((_, i) => i) : windowClips();
    const spawner = from
      ? loaded.world.points.find((p) => p.name === from)!
      : loaded.world.points.find((p) => p.tags.includes("foyer_zone_spawners") && p.tags.includes("zombie_spawner"))!;
    let firstBlow: number | null = null;
    const script: Script = {
      id: "zombies-nav-test",
      server: {
        // Nobody here is to die of it: whatever a blow takes is back by the next.
        combatRules: () => ({ maxHealth: 1000, regenDelay: 0, regenRate: 100_000 }),
        matchStart: (ctx) => {
          for (const i of boarded ? [] : clear) {
            const tag = loaded.world.solids[i]!.tags[0];
            if (tag !== undefined) {
              ctx.world.setPresent(tag, false);
            }
          }
          ctx.actors.spawn({ kind: "zombie", brain: ZOMBIE, at: spawner.position, look: spawner.look, gait: "run" });
        },
        playerDamage: (ctx) => {
          firstBlow ??= ctx.now;
        },
      },
    };
    const match = new Match(surfaces.view(presence), loaded.world, 60, 4, zombiePistols(), {
      map: SLUG,
      gametype: defaultGametype,
      catalogue,
      bodies: NO_BODIES,
      scripts: [script],
      nav: loaded.nav,
      presence,
      actorCollision: surfaces.view(presence, "ai"),
      partView: (i) => surfaces.partView(i),
      partBounds: (i) => surfaces.partBounds(i),
    });
    const PLAYER = "aaaaaaaa";
    match.join(PLAYER);
    const states: ActorState[] = [];
    for (let seq = 1; seq <= seconds * 60; seq++) {
      match.receive(PLAYER, {
        seq,
        dt: 1 / 60,
        input: idleInput(0, 0),
        claim: { x: 0, y: 0, z: 0 },
        drawn: { tick: match.tick & 0xffff, frac: 0 },
      });
      const step = match.step();
      const actor = match.snapshotFor(PLAYER, step.players).actors[0];
      if (actor) {
        states.push(actor);
      }
      if (firstBlow !== null) {
        break;
      }
    }
    return { states, firstBlow };
  }

  it("climbs a zombie in through a window to a player in the start room, the same way twice", async () => {
    const catalogue = await creatures();
    if (!catalogue.actorFor(ZOMBIE_KIND.body!.game, ZOMBIE_KIND.body!.id)) {
      console.log("  no zombie in this catalogue: skipped");
      return;
    }
    const first = hunt(catalogue, 40);
    const climbs = first.states.filter((s) => s.action === "traverse");
    const at = (s: ActorState) => `(${s.feet.x.toFixed(2)}, ${s.feet.y.toFixed(2)}, ${s.feet.z.toFixed(2)})`;
    console.log(
      `  first blow at ${first.firstBlow?.toFixed(2)} s; climbed for ${(climbs.length / 60).toFixed(2)} s from ${climbs[0] && at(climbs[0])} to ${climbs.at(-1) && at(climbs.at(-1)!)}`,
    );
    expect(climbs.length).toBeGreaterThan(30);
    // In step: the climb's phase runs forward from near 0 to 1.
    expect(climbs[0]!.phase).toBeLessThan(0.1);
    expect(climbs.at(-1)!.phase).toBeGreaterThan(0.9);
    expect(first.firstBlow).not.toBeNull();
    expect(first.firstBlow!).toBeLessThan(40);

    const second = hunt(catalogue, 40);
    expect(second.firstBlow).toBe(first.firstBlow);
    expect(second.states).toEqual(first.states);

    // Boarded, the same zombie never climbs and never lands a blow.
    const boarded = hunt(catalogue, 20, true);
    expect(boarded.firstBlow).toBeNull();
    expect(boarded.states.some((s) => s.action === "traverse")).toBe(false);
  }, 120_000);
  // BO1's chasers spawn on roofs and ledges and come down jump downs, in the
  // game's own clip for each. Each has a way down, and takes it: VIP's only way
  // off its roof is a jump down whose begin hangs past the lip (nav/snap.ts).
  it("brings a zombie down from every raised chaser to the floor it serves, in the jump downs' own clips", async () => {
    const catalogue = await creatures();
    if (!catalogue.actorFor(ZOMBIE_KIND.body!.game, ZOMBIE_KIND.body!.id)) {
      console.log("  no zombie in this catalogue: skipped");
      return;
    }
    for (const [name, floor] of [
      ["p2214", 8.2], // VIP, 14.0 m
      ["p1746", 0], // dressing, 5.4 m
      ["p2268", 0.1], // alleyway, 13.1 m
    ] as const) {
      const { states } = hunt(catalogue, 40, false, { from: name, open: true });
      const lowest = Math.min(...states.map((s) => s.feet.y));
      const jumped = new Set(states.filter((s) => s.action === "traverse" && s.traversal > 0).map((s) => s.traversal));
      console.log(`  ${name}: down to ${lowest.toFixed(2)} m in clip(s) ${[...jumped].join(", ") || "none"}`);
      expect(lowest, name).toBeLessThan(floor + 0.5);
      expect(jumped.size, name).toBeGreaterThan(0);
      // A clip's fall is its own, not a straight line: at half-time the body is
      // well short of half the drop (every jump down crouches, leaps, then falls).
      const first = states.filter((s) => s.action === "traverse" && s.traversal === [...jumped][0]);
      const top = first[0]!.feet.y;
      const middle = first.find((s) => s.phase >= 0.5)!.feet.y;
      expect(top - middle, name).toBeLessThan((top - first.at(-1)!.feet.y) / 2);
    }
  }, 300_000);

  /**
   * A runner or a walker from every walker spawner, every part gone so every room
   * is open, all hunting a bot that roams the dogs' and risers' floor spots — a
   * new one every 15 s, as a player running a train does. How often an actor's
   * follower is stuck (mid-path it shuts the link, off the graph the motor says
   * `stuck`: both caught here without the engine knowing), and where the actors
   * stall: under 0.3 m in a second, 3 m or more from the bot.
   */
  async function chase(catalogue: CatalogueView, seconds: number, gait: ActorGait) {
    const spawners = loaded.world.points.filter((p) => p.tags.includes("zombie_spawner") && !p.tags.includes("riser"));
    const spots = loaded.world.points.filter((p) => p.tags.includes("find_flesh"));
    let stuck = 0;
    let actorStep = false;
    const step = Motor.prototype.step;
    const motorSpy = vi.spyOn(Motor.prototype, "step").mockImplementation(function (this: Motor, m, dt, nav, out, feetOf) {
      actorStep = nav.mover.kind === "actor";
      const status = step.call(this, m, dt, nav, out, feetOf);
      stuck += actorStep && status === "stuck" ? 1 : 0;
      actorStep = false;
      return status;
    });
    const addBlocker = NavMatchState.prototype.addBlocker;
    const blockerSpy = vi.spyOn(NavMatchState.prototype, "addBlocker").mockImplementation(function (this: NavMatchState, name, spec, present) {
      stuck += actorStep && name.startsWith("stuck:") ? 1 : 0;
      return addBlocker.call(this, name, spec, present);
    });
    const ids: number[] = [];
    const trail = new Map<number, { x: number; z: number }[]>();
    const stalls = new Map<string, number>();
    let bot = "";
    let leg = -1;
    const surfaces = loaded.surfaces as CollisionWorld;
    const presence = presenceFor(loaded.world, undefined);
    const script: Script = {
      id: "chase",
      server: {
        // Nobody here is to die of it: whatever a blow takes is back by the next.
        combatRules: () => ({ maxHealth: 1000, regenDelay: 0, regenRate: 100_000 }),
        matchStart: (ctx) => {
          for (const solid of loaded.world.solids) {
            if (solid.tags[0] !== undefined) {
              ctx.world.setPresent(solid.tags[0], false);
            }
          }
          bot = ctx.bots.add({ brain: SEEK_NEAREST, objective: { kind: "goto", point: spots[0]!.position } });
          for (const from of spawners) {
            ids.push(
              ctx.actors.spawn({ kind: "zombie", brain: ZOMBIE, at: from.position, look: from.look, gait, objective: { kind: "hunt", targets: [bot] } }),
            );
          }
        },
        tick: (ctx) => {
          const next = Math.floor(ctx.now / 15);
          if (next !== leg) {
            leg = next;
            ctx.bots.order(bot, { kind: "goto", point: spots[(next * 37) % spots.length]!.position });
          }
          const quarry = ctx.state(bot)!.feet;
          for (const id of ids) {
            const { feet } = ctx.actors.state(id)!;
            const past = trail.get(id) ?? [];
            past.push({ x: feet.x, z: feet.z });
            if (past.length > 60) {
              past.shift();
            }
            trail.set(id, past);
            const far = Math.hypot(feet.x - quarry.x, feet.z - quarry.z) > 3;
            if (past.length === 60 && far && Math.hypot(feet.x - past[0]!.x, feet.z - past[0]!.z) < 0.3) {
              const key = `(${Math.round(feet.x)}, ${Math.round(feet.y)}, ${Math.round(feet.z)})`;
              stalls.set(key, (stalls.get(key) ?? 0) + 1 / 60);
            }
          }
        },
      },
    };
    try {
      const match = new Match(surfaces.view(presence), loaded.world, 60, 4, zombiePistols(), {
        map: SLUG,
        gametype: defaultGametype,
        catalogue,
        bodies: NO_BODIES,
        scripts: [script],
        nav: loaded.nav,
        presence,
        actorCollision: surfaces.view(presence, "ai"),
        partView: (i) => surfaces.partView(i),
        partBounds: (i) => surfaces.partBounds(i),
      });
      const PLAYER = "aaaaaaaa";
      match.join(PLAYER);
      for (let seq = 1; seq <= seconds * 60; seq++) {
        match.receive(PLAYER, {
          seq: seq & 0xffff,
          dt: 1 / 60,
          input: idleInput(0, 0),
          claim: { x: 0, y: 0, z: 0 },
          drawn: { tick: match.tick & 0xffff, frac: 0 },
        });
        match.step();
      }
    } finally {
      motorSpy.mockRestore();
      blockerSpy.mockRestore();
    }
    const stalled = [...stalls.values()].reduce((a, b) => a + b, 0);
    const worst = [...stalls].sort((a, b) => b[1] - a[1]).slice(0, 5);
    return { zombies: ids.length, stuck, stalled, worst };
  }

  // Theater's foyer has a threshold a walker used to grind at for ten seconds
  // (sim/stepSlide.ts, `rideKerbs`), and a zombie chasing someone on the move used
  // to turn back and forth between two routes round the same pillar (bots/motor.ts,
  // `onward`). Before either: 38 stuck and 207 actor-seconds stalled for walkers,
  // 28 and 154 for runners.
  it("chases a bot round the map without sticking, walkers and runners alike", async () => {
    const catalogue = await creatures();
    if (!catalogue.actorFor(ZOMBIE_KIND.body!.game, ZOMBIE_KIND.body!.id)) {
      console.log("  no zombie in this catalogue: skipped");
      return;
    }
    const SECONDS = 180;
    for (const gait of ["walk", "run"] as const) {
      const { zombies, stuck, stalled, worst } = await chase(catalogue, SECONDS, gait);
      console.log(
        `  ${gait}: ${zombies} zombies for ${SECONDS} s; stuck ${stuck}; stalled ${stalled.toFixed(0)} actor-s, most at ${worst.map(([at, t]) => `${at} ${t.toFixed(1)} s`).join(", ")}`,
      );
      expect(stuck, gait).toBeLessThanOrEqual(3);
      expect(stalled / (zombies * SECONDS), gait).toBeLessThan(0.015);
      expect(worst[0]?.[1] ?? 0, gait).toBeLessThan(4);
    }
  }, 600_000);

  // The whole loop, as a game server runs it: the zombies script over the
  // gametype's own presence, one player on a start spawn, and a stand-in gunner
  // that kills whatever comes within 4 m on that player's behalf. Round 1's six
  // have to spawn outside, climb in, and come at the player for round 2 to start.
  it("plays round 1 through to round 2: six zombies climb in, die, and pay", async () => {
    const catalogue = await creatures();
    if (!catalogue.actorFor(ZOMBIE_KIND.body!.game, ZOMBIE_KIND.body!.id)) {
      console.log("  no zombie in this catalogue: skipped");
      return;
    }
    const surfaces = loaded.surfaces as CollisionWorld;
    const presence = presenceFor(loaded.world, zombiesGametype.mode);
    const PLAYER = "aaaaaaaa";
    const kills: number[] = [];
    let climbed = 0;
    const gunner: Script = {
      id: "gunner",
      server: {
        tick: (ctx) => {
          const me = ctx.state(PLAYER);
          if (!me?.alive) {
            return;
          }
          for (const id of ctx.actors.ids()) {
            const a = ctx.actors.state(id)!;
            if (a.alive && Math.hypot(a.feet.x - me.feet.x, a.feet.y - me.feet.y, a.feet.z - me.feet.z) < 4) {
              ctx.actors.damage(id, 100_000, PLAYER);
              kills.push(ctx.now);
            }
          }
        },
      },
    };
    const match = new Match(surfaces.view(presence), loaded.world, 60, 4, zombiePistols(), {
      map: SLUG,
      gametype: zombiesGametype,
      catalogue,
      bodies: NO_BODIES,
      scripts: [zombiesScript, gunner],
      nav: loaded.nav,
      presence,
      actorCollision: surfaces.view(presence, "ai"),
      partView: (i) => surfaces.partView(i),
      partBounds: (i) => surfaces.partBounds(i),
    });
    match.join(PLAYER);
    let round = 0;
    let points = 0;
    const limit = (FIRST_ROUND_DELAY + ROUND_BREAK + 90) * 60;
    for (let seq = 1; seq <= limit && round < 2; seq++) {
      match.receive(PLAYER, {
        seq: seq & 0xffff,
        dt: 1 / 60,
        input: idleInput(0, 0),
        claim: { x: 0, y: 0, z: 0 },
        drawn: { tick: match.tick & 0xffff, frac: 0 },
      });
      const step = match.step();
      const snapshot = match.snapshotFor(PLAYER, step.players);
      climbed += snapshot.actors.filter((a) => a.action === "traverse").length;
      round = snapshot.counters[0] ?? 0;
      points = snapshot.players.find((p) => p.id === PLAYER)?.state.points ?? points;
    }
    console.log(
      `  round ${round} after ${(match.tick / 60).toFixed(1)} s; kills at ${kills.map((t) => t.toFixed(1)).join(", ")} s; ${(climbed / 60).toFixed(1)} actor-seconds climbing; ${points} points`,
    );
    expect(kills).toHaveLength(6);
    expect(climbed).toBeGreaterThan(0);
    expect(round).toBe(2);
    expect(points).toBe(500 + 6 * 50);
  }, 300_000);
});
