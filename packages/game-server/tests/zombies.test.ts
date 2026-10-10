// A zombies match on a made-up map: the round loop, the points, the doors and
// death, as `scripts/zombies.ts` plays them over a real `Match`.
//
// Flat ground, two zones each targeting its spawners, a door and a window. There
// is no navigation, so a zombie stands where it spawned and hits nobody: what is
// under test is the script, and walking to a player is actors.test.ts's.

import { describe, expect, it } from "vitest";
import type { ResolvedPoint, ResolvedSolid, ResolvedTrigger, ResolvedWorld } from "@3d/shared/dsl/resolved.js";
import { catalogueViewOf } from "@3d/shared/game/catalogueView.js";
import type { ServerContext } from "@3d/shared/game/context.js";
import type { UsableThing } from "@3d/shared/game/focus.js";
import { zombiesBo2HordeGametype, zombiesGametype } from "@3d/shared/game/gametypes/zombies.js";
import type { GametypeDecl } from "@3d/shared/game/gametypes/declaration.js";
import type { GameKey } from "@3d/shared/dsl/resolved.js";
import type { Script } from "@3d/shared/game/hooks.js";
import {
  FIRST_ROUND_DELAY,
  GAME_OVER_SECONDS,
  HIT_POINTS,
  KILL_POINTS,
  ROUND_BREAK,
  START_POINTS,
  zombieHealth,
  zombiesScript,
} from "@3d/shared/game/scripts/zombies/base.js";
import type { InputMessage } from "@3d/shared/net/messages/input.js";
import { idleInput, type PlayerInput } from "@3d/shared/sim/input.js";
import { createMovement, EYE_HEIGHT } from "@3d/shared/sim/movement.js";
import { CATALOG_VERSION, WeaponRegistry } from "@3d/shared/sim/weaponRegistry.js";
import { NO_BODIES } from "../src/bodies.js";
import { Match } from "../src/match/match.js";
import { zombiePistols } from "./zombiePistols.js";

const TICK_RATE = 60;
const MAP = "theater-bo1";

const ground = {
  ready: true,
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
  },
  overlapsCapsule: (position: { y: number }) => position.y < 0,
  groundBelow: (from: { y: number }, distance: number) => (from.y >= 0 && from.y - distance <= 0 ? 0 : null),
  surfaceAt: () => null,
  traceRay: () => null,
};

function trigger(id: number, over: Partial<ResolvedTrigger>): ResolvedTrigger {
  return { id, tags: [], position: { x: 0, y: 0, z: 0 }, yaw: 0, size: { x: 1, y: 1, z: 1 }, ...over };
}

function point(id: number, tags: string[], x: number, z: number, target?: string): ResolvedPoint {
  return { id, tags, position: { x, y: 0, z }, look: { x, y: 0, z: z - 1 }, target };
}

/** Where the start zone's walkers stand; everything else a zone targets is somewhere else. */
const WALKERS = [
  { x: 5, z: 5 },
  { x: -5, z: 5 },
];

/**
 * The start zone around the spawn and a far zone twenty metres off, each targeting
 * its spawners; a door's buy trigger a metre and a half ahead of the spawn, and an
 * electric one beside it; one window, whose part is a clip.
 */
function world(game: GameKey = "t5"): ResolvedWorld {
  const triggers = [
    trigger(10, { tags: ["start_zone", "player_volume"], target: "start_spawners", position: { x: 0, y: 1, z: 0 }, size: { x: 12, y: 3, z: 12 } }),
    trigger(11, { tags: ["far_zone", "player_volume"], target: "far_spawners", position: { x: 0, y: 1, z: -30 }, size: { x: 6, y: 3, z: 6 } }),
    trigger(12, { tags: ["ambient_package"], position: { x: 0, y: 1, z: 0 }, size: { x: 4, y: 3, z: 4 } }),
    trigger(13, { tags: ["zombie_door"], target: "backstage_door", use: "near", position: { x: 0, y: 1.25, z: -1.5 }, size: { x: 2, y: 2.5, z: 0.2 } }),
    trigger(14, {
      tags: ["zombie_door", "electric_door"],
      target: "power_door",
      use: "near",
      position: { x: 6, y: 1.25, z: -1.5 },
      size: { x: 2, y: 2.5, z: 0.2 },
    }),
  ];
  const points = [
    point(20, ["start_spawners", "zombie_spawner"], WALKERS[0]!.x, WALKERS[0]!.z),
    point(21, ["start_spawners", "zombie_spawner", "zombie_chaser"], WALKERS[1]!.x, WALKERS[1]!.z),
    point(22, ["start_spawners", "zombie_spawner", "riser"], 5, -5),
    point(23, ["start_spawners", "quad_zombie_spawner", "zombie_chaser"], -5, -5),
    point(24, ["start_spawners_dog", "find_flesh"], 7, 7),
    point(25, ["far_spawners", "zombie_spawner"], 0, -35),
    point(26, ["exterior_goal"], 9, 0, "pf1_auto1"),
  ];
  const solids: ResolvedSolid[] = [
    { id: 30, part: "*1", tags: ["backstage_door"] },
    { id: 31, part: "*2", tags: ["pf1_auto1", "clip"] },
    { id: 32, part: "*3", tags: ["power_door"] },
  ];
  return {
    name: "yard",
    game,
    spawn: { position: { x: 0, y: EYE_HEIGHT, z: 0 }, look: { x: 0, y: EYE_HEIGHT, z: -1 } },
    spawnPoints: [],
    triggers,
    mantles: [],
    ladders: [],
    effects: [],
    sounds: [],
    points,
    solids,
    rooms: [],
    topLevelObjects: [],
  } as unknown as ResolvedWorld;
}

interface Heard {
  ctx: () => ServerContext;
  used: UsableThing[];
}

/** A zombies match, with a second script that hands its context out and hears the use key. */
function zombies(gametype: GametypeDecl = zombiesGametype, game?: GameKey): { m: Match; heard: Heard } {
  let held: ServerContext | undefined;
  const used: UsableThing[] = [];
  const listener: Script = {
    id: "listener",
    server: {
      matchStart: (ctx) => (held = ctx),
      interact: (_ctx, thing) => void used.push(thing),
    },
  };
  const m = new Match(ground, world(game), TICK_RATE, 4, zombiePistols(), {
    map: MAP,
    gametype,
    catalogue: catalogueViewOf({ version: CATALOG_VERSION }, new WeaponRegistry([])),
    bodies: NO_BODIES,
    scripts: [zombiesScript, listener],
  });
  m.step();
  return { m, heard: { ctx: () => held!, used } };
}

let seq = 0;
function send(m: Match, id: string, input: Partial<PlayerInput> = {}): void {
  m.receive(id, {
    seq: ++seq & 0xffff,
    dt: 1 / TICK_RATE,
    input: { ...idleInput(0, 0), ...input },
    claim: createMovement({ x: 0, y: 0, z: 0 }, 0, 0),
    renderTick: 0,
    renderFrac: 0,
  } satisfies InputMessage);
}

/** `seconds` of ticks, each player standing still. */
function play(m: Match, seconds: number, players: string[] = ["a"]): void {
  for (let i = 0; i < Math.round(seconds * TICK_RATE); i++) {
    for (const id of players) {
      send(m, id);
    }
    m.step();
  }
}

function living(ctx: ServerContext): number[] {
  return ctx.actors.ids().filter((id) => ctx.actors.state(id)?.alive);
}

/** Kill every zombie standing, as `by`, and let the corpses lie. */
function killAll(ctx: ServerContext, by: string | null = null): void {
  for (const id of living(ctx)) {
    ctx.actors.damage(id, 1_000_000, by);
  }
}

/** Play the round out, killing every zombie as it arrives, to the tick it is won. */
function clearRound(m: Match, ctx: ServerContext, players: string[] = ["a"]): void {
  for (let i = 0; i < 120 * TICK_RATE; i++) {
    for (const id of players) {
      send(m, id);
    }
    m.step();
    if (m.eventsThisTick.some((said) => said.what === "roundOver")) {
      return;
    }
    killAll(ctx);
  }
  throw new Error("the round never ended");
}

describe("a zombies round", () => {
  it("starts round 1 two seconds in, and spawns BO1's six for one player at the start zone's walkers only", () => {
    const { m, heard } = zombies();
    m.join("a");
    const ctx = heard.ctx();
    expect(ctx.counter("round")).toBe(0);
    play(m, FIRST_ROUND_DELAY + 0.1);
    expect(ctx.counter("round")).toBe(1);
    expect(m.snapshotFor("a", []).counters).toEqual([1]);

    // A spawn every two seconds: six of them in the next twelve.
    play(m, 13);
    const spawned = ctx.actors.ids().map((id) => ctx.actors.state(id)!);
    expect(spawned).toHaveLength(6);
    for (const zombie of spawned) {
      // Three to a walker, so each stands where it was put or a body's width or two off it, pushed out of the others.
      expect(WALKERS.some((w) => Math.hypot(w.x - zombie.feet.x, w.z - zombie.feet.z) < 1)).toBe(true);
      expect(zombie.health).toBe(150);
    }
    // And no more: the round's six are all out.
    play(m, 10);
    expect(ctx.actors.ids()).toHaveLength(6);
  });

  it("spawns Black Ops' zombie on a t5 world, and TranZit's on a t6 one or in the BO2 horde preview", () => {
    const kinds = (z: { m: Match; heard: Heard }): string[] => {
      z.m.join("a");
      play(z.m, FIRST_ROUND_DELAY + 0.1);
      const ctx = z.heard.ctx();
      return [...new Set(ctx.actors.ids().map((id) => ctx.actors.state(id)!.kind))];
    };
    expect(kinds(zombies())).toEqual(["zombie"]);
    expect(kinds(zombies(zombiesGametype, "t6"))).toEqual(["zombie_transit"]);
    expect(kinds(zombies(zombiesBo2HordeGametype))).toEqual(["zombie_transit"]);
  });

  it("says a round's start and end, for the client half to play", () => {
    const { m, heard } = zombies();
    m.join("a");
    const said: string[] = [];
    for (let i = 0; i < (FIRST_ROUND_DELAY + 0.1) * TICK_RATE; i++) {
      send(m, "a");
      m.step();
      said.push(...m.eventsThisTick.map((e) => `${e.what}:${e.value}`));
    }
    expect(said).toEqual(["round:1"]);
    clearRound(m, heard.ctx());
    expect(m.eventsThisTick.map((e) => `${e.what}:${e.value}`)).toEqual(["roundOver:1"]);
  });

  it("opens the windows as the match starts, and leaves the doors shut", () => {
    const { m } = zombies();
    m.step();
    expect(m.presence.has(1)).toBe(false);
    expect(m.presence.has(0)).toBe(true);
    expect(m.presence.has(2)).toBe(true);
  });

  it("breaks for ten seconds when the last zombie dies, then prices round 2's zombies higher", () => {
    const { m, heard } = zombies();
    m.join("a");
    const ctx = heard.ctx();
    play(m, FIRST_ROUND_DELAY + 0.1);
    clearRound(m, ctx);
    // Round 1's last kill ends it; the next begins after the break.
    expect(ctx.counter("round")).toBe(1);
    play(m, ROUND_BREAK - 0.5);
    expect(ctx.counter("round")).toBe(1);
    play(m, 1);
    expect(ctx.counter("round")).toBe(2);
    play(m, 0.1);
    const fresh = living(ctx);
    expect(fresh.length).toBeGreaterThan(0);
    expect(ctx.actors.state(fresh[0]!)!.health).toBe(zombieHealth(2));
  });
});

describe("points", () => {
  it("start at 500, pay 10 for a hit that leaves one standing and 50 for a kill with no location", () => {
    const { m, heard } = zombies();
    m.join("a");
    const ctx = heard.ctx();
    expect(ctx.points("a")).toBe(START_POINTS);
    expect(m.snapshotFor("a", m.step().players).players.find((p) => p.id === "a")!.state.points).toBe(START_POINTS);
    play(m, FIRST_ROUND_DELAY + 0.1);
    const [zombie] = living(ctx);
    ctx.actors.damage(zombie!, 20, "a");
    expect(ctx.points("a")).toBe(START_POINTS + HIT_POINTS);
    // The killing hit is paid for the kill, and not for the hit as well.
    ctx.actors.damage(zombie!, 1000, "a", "bullet");
    expect(ctx.points("a")).toBe(START_POINTS + HIT_POINTS + KILL_POINTS);
    // A zombie nobody killed pays nobody.
    play(m, 2.1);
    killAll(ctx, null);
    expect(ctx.points("a")).toBe(START_POINTS + HIT_POINTS + KILL_POINTS);
  });
});

describe("doors", () => {
  /** A player on the spawn, facing the door, with `points` in their purse. */
  function facingTheDoor(points: number) {
    const z = zombies();
    z.m.join("a");
    const ctx = z.heard.ctx();
    ctx.addPoints("a", points - ctx.points("a"));
    play(z.m, 0.2);
    return { ...z, ctx };
  }

  it("opens for 1250 of a player's points, and takes them", () => {
    const { m, heard, ctx } = facingTheDoor(1250);
    send(m, "a", { use: true });
    m.step();
    expect(heard.used.map((thing) => thing.target)).toEqual(["backstage_door"]);
    // Said to everybody, about the buyer, who is the one to hear it.
    expect(m.eventsThisTick).toEqual([{ what: "purchase", player: "a", value: 1250 }]);
    expect(ctx.points("a")).toBe(0);
    expect(m.presence.has(0)).toBe(false);
    // Bought is gone: nothing is in focus there any more.
    send(m, "a");
    m.step();
    send(m, "a", { use: true });
    m.step();
    expect(heard.used).toHaveLength(1);
  });

  it("stays shut for a player with 500, and takes nothing", () => {
    const { m, heard, ctx } = facingTheDoor(500);
    send(m, "a", { use: true });
    m.step();
    expect(heard.used).toHaveLength(1);
    expect(m.eventsThisTick).toEqual([{ what: "deny", player: "a", value: 1250 }]);
    expect(ctx.points("a")).toBe(500);
    expect(m.presence.has(0)).toBe(true);
  });
});

describe("death", () => {
  it("keeps a dead player down until the round is won, and brings them back when it is", () => {
    const { m, heard } = zombies();
    m.join("a");
    m.join("b");
    const ctx = heard.ctx();
    play(m, FIRST_ROUND_DELAY + 0.1, ["a", "b"]);
    ctx.damage("a", 1000, null);
    play(m, 30, ["a", "b"]);
    expect(ctx.state("a")?.alive).toBe(false);
    expect(ctx.counter("round")).toBe(1);
    clearRound(m, ctx, ["a", "b"]);
    // Round 1 is won and the break under way: they are back for round 2.
    expect(ctx.state("a")?.alive).toBe(true);
    expect(ctx.counter("round")).toBe(1);
  });

  it("is the end of the game when nobody is left standing", () => {
    const { m, heard } = zombies();
    m.join("a");
    const ctx = heard.ctx();
    play(m, FIRST_ROUND_DELAY + 0.1);
    ctx.damage("a", 1000, null);
    m.step();
    expect(m.eventsThisTick).toContainEqual({ what: "gameOver", value: 1 });
    expect(m.ended).toBeUndefined();
    // Nobody is spawned for a game that is over.
    const count = ctx.actors.ids().length;
    play(m, GAME_OVER_SECONDS);
    expect(ctx.actors.ids().length).toBe(count);
    expect(m.ended).toMatch(/round 1/);
  });
});

describe("determinism", () => {
  it("plays two runs of the same match out the same", () => {
    const run = () => {
      const { m, heard } = zombies();
      m.join("a");
      m.join("b");
      const ctx = heard.ctx();
      const trace: unknown[] = [];
      for (let round = 0; round < 3; round++) {
        clearRound(m, ctx, ["a", "b"]);
        play(m, ROUND_BREAK + 3, ["a", "b"]);
        trace.push(
          ctx.counter("round"),
          ctx.actors.ids().map((id) => ctx.actors.state(id)),
        );
      }
      return JSON.stringify(trace);
    };
    expect(run()).toBe(run());
  });
});
