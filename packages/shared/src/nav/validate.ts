// The definitive check on a link: walk it, in simulation, with the follower a
// bot will use.
//
// A scratch player stands at the link's start and nav/follow.ts drives
// `stepMovement` towards its end at the match's own tick, with the world's
// mantle volumes and ladders exactly as a player gets them. It passes when the
// follower says it arrived, and fails when it says it is stuck, when the time
// runs out, or when it falls far below both ends. What it costs is the time it
// took; what it requires is what it had to do (mantle, climb, jump, drop).
//
// This touches the world only through `stepMovement` — `resolveCapsule`,
// `overlapsCapsule` and `groundBelow` — and never `traceRay`, so a change to what
// stops bullets never changes what a bot can walk (tests/navValidate.test.ts).

import type { PlayerInput } from "../sim/input.js";
import { idleInput } from "../sim/input.js";
import { createMovement, EMPTY_HANDS, stepMovement, WALK_SPEED, type MovementEnv, type MovementState } from "../sim/movement.js";
import { createCursor, followPath, type FollowGraph } from "./follow.js";
import { LINK_REASON, LINK_STATUS } from "./graph.js";
import { ABILITIES, LINK_KINDS } from "./vocab.js";

/** A fall longer than this, m, is a drop: more than a jump's own. */
export const DROP_ABILITY_HEIGHT = 1;
/** Below both ends by this much, m, the follower has fallen off something and will not be back. */
const FELL_BELOW = 4;
/** Seconds added to a traversal's time limit: a mantle alone takes up to 1.07. */
const TRAVERSAL_ALLOWANCE = 1.5;
/** Seconds per metre of height in the time limit: under a ladder's climbing speed (2.4 m/s). */
const VERTICAL_ALLOWANCE = 1 / 1.2;
/** Ticks the time limit always allows on top. */
const SLACK_TICKS = 30;
/** Idle ticks to settle onto the start before the clock starts. */
const SETTLE_TICKS = 2;

/** What a link's validation needs. */
export interface ValidateEnv {
  /** The world, its climbs and a player's body: what the follower is stepped in. */
  readonly movement: MovementEnv;
  /** The match's step, s: `1 / tickRate`. A link is walked at the rate a bot walks it. */
  readonly dt: number;
  readonly graph: FollowGraph;
  /** Per node, `ABILITIES` its file record asks for. */
  readonly nodeAbilities: Uint32Array;
}

/** The verdict on one link. */
export interface LinkOutcome {
  status: number;
  reason: number;
  /** Seconds it took, VALID only. */
  seconds: number;
  requires: number;
  /** Ticks simulated, whatever the verdict: what it cost. */
  ticks: number;
}

/** The ticks a link of this shape may take before it has timed out. */
export function timeLimit(horizontal: number, vertical: number, traversal: boolean, dt: number): number {
  const seconds = (1.5 * horizontal) / WALK_SPEED + vertical * VERTICAL_ALLOWANCE + (traversal ? TRAVERSAL_ALLOWANCE : 0);
  return Math.ceil(seconds / dt) + SLACK_TICKS;
}

const input: PlayerInput = idleInput(0, 0);
const one = [0];

/** Walk `link` in simulation and judge it. Deterministic: the same link, world and rules give the same outcome. */
export function simulateLink(env: ValidateEnv, link: number, out: LinkOutcome): LinkOutcome {
  const g = env.graph;
  const from = g.source[link]!;
  const to = g.target[link]!;
  const f = g.feet;
  const sx = f[from * 3]!;
  const sy = f[from * 3 + 1]!;
  const sz = f[from * 3 + 2]!;
  const dx = f[to * 3]! - sx;
  const dy = f[to * 3 + 1]! - sy;
  const dz = f[to * 3 + 2]! - sz;
  const traversal = g.kind[link] !== LINK_KINDS.WALK;
  const limit = timeLimit(Math.hypot(dx, dz), Math.abs(dy), traversal, env.dt);
  const floor = Math.min(sy, sy + dy) - FELL_BELOW;

  const s: MovementState = createMovement({ x: sx, y: sy, z: sz }, Math.atan2(-dx, -dz), 0);
  const settle = idleInput(s.yaw, 0);
  for (let i = 0; i < SETTLE_TICKS; i++) {
    stepMovement(s, settle, env.dt, env.movement, EMPTY_HANDS);
  }

  one[0] = link;
  const cursor = createCursor(one, env.dt);
  let requires = ABILITIES.WALK | env.nodeAbilities[to]!;
  let airTop = s.feet.y;
  out.status = LINK_STATUS.INVALID;
  out.reason = LINK_REASON.TIMEOUT;
  out.seconds = Number.NaN;
  for (let tick = 0; tick < limit; tick++) {
    const status = followPath(s, cursor, g, input);
    if (status === "arrived") {
      out.status = LINK_STATUS.VALID;
      out.reason = LINK_REASON.NONE;
      out.seconds = tick * env.dt;
      out.ticks = tick;
      out.requires = requires;
      return out;
    }
    if (status === "stuck") {
      out.reason = LINK_REASON.STUCK;
      out.ticks = tick;
      out.requires = requires;
      return out;
    }
    stepMovement(s, input, env.dt, env.movement, EMPTY_HANDS);

    if (s.move.kind === "mantle") {
      requires |= ABILITIES.MANTLE;
    }
    if (s.move.kind === "ladder") {
      requires |= ABILITIES.LADDER;
    }
    if (s.jumpFrom !== null && s.sinceJump === 0) {
      requires |= ABILITIES.JUMP;
    }
    // A drop is measured from the top of a flight to where it lands.
    if (s.grounded || s.move.kind !== "walk") {
      if (airTop - s.feet.y > DROP_ABILITY_HEIGHT) {
        requires |= ABILITIES.DROP;
      }
      airTop = s.feet.y;
    } else {
      airTop = Math.max(airTop, s.feet.y);
    }
    if (s.feet.y < floor) {
      out.reason = LINK_REASON.FELL;
      out.ticks = tick + 1;
      out.requires = requires;
      return out;
    }
  }
  out.ticks = limit;
  out.requires = requires;
  return out;
}
