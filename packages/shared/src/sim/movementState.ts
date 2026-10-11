// What a player's movement *is*: the body, the state a step advances, and the
// few numbers more than one move reads. No step is here — walking is
// sim/movement.ts, and the moves that replace it are sim/ladder.ts and
// sim/mantle.ts — so each of those can import this without importing another.

import type { Vec3 } from "./capsule.js";
import { UNIT } from "./units.js";

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

// -- Jumping -----------------------------------------------------------------------

/** Takeoff speed, m/s: a 0.84 m jump, 0.61 s in the air. */
export const JUMP_SPEED = 5.5;
/**
 * `sinceJump` counts up to this and stops: the longest any rule looks back at a
 * jump (JUMP_OFF_REPEAT), so the field has a bound to be sent in.
 */
export const JUMP_MEMORY = 0.5; // s

// -- State -------------------------------------------------------------------------

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
