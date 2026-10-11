// The walk: the move a player is in unless a climb or a ladder has taken over.
// Walking, sprinting, jumping, landing and falling.
//
// The keys never set the velocity. Friction bleeds it off on the ground, and
// acceleration adds towards a speed along the held direction, never past it —
// so a landing carries its speed in, and letting go skids to a stop. Every
// number is the games' own, in their units: reverse/iw5-pmove/ has each one.
//
// Every walk step ends in sim/stepSlide.ts, which moves the capsule, keeps it
// out of the world and says whether it ends on the ground.

import type { Vec3 } from "../capsule.js";
import type { PlayerInput } from "../input.js";
import type { MovementEnv } from "../movementEnv.js";
import { GRAVITY, JUMP_REPEAT, JUMP_SPEED, LAND_WINDOW, LAND_WINDOW_HIGH, type MovementState } from "../movementState.js";
import { airSlide, alongGround, groundSlide, groundWithin, standing, STEP_HEIGHT } from "../stepSlide.js";
import { UNIT } from "../units.js";

// -- Walking and sprinting ---------------------------------------------------------

/** Sideways and backward, as shares of the speed forward. A diagonal is no faster than its faster key. */
const STRAFE_SCALE = 0.8;
const BACK_SCALE = 0.7;
/** In a sprint the strafe keys count for this much, so a sprint curves rather than strafes. */
const SPRINT_STRAFE_SCALE = 0.667;
/** Per second, this many times the speed asked for — or STOP_SPEED, if that is more — is added on the ground. */
const GROUND_ACCEL = 9;
/** The same in the air, where the keys only nudge and letting go keeps the takeoff's speed. */
const AIR_ACCEL = 1;
/** Per second, this share of the speed is lost on the ground. */
const FRICTION = 5.5;
/** Friction and acceleration both work on at least this speed, so a slow drift stops quickly and a slow body still gets going. */
const STOP_SPEED = 100 * UNIT;
/** Slower than this on the ground is standing still. */
const STILL_SPEED = 1 * UNIT;
/** Ground whose normal points up less than this hides a step under a move that met nothing, so one is tried anyway. */
const STEP_TRIGGER_NORMAL_Y = 0.9;
/** How far below the feet the surface under the capsule's axis may be and still be the ground it stands on. */
const GROUND_PLANE_SLACK = 1 * UNIT;

/** How far under the feet the ground may be for a press of jump to count as made on it. */
const JUMP_REACH = 2 * UNIT;

// -- Landing -----------------------------------------------------------------------

/** A fall from at least this high costs the whole velocity FALL_SCALE on touching down. */
const FALL_HEIGHT = 12 * UNIT;
const FALL_SCALE = 0.67;
/** The first step on the ground after a jump scales the velocity again: by less when the landing is at least this far above the takeoff. */
const LAND_SCALE = 0.65;
const LAND_SCALE_HIGH = 0.5;
const LAND_HIGH = STEP_HEIGHT;
/** Friction's multiple at the start of a landing, held for the first LAND_HOLD and falling to 1 over the rest. */
const LAND_FRICTION = 2.5;
const LAND_HOLD = 0.1;

/** How much harder friction grips, and how much lower a jump is, `left` seconds from the end of a landing. */
function landFactor(left: number): number {
  const ramp = LAND_WINDOW - LAND_HOLD;
  return left >= ramp ? LAND_FRICTION : 1 + ((LAND_FRICTION - 1) * left) / ramp;
}

/**
 * How far a body at `speed` along the ground skids once its keys are let go,
 * outside a landing: what `friction` adds up to. For whoever has to stop
 * somewhere (nav/follow.ts) rather than at once.
 */
export function stopDistance(speed: number): number {
  return speed <= STOP_SPEED ? (speed * speed) / (2 * STOP_SPEED * FRICTION) : (speed - STOP_SPEED / 2) / FRICTION;
}

// Scratch, so a tick allocates nothing. None of it survives a call.
const wish: Vec3 = { x: 0, y: 0, z: 0 };
const ground: Vec3 = { x: 0, y: 0, z: 0 };
const probe: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * One step of the walk. `pressed` is a new press of jump this step and
 * `sprinting` whether this step sprints: sim/movement.ts decides both once,
 * from the state the step starts from.
 */
export function walk(s: MovementState, input: PlayerInput, dt: number, env: MovementEnv, pressed: boolean, sprinting: boolean): void {
  const v = s.velocity;
  if (!s.grounded) {
    // Broken ground drops a walk for a tick at a time, and a press on that tick
    // must not be lost: a walk that is not rising jumps off ground in JUMP_REACH.
    if (!(pressed && s.sinceJump >= JUMP_REPEAT && s.jumpFrom === null && v.y <= 0 && groundWithin(s, env, JUMP_REACH))) {
      fall(s, input, dt, env);
      return;
    }
  }
  s.landing = Math.max(0, s.landing - dt);
  if (s.jumpFrom !== null) {
    // The first step back on the ground after a jump takes its cost.
    const high = s.feet.y - s.jumpFrom >= LAND_HIGH;
    scale(v, high ? LAND_SCALE_HIGH : LAND_SCALE);
    s.landing = high ? LAND_WINDOW_HIGH : LAND_WINDOW;
    s.jumpFrom = null;
  }

  // A jump is a new press, on the ground, no sooner than JUMP_REPEAT after the
  // last: a held key never jumps again, and a press in the air is not kept.
  if (pressed && s.sinceJump >= JUMP_REPEAT) {
    // Inside a landing it is lower, by what the landing still weighs.
    v.y = JUMP_SPEED / Math.sqrt(landFactor(s.landing));
    s.jumpFrom = s.feet.y;
    s.sinceJump = 0;
    s.grounded = false;
    fall(s, input, dt, env);
    return;
  }

  friction(v, s.landing, dt);
  const speed = wishFor(s, input, sprinting ? env.body.runSpeed : env.body.walkSpeed, sprinting, true);
  if (speed === 0 && v.x === 0 && v.z === 0) {
    // Standing still: nowhere to go, and nothing to ask of the ground but whether it is there.
    s.grounded = standing(s, env);
    return;
  }
  // The velocity and what the keys ask for both lie along the ground, so a
  // slope is walked at the speed level ground is.
  const sloped = groundUnder(s, env);
  alongGround(v, ground);
  alongGround(wish, ground);
  accelerate(v, speed, GROUND_ACCEL, dt);
  groundSlide(s, dt, env, sloped);
}

/** The walk in the air, from a jump or a fall: the keys nudge, gravity pulls, and a landing takes the fall's cost. */
function fall(s: MovementState, input: PlayerInput, dt: number, env: MovementEnv): void {
  const v = s.velocity;
  // A landing's grip is the ground's; leaving it again ends it.
  s.landing = 0;
  // In the air the keys ask for the walk speed whatever is held: a sprint is not flown.
  accelerate(v, wishFor(s, input, env.body.walkSpeed, false, false), AIR_ACCEL, dt);
  airSlide(s, dt, env);
  if (s.grounded) {
    if (v.y < 0 && (v.y * v.y) / (2 * GRAVITY) >= FALL_HEIGHT) {
      scale(v, FALL_SCALE);
    }
    v.y = 0;
  }
}

function scale(v: Vec3, by: number): void {
  v.x *= by;
  v.y *= by;
  v.z *= by;
}

/**
 * The normal of the ground under the capsule's axis, into `ground` — flat when
 * what is there is not what the capsule rests on (it stands on an edge). True
 * if it is steep enough to try a step on (STEP_TRIGGER_NORMAL_Y).
 */
function groundUnder(s: Readonly<MovementState>, env: MovementEnv): boolean {
  const { radius } = env.body;
  probe.x = s.feet.x;
  probe.y = s.feet.y + radius;
  probe.z = s.feet.z;
  const height = env.world.ready ? env.world.groundBelow(probe, 2 * radius, ground) : null;
  // A capsule on a plane has the plane this far under its feet along its axis.
  if (height === null || s.feet.y - height > radius * (1 / ground.y - 1) + GROUND_PLANE_SLACK) {
    ground.x = 0;
    ground.y = 1;
    ground.z = 0;
    return false;
  }
  return ground.y < STEP_TRIGGER_NORMAL_Y;
}

/**
 * The direction the keys ask for, as a flat unit vector in `wish`, and the
 * speed they ask for along it: `speed` forward, and on the ground less for
 * sideways and backward. Zero, and no direction, with nothing held.
 */
function wishFor(s: Readonly<MovementState>, input: PlayerInput, speed: number, sprinting: boolean, onGround: boolean): number {
  const forward = input.forward;
  const right = sprinting ? input.right * SPRINT_STRAFE_SCALE : input.right;
  const held = Math.hypot(forward, right);
  wish.y = 0;
  if (held === 0) {
    wish.x = 0;
    wish.z = 0;
    return 0;
  }
  const sin = Math.sin(s.yaw);
  const cos = Math.cos(s.yaw);
  // Yaw 0 faces -Z, so forward is (-sin, -cos) and right (cos, -sin).
  wish.x = (-sin * forward + cos * right) / held;
  wish.z = (-cos * forward - sin * right) / held;
  const ahead = onGround && forward < 0 ? BACK_SCALE * -forward : Math.abs(forward);
  const aside = (onGround ? STRAFE_SCALE : 1) * Math.abs(right);
  return speed * Math.min(1, Math.max(ahead, aside));
}

/** Take friction off the speed along the ground, more inside a landing, stopping at zero. */
function friction(v: Vec3, landing: number, dt: number): void {
  const speed = Math.hypot(v.x, v.z);
  if (speed < STILL_SPEED) {
    v.x = 0;
    v.y = 0;
    v.z = 0;
    return;
  }
  const grip = landing > 0 ? landFactor(landing) : 1;
  scale(v, Math.max(0, speed - Math.max(speed, STOP_SPEED) * grip * FRICTION * dt) / speed);
}

/** Add towards `speed` along `wish`, never passing it along that direction. */
function accelerate(v: Vec3, speed: number, accel: number, dt: number): void {
  const room = speed - (v.x * wish.x + v.y * wish.y + v.z * wish.z);
  if (room <= 0) {
    return;
  }
  const add = Math.min(room, accel * dt * Math.max(speed, STOP_SPEED));
  v.x += add * wish.x;
  v.y += add * wish.y;
  v.z += add * wish.z;
}
