// Where a player may look. The view is absolute in the input, so a rule that
// holds it — a ladder's, a lying body's — is a function of the state that both
// the step and the camera ask: the step of the input's angles, and the camera
// of the mouse movement no step has spent yet, so it stops at the limit rather
// than swinging past it and back. The games write the overshoot into the
// view's delta angles for the same effect.

import { ladderYaw } from "./moves/ladder.js";
import type { MovementEnv } from "./movementEnv.js";
import { clampPitch, type MovementState } from "./movementState.js";
import { pronePitch, proneYaw } from "./stance.js";

/** The yaw a player in state `s` may look along, asked for `yaw`: what the move under way and the stance leave of it. */
export function capYaw(s: Readonly<MovementState>, yaw: number, env: MovementEnv): number {
  if (s.move.kind === "ladder") {
    return ladderYaw(s, yaw);
  }
  if (s.stance.kind === "prone") {
    return proneYaw(s, s.stance, yaw, env);
  }
  return yaw;
}

/** The same for the pitch. */
export function capPitch(s: Readonly<MovementState>, pitch: number): number {
  return clampPitch(s.stance.kind === "prone" ? pronePitch(s.stance, pitch) : pitch);
}
