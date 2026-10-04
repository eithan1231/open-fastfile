// An actor on the wire: 96 bits, against a player's several hundred.
//
// What makes a horde affordable. A client does not predict an actor, so nothing
// here has to reproduce a simulation step: it is drawn, interpolated between two
// snapshots like a peer, and posed from its action and phase (game/actors/pose.ts).
// So the position is quantised rather than a player's f32s — a sixty-fourth of a
// metre is finer than anyone can see on a body drawn a tick late.

import { angle, enumOf, quant, struct, uint, type Codec } from "../codec/schema.js";
import { ACTOR_ACTIONS, ACTOR_GAITS, type ActorAction, type ActorGait, type ActorState } from "../../game/actors/actor.js";
import { MAX_ACTOR_KINDS } from "../../game/actors/kinds.js";
import type { Vec3 } from "../../sim/movement.js";

/**
 * How far from the origin an actor can be placed, m. The imported maps reach
 * about 460 m across and 100 m up; past these an actor is drawn at the edge
 * (`quant` clamps) while the server goes on simulating it where it is.
 */
export const ACTOR_REACH = 1024;
export const ACTOR_HEIGHT_REACH = 256;
/** m/s. No kind runs near this (a sprinter's clip is 3.6); a faster one is drawn at it. */
export const ACTOR_SPEED_MAX = 8;

/** 17 + 15 + 17 bits: 1/64 m across and up. */
const actorFeet: Codec<Vec3> = struct({
  x: quant(-ACTOR_REACH, ACTOR_REACH, 17),
  y: quant(-ACTOR_HEIGHT_REACH, ACTOR_HEIGHT_REACH, 15),
  z: quant(-ACTOR_REACH, ACTOR_REACH, 17),
});

/**
 * 16 id + 4 kind + 49 feet + 8 yaw + 2 gait + 3 action + 6 speed + 8 phase = 96
 * bits, exactly twelve bytes, so a snapshot's actors never shift what follows them
 * off a byte boundary. `dead` is not sent: it is exactly `action === "die"`.
 *
 * **The speed's six bits carry the traversal clip while a body traverses.** A
 * speed only fades a moving body into its gait, which a traverse never reads, and
 * which clip a traverse plays is exactly what the client cannot see for itself —
 * the link is the server's. So the action goes first, and says which it is.
 */
const head = struct({
  id: uint(16),
  kind: uint(Math.log2(MAX_ACTOR_KINDS)),
  feet: actorFeet,
  /** 1.4°: a body turned a tick late, not an aim. */
  yaw: angle(8),
  gait: enumOf(ACTOR_GAITS) as Codec<ActorGait>,
  action: enumOf(ACTOR_ACTIONS) as Codec<ActorAction>,
});
/** 0.13 m/s: it only fades a body standing up into its gait. */
const speed = quant(0, ACTOR_SPEED_MAX, 6);
const traversal = uint(6);
const phase = quant(0, 1, 8);

/** The most traversal clips a set can hold for the wire to name one: `traversal` is 1-based in six bits. */
export const MAX_TRAVERSAL_CLIPS = 63;

export const actorStateSchema: Codec<ActorState> = {
  write: (w, state) => {
    head.write(w, state);
    if (state.action === "traverse") {
      traversal.write(w, Math.min(state.traversal, MAX_TRAVERSAL_CLIPS));
    } else {
      speed.write(w, state.speed);
    }
    phase.write(w, state.phase);
  },
  read: (r) => {
    const h = head.read(r);
    const traversing = h.action === "traverse";
    const moved = traversing ? 0 : speed.read(r);
    const clip = traversing ? traversal.read(r) : 0;
    return { ...h, speed: moved, traversal: clip, phase: phase.read(r), dead: h.action === "die" };
  },
};

/**
 * The most actors one snapshot carries. 64 × 12 bytes is 768, beside a handful of
 * players' states in one datagram. Past it the server sends each client the ones
 * nearest them (`Match.snapshotFor`).
 */
export const MAX_SNAPSHOT_ACTORS = 64;
