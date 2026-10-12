// A path, turned into the input a player would give to walk it.
//
// This is the one definition of "walkable": the bake validates every link by
// running this against `stepMovement` (nav/validate.ts), and a bot walks a path
// with it. A link the bake calls VALID is one this follower crossed in
// simulation, so a bot using it can cross it too — the two cannot disagree about
// what a link needs, because they are the same code.
//
// Pure: everything it remembers is in the cursor, and it reads the movement
// state without touching it. It never looks at the world. What it cannot see
// (where a ledge is, whether a mantle volume is there) it learns the way a
// player does: by walking into it. A climb puts jump down when forward motion
// stops, which is when a body is against the obstacle and a mantle can start.

import type { PlayerInput } from "../sim/input.js";
import { JUMP_REPEAT, type MovementState, type Vec3 } from "../sim/movement.js";
import { stopDistance } from "../sim/moves/walk.js";
import { LINK_KINDS, TRAVERSAL_KINDS } from "./vocab.js";

/** A path's end is reached within this horizontally, m, standing on the ground. */
export const FOLLOW_ARRIVE = 0.4;
/** ...and within this vertically, m. */
export const FOLLOW_ARRIVE_DY = 0.6;
/** A node in the middle of a walk is passed within this, m. */
export const FOLLOW_PASS = 0.6;
/** Or once past it along the link, this close, m: running corners overshoot. */
const FOLLOW_PASS_BEHIND = 1.2;
/** Run while further than this from where the path stops, m. */
export const FOLLOW_RUN_BEYOND = 2;
/** Stuck: not this much closer to the current target, m... */
export const FOLLOW_STUCK_PROGRESS = 0.05;
/** ...in this many ticks on the ground or a ladder. A flight or a mantle always ends, and does not count. */
export const FOLLOW_STUCK_TICKS = 30;
/** In the air this many ticks is a flight; fewer is a moment off the ground, and counts as ticks on it. */
const FOLLOW_FLIGHT_TICKS = 15;
/** Stuck too after this many ticks without the ground, a ladder or a mantle: a flight that never lands. */
const FOLLOW_AIR_TICKS = 180;
/** Stuck too after this many jumps against an obstacle with no progress between them: a ledge out of reach. */
const FOLLOW_JUMP_TRIES = 4;
/** A jump across is taken off this far past its begin node, m: by then a body has most of its speed. */
const JUMP_RUNUP = 0.3;
/**
 * A jump across longer than this, m, is run at, and a shorter one walked at: a
 * walking jump carries about 3 m at full speed and a running one half as far
 * again, and one that overshoots a short gap lands past its end.
 */
const RUN_ACROSS = 2.4;
/** Forward motion under this share of what the velocity asks for, on the ground, is a body against something. */
const BLOCKED_SHARE = 0.3;
/** Up a ladder at full speed: `climbLadder`'s vertical share saturates past about 0.36 rad. */
const LADDER_UP_PITCH = 0.6;
/** Down a ladder at full speed: past about 40° down. */
const LADDER_DOWN_PITCH = -Math.PI / 3;

/** What the follower reads of a graph. `NavGraph` satisfies it, and so does the bake's graph under construction. */
export interface FollowGraph {
  readonly feet: Float32Array;
  readonly source: Uint32Array;
  readonly target: Uint32Array;
  readonly kind: Uint8Array;
  readonly traversalKind: Uint8Array;
}

/** Where along a path a follower is, and what it remembers about the leg it is on. */
export interface NavCursor {
  /** Link ids, in order. */
  links: ArrayLike<number>;
  /** The link being walked; `links.length` once they are done. */
  index: number;
  /** The step length the movement is stepped at, s: what "moved too little last tick" is measured against. */
  readonly dt: number;
  /** A point walked straight to after the last link (a player standing off the graph), or null. */
  goal: Vec3 | null;
  /** The nearest this leg has been to its target, m, and the ticks since it got nearer. */
  best: number;
  sinceBest: number;
  /** Ticks since the ground, a ladder or a mantle last held the player. */
  airborne: number;
  /** Jumps pressed against an obstacle since this leg last got closer. */
  tries: number;
  /** This leg's stage on a ladder: 0 until the ladder has been held, 1 after. */
  phase: number;
  /** Jump was down on the last call, so the next may release it (a press is an edge) or keep it down (a hold). */
  pressed: boolean;
  /** A jump across has taken off. */
  jumped: boolean;
  /** The feet on the last call, to tell a body walking from one pressed against a wall. */
  lastX: number;
  lastZ: number;
  hasLast: boolean;
}

export type FollowStatus = "moving" | "arrived" | "stuck";

/** A cursor at the start of `links`, for movement stepped every `dt` seconds. */
export function createCursor(links: ArrayLike<number>, dt: number, goal: Vec3 | null = null): NavCursor {
  return {
    links,
    index: 0,
    dt,
    goal,
    best: Infinity,
    sinceBest: 0,
    airborne: 0,
    tries: 0,
    phase: 0,
    pressed: false,
    jumped: false,
    lastX: 0,
    lastZ: 0,
    hasLast: false,
  };
}

/** Put a cursor at the start of its next leg. Exported for a mover that crosses a traversal itself (game/bots/motor.ts). */
export function nextLeg(cursor: NavCursor): void {
  cursor.index++;
  cursor.best = Infinity;
  cursor.sinceBest = 0;
  cursor.airborne = 0;
  cursor.tries = 0;
  cursor.phase = 0;
  cursor.pressed = false;
  cursor.jumped = false;
}

/** The yaw that faces along (dx, dz): the player faces (-sin yaw, -cos yaw). */
function yawAlong(dx: number, dz: number): number {
  return Math.atan2(-dx, -dz);
}

/**
 * Write into `out` the input that carries `m` along the cursor's path, and say
 * whether it is still going. "stuck" is this follower's own verdict: no closer to
 * the current target by FOLLOW_STUCK_PROGRESS in FOLLOW_STUCK_TICKS ticks on the
 * ground, FOLLOW_JUMP_TRIES jumps at an obstacle to no effect, a flight that
 * never lands, or a link it has no move for. Call once per tick, before the step.
 */
export function followPath(m: Readonly<MovementState>, cursor: NavCursor, graph: FollowGraph, out: PlayerInput): FollowStatus {
  out.yaw = m.yaw;
  out.pitch = 0;
  out.forward = 0;
  out.right = 0;
  out.run = false;
  out.jump = false;
  out.fire = false;
  out.ads = false;
  out.reload = false;
  out.swap = false;

  // Blocked: the last step moved the feet less than a share of what the velocity
  // asked, measured along the velocity — a body jittering against a ledge moves,
  // but not forward.
  const speed = Math.hypot(m.velocity.x, m.velocity.z);
  const asked = speed * cursor.dt;
  const moved = cursor.hasLast && speed > 0 ? ((m.feet.x - cursor.lastX) * m.velocity.x + (m.feet.z - cursor.lastZ) * m.velocity.z) / speed : Infinity;
  const blocked = m.grounded && asked > 0.01 && moved < BLOCKED_SHARE * asked;
  cursor.lastX = m.feet.x;
  cursor.lastZ = m.feet.z;
  cursor.hasLast = true;

  const f = graph.feet;
  // Advance past every leg already done; a pass can finish several at once.
  for (;;) {
    const count = cursor.links.length;
    if (cursor.index > count || (cursor.index === count && !cursor.goal)) {
      return "arrived";
    }
    const onGoal = cursor.index === count;
    const link = onGoal ? -1 : cursor.links[cursor.index]!;
    const to = onGoal ? -1 : graph.target[link]!;
    const tx = onGoal ? cursor.goal!.x : f[to * 3]!;
    const ty = onGoal ? cursor.goal!.y : f[to * 3 + 1]!;
    const tz = onGoal ? cursor.goal!.z : f[to * 3 + 2]!;
    const dx = tx - m.feet.x;
    const dy = ty - m.feet.y;
    const dz = tz - m.feet.z;
    const horizontal = Math.hypot(dx, dz);
    const last = onGoal || (cursor.index === count - 1 && !cursor.goal);
    const next = last || onGoal ? -1 : cursor.index + 1 < count ? cursor.links[cursor.index + 1]! : -1;
    const nextIsWalk = next < 0 ? !last : graph.kind[next] === LINK_KINDS.WALK;

    if (!onGoal && graph.kind[link] !== LINK_KINDS.WALK && graph.kind[link] !== LINK_KINDS.TRAVERSE) {
      return "stuck";
    }

    const settled = m.move.kind === "walk" && m.grounded;
    const level = Math.abs(dy) <= FOLLOW_ARRIVE_DY;
    if (last) {
      if (horizontal <= FOLLOW_ARRIVE && level && settled) {
        nextLeg(cursor);
        if (onGoal) {
          cursor.index = count + 1;
        }
        return "arrived";
      }
    } else if (settled && level) {
      const radius = nextIsWalk ? FOLLOW_PASS : FOLLOW_ARRIVE;
      let passed = horizontal <= radius;
      if (!passed && nextIsWalk && !onGoal && horizontal <= FOLLOW_PASS_BEHIND) {
        // Past the node along its own link: a runner's corner, not a miss.
        const from = graph.source[link]!;
        passed = (tx - f[from * 3]!) * -dx + (tz - f[from * 3 + 2]!) * -dz > 0;
      }
      if (passed) {
        nextLeg(cursor);
        continue;
      }
    }

    // Progress is measured where the player stands. A mantle is on rails and may
    // climb away from the target first (onto a wall, to drop off its far side),
    // and a flight may pass over the target and land beyond it: both end by
    // themselves, and neither is a player getting nowhere. Back on the ground (or
    // a ladder), progress is measured afresh from where they came down.
    const distance = Math.hypot(horizontal, dy);
    if (m.move.kind === "mantle") {
      cursor.airborne = 1;
    } else if (!m.grounded && m.move.kind !== "ladder") {
      if (++cursor.airborne >= FOLLOW_AIR_TICKS) {
        return "stuck";
      }
    } else if (cursor.airborne >= FOLLOW_FLIGHT_TICKS) {
      cursor.airborne = 0;
      cursor.best = distance;
      cursor.sinceBest = 0;
    } else if (cursor.airborne > 0) {
      // Off the ground for a moment is not a flight: a body jammed where nothing
      // is under it leaves and finds the ground over and over, getting nowhere.
      cursor.sinceBest += cursor.airborne;
      cursor.airborne = 0;
    } else if (distance < cursor.best - FOLLOW_STUCK_PROGRESS) {
      cursor.best = distance;
      cursor.sinceBest = 0;
      cursor.tries = 0;
    } else if (++cursor.sinceBest >= FOLLOW_STUCK_TICKS || cursor.tries >= FOLLOW_JUMP_TRIES) {
      return "stuck";
    }

    const facing = horizontal > 0.05 ? yawAlong(dx, dz) : m.yaw;
    if (onGoal || graph.kind[link] === LINK_KINDS.WALK) {
      if (m.move.kind === "ladder") {
        leaveLadder(m, cursor, out, facing);
      } else {
        walk(out, facing, horizontal, horizontal > FOLLOW_RUN_BEYOND || nextIsWalk);
        // Where the path stops, the keys are let go as far out as the skid is long.
        if (m.grounded && stopsWithin(cursor, graph, tx, tz, horizontal, stopDistance(speed))) {
          out.forward = 0;
        }
      }
      return "moving";
    }
    return traverse(m, cursor, graph, link, out, facing, horizontal, blocked) ? "moving" : "stuck";
  }
}

/**
 * Whether the path stops within `reach` of the feet, walking all the way: this
 * leg's target is `horizontal` off at (tx, tz), and the legs after it are added
 * until they pass `reach`, end, or are not a walk.
 */
function stopsWithin(cursor: NavCursor, graph: FollowGraph, tx: number, tz: number, horizontal: number, reach: number): boolean {
  const f = graph.feet;
  const count = cursor.links.length;
  let total = horizontal;
  let x = tx;
  let z = tz;
  for (let i = cursor.index + 1; i < count && total <= reach; i++) {
    const link = cursor.links[i]!;
    if (graph.kind[link] !== LINK_KINDS.WALK) {
      return false;
    }
    const to = graph.target[link]! * 3;
    total += Math.hypot(f[to]! - x, f[to + 2]! - z);
    x = f[to]!;
    z = f[to + 2]!;
  }
  if (cursor.goal && cursor.index < count) {
    total += Math.hypot(cursor.goal.x - x, cursor.goal.z - z);
  }
  return total <= reach;
}

/**
 * Press jump against an obstacle: a press is an edge, so never two ticks
 * running. One too soon after the last jump to be another is not counted as a
 * jump tried.
 */
function press(m: Readonly<MovementState>, cursor: NavCursor, out: PlayerInput, blocked: boolean): void {
  out.jump = blocked && !cursor.pressed;
  cursor.pressed = out.jump;
  if (out.jump && m.sinceJump >= JUMP_REPEAT) {
    cursor.tries++;
  }
}

/**
 * Hold jump against an obstacle, for a mantle: down from the first tick
 * against it and through any jump that press began. On the ground it is let
 * go for one tick whenever a new press would be a jump, so a ledge that
 * offers nothing from the ground is jumped at again, and counted.
 */
function hold(m: Readonly<MovementState>, cursor: NavCursor, out: PlayerInput, blocked: boolean): void {
  const again = cursor.pressed && m.sinceJump >= JUMP_REPEAT;
  out.jump = m.grounded ? blocked && !again : cursor.pressed;
  if (out.jump && !cursor.pressed && m.sinceJump >= JUMP_REPEAT) {
    cursor.tries++;
  }
  cursor.pressed = out.jump;
}

/**
 * Off a ladder this link does not climb (grabbed by walking or falling past
 * one): standing, let go of forward; in the air, jump off it towards the target.
 */
function leaveLadder(m: Readonly<MovementState>, cursor: NavCursor, out: PlayerInput, facing: number): void {
  out.yaw = facing;
  if (!m.grounded) {
    out.jump = !cursor.pressed;
    cursor.pressed = out.jump;
  }
}

function walk(out: PlayerInput, yaw: number, horizontal: number, run: boolean): void {
  out.yaw = yaw;
  out.forward = horizontal > 0.05 ? 1 : 0;
  out.run = run;
}

/** One tick of a traversal link. False for a kind our player has no move for. */
function traverse(
  m: Readonly<MovementState>,
  cursor: NavCursor,
  graph: FollowGraph,
  link: number,
  out: PlayerInput,
  facing: number,
  horizontal: number,
  blocked: boolean,
): boolean {
  const f = graph.feet;
  const from = graph.source[link]!;
  const to = graph.target[link]!;
  const bx = f[from * 3]!;
  const bz = f[from * 3 + 2]!;
  const ax = f[to * 3]! - bx;
  const az = f[to * 3 + 2]! - bz;
  const across = Math.hypot(ax, az);
  const along = across > 0.05 ? yawAlong(ax, az) : facing;

  const kind = graph.traversalKind[link];
  const ladder = kind === TRAVERSAL_KINDS.LADDER_UP || kind === TRAVERSAL_KINDS.LADDER_DOWN;
  const move = m.move;
  if (move.kind === "mantle") {
    // On rails: no key is needed, and letting jump go makes the next one a press.
    out.yaw = along;
    cursor.pressed = false;
    return true;
  }
  if (move.kind === "ladder" && !ladder) {
    leaveLadder(m, cursor, out, facing);
    return true;
  }

  switch (kind) {
    case TRAVERSAL_KINDS.MANTLE_ON:
    case TRAVERSAL_KINDS.MANTLE_OVER:
      // Walk at it; against it, hold jump. A mantle starts on any step the key
      // is down facing its ledge, and a ledge out of reach from the ground is
      // in reach from the top of the jump the press began.
      walk(out, facing, horizontal, false);
      hold(m, cursor, out, blocked);
      return true;

    case TRAVERSAL_KINDS.STEP_UP:
    case TRAVERSAL_KINDS.JUMP_UP:
    case TRAVERSAL_KINDS.JUMP_DOWN:
      // Walk at it; against it, press jump, which the forward key carries onto
      // anything a jump clears. A jump down walks off its edge, and presses
      // only where a railing is in the way.
      walk(out, facing, horizontal, false);
      press(m, cursor, out, blocked);
      return true;

    case TRAVERSAL_KINDS.JUMP_ACROSS: {
      const long = across > RUN_ACROSS;
      walk(out, facing, horizontal, long);
      if (m.jumpFrom !== null && !m.grounded) {
        cursor.jumped = true;
      } else if (!cursor.jumped && m.grounded && !cursor.pressed) {
        // A jump is taken from the ground or not at all, so it is pressed
        // before the edge: past the run-up, or against something sooner.
        const run = ((m.feet.x - bx) * ax + (m.feet.z - bz) * az) / Math.max(across, 1e-6);
        out.jump = blocked || run >= JUMP_RUNUP;
      }
      cursor.pressed = out.jump;
      return true;
    }

    case TRAVERSAL_KINDS.LADDER_UP:
      if (move.kind === "ladder") {
        cursor.phase = 1;
        out.yaw = along;
        out.pitch = LADDER_UP_PITCH;
        out.forward = 1;
        return true;
      }
      // Into the ladder until it is held, then over its top to the end.
      walk(out, cursor.phase === 0 ? along : facing, horizontal, false);
      out.pitch = LADDER_UP_PITCH;
      return true;

    case TRAVERSAL_KINDS.LADDER_DOWN:
      if (move.kind === "ladder") {
        cursor.phase = 1;
        // At the foot, standing: let go of forward, which lets go of the ladder.
        if (m.grounded) {
          out.yaw = m.yaw;
          return true;
        }
        out.yaw = move.facing + Math.PI;
        out.pitch = LADDER_DOWN_PITCH;
        out.forward = 1;
        return true;
      }
      if (cursor.phase === 0) {
        // Backward off the top, facing back the way the link came: falling past
        // the ladder facing it is what catches its climbing side.
        out.yaw = across > 0.05 ? yawAlong(-ax, -az) : m.yaw;
        out.forward = -1;
        return true;
      }
      walk(out, facing, horizontal, false);
      return true;

    default:
      // SPECIAL, UNKNOWN, and any kind this build does not know: no move for it.
      return false;
  }
}
