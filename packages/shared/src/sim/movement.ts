// How a player moves: walking, running, jumping and falling, with a capsule
// that keeps them out of walls. One step function over plain state, so the same
// state and input give the same result on a client and on a server.
//
// Movement is Quake's, which CoD inherits: the keys never set the velocity.
// Friction bleeds it off on the ground, and acceleration adds, per second, a
// share of the walk or run speed along the held direction, never past that
// speed. So a landing carries its speed in, and letting go skids to a stop.
//
// Each step resolves the capsule against the world once (engine/collision.ts).
// The capsule's rounded bottom slides up any ledge shorter than RADIUS; a move
// blocked by a taller one, up to STEP_HEIGHT, is tried again from that much
// higher (`stepUp`), as the games' step-slide move does.
//
// Two moves replace walking for a while: a mantle (on rails, sim/mantle.ts) and
// a ladder (steered, sim/ladder.ts). docs/engine/player.md has both.

import type { CapsuleResolution, CapsuleWorld, Vec3 } from "./capsule.js";
import { wantsSprint, type PlayerInput } from "./input.js";
import { NO_LADDERS, UNIT, type LadderHit, type LadderVolumes } from "./ladder.js";
import { MAX_CLIMB, MIN_CLIMB, NO_MANTLES, type MantleTarget, type MantleVolumes } from "./mantle.js";

export type { CapsuleWorld, Vec3 };

// -- The body ----------------------------------------------------------------------

export const RADIUS = 0.3; // m
export const HEIGHT = 1.7; // m
/**
 * The eye above the feet, m: the games' own viewheight, 60 units.
 *
 * Measured against the bodies rather than chosen as a round number, which is what
 * it used to be. A catalogue body posed standing puts its `tag_eye` at 1.47–1.48 m
 * and the top of its head at 1.62–1.69 m, so an eye at 1.6 sat in the top few
 * centimetres of a peer's head box — and this is where a round leaves from
 * (`Match.trace`), so a player saw and shot over a wall from 12 cm above the head
 * anyone could shoot back at. 60 units leaves the same small gap over a body's own
 * eye that the games leave.
 */
export const EYE_HEIGHT = 60 * UNIT;
const PITCH_LIMIT = Math.PI / 2 - 0.01;

// -- Walking and running (Quake's values in brackets) ------------------------------

export const WALK_SPEED = 3.2; // m/s
export const RUN_SPEED = 5.8; // m/s

/**
 * The body a step moves and the speeds its keys ask for. A player's is
 * `PLAYER_MOVEMENT`, which is every step's default: a client predicting and a
 * server replaying pass nothing, so they cannot disagree about it. An actor's
 * kind names its own (game/actors/), stepped on the server alone.
 */
export interface MovementParams {
  /** The capsule, m. */
  readonly radius: number;
  readonly height: number;
  /** m/s, without and with `run`. */
  readonly walkSpeed: number;
  readonly runSpeed: number;
  /**
   * Stand on a kerb's corner after stepping onto it, rather than fall back off it.
   * A player crosses a thin threshold in one tick's move and never needs it; an
   * actor walking at 0.6 m/s moves a centimetre a tick and is pinned by one
   * without it (theater's foyer). Off for a player, whose step is pinned bit for
   * bit (tests/movementParams.test.ts).
   */
  readonly rideKerbs?: boolean;
}

export const PLAYER_MOVEMENT: MovementParams = { radius: RADIUS, height: HEIGHT, walkSpeed: WALK_SPEED, runSpeed: RUN_SPEED };
/**
 * Below this a player is standing still as far as the legs are concerned, so the
 * stride clock stops and the idle clip takes over. Here rather than in the
 * animator because `stride` is simulation state now — see `advanceStride`.
 */
export const IDLE_SPEED = 0.35;
/**
 * Seconds one full stride takes at `RUN_SPEED`, which is what `stride` counts in.
 *
 * A constant rather than the run clip's own duration, because `stepMovement` is
 * pure and asset-free and must stay that way — and because the alternative is
 * worse: the three games' `runForward` loops are 1.867 s (iw4), 1.700 s (iw5) and
 * 1.800 s (iw6), so the period already differed by 10% between maps. This is
 * their mean, within 6% of each, and the point is that **both ends now agree**:
 * a limb hitbox cannot be where the server says it is unless the phase that
 * placed it was replayed rather than integrated locally per frame.
 */
export const STRIDE_PERIOD = 1.8;
/**
 * How long a change of gait takes to blend, seconds.
 *
 * The animator used to walk its own weights towards a target over this, which made
 * a pose a function of every frame before it — so it was dropped when the pose had
 * to become reproducible, and the result was visibly snappy. The blend is back as
 * *state* instead: `gait` and `airborne` are smoothed booleans stepped here, so both
 * ends reach the same weights from the same inputs and a hit box stays exactly where
 * the body is drawn.
 *
 * 0.18 s is the animator's own original figure.
 *
 * Keying this on speed instead was measured and rejected: a player accelerating from
 * a standstill crosses `IDLE_SPEED` in a single tick, so a speed-derived crossfade
 * lasts 17 ms and is no smoother than the switch it replaced.
 */
export const GAIT_BLEND = 0.18;

/**
 * How long a change of *heading* takes to blend, seconds **per unit** of it.
 *
 * Per unit rather than per transition, because the two transitions it covers are
 * different sizes: stopping walks the direction one unit to the origin, and
 * reversing walks it two, all the way out the other side. One rate gives a stop
 * TRAVEL_BLEND and a reversal twice it, which is about the right proportion — a
 * reversal really is the longer move.
 *
 * Shorter than `GAIT_BLEND` for that reason: at 0.18 a reversal took 0.36 s and the
 * legs sat near the idle pose for a fifth of it while the player was already running
 * backwards at full speed.
 */
export const TRAVEL_BLEND = 0.125;
/** How far the stride rate may be pushed from the clip's own by the speed being made. */
const STRIDE_RATE_RANGE = [0.35, 1.6] as const;
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

/**
 * The tallest ledge a blocked move steps onto: IW5's 18 units (0x424a30). A
 * standing player steps; so does one climbing a ladder upward, which is what
 * sets them on its top.
 */
export const STEP_HEIGHT = 18 * UNIT;
/** How finely `stepUp` finds the surface it sets the feet on, as halvings of its drop. */
const STEP_SEARCH = 12;
/**
 * A step that sets the capsule on a ledge's corner is kept if the ledge's top
 * is less than this share of the radius above the feet: low enough for the
 * rounded bottom to climb the rest, as it climbs any kerb.
 */
const STEP_KERB = 0.8;
/** Where along the move, from the capsule's middle, `stepUp` looks for a ledge too tall to step, in radii. */
const STEP_LOOK = [0, 0.5, 1, 1.5];

// -- Jumping and landing -----------------------------------------------------------

export const GRAVITY = 18; // m/s²
/** Takeoff speed, m/s: a 0.84 m jump, 0.61 s in the air. */
const JUMP_SPEED = 5.5;
/**
 * `sinceJump` counts up to this and stops: the longest any rule looks back at a
 * jump (JUMP_OFF_REPEAT), so the field has a bound to be sent in.
 */
const JUMP_MEMORY = 0.5; // s
/**
 * Jump forgiveness. The resolver's `grounded` flickers off for a frame now and
 * then over imported triangle soup, so the ground still counts for COYOTE_TIME
 * after leaving it, and a press waits JUMP_BUFFER for the ground to come.
 */
const COYOTE_TIME = 0.12; // s
const JUMP_BUFFER = 0.15; // s
/**
 * Landing from a jump (not a fall) lowers the speed the keys accelerate to
 * (CoD's `jump_slowdownEnable`) to LAND_SLOWDOWN of it, recovering linearly over
 * LAND_RECOVERY, and raises friction to LAND_FRICTION so the landing slides
 * less. LAND_FRICTION must not pass GROUND_ACCEL, or the keys cannot hold full
 * speed against it.
 */
const LAND_SLOWDOWN = 0.5;
export const LAND_RECOVERY = 0.5; // s
const LAND_FRICTION = 10;

// -- Mantling ----------------------------------------------------------------------

/**
 * How long a climb takes, seconds, at MIN_CLIMB and at MAX_CLIMB.
 *
 * The games' own numbers: `mp_mantle_up_21` runs 0.33 s and `mp_mantle_up_57`
 * runs 0.83 s, and the seven clips between them rise monotonically, so a climb
 * is timed by interpolating between the two ends rather than by picking a clip.
 * Named here rather than read from an animation because the simulation has to
 * agree across a client and a server that may not have loaded the same models —
 * and because making mantling faster than the original is a change to these two
 * numbers and nothing else.
 */
const MANTLE_TIME_LOW = 0.33;
const MANTLE_TIME_HIGH = 0.83;

/** Seconds a climb of `rise` metres takes. */
export function mantleDuration(rise: number): number {
  const t = (rise - MIN_CLIMB) / (MAX_CLIMB - MIN_CLIMB);
  return MANTLE_TIME_LOW + (MANTLE_TIME_HIGH - MANTLE_TIME_LOW) * Math.max(0, Math.min(1, t));
}

/**
 * A climb under way. Null unless the player is mantling, which is what makes it
 * one bit on the wire in the ordinary case rather than three fields of zeroes.
 */
export interface MantleState {
  /** The feet position this climb ends at, fixed when it started. */
  target: Vec3;
  /** Seconds left of it. */
  left: number;
  /** The whole climb's height, m. Fixed at the start, so the animation it picks does not change under it. */
  rise: number;
  /**
   * A vault across the obstacle rather than a step up onto it (`kind: over`,
   * with somewhere to vault to).
   *
   * On the wire, and for one reason: a snapshot carries the climb but not the
   * volume it came from, so without this bit a peer's animator would have to
   * guess which of the two it is playing — and the heights of the two kinds
   * overlap, so there is no guess to make. One bit, inside a struct that only
   * exists while somebody is actually climbing.
   */
  over: boolean;
}

// -- Ladders -----------------------------------------------------------------------
//
// Every number here is IW5's own, read from `PM_CheckLadderMove` (0x4230d0),
// `PM_LadderMove` (0x423380) and the jump-off (0x416780), in game units where the
// game has them. BO1 runs the same code with the same numbers. The derivation is
// in docs/engine/player.md#ladders.

/** The speed a climb is a share of: the games' `g_speed`, 190 units/s, not our walk speed. */
const LADDER_SPEED = 190 * UNIT;
/** Of LADDER_SPEED: straight up or down at full pitch, and sideways. */
const LADDER_CLIMB_SHARE = 0.5;
const LADDER_STRAFE_SHARE = 0.2;
/** Per second, this many times the wanted speed is added toward the wanted velocity. */
const LADDER_ACCEL = 9;
/** Off the ground, a mostly-vertical climb is held against the ladder at this speed: what carries a player over the top. */
const LADDER_PUSH = 50 * UNIT;
/** How far ahead a probe looks for a ladder, standing and in the air. */
const LADDER_REACH_GROUND = 8 * UNIT;
const LADDER_REACH_AIR = 30 * UNIT;
/** No ladder is grabbed this soon after a jump, and one is only jumped off this long after the last. */
const LADDER_GRAB_DELAY = 0.3; // s
const JUMP_OFF_REPEAT = 0.5; // s
/** A jump off a ladder keeps this share of the jump's rise, and leaves at this speed along the ground. */
const JUMP_OFF_RISE = 0.75;
const JUMP_OFF_SPEED = 128 * UNIT;
/** In the air on a ladder, the view may turn this far from facing it (`bg_ladder_yawcap`). */
const LADDER_YAW_CAP = (100 * Math.PI) / 180;

/**
 * A ladder being climbed. Null unless the player is on one, which makes it one
 * bit on the wire in the ordinary case.
 */
export interface LadderState {
  /**
   * Which way the side they grabbed faces, as a yaw (its outward normal, the way
   * a player facing out from it would look). Fixed at the grab, as the game's
   * `vLadderVec` is: never refreshed while climbing.
   */
  facing: number;
}

/** The outward normal a ladder's `facing` names, horizontal and unit. */
export function ladderNormal(ladder: LadderState): { x: number; z: number } {
  return { x: -Math.sin(ladder.facing), z: -Math.cos(ladder.facing) };
}

// -- State -------------------------------------------------------------------------

/**
 * Everything about a player's movement that changes as they play, as plain
 * JSON-safe data (no three.js values, no Infinity): what a network sends.
 * tests/player.test.ts runs a JSON copy in lockstep to keep it complete.
 */
export interface MovementState {
  /** The bottom of the capsule, world metres. */
  feet: Vec3;
  /** m/s. */
  velocity: Vec3;
  /** Radians: yaw about +Y (0 faces -Z), pitch up positive. */
  yaw: number;
  pitch: number;
  /** Standing on something after the last step. */
  grounded: boolean;
  /** Seconds the ground still counts after leaving it (COYOTE_TIME); 0 once gone or spent on a jump. */
  coyote: number;
  /** Seconds a jump press still waits for the ground (JUMP_BUFFER). */
  jumpBuffer: number;
  /** In the air from a jump, not a fall, so the landing slows the player. */
  jumped: boolean;
  /** Seconds left of the landing slowdown (LAND_RECOVERY). */
  landing: number;
  /**
   * The climb under way, or null. While this is set the player is on rails: no
   * gravity, no friction, no keys and no collision resolution. The path was
   * checked clear before the climb began (sim/mantle.ts), and nothing it was
   * checked against moves; resolving against the corner it hugs would only
   * nudge it off the line a server replays.
   */
  mantle: MantleState | null;
  /** The ladder being climbed, or null. While set, the ladder move replaces walking. */
  ladder: LadderState | null;
  /**
   * Off a ladder by any way but a jump, and not yet back on the ground: no
   * ladder can be grabbed until they are. The game's pm_flags 0x1000.
   */
  ladderLock: boolean;
  /** Seconds since the last jump, stopping at JUMP_MEMORY. */
  sinceJump: number;
  /** Jump was held last step, so a held key is not a new press: a ladder is jumped off by pressing. */
  jumpHeld: boolean;
  /**
   * How much of a gait is under way: 0 standing still, 1 moving.
   *
   * A smoothed boolean, not a speed. `IDLE_SPEED` is the threshold it chases and
   * `GAIT_BLEND` is how long it takes to get there, so a player who starts walking
   * crossfades out of the idle clip over 0.18 s rather than switching in one tick.
   *
   * Simulation state for the same reason `stride` is: a bullet is traced against a
   * posed skeleton, and a weight each end smoothed on its own frame times would put
   * a peer's legs in two different places.
   */
  gait: number;
  /**
   * How far off the ground the *pose* is: 0 standing, 1 airborne. The same kind of
   * smoothed boolean as `gait`, chasing `grounded`.
   *
   * Its own field rather than derived from `coyote`, `sinceJump` and `landing`
   * between them — those would each cover one way of leaving or meeting the ground
   * and disagree about walking off a ledge, which is clever where this is clear.
   */
  airborne: number;
  /**
   * Which way the body is travelling, in its own frame: forward and right, each
   * -1 (back, left) to 1 (forward, right), and **smoothed**.
   *
   * The third of the pose blends, and the one with the least obvious need. The four
   * run clips are blended by the direction of travel, and the direction of a vector
   * is *discontinuous where the vector passes through zero* — which is every stop
   * and every change of heading. Reversing from a run took `runForward` to
   * `runBack` in a single frame, and stopping took it to `idle`: a whole clip
   * swapped between two frames, measured at 2.0 of weight either way by
   * `tests/pose.test.ts`'s own yardstick. Changing *speed* never crosses zero, which
   * is exactly why walking to running was the one transition that already looked
   * right.
   *
   * No function of the instantaneous velocity can fix that — it flips as fast as the
   * velocity does, and a reversal crosses zero in about three ticks. The smoothing
   * has to be in the state, and this pair is it: each component walks towards the
   * unit direction of travel over `GAIT_BLEND`, so a reversal travels through the
   * middle rather than jumping across it, and the middle is where the run clips
   * carry no weight (`runBlend`). Two bytes, on the argument `gait` and `airborne`
   * are two bytes: a body is drawn through the transition, so a hit box traced
   * against the pose has to be drawn through it too.
   */
  travelForward: number;
  travelRight: number;
  /**
   * Where in a run cycle the feet are, 0..1, shared by all four run clips.
   *
   * Simulation state, not a drawing detail, and that is the whole reason it is
   * here: a bullet is traced against a posed skeleton, the pose is a function of
   * this, and a value each end integrated on its own frame times would put a
   * peer's legs in two different places. Advanced by `advanceStride`.
   */
  stride: number;
}

/** A player standing at `feet`, at rest and not yet on the ground. */
export function createMovement(feet: Vec3, yaw: number, pitch: number): MovementState {
  return {
    feet: { x: feet.x, y: feet.y, z: feet.z },
    velocity: { x: 0, y: 0, z: 0 },
    yaw,
    pitch: clampPitch(pitch),
    grounded: false,
    coyote: 0,
    jumpBuffer: 0,
    jumped: false,
    landing: 0,
    mantle: null,
    ladder: null,
    ladderLock: false,
    sinceJump: JUMP_MEMORY,
    jumpHeld: false,
    gait: 0,
    airborne: 0,
    travelForward: 0,
    travelRight: 0,
    stride: 0,
  };
}

export function clampPitch(pitch: number): number {
  return Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitch));
}

/** m/s along the ground. */
export function horizontalSpeed(s: Readonly<MovementState>): number {
  return Math.hypot(s.velocity.x, s.velocity.z);
}

/**
 * Turn the stride clock by `dt`, or hold it.
 *
 * It is reset to nothing on a climb, where the legs are playing a mantle or a
 * ladder and there is no cycle to be in. Everywhere else it **holds its phase**
 * rather than stopping dead:
 *
 *  - airborne, so a player who hops mid-sprint lands back into the stride they
 *    left, which is what the games do;
 *  - standing still, so the run clip `gait` is still fading out has somewhere to
 *    fade *from*. This used to reset, and it is half of why stopping was instant
 *    rather than blended: friction kills a run's speed in a single tick, so the
 *    stride snapped to its first frame in the same frame the player stopped —
 *    and a crossfade out of a pose nobody was in is a cut with extra steps. See
 *    `runBlend` in sim/pose.ts for the other half.
 *
 * Nothing reads it while a body is genuinely standing: `gait` is zero by then and
 * the run layer is dropped before its phase is looked at.
 */
/**
 * Walk the pose blends towards what the state actually is.
 *
 * Linear here and eased where it is read (`sim/pose.ts`), so that what travels is a
 * plain fraction of the way through a transition and the shaping is one decision in
 * one place.
 */
export function advanceBlends(s: MovementState, dt: number): void {
  const step = GAIT_BLEND > 0 ? dt / GAIT_BLEND : 1;
  const speed = horizontalSpeed(s);
  const moving = s.mantle === null && s.ladder === null && speed > IDLE_SPEED;
  s.gait = approach(s.gait, moving ? 1 : 0, step);
  s.airborne = approach(s.airborne, s.grounded ? 0 : 1, step);

  // The direction of travel in the player's own frame. Yaw 0 faces -Z, so forward
  // is (-sin yaw, -cos yaw) and right is (cos yaw, -sin yaw). Standing still has no
  // direction and aims at the origin, which is what lets a stop fade out rather than
  // switch — and a reversal passes through the origin on the way rather than
  // jumping across it. Each component walks its own way there: a straight line
  // through the middle is the point, where turning the vector would keep it at full
  // length and reintroduce the swap it exists to prevent.
  let forward = 0;
  let right = 0;
  if (moving) {
    const sin = Math.sin(s.yaw);
    const cos = Math.cos(s.yaw);
    forward = (-s.velocity.x * sin - s.velocity.z * cos) / speed;
    right = (s.velocity.x * cos - s.velocity.z * sin) / speed;
  }
  const travelStep = TRAVEL_BLEND > 0 ? dt / TRAVEL_BLEND : 1;
  s.travelForward = approach(s.travelForward, forward, travelStep);
  s.travelRight = approach(s.travelRight, right, travelStep);
}

/** `value` towards `target`, by at most `step`, without overshooting it. */
function approach(value: number, target: number, step: number): number {
  const delta = target - value;
  return Math.abs(delta) <= step ? target : value + Math.sign(delta) * step;
}

export function advanceStride(s: MovementState, dt: number, runSpeed = RUN_SPEED): void {
  if (s.mantle || s.ladder) {
    s.stride = 0;
    return;
  }
  const speed = horizontalSpeed(s);
  if (s.grounded && speed <= IDLE_SPEED) {
    return;
  }
  const rate = Math.max(STRIDE_RATE_RANGE[0], Math.min(STRIDE_RATE_RANGE[1], speed / runSpeed));
  s.stride = (s.stride + (dt * rate) / STRIDE_PERIOD) % 1;
}

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

/**
 * Move by the velocity, push out of the world, and keep the ground's
 * bookkeeping: the end of every free step. `canStep` lets a blocked move step
 * up (`stepUp`).
 */
function integrate(s: MovementState, dt: number, world: CapsuleWorld, canStep: boolean, body: MovementParams): void {
  const fromX = s.feet.x;
  const fromY = s.feet.y;
  const fromZ = s.feet.z;
  s.feet.x += s.velocity.x * dt;
  s.feet.y += s.velocity.y * dt;
  s.feet.z += s.velocity.z * dt;
  collide(s, world, body);
  // A step up kept on a kerb's corner is not a walk off a ledge: stepping down
  // after it sets the feet back where they were (`rideKerbs`).
  if (canStep && world.ready && !(stepUp(s, dt, world, fromX, fromY, fromZ, body) && body.rideKerbs)) {
    stepDown(s, world, body);
  }

  // Only ground reached on the way down re-arms the coyote window.
  const landed = s.grounded && s.velocity.y <= 0;
  s.coyote = landed ? COYOTE_TIME : Math.max(0, s.coyote - dt);
  s.landing = Math.max(0, s.landing - dt);
  if (s.jumped && landed) {
    s.jumped = false;
    s.landing = LAND_RECOVERY;
  }
}

/**
 * The yaw a player in state `s` may look along, asked for `yaw`: off the ground
 * on a ladder, no further than LADDER_YAW_CAP from facing it. A step applies it
 * to the input; the camera applies it to the mouse movement no step has spent
 * yet (engine/controls/firstPerson.ts), as the game writes the overshoot into
 * the view's delta angles.
 */
export function ladderYaw(s: Readonly<MovementState>, yaw: number): number {
  if (!s.ladder || s.grounded) {
    return yaw;
  }
  const toward = s.ladder.facing + Math.PI;
  const delta = Math.atan2(Math.sin(yaw - toward), Math.cos(yaw - toward));
  if (Math.abs(delta) <= LADDER_YAW_CAP) {
    return yaw;
  }
  return toward + Math.sign(delta) * LADDER_YAW_CAP;
}

/** Leave the ladder, if on one, without a jump: no other ladder until the ground. */
function letGo(s: MovementState): void {
  if (s.ladder) {
    s.ladder = null;
    s.ladderLock = true;
  }
}

function ladderReach(s: Readonly<MovementState>): number {
  return s.grounded ? LADDER_REACH_GROUND : LADDER_REACH_AIR;
}

/**
 * The ladder side the grab check's probe meets from `s`, or null: along the
 * view, or straight back into the ladder when climbing one in the air. What the
 * next step tests, before its other conditions (the lock, a jump's delay, the
 * forward key), which is what the climb view (`M`) wants to show.
 */
export function ladderAhead(s: Readonly<MovementState>, ladders: LadderVolumes, body: MovementParams = PLAYER_MOVEMENT): LadderHit | null {
  let dirX = -Math.sin(s.yaw);
  let dirZ = -Math.cos(s.yaw);
  if (s.ladder && !s.grounded) {
    const normal = ladderNormal(s.ladder);
    dirX = -normal.x;
    dirZ = -normal.z;
  }
  return ladders.trace(s.feet, dirX, dirZ, ladderReach(s), body);
}

/**
 * Grab a ladder, keep hold of one, or let go: IW5's `PM_CheckLadderMove`.
 *
 * A probe goes ahead of the player — along the view on the ground or on the way
 * to a ladder, but straight back into the ladder once climbing it in the air, so
 * looking away does not let go. Standing, only a player pushing forward holds
 * on, which is how stepping off at the bottom works. A first grab checks a
 * second probe straight in along the side's normal, as the game does.
 */
function checkLadder(s: MovementState, input: PlayerInput, ladders: LadderVolumes, body: MovementParams): void {
  if (s.ladderLock) {
    return;
  }
  if (s.sinceJump < LADDER_GRAB_DELAY) {
    letGo(s);
    return;
  }
  const hit = ladderAhead(s, ladders, body);
  if (hit && (!s.grounded || input.forward > 0)) {
    if (s.ladder) {
      return;
    }
    if (ladders.trace(s.feet, -hit.x, -hit.z, ladderReach(s), body)) {
      s.ladder = { facing: Math.atan2(-hit.x, -hit.z) };
      // Whatever jump brought them here is over; the next ground is not its landing.
      s.jumped = false;
      return;
    }
  }
  letGo(s);
}

/**
 * One step on a ladder: IW5's `PM_LadderMove`.
 *
 * The keys ask for a velocity and it is approached at LADDER_ACCEL. Forward
 * climbs, and the pitch says which way and how fast: level is 0.625 of full
 * speed up, about 14.5 degrees down is still, and past 40 degrees down forward
 * climbs down at full speed. Strafing moves along the ladder. With a key let go,
 * that half of the velocity stops. No gravity; collision still runs, because a
 * ladder is steered, not a rail.
 */
function climbLadder(s: MovementState, input: PlayerInput, dt: number, world: CapsuleWorld, body: MovementParams): void {
  const v = s.velocity;
  const normal = ladderNormal(s.ladder!);
  const upScale = Math.max(-1, Math.min(1, (Math.sin(s.pitch) + 0.25) * 2.5));
  // The view's flat right, laid onto the ladder's plane and left unnormalised:
  // strafing at a ladder side-on is slower, as it is in the game.
  const flatRightX = Math.cos(s.yaw);
  const flatRightZ = -Math.sin(s.yaw);
  const across = flatRightX * normal.x + flatRightZ * normal.z;
  const rightX = flatRightX - normal.x * across;
  const rightZ = flatRightZ - normal.z * across;

  // The game's command scale: a diagonal is no faster than a straight push.
  const held = Math.hypot(input.forward, input.right);
  const scale = held > 0 ? (LADDER_SPEED * Math.max(Math.abs(input.forward), Math.abs(input.right))) / held : 0;
  const wishX = input.right * scale * LADDER_STRAFE_SHARE * rightX;
  const wishY = input.forward * upScale * LADDER_CLIMB_SHARE * scale;
  const wishZ = input.right * scale * LADDER_STRAFE_SHARE * rightZ;
  const wishSpeed = Math.hypot(wishX, wishY, wishZ);
  if (wishSpeed > 0) {
    const dx = wishX - v.x;
    const dy = wishY - v.y;
    const dz = wishZ - v.z;
    const gap = Math.hypot(dx, dy, dz);
    if (gap > 0) {
      const add = Math.min(gap, LADDER_ACCEL * wishSpeed * dt) / gap;
      v.x += dx * add;
      v.y += dy * add;
      v.z += dz * add;
    }
  }

  // A key let go stops its half of the climb at once: no glide up the ladder
  // or along it, which is how the game plays. Its code decays the two instead
  // (vertical at gravity, 0.12 s from full speed; sideways at 16× a second);
  // stopping outright also keeps a still climber exactly still at any tick rate.
  if (input.forward === 0) {
    v.y = 0;
  }
  if (input.right === 0) {
    const length = Math.hypot(rightX, rightZ);
    if (length > 0) {
      const alongX = rightX / length;
      const alongZ = rightZ / length;
      const side = alongX * v.x + alongZ * v.z;
      v.x -= alongX * side;
      v.z -= alongZ * side;
    }
  }

  if (!s.grounded) {
    const out = v.x * normal.x + v.z * normal.z;
    v.x -= normal.x * out;
    v.z -= normal.z * out;
    const moving = v.x !== 0 || v.y !== 0 || v.z !== 0;
    if (moving && v.x * v.x + v.z * v.z <= v.y * v.y) {
      v.x -= normal.x * LADDER_PUSH;
      v.z -= normal.z * LADDER_PUSH;
    }
  }

  // Standing, or climbing upward: the games step a climber onto the top.
  integrate(s, dt, world, s.grounded || v.y > 0, body);
}

/**
 * Jump away from the ladder: the ordinary takeoff, less a quarter of its rise,
 * and JUMP_OFF_SPEED along the ground. Looking away from the ladder,
 * that is where the view points; looking at it, the view is mirrored off it, so
 * either way the jump leaves the ladder behind.
 */
function jumpOffLadder(s: MovementState): void {
  const normal = ladderNormal(s.ladder!);
  let x = -Math.sin(s.yaw);
  let z = -Math.cos(s.yaw);
  const into = x * normal.x + z * normal.z;
  if (into < 0) {
    x -= 2 * into * normal.x;
    z -= 2 * into * normal.z;
    const length = Math.hypot(x, z);
    x /= length;
    z /= length;
  }
  s.velocity.x = x * JUMP_OFF_SPEED;
  s.velocity.y = JUMP_SPEED * JUMP_OFF_RISE;
  s.velocity.z = z * JUMP_OFF_SPEED;
  s.ladder = null;
  s.grounded = false;
  s.coyote = 0;
  s.jumpBuffer = 0;
  s.jumped = true;
  s.sinceJump = 0;
}

/** Begin a climb: from here the player is on rails until `advanceMantle` finishes it. */
function startMantle(s: MovementState, target: MantleTarget): void {
  s.mantle = {
    target: { x: target.feet.x, y: target.feet.y, z: target.feet.z },
    left: mantleDuration(target.rise),
    rise: target.rise,
    over: target.over,
  };
  s.jumpBuffer = 0; // spent on the climb, or it jumps the moment the climb ends
  s.coyote = 0;
  s.jumped = false;
  s.velocity.x = 0;
  s.velocity.y = 0;
  s.velocity.z = 0;
  s.grounded = false;
}

/**
 * Carry a climb forward by `dt`, and finish it when its time runs out.
 *
 * The path has two legs: straight up to the target's height, then straight
 * across to it — the path `MantleVolumes` checked clear, and the only one that
 * is: a straight line from the foot of a ledge to its top cuts through its
 * corner. Which leg the player is on follows from their feet alone.
 *
 * Each step covers the share of what is left that `dt` is of the time left, so
 * the whole trajectory is a function of (feet, target, left) and nothing else.
 * That is what lets a server replaying the same inputs from the same state land
 * in the same place, rather than approximately there.
 */
function advanceMantle(s: MovementState, dt: number): void {
  const mantle = s.mantle!;
  if (dt >= mantle.left) {
    s.feet.x = mantle.target.x;
    s.feet.y = mantle.target.y;
    s.feet.z = mantle.target.z;
    s.velocity.x = 0;
    s.velocity.y = 0;
    s.velocity.z = 0;
    s.mantle = null;
    // Standing on what they climbed, with the ground's forgiveness armed: a
    // player who holds jump through a mantle jumps as they arrive, as they
    // would off any other landing. No `landing` slowdown — a climb is not a fall.
    s.grounded = true;
    s.coyote = COYOTE_TIME;
    s.landing = 0;
    return;
  }

  const { target } = mantle;
  const up = Math.max(0, target.y - s.feet.y);
  const acrossX = target.x - s.feet.x;
  const acrossZ = target.z - s.feet.z;
  const across = Math.hypot(acrossX, acrossZ);
  const move = (up + across) * (dt / mantle.left);
  let dx = 0;
  let dy = move;
  let dz = 0;
  if (move >= up) {
    // Round the corner: the rest of this step goes across. The height is set
    // rather than added to, so the next step sees the corner as passed.
    dy = target.y - s.feet.y;
    const share = across > 0 ? Math.min(1, (move - up) / across) : 0;
    dx = acrossX * share;
    dz = acrossZ * share;
  }
  s.feet.x += dx;
  s.feet.y = move >= up ? target.y : s.feet.y + dy;
  s.feet.z += dz;
  // The velocity the climb is making, so anything reading the state (a camera's
  // snap test, a peer's animator) sees the motion rather than a still player.
  s.velocity.x = dx / dt;
  s.velocity.y = dy / dt;
  s.velocity.z = dz / dt;
  mantle.left -= dt;
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

/**
 * How far into the ground `stepDown` sets the feet before resolving.
 *
 * The resolver only reports `grounded` where it actually pushed the capsule out
 * of something, so feet placed exactly on a surface come back in the air. A
 * millimetre is enough to be pushed out of and far above float noise; `stepUp`
 * sets its own feet down the same way.
 */
const GROUND_BITE = 1e-3;

/** Where `stepDown` probes, reused: it can run for every player every tick. */
const downProbe: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * Set the feet back down on ground walked off within a step's height.
 *
 * A slope walked *down* leaves the feet in the air every tick: the move along it
 * is horizontal, so it ends above the surface, and gravity needs two or three
 * ticks to bring the capsule back to it. `grounded` flickers for those ticks and
 * the pose blends follow — a body walking down a hill crossfades between falling
 * and walking several times a second — while the player also loses ground
 * acceleration and friction for most of the descent.
 *
 * Every engine of this family answers it the same way (Quake's PM_StepSlideMove
 * step-down, IW5's 0x424a30): a move that *started* on the ground and ended off
 * it, with nothing carrying the player upwards, stands on whatever is within a
 * step below. Walking off a kerb therefore sticks to it, as the games do;
 * anything taller than a step is still a fall.
 *
 * A jump never reaches this — the takeoff clears `grounded` before the move, and
 * `integrate`'s `canStep` is read from it — and a ladder or a mantle is on rails.
 */
function stepDown(s: MovementState, world: CapsuleWorld, body: MovementParams): void {
  if (s.grounded || s.velocity.y > 0 || s.ladder !== null || s.mantle !== null) {
    return;
  }
  downProbe.x = s.feet.x;
  downProbe.y = s.feet.y;
  downProbe.z = s.feet.z;
  const ground = world.groundBelow(downProbe, STEP_HEIGHT);
  if (ground === null) {
    return;
  }
  const keptX = s.feet.x;
  const keptY = s.feet.y;
  const keptZ = s.feet.z;
  const keptRise = s.velocity.y;
  s.feet.y = ground - GROUND_BITE;
  collide(s, world, body);
  // Nothing to stand on after all — a surface the ray found but the capsule
  // cannot rest on. The fall is left exactly as it was.
  if (!s.grounded) {
    s.feet.x = keptX;
    s.feet.y = keptY;
    s.feet.z = keptZ;
    s.velocity.y = keptRise;
  }
}

/** Where `stepUp` tries its positions, reused: it can run for every player every tick. */
const stepProbe: Vec3 = { x: 0, y: 0, z: 0 };
const stepResult: CapsuleResolution = { position: { x: 0, y: 0, z: 0 }, grounded: false };

/**
 * If this step's move along the ground came up short, try it again from
 * STEP_HEIGHT higher and set the feet down on whatever is there — IW5's
 * step-slide move (0x424a30), over a resolver rather than a trace.
 *
 * The stepped move is kept only if it gets further along the ground than the
 * plain one did and ends on the ledge: sliding along a wall gains nothing from
 * a step and keeps the plain result. Every position it keeps was tested clear of
 * the world (`overlapsCapsule`), so a step never puts the capsule inside
 * anything, and the whole of it is a function of the state and the world, so
 * a server replaying it steps the same way. True when it kept the stepped move.
 */
function stepUp(s: MovementState, dt: number, world: CapsuleWorld, fromX: number, fromY: number, fromZ: number, body: MovementParams): boolean {
  const { radius, height } = body;
  const wantedX = s.velocity.x * dt;
  const wantedZ = s.velocity.z * dt;
  const wanted = Math.hypot(wantedX, wantedZ);
  const plain = Math.hypot(s.feet.x - fromX, s.feet.z - fromZ);

  if (wanted < 1e-6 || plain >= wanted - 1e-4) {
    return false;
  }

  // Up, if there is room overhead.
  const p = stepProbe;
  p.x = fromX;
  p.y = fromY + STEP_HEIGHT;
  p.z = fromZ;

  if (world.overlapsCapsule(p, radius, height)) {
    return false;
  }

  // Across, as far as the world lets the raised capsule go: a kerb rider at least
  // a body's radius, so a slow one clears a thin threshold rather than setting
  // down on its corner a centimetre at a time (`rideKerbs`).
  const reach = body.rideKerbs ? Math.max(wanted, radius) / wanted : 1;
  p.x = fromX + wantedX * reach;
  p.z = fromZ + wantedZ * reach;
  const across = world.resolveCapsule(p, radius, height, stepResult).position;
  const x = across.x;
  const top = across.y;
  const z = across.z;

  if (Math.hypot(x - fromX, z - fromZ) <= plain + 1e-4) {
    return false;
  }

  // Nothing taller than a step ahead. The capsule sets down on a ledge's corner
  // and its rounded bottom slides up the rest, so the ledge itself is what
  // must be no taller: looked for straight down, from the capsule's middle to
  // past its front.
  const limit = fromY + STEP_HEIGHT + 1e-3;
  let ledge = -Infinity;

  for (const share of STEP_LOOK) {
    const ahead = share * radius;
    p.x = x + (wantedX / wanted) * ahead;
    p.y = limit + radius;
    p.z = z + (wantedZ / wanted) * ahead;
    const ground = world.groundBelow(p, radius + STEP_HEIGHT);

    if (ground !== null && ground > limit) {
      return false;
    }

    if (ground !== null) {
      ledge = Math.max(ledge, ground);
    }
  }

  // Down onto what is there: the lowest clear height within the step, found by
  // halving. Nothing to stand on within reach keeps the plain move.
  p.x = x;
  p.z = z;
  let clear = top;
  let blocked = fromY - 1e-3;
  p.y = blocked;

  if (!world.overlapsCapsule(p, radius, height)) {
    return false;
  }

  for (let i = 0; i < STEP_SEARCH; i++) {
    p.y = (clear + blocked) / 2;
    if (world.overlapsCapsule(p, radius, height)) {
      blocked = p.y;
    } else {
      clear = p.y;
    }
  }

  const keptX = s.feet.x;
  const keptY = s.feet.y;
  const keptZ = s.feet.z;
  const keptGrounded = s.grounded;
  const keptRise = s.velocity.y;

  // Set just into what is there, so the resolver lifts the feet onto it.
  s.feet.x = x;
  s.feet.y = blocked;
  s.feet.z = z;

  collide(s, world, body);

  // A box, as the game's player is, stands on a ledge with an inch of it
  // underfoot; a capsule set down that far out rests on the ledge's corner, not
  // on its top. That is kept as long as what is left is a kerb the rounded
  // bottom slides up on the next moves. A step is STEP_HEIGHT and no more.
  const onLedge = s.grounded || ledge - s.feet.y < STEP_KERB * radius;

  if (!onLedge || s.feet.y > limit || world.overlapsCapsule(s.feet, radius, height)) {
    s.feet.x = keptX;
    s.feet.y = keptY;
    s.feet.z = keptZ;
    s.grounded = keptGrounded;
    s.velocity.y = keptRise;
    return false;
  }

  // Standing on it, as that box would: an ungrounded capsule on the corner is a
  // falling one next tick, which cannot step, and slides back off the kerb it
  // was meant to ride up — a slow body never gets over a threshold that way.
  if (body.rideKerbs) {
    s.grounded = true;
    s.velocity.y = Math.max(0, s.velocity.y);
  }

  return true;
}

const scratch: Vec3 = { x: 0, y: 0, z: 0 };
/** The resolution `collide` hands the collision world to fill, so a tick allocates nothing. */
const resolution: CapsuleResolution = { position: { x: 0, y: 0, z: 0 }, grounded: false };

/** Push the capsule out of the world; ground stops a fall, and a ceiling ends a jump. */
function collide(s: MovementState, world: CapsuleWorld, body: MovementParams): void {
  if (!world.ready) {
    s.grounded = false;
    return;
  }
  scratch.x = s.feet.x;
  scratch.y = s.feet.y;
  scratch.z = s.feet.z;
  const result = world.resolveCapsule(scratch, body.radius, body.height, resolution);
  // Pushed down while rising, more than sideways: the head hit something, and
  // the jump ends there instead of pressing against it until gravity wins. A
  // wall's push can carry a fraction of a millimetre of down in it (a capsule
  // parallel to a triangle has no unique closest point), which must not end a
  // jump, or a ladder climb, along it.
  const down = s.feet.y - result.position.y;
  const aside = Math.hypot(result.position.x - s.feet.x, result.position.z - s.feet.z);
  const headHit = s.velocity.y > 0 && down > 1e-4 && down > aside;
  s.feet.x = result.position.x;
  s.feet.y = result.position.y;
  s.feet.z = result.position.z;
  s.grounded = result.grounded;
  if ((s.grounded && s.velocity.y < 0) || headHit) {
    s.velocity.y = 0;
  }
}
