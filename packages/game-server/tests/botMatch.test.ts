// Bots as match members, with no real map: flat ground, a line of nodes baked on
// it, and controllers that record what they are asked.
//
// What is under test is the mechanics a bot shares with a player and the few
// places it differs — its id, the input it is given each tick, the counts that
// ignore it, and standing still until there is a graph to plan over. Walking a
// real map is bots.test.ts's.

import { describe, expect, it, vi } from "vitest";
import type { ResolvedWorld } from "@3d/shared/dsl/resolved.js";
import { catalogueViewOf } from "@3d/shared/game/catalogueView.js";
import { defaultGametype } from "@3d/shared/game/gametypes/default.js";
import type { Script } from "@3d/shared/game/hooks.js";
import type { ServerContext } from "@3d/shared/game/context.js";
import type { GametypeDecl } from "@3d/shared/game/gametypes/declaration.js";
import type { Objective } from "@3d/shared/game/bots/objective.js";
import { BotDriver } from "@3d/shared/game/bots/driver.js";
import { bakeNav } from "@3d/shared/nav/bake.js";
import { NO_INDEX_16, NO_INDEX_32, type NavFile } from "@3d/shared/nav/format.js";
import type { NavGraph } from "@3d/shared/nav/graph.js";
import { HEADER_FLAGS } from "@3d/shared/nav/vocab.js";
import { isBotId } from "@3d/shared/net/messages/fields.js";
import { idleInput, type PlayerInput } from "@3d/shared/sim/input.js";
import { EYE_HEIGHT } from "@3d/shared/sim/movement.js";
import { movementRules } from "@3d/shared/sim/worldRules.js";
import { CATALOG_VERSION, WeaponRegistry } from "@3d/shared/sim/weaponRegistry.js";
import { NO_BODIES } from "../src/bodies.js";
import type { BotController, BotTurn } from "../src/bots.js";
import { Match } from "../src/match/match.js";
import { GotoPoint } from "./gotoPoint.js";

const TICK_RATE = 60;
const DT = 1 / TICK_RATE;

/** A floor at y=0 and nothing else. */
class FlatGround {
  readonly ready = true;
  resolveCapsule(
    position: { x: number; y: number; z: number },
    _r: number,
    _h: number,
    out?: { position: { x: number; y: number; z: number }; grounded: boolean },
  ) {
    const result = out ?? { position: { x: 0, y: 0, z: 0 }, grounded: false };
    result.position.x = position.x;
    result.position.y = Math.max(position.y, 0);
    result.position.z = position.z;
    result.grounded = position.y <= 0;
    return result;
  }

  overlapsCapsule(position: { y: number }): boolean {
    return position.y < 0;
  }

  traceRay(): null {
    return null;
  }

  groundBelow(from: { y: number }, distance: number): number | null {
    return from.y >= 0 && from.y - distance <= 0 ? 0 : null;
  }

  surfaceAt(): null {
    return null;
  }
}

function world(): ResolvedWorld {
  return {
    spawn: { position: { x: 0, y: EYE_HEIGHT, z: 0 }, look: { x: 0, y: EYE_HEIGHT, z: -1 } },
    spawnPoints: [],
    triggers: [],
    mantles: [],
    ladders: [],
    points: [],
    solids: [],
    rooms: [],
    topLevelObjects: [],
  } as unknown as ResolvedWorld;
}

/** Nodes half a metre above the floor, every 4 m along -Z from the spawn: links derived at load. */
function lineFile(count: number): NavFile {
  const position = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    position.set([0, 0.5, -4 * i], i * 3);
  }
  return {
    major: 1,
    minor: 0,
    flags: HEADER_FLAGS.DERIVE_WALK_LINKS,
    nodes: {
      count,
      position,
      yaw: new Uint16Array(count),
      type: new Uint8Array(count),
      flags: new Uint8Array(count),
      abilities: new Uint32Array(count),
      source: new Uint32Array(count).fill(NO_INDEX_32),
      name: new Uint32Array(count),
      group: new Uint16Array(count).fill(NO_INDEX_16),
      stance: new Uint8Array(count),
    },
    links: {
      count: 0,
      first: new Uint32Array(count + 1),
      target: new Uint32Array(0),
      gameCost: new Float32Array(0),
      kind: new Uint8Array(0),
      flags: new Uint8Array(0),
      traversal: new Uint16Array(0),
    },
    traversals: { count: 0, begin: new Uint32Array(0), end: new Uint32Array(0), kind: new Uint8Array(0), animscript: new Uint32Array(0) },
    strings: [""],
    meta: null,
    sections: [],
  };
}

let baked: NavGraph | undefined;
/** Four nodes over 12 m, baked once on the flat ground. */
function lineGraph(): NavGraph {
  baked ??= bakeNav(lineFile(4), new FlatGround(), movementRules(world()), { tickRate: TICK_RATE }).graph;
  return baked;
}

function match(options: { nav?: { graph: NavGraph | null }; scripts?: Script[]; maxPlayers?: number; gametype?: GametypeDecl } = {}): Match {
  return new Match(new FlatGround(), world(), TICK_RATE, options.maxPlayers ?? 4, new WeaponRegistry([]), {
    map: "flat",
    gametype: options.gametype ?? defaultGametype,
    catalogue: catalogueViewOf({ version: CATALOG_VERSION }, new WeaponRegistry([])),
    bodies: NO_BODIES,
    scripts: options.scripts ?? [],
    nav: options.nav,
  });
}

/** Records every tick it is asked about, and walks forward when told to. */
class Recorder implements BotController {
  readonly ticks: BotTurn[] = [];
  /** The input each tick arrived as, before this wrote anything. */
  readonly given: PlayerInput[] = [];
  walk = false;
  think(bot: BotTurn, out: PlayerInput): void {
    this.ticks.push({ ...bot, movement: structuredClone(bot.movement) });
    this.given.push({ ...out });
    if (this.walk) {
      out.forward = 1;
    }
  }
}

function feetOf(m: Match, id: string) {
  return m.step().players.find((p) => p.id === id)!.state.movement.feet;
}

describe("a bot in a match", () => {
  it("is minted an id the api cannot issue, and counts as a member but not as a person", () => {
    const m = match({ maxPlayers: 1 });
    const a = m.addBot({ controller: new Recorder() });
    const b = m.addBot({ controller: new Recorder() });
    expect([a, b]).toEqual(["#b1", "#b2"]);
    expect(isBotId(a)).toBe(true);
    expect(isBotId("aaaaaaaa")).toBe(false);
    expect(m.size).toBe(2);
    expect(m.humans).toBe(0);
    // The lobby was sized in people.
    expect(m.full).toBe(false);
    m.join("aaaaaaaa");
    expect(m.full).toBe(true);
    expect(m.humans).toBe(1);

    // In the snapshot like anybody else: no wire change, a client sees a player.
    expect(
      m
        .step()
        .players.map((p) => p.id)
        .sort(),
    ).toEqual(["#b1", "#b2", "aaaaaaaa"]);

    expect(m.removeBot("aaaaaaaa")).toBe(false);
    expect(m.removeBot(a)).toBe(true);
    expect(m.removeBot(a)).toBe(false);
    m.leave(b);
    expect(m.size).toBe(1);
    expect(m.humans).toBe(1);
    // An id is never reused, so a client never mistakes a new bot for an old one.
    expect(m.addBot({ controller: new Recorder() })).toBe("#b3");
  });

  it("joins the side it is given, and a side the gametype lacks throws", () => {
    const m = match();
    const id = m.addBot({ controller: new Recorder(), team: "axis" });
    const side = m.step().players.find((p) => p.id === id)!.state.team;
    expect(side).toBe(defaultGametype.teams.indexOf("axis"));
    expect(() => m.addBot({ controller: new Recorder(), team: "nobody" })).toThrow(/nobody/);
  });

  it("stands still, unasked, until the world's graph is baked, and is still stepped", () => {
    const nav: { graph: NavGraph | null } = { graph: null };
    const controller = new Recorder();
    controller.walk = true;
    const m = match({ nav });
    const id = m.addBot({ controller });
    const start = feetOf(m, id);
    for (let i = 0; i < 30; i++) {
      m.step();
    }
    const after = feetOf(m, id);
    expect(controller.ticks).toHaveLength(0);
    expect(m.navigation).toBeNull();
    expect(after.x).toBeCloseTo(start.x, 6);
    expect(after.z).toBeCloseTo(start.z, 6);
    // Stepped all the same: a member is only stepped by its inputs, and one that
    // had none would never have found the floor it was placed on.
    expect(m.step().players.find((p) => p.id === id)!.state.movement.grounded).toBe(true);

    nav.graph = lineGraph();
    const tick = m.tick;
    for (let i = 0; i < 30; i++) {
      m.step();
    }
    expect(controller.ticks).toHaveLength(30);
    expect(controller.ticks.map((t) => t.tick)).toEqual(Array.from({ length: 30 }, (_, i) => tick + 1 + i));
    expect(controller.ticks.every((t) => t.dt === DT && t.alive && t.id === id)).toBe(true);
    // One match state, built when the graph appeared, handed to every tick.
    expect(m.navigation).not.toBeNull();
    expect(controller.ticks.every((t) => t.nav === m.navigation)).toBe(true);
    expect(feetOf(m, id).z).toBeLessThan(start.z - 1);
  });

  it("measures no drift for a bot, which claims nothing", () => {
    const controller = new Recorder();
    controller.walk = true;
    const m = match({ nav: { graph: lineGraph() } });
    const id = m.addBot({ controller });
    for (let i = 0; i < 20; i++) {
      m.step();
    }
    expect(m.drift(id)).toEqual({ current: 0, max: 0, mean: 0, samples: 0 });
  });

  it("keeps no game's scripts running on its own", () => {
    const tick = vi.fn();
    const m = match({ scripts: [{ id: "clock", server: { tick } }] });
    m.addBot({ controller: new Recorder() });
    for (let i = 0; i < 10; i++) {
      m.step();
    }
    expect(tick).not.toHaveBeenCalled();
    m.join("aaaaaaaa");
    m.step();
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it("stands still for good once its controller throws, and the tick goes on", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const think = vi.fn((_bot: BotTurn, out: PlayerInput) => {
      out.forward = 1;
      throw new Error("a brain with a bug");
    });
    const m = match({ nav: { graph: lineGraph() } });
    const id = m.addBot({ controller: { think } });
    const walker = new Recorder();
    walker.walk = true;
    const other = m.addBot({ controller: walker });
    const start = feetOf(m, id);
    for (let i = 0; i < 30; i++) {
      m.step();
    }
    expect(think).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(feetOf(m, id).z).toBeCloseTo(start.z, 6);
    expect(walker.ticks.length).toBeGreaterThan(30);
    expect(feetOf(m, other).z).toBeLessThan(start.z - 1);
    warn.mockRestore();
  });

  it("walks a planned path to its end", () => {
    const controller = new GotoPoint({ x: 0, y: 0, z: -12 });
    const m = match({ nav: { graph: lineGraph() } });
    const id = m.addBot({ controller });
    let ticks = 0;
    while (controller.status !== "arrived" && ticks < 10 * TICK_RATE) {
      m.step();
      ticks++;
    }
    expect(controller.status).toBe("arrived");
    expect(controller.plans).toBe(1);
    const feet = feetOf(m, id);
    expect(Math.hypot(feet.x, feet.z + 12)).toBeLessThan(0.4);
    // Twelve metres at about 5.3 m/s running, plus slowing down at the end.
    expect(ticks).toBeLessThan(4 * TICK_RATE);
  });

  it("is handed an idle input facing where it already faces", () => {
    const controller = new Recorder();
    const m = match({ nav: { graph: lineGraph() } });
    m.addBot({ controller });
    m.step();
    m.step();
    const [tick, given] = [controller.ticks[1]!, controller.given[1]!];
    expect(given).toEqual(idleInput(tick.movement.yaw, tick.movement.pitch));
  });
});

/** A script that hands its context out, so a test can call the verbs a script has. */
function handle(extra: Script["server"] = {}): { script: Script; ctx: () => ServerContext } {
  let last: ServerContext | undefined;
  const script: Script = {
    id: "handle",
    server: {
      ...extra,
      matchStart: (ctx) => {
        last = ctx;
        extra.matchStart?.(ctx);
      },
      tick: (ctx, dt) => {
        last = ctx;
        extra.tick?.(ctx, dt);
      },
    },
  };
  return { script, ctx: () => last! };
}

describe("a script and its bots", () => {
  it("asks matchStart once, on the first tick, with nobody here — and its bots are there before anyone arrives", () => {
    const matchStart = vi.fn((ctx: ServerContext) => {
      ctx.bots.add({ brain: "seek-nearest", team: "axis" });
    });
    const tick = vi.fn();
    const m = match({ scripts: [{ id: "horde", server: { matchStart, tick } }] });
    expect(matchStart).not.toHaveBeenCalled();
    for (let i = 0; i < 5; i++) {
      m.step();
    }
    expect(matchStart).toHaveBeenCalledTimes(1);
    expect(m.size).toBe(1);
    expect(m.humans).toBe(0);
    // `tick` is still for rooms with people in them.
    expect(tick).not.toHaveBeenCalled();
    m.join("aaaaaaaa");
    m.step();
    expect(matchStart).toHaveBeenCalledTimes(1);
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it("adds, lists, orders and removes bots by brain, and refuses what nobody declared", () => {
    const { script, ctx } = handle();
    const m = match({ scripts: [script], nav: { graph: lineGraph() } });
    m.join("aaaaaaaa");
    m.step();
    const bots = ctx().bots;
    const a = bots.add({ brain: "seek-nearest", team: "axis" });
    const b = bots.add({ brain: "seek-nearest", objective: { kind: "goto", point: { x: 0, y: 0, z: -8 } } });
    expect([a, b]).toEqual(["#b1", "#b2"]);
    expect(bots.ids()).toEqual([a, b]);
    expect(() => bots.add({ brain: "nobody" })).toThrow(/nobody/);
    expect(() => bots.add({ brain: "seek-nearest", team: "martians" })).toThrow(/martians/);
    expect(() => bots.order("aaaaaaaa", { kind: "none" })).toThrow(/not a bot/);
    // An id not here is nobody to order, as `setTeam` treats one.
    expect(() => bots.order("#b99", { kind: "none" })).not.toThrow();

    m.step();
    const view = ctx();
    expect(view.player(a)?.bot).toBe(true);
    expect(view.player("aaaaaaaa")?.bot).toBe(false);
    expect(bots.remove(a)).toBe(true);
    expect(bots.remove(a)).toBe(false);
    expect(bots.remove("aaaaaaaa")).toBe(false);
    expect(ctx().bots.ids()).toEqual([b]);
  });

  it("carries an order to the bot's brain at once, and a botObjective answer over it", () => {
    const script: { says?: Objective } = {};
    const { script: hooks, ctx } = handle({
      botObjective: (_ctx, _bot) => script.says,
    });
    const m = match({ scripts: [hooks], nav: { graph: lineGraph() } });
    m.join("aaaaaaaa");
    m.step();
    const driver = new BotDriver({ id: "probe", period: 100, init: () => null, think: () => ({ kind: "idle" }) });
    const id = m.addBot({ controller: driver, objective: { kind: "hunt" } });
    m.step();
    expect(driver.thinks).toBe(1);
    expect(driver.objective).toEqual({ kind: "hunt" });

    ctx().bots.order(id, { kind: "goto", node: 2 });
    m.step();
    expect(driver.thinks).toBe(2);
    expect(driver.objective).toEqual({ kind: "goto", node: 2 });

    // Null is `none`.
    ctx().bots.order(id, null);
    m.step();
    expect(driver.objective).toEqual({ kind: "none" });

    script.says = { kind: "follow", id: "aaaaaaaa" };
    ctx().bots.order(id, { kind: "hunt" });
    m.step();
    expect(driver.objective).toEqual(script.says);
  });

  it("tells a script where anybody is, as a copy", () => {
    const { script, ctx } = handle();
    const m = match({ scripts: [script] });
    m.join("aaaaaaaa");
    const bot = m.addBot({ controller: new Recorder(), team: "axis" });
    m.step();
    const state = ctx().state(bot)!;
    expect(state).toMatchObject({ alive: true, health: 100, team: "axis" });
    expect(state.feet.y).toBeCloseTo(0, 6);
    (state.feet as { x: number }).x = 1000;
    expect(ctx().state(bot)!.feet.x).not.toBe(1000);
    expect(ctx().state("nobody")).toBeUndefined();
  });

  it("keeps a blocker added before the graph is baked, and applies it when it is", () => {
    const nav: { graph: NavGraph | null } = { graph: null };
    const { script, ctx } = handle();
    const m = match({ scripts: [script], nav });
    m.join("aaaaaaaa");
    m.step();
    expect(ctx().nav.ready).toBe(false);
    expect(ctx().nav.nearestNode({ x: 0, y: 0, z: 0 })).toBe(-1);
    expect(ctx().nav.addBlocker("door", { links: [0, 1] })).toEqual([]);
    expect(ctx().nav.setBlocked("door", false)).toBe(true);
    expect(ctx().nav.setBlocked("door", false)).toBe(false);
    expect(ctx().nav.setBlocked("door", true)).toBe(true);

    nav.graph = lineGraph();
    m.step();
    expect(ctx().nav.ready).toBe(true);
    expect(ctx().nav.nearestNode({ x: 0.2, y: 0, z: -3.8 })).toBe(1);
    const state = m.navigation!.state;
    expect([state.blocked[0], state.blocked[1]]).toEqual([1, 1]);
    const epoch = state.epoch;
    expect(ctx().nav.setBlocked("door", false)).toBe(true);
    expect([state.blocked[0], state.blocked[1]]).toEqual([0, 0]);
    expect(state.epoch).toBeGreaterThan(epoch);
  });

  it("asks playerJoin for people and bots alike, before the spawn, so a side set there is the one spawned on", () => {
    const sides: Record<string, string | undefined> = {};
    const gametype: GametypeDecl = { id: "sides", display: "Sides", teams: ["red", "blue"] };
    const m = match({
      gametype,
      scripts: [
        {
          id: "sides",
          server: {
            playerJoin: (ctx, id) => {
              if (!ctx.player(id)?.bot) {
                ctx.setTeam(id, "blue");
              }
            },
            playerSpawn: (ctx, id) => {
              sides[id] = ctx.player(id)?.team;
            },
          },
        },
      ],
    });
    // Balancing alone would put the second arrival on red.
    const bot = m.addBot({ controller: new Recorder(), team: "blue" });
    m.join("aaaaaaaa");
    expect(sides).toEqual({ [bot]: "blue", aaaaaaaa: "blue" });
  });
});
