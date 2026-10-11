// What a player's movement *is*: the body, the state a step advances, and the
// few numbers more than one move reads. No step is here — sim/movement.ts is
// the step and sim/moves/ has one module per move — so each of those can import
// this without importing another.

import { WALKABLE_NORMAL_Y, type Vec3 } from "./capsule.js";
import { UNIT } from "./units.js";

// -- The body ----------------------------------------------------------------------

// Every number here is the games' own, in their units (reverse/iw5-pmove/).

export const RADIUS = 15 * UNIT;
export const HEIGHT = 70 * UNIT;
/**
 * The eye above the feet. A catalogue body posed standing puts its `tag_eye` at
 * 1.47–1.48 m and the top of its head at 1.62–1.69 m, and a round leaves from
 * here (`Match.trace`): an eye any higher sees and shoots over a wall from above
 * the head anyone could shoot back at.
 */
export const EYE_HEIGHT = 60 * UNIT;
const PITCH_LIMIT = Math.PI / 2 - 0.01;

// -- Walking and running -----------------------------------------------------------

/** m/s, with nothing held: every other speed of a player's is a share of this. */
export const WALK_SPEED = 190 * UNIT;
/** A sprint, as a share of the walk. */
const SPRINT_SCALE = 1.5;
export const RUN_SPEED = WALK_SPEED * SPRINT_SCALE;

/**
 * The body a step moves and the speeds its keys ask for. A player's is
 * `PLAYER_MOVEMENT`, on both ends; an actor's kind names its own
 * (game/actors/), stepped on the server alone.
 */
export interface MovementParams {
  /** The capsule, m. */
  readonly radius: number;
  readonly height: number;
  /** m/s forward, without and with a sprint. Sideways, backward and in the air are shares of the walk (sim/moves/walk.ts). */
  readonly walkSpeed: number;
  readonly runSpeed: number;
  /**
   * The least a contact under this body may face up (`CapsuleResolution.normal.y`)
   * for it to stand there. A player's is the walkable limit: steeper, it slides,
   * and gets up a short bank only at speed.
   */
  readonly footing: number;
}

export const PLAYER_MOVEMENT: MovementParams = {
  radius: RADIUS,
  height: HEIGHT,
  walkSpeed: WALK_SPEED,
  runSpeed: RUN_SPEED,
  footing: WALKABLE_NORMAL_Y,
};

// -- Jumping -----------------------------------------------------------------------

export const GRAVITY = 800 * UNIT; // m/s²
/** How high a jump lifts the feet, and the takeoff speed that does it. */
export const JUMP_HEIGHT = 39 * UNIT;
export const JUMP_SPEED = Math.sqrt(2 * JUMP_HEIGHT * GRAVITY);
/**
 * Seconds from one takeoff before the next jump, off the ground or off a
 * ladder. `sinceJump` counts up to this and stops, being the longest any rule
 * looks back at a jump, so the field has a bound to be sent in.
 */
export const JUMP_REPEAT = 0.5;
/**
 * Seconds a landing from a jump is felt for: friction is raised and a jump is
 * lower, both wearing off across it (sim/moves/walk.ts). A landing well above
 * the takeoff starts it part-way in, at LAND_WINDOW_HIGH.
 */
export const LAND_WINDOW = 1.8;
export const LAND_WINDOW_HIGH = 1.2;

// -- State -------------------------------------------------------------------------

/** Walking, running, jumping and falling: the move a player is in unless another has taken over. */
export interface WalkMove {
  kind: "walk";
}

/**
 * A climb under way: the player is on rails, with no gravity, no friction, no
 * keys and no collision resolution. The path was checked clear before it began
 * (sim/moves/mantle.ts), and resolving against the corner it hugs would only
 * nudge it off the line a server replays.
 */
export interface MantleMove {
  kind: "mantle";
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

/** A ladder being climbed: steered by the view and the keys, and still resolved against the world. */
export interface LadderMove {
  kind: "ladder";
  /**
   * Which way the side they grabbed faces, as a yaw (its outward normal, the way
   * a player facing out from it would look). Fixed at the grab, as the game's
   * `vLadderVec` is: never refreshed while climbing.
   */
  facing: number;
}

/**
 * Which move owns a player's step. Exactly one does, so every reader switches
 * on `kind` rather than testing the moves one by one.
 */
export type Move = WalkMove | MantleMove | LadderMove;

/** The walk every state shares, so entering it allocates nothing. Frozen: a move's fields are only ever its own. */
export const WALKING: WalkMove = Object.freeze({ kind: "walk" });

/**
 * Everything about a player's movement that changes as they play, as plain
 * JSON-safe data (no three.js values, no Infinity): what a network sends.
 * tests/player.test.ts runs a JSON copy in lockstep to keep it complete.
 */
export interface MovementState {
  /** The bottom of the capsule, world metres. */
  feet: Vec3;
  /** m/s. Walking, it lies along the ground under the feet, so it rises and falls with a slope. */
  velocity: Vec3;
  /** Radians: yaw about +Y (0 faces -Z), pitch up positive. */
  yaw: number;
  pitch: number;
  /** Standing on walkable ground after the last step: what the next one walks on, jumps from and sprints on. */
  grounded: boolean;
  /**
   * The feet's height at the takeoff of the jump under way, or null: in the air
   * from a jump rather than a fall, until the first step back on the ground —
   * which is the one that takes the landing's cost.
   */
  jumpFrom: number | null;
  /** Seconds left of the landing from a jump (LAND_WINDOW); 0 once it has worn off, or in the air. */
  landing: number;
  /** The move that owns this player's steps: walking, unless a climb or a ladder has taken over. */
  move: Move;
  /**
   * Off a ladder by any way but a jump, and not yet back on the ground: no
   * ladder can be grabbed until they are. The game's pm_flags 0x1000.
   */
  ladderLock: boolean;
  /** Seconds since the last takeoff, stopping at JUMP_REPEAT. */
  sinceJump: number;
  /** Jump was held last step, so a held key is not a new press: a jump, and a jump off a ladder, each need one. */
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
   * Its own field rather than derived from `sinceJump` and `landing` between
   * them: those cover a jump, and say nothing about walking off a ledge.
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
    jumpFrom: null,
    landing: 0,
    move: WALKING,
    ladderLock: false,
    sinceJump: JUMP_REPEAT,
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
