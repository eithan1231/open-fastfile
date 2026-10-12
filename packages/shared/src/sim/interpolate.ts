// What a peer looks like *between* two ticks — the one definition of it.
//
// This exists as shared code rather than as a detail of the client's renderer
// because lag compensation makes it load-bearing on both ends. A client draws
// another player one tick behind the newest snapshot, interpolated; when that
// client shoots, the server rewinds to reproduce what they were aiming at. If the
// server's idea of "between tick 41 and 42, 37% of the way" differed from the
// client's by even a body's width, a hit would land where nobody was.
//
// So both ends call `lerpMovement`, and a rewind is a lookup plus this function.
// Anything added here must stay a pure function of its two endpoints: no clock, no
// state of its own, nothing read from the outside.
//
// **Every field of `MovementState` has to appear in both functions below**, and
// nothing in the type system says so: these write onto an object the caller already
// has, so a field left out keeps whatever that object held rather than failing to
// compile. That is not hypothetical — `gait` and `airborne` were added to the state
// and forgotten here, and the symptom was every peer standing still, because a body
// is drawn from an interpolated state and theirs came back a permanent zero. The
// wire has `satisfies Codec<MovementState>` to make the same mistake a build
// failure; this has `tests/interpolate.test.ts`, which round-trips a state with every
// field distinct and compares the whole object.

import { CROUCHING, STANDING, WALKING, type EyeShift, type Move, type MovementState, type Stance } from "./movementState.js";
import { eyePathSeconds, reversedEyePath } from "./stance.js";

/** Turning from `a` to `b` the short way round, so crossing ±π does not spin the body. */
export function shortestTurn(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) {
    d -= Math.PI * 2;
  }
  if (d < -Math.PI) {
    d += Math.PI * 2;
  }
  return d;
}

/**
 * The same for a phase in [0, 1) — the stride clock.
 *
 * Needed for the same reason as `shortestTurn` and easier to get wrong: a stride
 * running 0.98 → 0.02 has advanced 4% of a cycle, and interpolating the raw
 * numbers walks it *backwards* through 0.5, which is a leg swinging the wrong way
 * for one frame every stride. Only ever a short way round, because a cycle takes
 * STRIDE_PERIOD and a tick is a fraction of it.
 */
export function shortestPhase(a: number, b: number): number {
  let d = (b - a) % 1;
  if (d > 0.5) {
    d -= 1;
  }
  if (d < -0.5) {
    d += 1;
  }
  return d;
}

/** True where a gap between two samples is a placement rather than a movement: a spawn, or a stalled client. */
export const TELEPORT_DISTANCE = 2;

/**
 * Is the step from `from` to `to` a teleport rather than a move?
 *
 * Interpolating across one draws a body sliding through the world at an
 * impossible speed, so the caller snaps to `to` instead.
 */
export function teleported(from: MovementState, to: MovementState): boolean {
  return Math.abs(to.feet.x - from.feet.x) > TELEPORT_DISTANCE || Math.abs(to.feet.z - from.feet.z) > TELEPORT_DISTANCE;
}

/**
 * Copy `src` over `dst`, field by field, allocating only what it has to.
 *
 * For a caller keeping a ring of past states: preallocate the states once and
 * overwrite them, rather than `structuredClone`ing one per player per tick. The
 * move is the only thing that can allocate, and only on the tick somebody gets
 * onto a ladder or a ledge.
 */
export function copyMovement(src: MovementState, dst: MovementState): MovementState {
  dst.feet.x = src.feet.x;
  dst.feet.y = src.feet.y;
  dst.feet.z = src.feet.z;
  dst.velocity.x = src.velocity.x;
  dst.velocity.y = src.velocity.y;
  dst.velocity.z = src.velocity.z;
  dst.yaw = src.yaw;
  dst.pitch = src.pitch;
  dst.grounded = src.grounded;
  dst.jumpFrom = src.jumpFrom;
  dst.landing = src.landing;
  dst.ladderLock = src.ladderLock;
  dst.sinceJump = src.sinceJump;
  dst.jumpHeld = src.jumpHeld;
  dst.gait = src.gait;
  dst.airborne = src.airborne;
  dst.travelForward = src.travelForward;
  dst.travelRight = src.travelRight;
  dst.stride = src.stride;

  dst.move = copyMove(src.move, dst.move);
  dst.stance = copyStance(src.stance, dst.stance);
  dst.eyeShift = src.eyeShift === null ? null : writeEyeShift(dst.eyeShift, src.eyeShift.path, src.eyeShift.elapsed);
  return dst;
}

/** `src` as `dst` may keep it: its own object lying down, whose fields a step writes, reused when `dst` is lying too. */
function copyStance(src: Stance, dst: Stance): Stance {
  switch (src.kind) {
    case "stand":
      return STANDING;
    case "crouch":
      return CROUCHING;
    case "prone":
      if (dst.kind !== "prone") {
        return { kind: "prone", heading: src.heading, torso: src.torso };
      }
      dst.heading = src.heading;
      dst.torso = src.torso;
      return dst;
  }
}

/** An eye shift written into `into`, or a new one where there is none to reuse. */
function writeEyeShift(into: EyeShift | null, path: EyeShift["path"], elapsed: number): EyeShift {
  if (into === null) {
    return { path, elapsed };
  }
  into.path = path;
  into.elapsed = elapsed;
  return into;
}

/**
 * The eye between two ticks, as a shift of `out`'s own. Along one leg it is
 * that leg's clock interpolated. A leg `to` no longer has is run to its end,
 * where the next begins — unless `to` turned it round, which leaves the eye
 * where `from` has it.
 */
function lerpEyeShift(from: EyeShift | null, to: EyeShift | null, k: number, out: EyeShift | null): EyeShift | null {
  if (from === null) {
    return null;
  }
  const { path, elapsed } = from;
  if (to !== null && to.path === path) {
    return writeEyeShift(out, path, elapsed + (to.elapsed - elapsed) * k);
  }
  if (to !== null && to.path === reversedEyePath(path)) {
    return writeEyeShift(out, path, elapsed);
  }
  return writeEyeShift(out, path, elapsed + (eyePathSeconds(path) - elapsed) * k);
}

/** `src` as `dst` may keep it: its own object for a move with fields a step writes, reused when `dst` is already in that move. */
function copyMove(src: Move, dst: Move): Move {
  switch (src.kind) {
    case "walk":
      return WALKING;
    case "mantle":
      if (dst.kind !== "mantle") {
        return { kind: "mantle", ledge: { ...src.ledge }, yaw: src.yaw, row: src.row, over: src.over, left: src.left };
      }
      dst.ledge.x = src.ledge.x;
      dst.ledge.y = src.ledge.y;
      dst.ledge.z = src.ledge.z;
      dst.yaw = src.yaw;
      dst.row = src.row;
      dst.over = src.over;
      dst.left = src.left;
      return dst;
    case "ladder":
      if (dst.kind !== "ladder") {
        return { kind: "ladder", facing: src.facing };
      }
      dst.facing = src.facing;
      return dst;
  }
}

/**
 * `from` and `to` blended at `t` in [0, 1], written into `out`.
 *
 * Continuous quantities are interpolated; **discrete ones are taken from `from`**,
 * which is the state that was actually true at the earlier tick and therefore
 * true throughout the span being drawn. Blending them would be meaningless
 * (there is no half a ladder) and the errors would be the worst kind: a body
 * momentarily neither climbing nor walking.
 *
 * `out` may be `from` or `to`; every read happens before the matching write.
 */
export function lerpMovement(from: MovementState, to: MovementState, t: number, out: MovementState): MovementState {
  const k = t <= 0 ? 0 : t >= 1 ? 1 : t;

  out.feet.x = from.feet.x + (to.feet.x - from.feet.x) * k;
  out.feet.y = from.feet.y + (to.feet.y - from.feet.y) * k;
  out.feet.z = from.feet.z + (to.feet.z - from.feet.z) * k;
  out.velocity.x = from.velocity.x + (to.velocity.x - from.velocity.x) * k;
  out.velocity.y = from.velocity.y + (to.velocity.y - from.velocity.y) * k;
  out.velocity.z = from.velocity.z + (to.velocity.z - from.velocity.z) * k;
  out.yaw = from.yaw + shortestTurn(from.yaw, to.yaw) * k;
  out.pitch = from.pitch + (to.pitch - from.pitch) * k;
  // The pose blends, which are plain 0..1 ramps rather than phases: they do not
  // wrap, so they interpolate like any other quantity.
  out.gait = from.gait + (to.gait - from.gait) * k;
  out.airborne = from.airborne + (to.airborne - from.airborne) * k;
  // The direction of travel, which is a plain pair of ramps and not an angle: it
  // is interpolated component-wise for the same reason it is *stepped* that way,
  // that the straight line between two headings runs through the middle.
  out.travelForward = from.travelForward + (to.travelForward - from.travelForward) * k;
  out.travelRight = from.travelRight + (to.travelRight - from.travelRight) * k;
  // A stride is a phase, so `shortestPhase` may carry it either side of an end and
  // it has to come back into [0, 1). Wrapped only when it actually left: `% 1` is
  // not exact on a value already in range, and at k = 0 that noise would make this
  // function not quite the identity — which is a property worth having, and what
  // `tests/interpolate.test.ts` compares whole objects against.
  const stride = from.stride + shortestPhase(from.stride, to.stride) * k;
  out.stride = stride < 0 ? stride + 1 : stride >= 1 ? stride - 1 : stride;

  // Discrete, so `from`'s answer stands for the whole span.
  out.grounded = from.grounded;
  out.jumpFrom = from.jumpFrom;
  out.ladderLock = from.ladderLock;
  out.jumpHeld = from.jumpHeld;
  out.move = from.move;
  out.stance = from.stance;
  // The eye is drawn, and from it a peer's shot is placed: it moves between two ticks as the feet do.
  out.eyeShift = lerpEyeShift(from.eyeShift, to.eyeShift, k, out.eyeShift === from.eyeShift || out.eyeShift === to.eyeShift ? null : out.eyeShift);
  // Timers count down within a tick, so they interpolate; they are also what a
  // landing's fade is timed by, and a body that snapped between two would flicker.
  out.landing = from.landing + (to.landing - from.landing) * k;
  out.sinceJump = from.sinceJump + (to.sinceJump - from.sinceJump) * k;
  return out;
}
