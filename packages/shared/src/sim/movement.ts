// How a player moves: walking, running, jumping and falling, with a capsule
// that keeps them out of walls. One step function over plain state, so the same
// state and input give the same result on a client and on a server.
//
// Movement is Quake's, which CoD inherits: the keys never set the velocity.
// Friction bleeds it off on the ground, and acceleration adds, per second, a
// share of the walk or run speed along the held direction, never past that
// speed. So a landing carries its speed in, and letting go skids to a stop.
//
// This file is the step and the walk. The state it advances is
// sim/movementState.ts; every free step ends in sim/stepSlide.ts, which moves
// the capsule and keeps it out of the world; the pose clocks are sim/gait.ts.
//
// Two moves replace walking for a while: a mantle (on rails, sim/mantle.ts) and
// a ladder (steered, sim/ladder.ts). docs/engine/player.md has both.

import type { CapsuleWorld, Vec3 } from "./capsule.js";
import { advanceBlends, advanceStride } from "./gait.js";
import { wantsSprint, type PlayerInput } from "./input.js";
import { checkLadder, climbLadder, JUMP_OFF_REPEAT, jumpOffLadder, ladderYaw, NO_LADDERS, type LadderVolumes } from "./ladder.js";
import { advanceMantle, NO_MANTLES, startMantle, type MantleVolumes } from "./mantle.js";
import { clampPitch, JUMP_MEMORY, JUMP_SPEED, PLAYER_MOVEMENT, type MovementParams, type MovementState } from "./movementState.js";
import { integrate, LAND_RECOVERY } from "./stepSlide.js";

export type { CapsuleWorld, Vec3 };
// The body and the state are what nearly every reader of a step wants with it.
export * from "./movementState.js";

// -- Walking and running (Quake's values in brackets) ------------------------------

/** Per second, this many times the target speed is added on the ground [10]. */
const GROUND_ACCEL = 10;
/** The same in the air, where the keys only nudge and letting go keeps the takeoff's speed [1]. */
const AIR_ACCEL = 0.5;
/** Per second, this share of the speed is lost on the ground [6]. */
const FRICTION = 6;
/**
 * Friction works on at least this speed, m/s, so a slow drift still stops quickly
 * [100 units] — or on the body's walk speed, if that is lower: against a floor of
 * 2.5 m/s the keys cannot hold anything under 1.5 m/s, and a slow body never moves.
 */
const STOP_SPEED = 2.5;

// -- Jumping and landing -----------------------------------------------------------

export const GRAVITY = 18; // m/s²
/** Seconds a jump press still waits for the ground to come: the other half of COYOTE_TIME's forgiveness. */
const JUMP_BUFFER = 0.15; // s
/**
 * Landing from a jump (not a fall) lowers the speed the keys accelerate to
 * (CoD's `jump_slowdownEnable`) to LAND_SLOWDOWN of it, recovering linearly over
 * LAND_RECOVERY, and raises friction to LAND_FRICTION so the landing slides
 * less. LAND_FRICTION must not pass GROUND_ACCEL, or the keys cannot hold full
 * speed against it.
 */
const LAND_SLOWDOWN = 0.5;
const LAND_FRICTION = 10;

// -- The step ----------------------------------------------------------------------

/**
 * Advance `s` by `dt` seconds of `input`. Running needs the sprint rule
 * (input.ts) and `sprintAllowed`, the held weapon's say: it pauses a sprint to
 * reload, aim or fire. `body` is the capsule and the speeds, a player's unless
 * an actor's kind says otherwise.
 */
export function stepMovement(
  s: MovementState,
  input: PlayerInput,
  dt: number,
  world: CapsuleWorld,
  sprintAllowed: boolean,
  mantles: MantleVolumes = NO_MANTLES,
  ladders: LadderVolumes = NO_LADDERS,
  body: MovementParams = PLAYER_MOVEMENT,
): void {
  // Looking is allowed mid-climb and nothing else is. The view is absolute in
  // the input either way, so refusing it here would only make the client's
  // camera fight the mouse for the length of the mantle.
  s.yaw = input.yaw;
  s.pitch = clampPitch(input.pitch);
  const pressed = input.jump && !s.jumpHeld;
  s.jumpHeld = input.jump;
  s.sinceJump = Math.min(JUMP_MEMORY, s.sinceJump + dt);
  // Before any branch below returns, and from the state the step *starts* from,
  // so every path advances it exactly once and a replay of the same input
  // reaches the same phase.
  advanceStride(s, dt, body.runSpeed);
  advanceBlends(s, dt);

  if (s.mantle) {
    advanceMantle(s, dt);
    return;
  }

  s.yaw = ladderYaw(s, s.yaw);
  if (s.grounded) {
    s.ladderLock = false;
  }
  checkLadder(s, input, ladders, body);
  // A jump on a ladder is a new press, not a held key: holding jump up a ladder
  // must not throw the player off it the moment the repeat allows.
  const jumpOff = s.ladder !== null && pressed && s.sinceJump >= JUMP_OFF_REPEAT;
  if (s.ladder && !jumpOff) {
    s.jumpBuffer = 0;
    climbLadder(s, input, dt, world, body);
    return;
  }
  if (jumpOff) {
    // The rest of this step is the air move the game runs after one, with
    // nothing left of the press to climb a ledge or jump again with.
    jumpOffLadder(s);
  }

  // A press is latched before the mantle check, so a jump *into* a ledge climbs
  // it rather than jumping at it. Deliberately not gated on being grounded: in
  // the games a mantle can start from a jump or a fall, and the volume is what
  // says whether there is anything to climb.
  if (input.jump && !jumpOff) {
    s.jumpBuffer = JUMP_BUFFER;
  }
  if (s.jumpBuffer > 0) {
    const target = mantles.find(s.feet, s.yaw, body, world);
    if (target) {
      startMantle(s, target);
      return;
    }
  }

  // The coyote window counts as ground, for the keys as for a jump.
  const onGround = s.coyote > 0;
  const wish = wishVelocity(s, input, wantsSprint(input) && sprintAllowed, body);
  if (onGround) {
    applyFriction(s.velocity, s.landing > 0 ? LAND_FRICTION : FRICTION, dt, Math.min(STOP_SPEED, body.walkSpeed));
  }
  accelerate(s.velocity, wish, onGround ? GROUND_ACCEL : AIR_ACCEL, dt);

  if (s.jumpBuffer > 0 && onGround) {
    s.velocity.y = JUMP_SPEED;
    s.jumpBuffer = 0;
    s.coyote = 0; // spent, or one takeoff jumps twice
    s.jumped = true;
    s.sinceJump = 0;
    s.grounded = false; // off the ground from here: a takeoff does not step
  } else {
    s.jumpBuffer = Math.max(0, s.jumpBuffer - dt);
  }

  s.velocity.y -= GRAVITY * dt;
  integrate(s, dt, world, s.grounded, body);
}

/** Where `wishVelocity` writes: one step reads it immediately and keeps nothing. */
const wishScratch = { x: 0, z: 0 };

/** The velocity the keys ask for: along the held direction, at walk or run speed, less any landing slowdown. */
function wishVelocity(s: MovementState, input: PlayerInput, running: boolean, body: MovementParams): { x: number; z: number } {
  const sin = Math.sin(s.yaw);
  const cos = Math.cos(s.yaw);
  // Yaw 0 faces -Z, so forward is (-sin, -cos) and right (cos, -sin).
  const x = -sin * input.forward + cos * input.right;
  const z = -cos * input.forward - sin * input.right;
  const slowdown = 1 - ((1 - LAND_SLOWDOWN) * s.landing) / LAND_RECOVERY;
  // A diagonal is no faster than straight ahead.
  const scale = ((running ? body.runSpeed : body.walkSpeed) * slowdown) / Math.max(1, Math.hypot(x, z));
  wishScratch.x = x * scale;
  wishScratch.z = z * scale;
  return wishScratch;
}

/** Take friction × max(speed, stop) × dt off the speed along the ground, stopping at zero. */
function applyFriction(v: Vec3, friction: number, dt: number, stop: number): void {
  const speed = Math.hypot(v.x, v.z);
  if (speed === 0) {
    return;
  }
  const scale = Math.max(0, speed - Math.max(speed, stop) * friction * dt) / speed;
  v.x *= scale;
  v.z *= scale;
}

/** Add up to accel × |wish| × dt towards `wish`, never passing its speed along its direction. */
function accelerate(v: Vec3, wish: { x: number; z: number }, accel: number, dt: number): void {
  const wishSpeed = Math.hypot(wish.x, wish.z);
  if (wishSpeed === 0) {
    return;
  }
  const dx = wish.x / wishSpeed;
  const dz = wish.z / wishSpeed;
  const room = wishSpeed - (v.x * dx + v.z * dz);
  if (room <= 0) {
    return;
  }
  const add = Math.min(accel * wishSpeed * dt, room);
  v.x += add * dx;
  v.z += add * dz;
}
