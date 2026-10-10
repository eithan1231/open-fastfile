// What a script keeps and what a match keeps for it: a script's own state
// (`init`, `ctx.memory`), each player's points, the gametype's counters, a
// respawn a script decides, and a match a script ends.
//
// Flat ground and an empty world: none of this is about where anybody is.

import { describe, expect, it } from "vitest";
import type { ResolvedWorld } from "@3d/shared/dsl/resolved.js";
import { catalogueViewOf } from "@3d/shared/game/catalogueView.js";
import type { ServerContext } from "@3d/shared/game/context.js";
import type { GametypeDecl } from "@3d/shared/game/gametypes/declaration.js";
import { defineScript, type Script } from "@3d/shared/game/hooks.js";
import { MAX_POINTS } from "@3d/shared/game/matchValues.js";
import { decodePacket, encodePacket, MessageType } from "@3d/shared/net/packet.js";
import { CATALOG_VERSION, WeaponRegistry } from "@3d/shared/sim/weaponRegistry.js";
import { NO_BODIES } from "../src/bodies.js";
import { Match } from "../src/match/match.js";

const TICK_RATE = 60;

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

const WORLD = {
  spawn: { position: { x: 0, y: 1.6, z: 0 }, look: { x: 0, y: 1.6, z: -1 } },
  spawnPoints: [],
  triggers: [],
  mantles: [],
  ladders: [],
  points: [],
  solids: [],
  rooms: [],
  topLevelObjects: [],
} as unknown as ResolvedWorld;

const KEEPING: GametypeDecl = { id: "keeping", display: "Keeping", teams: ["us"], counters: ["round", "wave"], points: true };

function match(scripts: Script[], gametype: GametypeDecl = KEEPING): Match {
  return new Match(ground, WORLD, TICK_RATE, 4, new WeaponRegistry([]), {
    map: "flat",
    gametype,
    catalogue: catalogueViewOf({ version: CATALOG_VERSION }, new WeaponRegistry([])),
    bodies: NO_BODIES,
    scripts,
  });
}

/** A script that hands its context out, so a test can call its verbs. */
function holding(extra: Script["server"] = {}): { script: Script; ctx: () => ServerContext } {
  let held: ServerContext | undefined;
  return {
    script: { id: "holder", server: { ...extra, matchStart: (ctx) => (held = ctx) } },
    ctx: () => held!,
  };
}

describe("a script's own state", () => {
  it("is made once, before any other hook, and is the same object on every hook for the match", () => {
    let made = 0;
    const seen: unknown[] = [];
    const counter = defineScript<{ ticks: number; joined: string[] }>({
      id: "counter",
      server: {
        init: (ctx) => {
          made++;
          // Made before any hook: nobody here, and nothing to remember yet.
          expect(ctx.memory).toBeUndefined();
          return { ticks: 0, joined: [] };
        },
        combatRules: (ctx) => void seen.push(ctx.memory),
        playerJoin: (ctx, id) => void ctx.memory.joined.push(id),
        tick: (ctx) => {
          ctx.memory.ticks++;
          seen.push(ctx.memory);
        },
      },
    });
    const other = holding();
    const m = match([counter, other.script]);
    m.join("a");
    for (let i = 0; i < 5; i++) {
      m.step();
    }
    expect(made).toBe(1);
    expect(new Set(seen).size).toBe(1);
    const memory = seen[0] as { ticks: number; joined: string[] };
    expect(memory).toEqual({ ticks: 5, joined: ["a"] });
    // Another script's context has its own memory, which is none.
    expect(other.ctx().memory).toBeUndefined();
  });

  it("is each match's own, though the script is one module", () => {
    const memories: { ticks: number }[] = [];
    const script = defineScript<{ ticks: number }>({
      id: "s",
      server: {
        init: () => ({ ticks: 0 }),
        matchStart: (ctx) => void memories.push(ctx.memory),
        tick: (ctx) => void ctx.memory.ticks++,
      },
    });
    const one = match([script]);
    const two = match([script]);
    one.join("a");
    two.join("a");
    for (let i = 0; i < 3; i++) {
      one.step();
    }
    two.step();
    expect(memories.map((memory) => memory.ticks)).toEqual([3, 1]);
  });
});

describe("points", () => {
  it("are a player's purse, in the snapshot and the view, and never below nothing", () => {
    const { script, ctx } = holding({ playerJoin: (c, id) => c.addPoints(id, 500) });
    const m = match([script]);
    m.join("a");
    m.step();
    expect(ctx().points("a")).toBe(500);
    ctx().addPoints("a", -120);
    expect(ctx().points("a")).toBe(380);
    expect(ctx().player("a")?.points).toBe(380);
    const snapshot = m.step();
    expect(snapshot.players.find((p) => p.id === "a")!.state.points).toBe(380);
    const wire = decodePacket(encodePacket(MessageType.snapshot, snapshot)).message as typeof snapshot;
    expect(wire.players[0]!.state.points).toBe(380);

    expect(() => ctx().addPoints("a", -381)).toThrow(/has 380/);
    expect(ctx().points("a")).toBe(380);
    expect(() => ctx().addPoints("a", 0.5)).toThrow(/whole/);
    // Somebody not here is nobody to pay.
    expect(() => ctx().addPoints("nobody", 10)).not.toThrow();
    expect(ctx().points("nobody")).toBe(0);
    // Past what the wire carries, the purse stops.
    ctx().addPoints("a", MAX_POINTS);
    expect(ctx().points("a")).toBe(MAX_POINTS);
  });

  it("are refused in a gametype that keeps none", () => {
    const { script, ctx } = holding();
    const m = match([script], { id: "plain", display: "Plain", teams: [] });
    m.join("a");
    m.step();
    expect(() => ctx().addPoints("a", 10)).toThrow(/keeps none/);
    expect(ctx().player("a")?.points).toBe(0);
  });
});

describe("counters", () => {
  it("are set by name, read on the view and carried in the snapshot in the gametype's order", () => {
    const { script, ctx } = holding();
    const m = match([script]);
    m.step();
    expect(ctx().counter("round")).toBe(0);
    ctx().setCounter("wave", -4);
    ctx().setCounter("round", 7);
    expect(ctx().counter("round")).toBe(7);
    const snapshot = m.step();
    expect(snapshot.counters).toEqual([7, -4]);
    expect(m.snapshotFor("a", []).counters).toEqual([7, -4]);
    expect((decodePacket(encodePacket(MessageType.snapshot, snapshot)).message as typeof snapshot).counters).toEqual([7, -4]);
  });

  it("refuses a name the gametype does not declare, and a value the wire cannot carry", () => {
    const { script, ctx } = holding();
    const m = match([script]);
    m.step();
    expect(() => ctx().setCounter("lap", 1)).toThrow(/no counter "lap"/);
    expect(() => ctx().counter("lap")).toThrow(/no counter "lap"/);
    expect(() => ctx().setCounter("round", 1.5)).toThrow(/whole number/);
    expect(() => ctx().setCounter("round", 2 ** 23)).toThrow(/whole number/);
  });

  it("cost a gametype that declares none nothing but their count", () => {
    const { script } = holding();
    const m = match([script], { id: "plain", display: "Plain", teams: [] });
    expect(m.step().counters).toEqual([]);
  });
});

describe("a respawn a script decides", () => {
  it("never comes by the clock where the delay is null, and comes at once when a script asks", () => {
    const { script, ctx } = holding({ combatRules: () => ({ respawnDelay: null }) });
    const m = match([script]);
    expect(m.rules.respawnDelay).toBeNull();
    m.join("a");
    m.step();
    ctx().damage("a", 1000, null);
    // A minute of ticks: still down.
    for (let i = 0; i < TICK_RATE * 60; i++) {
      m.step();
    }
    expect(ctx().state("a")?.alive).toBe(false);
    expect(ctx().respawn("a")).toBe(true);
    expect(ctx().state("a")?.alive).toBe(true);
    expect(ctx().state("a")?.health).toBe(m.rules.maxHealth);
    // Somebody alive, or not here, is left alone.
    expect(ctx().respawn("a")).toBe(false);
    expect(ctx().respawn("nobody")).toBe(false);
  });

  it("still counts down where the gametype gives a delay", () => {
    const { script, ctx } = holding({ combatRules: () => ({ respawnDelay: 1 }) });
    const m = match([script]);
    m.join("a");
    m.step();
    ctx().damage("a", 1000, null);
    for (let i = 0; i < TICK_RATE + 2; i++) {
      m.step();
    }
    expect(ctx().state("a")?.alive).toBe(true);
  });
});

describe("a match a script ends", () => {
  it("says why, once, and plays on until it is dropped", () => {
    const { script, ctx } = holding();
    const m = match([script]);
    m.step();
    expect(m.ended).toBeUndefined();
    ctx().endMatch("everyone died");
    ctx().endMatch("said again");
    expect(m.ended).toBe("everyone died");
    expect(() => m.step()).not.toThrow();
  });
});
