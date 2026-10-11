// How a player moves, as one step function over plain state: the same state and
// input give the same result on a client and on a server.
//
// This file is the step: what every move has in common (the view, the jump
// key's edge, the sprint, the pose clocks) and which move owns the rest of it.
// The moves are sim/moves/ — the walk, a mantle (on rails) and a ladder
// (steered) — the state they advance is sim/movementState.ts, and what a step
// is given with it is sim/movementEnv.ts. docs/engine/player.md has all of it.

import type { CapsuleWorld, Vec3 } from "./capsule.js";
import { advanceBlends, advanceStride } from "./gait.js";
import type { PlayerInput } from "./input.js";
import { checkLadder, climbLadder, jumpOffLadder, ladderYaw } from "./moves/ladder.js";
import { advanceMantle, startMantle } from "./moves/mantle.js";
import { walk } from "./moves/walk.js";
import type { Carry, MovementEnv } from "./movementEnv.js";
import { clampPitch, JUMP_REPEAT, type MovementState } from "./movementState.js";

export type { CapsuleWorld, Vec3 };
// The body, the state and the step's surroundings are what nearly every reader of a step wants with it.
export * from "./movementState.js";
export * from "./movementEnv.js";

/**
 * Whether the step `input` asks of `s` is a sprint, as far as the keys and the
 * move go: the one sprint rule, which the walk, the weapon and the pose all
 * read. Run held while pushing forward, and neither the jump key down nor a
 * jump under way — a jump ends a sprint at its takeoff, and the ground under
 * a held run key starts it again.
 */
export function wantsSprint(s: Readonly<MovementState>, input: PlayerInput): boolean {
  return input.run && input.forward > 0 && !input.jump && s.move.kind === "walk" && s.jumpFrom === null;
}

/**
 * Advance `s` by `dt` seconds of `input`, in `env`. `carry` is the held
 * weapon's say: it pauses a sprint to reload, aim or fire.
 */
export function stepMovement(s: MovementState, input: PlayerInput, dt: number, env: MovementEnv, carry: Carry): void {
  // Looking is allowed mid-climb and nothing else is. The view is absolute in
  // the input either way, so refusing it here would only make the client's
  // camera fight the mouse for the length of the mantle.
  s.yaw = input.yaw;
  s.pitch = clampPitch(input.pitch);
  const pressed = input.jump && !s.jumpHeld;
  s.jumpHeld = input.jump;
  s.sinceJump = Math.min(JUMP_REPEAT, s.sinceJump + dt);
  // Before any move below, and from the state the step *starts* from, so every
  // path advances them exactly once and a replay reaches the same phase.
  const sprinting = wantsSprint(s, input) && carry.sprint;
  advanceStride(s, dt, env.body.runSpeed);
  advanceBlends(s, dt);

  if (s.move.kind === "mantle") {
    advanceMantle(s, s.move, dt);
    return;
  }

  s.yaw = ladderYaw(s, s.yaw);
  if (s.grounded) {
    s.ladderLock = false;
  }
  checkLadder(s, input, env);
  let jump = pressed;
  if (s.move.kind === "ladder") {
    // A jump on a ladder is a new press, not a held key: holding jump up a
    // ladder must not throw the player off it the moment the repeat allows.
    if (!pressed || s.sinceJump < JUMP_REPEAT) {
      climbLadder(s, s.move, input, dt, env);
      return;
    }
    // The rest of this step is the air move the game runs after one, with
    // nothing left of the press to climb a ledge or jump again with.
    jumpOffLadder(s, s.move);
    jump = false;
  } else if (input.jump) {
    // Before the jump, and for as long as the key is down: a press into a
    // ledge climbs it rather than jumping at it, and so does a jump held into
    // one. Not gated on the ground — the volume says whether there is a climb.
    const target = env.mantles.find(s.feet, s.yaw, env.body, env.world);
    if (target) {
      startMantle(s, target);
      return;
    }
  }

  walk(s, input, dt, env, jump, sprinting);
}
