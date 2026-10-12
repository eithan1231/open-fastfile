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
import { checkLadder, climbLadder, jumpOffLadder } from "./moves/ladder.js";
import { advanceMantle, mantleStows, startMantle } from "./moves/mantle.js";
import { walk } from "./moves/walk.js";
import type { Carry, MovementEnv } from "./movementEnv.js";
import { JUMP_REPEAT, type Move, type MovementState, type StanceKind } from "./movementState.js";
import { advanceEye, followSlope, standFits, stepStance, turnBody } from "./stance.js";
import { capPitch, capYaw } from "./view.js";

export type { CapsuleWorld, Vec3 };
// The body, the state and the step's surroundings are what nearly every reader of a step wants with it.
export * from "./movementState.js";
export * from "./movementEnv.js";

/**
 * Whether the step `input` asks of `s` is a sprint, as far as the keys and the
 * move go: the one sprint rule, which the walk, the weapon and the pose all
 * read. Run held while pushing forward, and neither the jump key down nor a
 * jump under way — a jump ends a sprint at its takeoff, and the ground under
 * a held run key starts it again. A sprint is run standing: asking to crouch
 * or lie down ends one, and one from either needs the head room to stand in.
 */
export function wantsSprint(s: Readonly<MovementState>, input: PlayerInput, env: MovementEnv): boolean {
  if (!input.run || input.forward <= 0 || input.jump || input.crouch || input.prone) {
    return false;
  }
  return s.move.kind === "walk" && s.jumpFrom === null && (s.stance.kind === "stand" || standFits(s, env));
}

/**
 * Whether `move` takes the weapon out of the hands for as long as it lasts: a
 * ladder does, and a mantle onto all but the lowest ledges. The one rule a
 * holder of a weapon reads (sim/player.ts).
 */
export function stowsWeapon(move: Readonly<Move>): boolean {
  return move.kind === "ladder" || (move.kind === "mantle" && mantleStows(move));
}

/**
 * Advance `s` by `dt` seconds of `input`, in `env`. `carry` is the held
 * weapon's say: it pauses a sprint to reload, aim or fire, and holds a lying
 * body still.
 *
 * Returns the stance the step held the player to against their keys, or null
 * (`stepStance`): what whoever turns a key into `crouch` and `prone` follows.
 */
export function stepMovement(s: MovementState, input: PlayerInput, dt: number, env: MovementEnv, carry: Carry): StanceKind | null {
  // The view first, as far as the move and the stance allow it (sim/view.ts).
  const lying = s.stance.kind === "prone" ? s.stance : null;
  const still = lying !== null && carry.braced;
  if (lying) {
    turnBody(s, lying, input.yaw, !still && (input.forward !== 0 || input.right !== 0), input.prone, dt, env);
  }
  s.yaw = capYaw(s, input.yaw, env);
  if (lying) {
    followSlope(s, lying, dt, env);
  }
  s.pitch = capPitch(s, input.pitch);
  const pressed = input.jump && !s.jumpHeld;
  s.jumpHeld = input.jump;
  s.sinceJump = Math.min(JUMP_REPEAT, s.sinceJump + dt);
  // Before any move below, and from the state the step *starts* from, so every
  // path advances them exactly once and a replay reaches the same phase.
  const sprinting = wantsSprint(s, input, env) && carry.sprint;
  advanceStride(s, dt, env.body);
  advanceBlends(s, dt);

  if (s.move.kind === "mantle") {
    // On rails, and the stance with it: only the eye finishes what it was doing.
    advanceEye(s, dt, s.stance.kind);
    return advanceMantle(s, s.move, dt, env);
  }

  // A jump is made standing. Pressed ducked, the key stands the player up
  // instead, and nothing is left of the press to jump with once they are.
  let jump = pressed && s.stance.kind === "stand";
  const forced = stepStance(s, input, dt, env, sprinting, pressed);

  if (s.grounded) {
    s.ladderLock = false;
  }
  // A mantle is asked for every step the key is down, pressed or held, before
  // the ladder and the jump: on the ground, in the air or on a ladder, by a
  // body standing with its eye at rest. Its first step is this one.
  if (input.jump && s.stance.kind === "stand" && s.eyeShift === null) {
    const found = env.mantles.find(s.feet, s.yaw, env.body, env.world);
    if (found) {
      return advanceMantle(s, startMantle(s, found, dt), dt, env) ?? forced;
    }
  }
  checkLadder(s, input, env);
  if (s.move.kind === "ladder") {
    // A jump on a ladder is a new press, not a held key: holding jump up a
    // ladder must not throw the player off it the moment the repeat allows.
    if (!jump || s.sinceJump < JUMP_REPEAT) {
      climbLadder(s, s.move, input, dt, env);
      return forced;
    }
    // The rest of this step is the air move the game runs after one, with
    // nothing left of the press to jump again with.
    jumpOffLadder(s, s.move);
    jump = false;
  }

  walk(s, input, dt, env, jump, sprinting, still);
  return forced;
}
