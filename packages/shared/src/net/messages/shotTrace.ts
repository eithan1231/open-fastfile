// SHOTTRACE — a temporary diagnostic. The whole of it is listed in
// docs/engine/diagnostics-shottrace.md, whose last section is how to remove it.
//
// The server's own account of one round it fired, sent to the player who fired
// it and to nobody else. It exists so a client can draw the server's answer
// beside its own and show where the two disagree — which is almost always the
// rewind: the server judges a peer at the moment the shooter was drawing them,
// and the client draws them interpolated one tick behind the newest snapshot.
//
// **Not an entry in the snapshot's event tail**, and the reason is not size. The
// tail carries at most seven events on a documented byte budget, and the one
// event a shot already produces (`HitEvent`) fires only where health actually
// fell — so a miss, which is the case worth looking at here, produces nothing at
// all. A message of its own costs the quiet snapshot nothing.
//
// Unreliable, like the two other hot-path messages: a lost diagnostic packet is
// a line that is not drawn, never a line drawn wrongly.

import { enumOf, struct, uint, type Codec } from "../codec/schema.js";
import { metres, vec3 } from "./fields.js";
import type { Vec3 } from "../../sim/movement.js";

/** What the round met. `none` is a bullet that reached its range through open air. Appended: still two bits. */
const SHOT_TRACE_MET = ["none", "world", "player", "actor"] as const;
export type ShotTraceMet = (typeof SHOT_TRACE_MET)[number];

export interface ShotTraceMessage {
  /**
   * `WeaponData.fired` after this round left — which shot of this weapon's life
   * it was. This is what pairs the server's answer with the client's own trace
   * of the same round, and it has to: a burst puts several traces in flight at
   * once over an unreliable channel, and pairing by arrival order would draw one
   * round's divergence against another's.
   */
  ordinal: number;
  /** The eye it left, and the unit vector it went along. Full floats: this is a measurement, not state to predict. */
  from: Vec3;
  direction: Vec3;
  /** Metres travelled. The weapon's whole range where `met` is `none`. */
  distance: number;
  met: ShotTraceMet;
}

export const shotTraceMessage = struct({
  ordinal: uint(16),
  from: vec3,
  direction: vec3,
  distance: metres,
  met: enumOf(SHOT_TRACE_MET),
}) satisfies Codec<ShotTraceMessage>;
