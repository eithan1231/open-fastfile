// The match's tick as a structure: the order its phases run in, what a script is
// handed across it, and the counters that are kept once per shot.
//
// What each phase *does* is tested where it is about something — combat.test.ts,
// interaction.test.ts, botMatch.test.ts. This file is for the two things only the
// structure can get wrong: the order, and state that is counted or built in the
// wrong place.

import "reflect-metadata";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { ResolvedWorld } from "@3d/shared/dsl/resolved.js";
import { catalogueViewOf } from "@3d/shared/game/catalogueView.js";
import type { ServerContext } from "@3d/shared/game/context.js";
import { defaultGametype } from "@3d/shared/game/gametypes/default.js";
import type { Script } from "@3d/shared/game/hooks.js";
import type { InputMessage } from "@3d/shared/net/messages/input.js";
import { idleInput } from "@3d/shared/sim/input.js";
import { STAND_EYE_HEIGHT } from "@3d/shared/sim/movement.js";
import { CATALOG_VERSION, WeaponRegistry } from "@3d/shared/sim/weaponRegistry.js";
import type { BodyView, LoadedBody } from "../src/bodies.js";
import { NO_BODIES } from "../src/bodies.js";
import { Match } from "../src/match/match.js";
import { PHASES } from "../src/match/phases.js";

const TICK_RATE = 60;

const ground = {
  ready: true,
  resolveCapsule(
    position: { x: number; y: number; z: number },
    _r: number,
    _h: number,
    out?: { position: { x: number; y: number; z: number }; grounded: boolean; normal: { x: number; y: number; z: number } },
  ) {
    const result = out ?? { position: { x: 0, y: 0, z: 0 }, grounded: false, normal: { x: 0, y: 0, z: 0 } };
    result.position.x = position.x;
    result.position.y = Math.max(position.y, 0);
    result.position.z = position.z;
    result.grounded = position.y <= 0;
    result.normal.x = 0;
    result.normal.y = result.grounded ? 1 : 0;
    result.normal.z = 0;
    return result;
  },
  overlapsCapsule: (position: { y: number }) => position.y < 0,
  overlapsSweep: (from: { y: number }, to: { y: number }, radius: number) => Math.min(from.y, to.y) < radius,
  groundBelow: (from: { y: number }, distance: number, normal?: { x: number; y: number; z: number }) => {
    if (from.y < 0 || from.y - distance > 0) {
      return null;
    }
    if (normal) {
      normal.x = 0;
      normal.y = 1;
      normal.z = 0;
    }
    return 0;
  },
  surfaceAt: () => null,
  traceRay: () => null,
};

function world(): ResolvedWorld {
  return {
    game: "iw5",
    spawn: { position: { x: 0, y: STAND_EYE_HEIGHT, z: 0 }, look: { x: 0, y: STAND_EYE_HEIGHT, z: -1 } },
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

function match(scripts: Script[], bodies: BodyView = NO_BODIES): Match {
  return new Match(ground, world(), TICK_RATE, 8, new WeaponRegistry([]), {
    map: "yard",
    gametype: defaultGametype,
    catalogue: catalogueViewOf({ version: CATALOG_VERSION }, new WeaponRegistry([])),
    bodies,
    scripts,
  });
}

function input(renderTick: number): InputMessage {
  return { seq: 1, dt: 1 / TICK_RATE, input: idleInput(0, 0), claim: { x: 0, y: 0, z: 0 }, drawn: { tick: renderTick, frac: 0 } };
}

describe("a tick's phases", () => {
  it("run in the order phases.ts lists, with every one of them filled", () => {
    const m = match([]);
    expect(m.tickPhases).toEqual([...PHASES]);
    // Pinned in full: each neighbour's comment in phases.ts is a reason this order
    // is not another, and a reorder should have to come and change this too.
    expect(m.tickPhases).toEqual([
      "records",
      "nav",
      "start",
      "bots",
      "inputs",
      "interactions",
      "fall out",
      "actors",
      "health",
      "occupancy",
      "scripts",
      "physics",
      "parts",
      "history",
      "snapshot",
    ]);
  });

  it("asks matchStart once, before the first tick's own hook", () => {
    const heard: string[] = [];
    const m = match([{ id: "s", server: { matchStart: () => void heard.push("start"), tick: () => void heard.push("tick") } }]);
    m.join("a");
    m.step();
    m.step();
    expect(heard).toEqual(["start", "tick", "tick"]);
  });
});

describe("a script's context", () => {
  it("is one object for the match, and reads the match as it is now", () => {
    const seen: ServerContext[] = [];
    const m = match([{ id: "s", server: { tick: (ctx) => void seen.push(ctx) } }]);
    m.join("a");
    m.step();
    const kept = seen[0]!;
    expect(kept.now).toBeCloseTo(1 / TICK_RATE, 9);
    expect(kept.players.map((p) => p.id)).toEqual(["a"]);

    m.join("b");
    m.step();
    // The same object on the next tick, and what it says has moved with the match.
    expect(seen[1]).toBe(kept);
    expect(kept.now).toBeCloseTo(2 / TICK_RATE, 9);
    expect(kept.players.map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("keeps each script's memory to itself", () => {
    const memories: unknown[] = [];
    const script = (id: string, state: unknown): Script => ({
      id,
      server: { ...(state === undefined ? {} : { init: () => state }), tick: (ctx) => void memories.push(ctx.memory) },
    });
    const m = match([script("one", { n: 1 }), script("none", undefined), script("two", { n: 2 })]);
    m.join("a");
    m.step();
    expect(memories).toEqual([{ n: 1 }, undefined, { n: 2 }]);
  });
});

describe("lag compensation's counters", () => {
  /** A body nothing can hit: enough for a player to be somebody a shot is judged against. */
  const body = {
    id: "body",
    game: "iw5",
    rig: { root: new THREE.Object3D() },
    poser: { update: () => {} },
    boxes: { trace: () => null },
  } as unknown as LoadedBody;
  const dressed: Script = {
    id: "cast",
    client: {
      cast: () => ({
        characters: [{ id: "body", body: { game: "iw5", file: "body.glb" } }],
        animations: { game: "iw5", file: "a.glb" },
        hands: { game: "iw5", file: "h.glb" },
        defaultWeapon: null,
      }),
    },
  } as unknown as Script;

  it("count a shot once, however many players it is judged against", () => {
    const m = match([dressed], { get: () => body });
    for (const id of ["shooter", "b", "c", "d", "e"]) {
      m.join(id);
    }
    for (let i = 0; i < 40; i++) {
      m.step();
    }
    expect(m.rewindReport()).toEqual({ implausible: 0, clamped: 0 });

    // A moment further back than a rewind may reach: clamped, once for the shot
    // and not once for each of the four players it could have hit.
    const stale = (m.tick - m.maxRewindTicks - 5) & 0xffff;
    m.traceShot("shooter", { x: 0, y: 1.5, z: 5 }, { x: 0, y: 0, z: -1 }, 20, input(stale));
    expect(m.rewindReport()).toEqual({ implausible: 0, clamped: 1 });
  });
});
