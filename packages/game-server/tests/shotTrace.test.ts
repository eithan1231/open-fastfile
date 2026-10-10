// SHOTTRACE — a temporary diagnostic (docs/engine/diagnostics-shottrace.md).
// Delete this file with the rest of it.
//
// What the server puts on the wire about one round it fired. The socket is not
// under test — `Match` is drivable without one, and `shotTracePacket` is a free
// function precisely so that the mapping can be checked against a real
// `FiredShot` rather than against a literal somebody typed.
//
// The fixture is deliberately not a round number anywhere: the shot is fired at
// a yaw and pitch that are unequal and of opposite sign, and the body reports a
// hit at a distance that is neither the range nor zero — so a packet that sent
// the wrong field, or the range where the hit was, is a different number.

import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { ResolvedWorld } from "@3d/shared/dsl/resolved.js";
import { catalogueViewOf } from "@3d/shared/game/catalogueView.js";
import type { CastChoice } from "@3d/shared/game/cast.js";
import { defaultGametype } from "@3d/shared/game/gametypes/default.js";
import type { Script } from "@3d/shared/game/hooks.js";
import type { PlayerId } from "@3d/shared/net/messages/fields.js";
import type { InputMessage } from "@3d/shared/net/messages/input.js";
import { shotTraceMessage } from "@3d/shared/net/messages/shotTrace.js";
import { BitReader, BitWriter } from "@3d/shared/net/codec/bits.js";
import { idleInput, type PlayerInput } from "@3d/shared/sim/input.js";
import type { Loadout } from "@3d/shared/sim/loadout.js";
import { createMovement } from "@3d/shared/sim/movement.js";
import type { HitLocation } from "@3d/shared/sim/hitLocations.js";
import { CATALOG_VERSION, WeaponRegistry, type WeaponEntry } from "@3d/shared/sim/weaponRegistry.js";
import { weaponDef } from "@3d/shared/testing/weaponDef.js";
import type { BodyView, LoadedBody } from "../src/bodies.js";
import { config } from "../src/config.js";
import { Match } from "../src/match/match.js";
import type { FiredShot } from "../src/match/shots.js";
import { BULLET_RANGE as SHOT_RANGE } from "@3d/shared/sim/weaponDef.js";
import { shotTracePacket } from "../src/shotTrace.js";

const TICK_RATE = 60;
const DT = 1 / TICK_RATE;
const GAME = "iw5";
const ARMED = "iw5/test_mp";

/** Where the stub body says the round stopped. Neither zero nor the range. */
const HIT_AT = 17.25;

const ground = {
  ready: true,
  resolveCapsule: (
    position: { x: number; y: number; z: number },
    _r: number,
    _h: number,
    out?: { position: { x: number; y: number; z: number }; grounded: boolean },
  ) => {
    const result = out ?? { position: { x: 0, y: 0, z: 0 }, grounded: false };
    result.position = { ...position, y: Math.max(position.y, 0) };
    result.grounded = position.y <= 0;
    return result;
  },
  overlapsCapsule: (position: { y: number }) => position.y < 0,
  groundBelow: (from: { y: number }, distance: number) => (from.y >= 0 && from.y - distance <= 0 ? 0 : null),
  // Nothing here has a surface; a flat test floor is `default` either way.
  surfaceAt: () => null,
  traceRay: () => null,
};

function world(): ResolvedWorld {
  return {
    game: GAME,
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
}

function registry(): WeaponRegistry {
  const entries: WeaponEntry[] = [
    { id: "test_mp", game: GAME, slot: "primary", class: "rifle", def: weaponDef({ clipSize: 30, locationDamage: { torsoUpper: 0.8 } }), attachments: [] },
  ];
  return new WeaponRegistry(entries);
}

function carrying(): Loadout {
  return { name: "Test", game: "iw5", primary: { weapon: ARMED, attachments: [] }, secondary: { weapon: null, attachments: [] } };
}

/** One body for everybody, reporting a hit where this file asked for one, or nothing at all. */
function stubBodies(location: HitLocation | null): BodyView {
  const body = {
    id: "dummy",
    game: GAME,
    rig: { root: new THREE.Object3D() },
    poser: { update: () => undefined },
    boxes: { trace: () => (location === null ? null : { bone: "j_spine4", location, fraction: HIT_AT / SHOT_RANGE }) },
  } as unknown as LoadedBody;
  return { get: () => body };
}

const CAST: CastChoice = {
  characters: [{ id: "dummy", body: { kind: "characters", game: GAME, id: "dummy", file: "dummy.glb" } }],
  animations: { kind: "animations", game: GAME, id: "clips", file: "clips.glb" },
  hands: { kind: "hands", game: GAME, id: "hands", file: "hands.glb" },
  defaultWeapon: null,
};

/** Fire one round from `a` at `b` and hand back what the replay recorded. */
function fireOne(hits: HitLocation | null): FiredShot {
  const script: Script = { id: "test", server: {}, client: { cast: () => CAST } };
  const match = new Match(ground, world(), TICK_RATE, 8, registry(), {
    map: "dome-mw3",
    gametype: defaultGametype,
    catalogue: catalogueViewOf({ version: CATALOG_VERSION }, new WeaponRegistry([])),
    bodies: stubBodies(hits),
    scripts: [script],
  });
  const players: PlayerId[] = ["a", "b"];
  for (const id of players) {
    match.join(id, carrying());
  }

  // Not level and not on an axis, so a packet that mixed the direction's
  // components up is a different vector rather than the same one.
  const firing: PlayerInput = { ...idleInput(0.9, -0.35), fire: true };
  let seq = 0;
  for (let i = 0; i < 200; i++) {
    for (const id of players) {
      const message: InputMessage = {
        seq: ++seq,
        dt: DT,
        input: id === "a" ? firing : idleInput(0, 0),
        claim: createMovement({ x: 0, y: 0, z: 0 }, 0, 0),
        renderTick: 0,
        renderFrac: 0,
      };
      match.receive(id, message);
    }
    match.step();
    if (match.shotsThisTick.length > 0) {
      return { ...match.shotsThisTick[0]! };
    }
  }
  throw new Error("nothing was fired in 200 ticks");
}

describe("what the server says about a round it fired", () => {
  it("is off unless SHOT_TRACE is set, and nothing in the test environment sets it", () => {
    // The whole cost of the diagnostic on a production fleet is this boolean.
    expect(config.shotTrace).toBe(false);
  });

  it("carries the shot's own ordinal, origin, direction and what it met", () => {
    const shot = fireOne("torsoUpper");
    const packet = shotTracePacket(shot);

    expect(packet.ordinal).toBe(shot.ordinal);
    expect(packet.ordinal).toBeGreaterThan(0);
    expect(packet.from).toEqual(shot.from);
    expect(packet.direction).toEqual(shot.direction);
    // The direction is the shot's, not a placeholder: three different components,
    // none of them zero, and a unit vector.
    expect(Math.hypot(packet.direction.x, packet.direction.y, packet.direction.z)).toBeCloseTo(1, 12);
    expect(new Set([packet.direction.x, packet.direction.y, packet.direction.z]).size).toBe(3);

    expect(packet.met).toBe("player");
    expect(packet.target).toBe("b");
    expect(packet.distance).toBeCloseTo(HIT_AT, 6);
  });

  it("reports a clean miss at the weapon's whole range, which a hit marker cannot", () => {
    const shot = fireOne(null);
    expect(shot.result).toBeNull();

    const packet = shotTracePacket(shot);
    expect(packet.met).toBe("none");
    expect(packet.target).toBeNull();
    expect(packet.distance).toBeCloseTo(SHOT_RANGE, 6);
    // And it is the range, not zero and not some other constant.
    expect(packet.distance).toBeGreaterThan(200);
  });

  it("survives the wire it is going to be sent over", () => {
    const packet = shotTracePacket(fireOne("torsoUpper"));
    const w = new BitWriter();
    shotTraceMessage.write(w, packet);
    const back = shotTraceMessage.read(new BitReader(w.finish()));

    expect(back.ordinal).toBe(packet.ordinal);
    expect(back.met).toBe(packet.met);
    expect(back.target).toBe(packet.target);
    expect(back.distance).toBeCloseTo(packet.distance, 4);
    expect(back.direction.x).toBeCloseTo(packet.direction.x, 6);
    expect(back.direction.y).toBeCloseTo(packet.direction.y, 6);
    expect(back.direction.z).toBeCloseTo(packet.direction.z, 6);
  });
});
