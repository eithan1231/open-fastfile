// What crosses the wire to create a physics entity, and to end one early.
//
// The layer is general (`sim/entityKinds.ts`) and so is this: a spawn names a kind
// and carries that kind's own payload, so a grenade is an entry in the table plus a
// branch here rather than a new message. Only one kind exists today.
//
// -- Why the pose is sent at all ----------------------------------------------
//
// Every end runs the same simulation, so the only thing that has to travel is the
// initial conditions — but they have to travel *exactly*. `CharacterPoser` is a pure
// function of a snapshot and agrees between two machines to a nanometre
// (docs/engine/rendering.md#player-characters), which is worth a great deal for a
// hit box and nothing at all for a contact-rich rigid-body sim: a nanometre of
// initial condition is a different pile of bodies a second later. And the pose is
// downstream of `Quaternion.slerp`, which is `acos` and `sin`, both of which
// Rapier's own documentation names as not cross-platform deterministic.
//
// So the pose is **sent quantised, and every end simulates the value it decoded —
// the server included**. `roundRagdollSpawn` is that rule as a function, and it is
// the same discipline `roundInput` already states for a player's input in
// net/packet.ts. It is also why the rotations are in world space rather than joint
// local: a quantisation error in a local rotation is amplified by every joint below
// it, and a hand would end up a hand's width from where the next client put it.

import { quant, struct, uint, type Codec, type Quat } from "../codec/schema.js";
import { RAGDOLL_SEGMENTS } from "../../sim/ragdollBones.js";
import { metres, playerId, quat, type PlayerId } from "./fields.js";
import type { Vec3 } from "../../sim/movement.js";

/**
 * How fast a corpse is thrown at the moment it becomes one, m/s.
 *
 * A sprinting player does about 6 and nothing in the game launches a body, so 20
 * is generous. Twelve bits is a centimetre a second, well under what a first frame
 * can show.
 */
export const speed = quant(-20, 20, 12);

/**
 * A push, newton-seconds, one component.
 *
 * Carried as a vector rather than as a direction and a magnitude, which halves the
 * arithmetic and removes the one genuinely awkward step — a quantised unit vector
 * is no longer unit, and renormalising it is a `sqrt` both ends would have to agree
 * on. 400 N·s clears anything a rifle does to a 72 kg body by a wide margin.
 */
export const impulseAxis = quant(-400, 400, 12);

const vec3Speed = struct({ x: speed, y: speed, z: speed });
const vec3Impulse = struct({ x: impulseAxis, y: impulseAxis, z: impulseAxis });
const vec3Metres = struct({ x: metres, y: metres, z: metres });

/** Everything needed to build the same corpse on every machine. */
export interface RagdollSpawn {
  /** Whose body it was. Names the character they were wearing, and the kill feed's subject. */
  victim: PlayerId;
  /** The pelvis, world metres. Every other segment follows from the skeleton's own offsets. */
  origin: Vec3;
  /** One world rotation per segment, in `RAGDOLL_SEGMENTS` order. The order is a format. */
  rotations: Quat[];
  /** What the player was doing when they stopped. Every segment starts with it, unweighted. */
  velocity: Vec3;
  /**
   * What the round did to the body as a whole, m/s along the round.
   *
   * Separate from `velocity` rather than folded into it, because the two are shared
   * out differently: a player's own momentum belongs to every segment equally,
   * while the round's knock is weighted by height so the corpse topples about its
   * feet instead of sliding (`physics/ragdoll.ts`'s `knockWeights`). Folded
   * together there is no way to weight one and not the other, and a corpse then
   * falls whichever way its last animation frame happened to lean.
   */
  knock: Vec3;
  /** Which segment the killing round landed on: an index into `RAGDOLL_SEGMENTS`. */
  segment: number;
  /** The push, at that segment, in newton-seconds. Zero for a death no round caused. */
  impulse: Vec3;
}

/**
 * Sixteen rotations, and the length is not on the wire.
 *
 * `array` would spend eight bits saying "sixteen" on every death. The count is a
 * property of the build — `RAGDOLL_SEGMENTS.length` — and a packet that disagreed
 * with it is a protocol mismatch, which `PROTOCOL_VERSION` already refuses.
 */
const rotations: Codec<Quat[]> = {
  write(w, value) {
    for (let i = 0; i < RAGDOLL_SEGMENTS.length; i++) {
      quat.write(w, value[i] ?? { x: 0, y: 0, z: 0, w: 1 });
    }
  },
  read(r) {
    const out: Quat[] = [];
    for (let i = 0; i < RAGDOLL_SEGMENTS.length; i++) {
      out.push(quat.read(r));
    }
    return out;
  },
  round(value) {
    return value.map((one) => quat.round!(one));
  },
};

export const ragdollSpawn: Codec<RagdollSpawn> = struct({
  victim: playerId,
  origin: vec3Metres,
  rotations,
  velocity: vec3Speed,
  knock: vec3Speed,
  // Four bits for sixteen segments. `RAGDOLL_SEGMENTS` may not grow past 16
  // without widening this, which `netEntities.test.ts` asserts rather than hopes.
  segment: uint(4),
  impulse: vec3Impulse,
});

/**
 * A spawn as every end will actually see it.
 *
 * Nothing simulates a spawn it has not put through this, the server included: that
 * is what makes both ends' initial conditions the same numbers rather than the same
 * intention. `origin` is `f32` and already exact, so it passes through untouched —
 * the same exemption `net/packet.ts` grants a player's position for the same reason.
 */
export function roundRagdollSpawn(spawn: RagdollSpawn): RagdollSpawn {
  return ragdollSpawn.round ? ragdollSpawn.round(spawn) : spawn;
}

/** How many segments a spawn may describe before `segment` needs more bits. */
export const MAX_SEGMENTS_ON_THE_WIRE = 16;
