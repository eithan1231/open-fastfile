// The clocks a body is posed from: how far into a stride the feet are, and how
// far through each change of gait, of footing and of heading the pose has got.
//
// Simulation state rather than a drawing detail, stepped here once per movement
// step: a bullet is traced against a posed skeleton, so both ends have to reach
// the same pose from the same inputs. What reads them is sim/pose.ts.

import { horizontalSpeed, type MovementParams, type MovementState, type StanceKind } from "./movementState.js";
import { stanceSpeed } from "./stance.js";

/**
 * Below this a player is standing still as far as the legs are concerned, so the
 * stride clock stops and the idle clip takes over. Here rather than in the
 * animator because `stride` is simulation state now — see `advanceStride`.
 */
export const IDLE_SPEED = 0.35;
/**
 * Seconds one full stride takes at a body's run speed, which is what `stride` counts in.
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
/**
 * Seconds one loop of a stance's moving clips takes at that stance's own top
 * speed: what keeps a foot on the ground it is drawn on. Crouched and prone it
 * is the forward loop's own travel over the stance's speed, 6.9 m and 2.8 m —
 * constants for STRIDE_PERIOD's reason, and each game's own are in
 * docs/cod/pipeline.md#the-player-clip-set.
 */
const STANCE_STRIDE_PERIOD: Record<StanceKind, number> = { stand: STRIDE_PERIOD, crouch: 2.2, prone: 3.9 };
/** How far the stride rate may be pushed from the clip's own by the speed being made. */
const STRIDE_RATE_RANGE = [0.35, 1.6] as const;

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
  const moving = s.move.kind === "walk" && speed > IDLE_SPEED;
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
export function advanceStride(s: MovementState, dt: number, body: MovementParams): void {
  if (s.move.kind !== "walk") {
    s.stride = 0;
    return;
  }
  const speed = horizontalSpeed(s);
  if (s.grounded && speed <= IDLE_SPEED) {
    return;
  }
  const kind = s.stance.kind;
  const top = kind === "stand" ? body.runSpeed : body.walkSpeed * stanceSpeed(kind);
  const rate = Math.max(STRIDE_RATE_RANGE[0], Math.min(STRIDE_RATE_RANGE[1], speed / top));
  s.stride = (s.stride + (dt * rate) / STANCE_STRIDE_PERIOD[kind]) % 1;
}
