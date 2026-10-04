// The cheap look along a derived walk link, before the simulation that decides
// it: a few hundred microseconds that throw out the pairs no body could walk
// between, so the few milliseconds of simulation go on the ones it might.
//
// A prefilter and nothing more. What it rejects, the simulation would have
// rejected too (a wall, a hole, a cliff up); what it passes still has to be
// walked by nav/validate.ts before it counts. So it may be wrong in one
// direction only — passing too much — and every threshold leans that way.
//
// One height profile serves both directions: the ground under the straight line
// between the two feet, sampled every SPACING stepping from the previous sample's
// ground, as a walker would find it. A drop one way is a rise the other way.

import type { CapsuleWorld, Vec3 } from "../sim/capsule.js";
import { RADIUS, STEP_HEIGHT } from "../sim/movement.js";
import { LINK_REASON } from "./graph.js";
import { bodyClear } from "./snap.js";

/** Metres between samples. Under a body's width, so nothing it collides with fits between two. */
export const PROBE_SPACING = 0.25;
/** The deepest single drop a walk link may take, m: the game's own vertical link limit (128 in). */
export const PROBE_MAX_DROP = 3.25;
/** How far the corridor's end may be from the target's feet, vertically, and still arrive there, m. */
export const PROBE_LEVEL = 0.6;
/** Slack over a step, m: a rise the step-up takes is sometimes a hair over it after float error. */
const RISE_SLACK = 0.02;

/** A probe's verdict for each direction: a LINK_REASON, NONE where it passed. */
export interface ProbeVerdict {
  forward: number;
  backward: number;
  /** Samples taken, both passes: what the probe cost. */
  samples: number;
}

const at: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * Probe the corridor between the feet `a` and `b` both ways. When the forward
 * walk arrives at `b`, the backward direction is read off the same profile.
 * When it does not — blocked, or ending on another level — the way back is
 * walked from `b` on its own: the foot of a ledge is a wall one way and a drop
 * the other.
 */
export function probePair(world: CapsuleWorld, a: Vec3, b: Vec3, out: ProbeVerdict): ProbeVerdict {
  out.samples = 0;
  const forward = walkProfile(world, a, b, out);
  if (forward.blocked === LINK_REASON.NONE && forward.reachedLevel) {
    out.forward = verdict(forward.maxDrop, 0);
    // The same ground walked the other way: its drops are rises.
    out.backward = verdict(forward.maxRise, forward.maxDrop);
    return out;
  }
  out.forward = forward.blocked !== LINK_REASON.NONE ? forward.blocked : LINK_REASON.LEVEL;
  const backward = walkProfile(world, b, a, out);
  out.backward = backward.blocked !== LINK_REASON.NONE ? backward.blocked : backward.reachedLevel ? verdict(backward.maxDrop, 0) : LINK_REASON.LEVEL;
  return out;
}

/** A direction whose largest drop is `drop` and whose largest rise is `rise`. */
function verdict(drop: number, rise: number): number {
  if (rise > STEP_HEIGHT + RISE_SLACK) {
    return LINK_REASON.RISE;
  }
  if (drop > PROBE_MAX_DROP) {
    return LINK_REASON.DROP;
  }
  return LINK_REASON.NONE;
}

interface Profile {
  /** GAP or BLOCKED when the corridor itself cannot be walked in either direction; NONE otherwise. */
  blocked: number;
  /** The largest single fall between two samples, walking from `from`. */
  maxDrop: number;
  /** The largest single rise between two samples, walking from `from` (at most a step: the search starts there). */
  maxRise: number;
  /** The ground at the far end is the target's. */
  reachedLevel: boolean;
}

const profile: Profile = { blocked: 0, maxDrop: 0, maxRise: 0, reachedLevel: false };

function walkProfile(world: CapsuleWorld, from: Vec3, to: Vec3, out: ProbeVerdict): Profile {
  const p = profile;
  p.blocked = LINK_REASON.NONE;
  p.maxDrop = 0;
  p.maxRise = 0;
  p.reachedLevel = false;
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const length = Math.hypot(dx, dz);
  const n = Math.max(1, Math.ceil(length / PROBE_SPACING));
  // Off a ledge, the body is still up at the ledge's height for about its own
  // width past the edge; tested at the foot of the wall it would sink into it.
  const carry = Math.ceil((2 * RADIUS * n) / Math.max(length, 1e-6));
  let carried = 0;
  let carriedUntil = 0;
  let ground = from.y;
  for (let k = 1; k <= n; k++) {
    const t = k / n;
    at.x = from.x + dx * t;
    at.z = from.z + dz * t;
    // From a step above the last ground: anything higher than that is not
    // stepped onto, and the body test below is what finds it.
    at.y = ground + STEP_HEIGHT + RISE_SLACK;
    out.samples++;
    const found = world.groundBelow(at, STEP_HEIGHT + RISE_SLACK + PROBE_MAX_DROP + 1);
    if (found === null) {
      p.blocked = LINK_REASON.GAP;
      return p;
    }
    const change = found - ground;
    if (change < -STEP_HEIGHT) {
      carried = ground;
      carriedUntil = k + carry;
    }
    if (!bodyClear(world, at.x, k <= carriedUntil ? Math.max(found, carried) : found, at.z)) {
      p.blocked = LINK_REASON.BLOCKED;
      return p;
    }
    if (change < 0) {
      p.maxDrop = Math.max(p.maxDrop, -change);
    } else {
      p.maxRise = Math.max(p.maxRise, change);
    }
    ground = found;
  }
  p.reachedLevel = Math.abs(ground - to.y) <= PROBE_LEVEL;
  return p;
}
