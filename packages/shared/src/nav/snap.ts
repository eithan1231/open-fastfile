// A node's feet: where a body standing at the file's position actually stands
// in our collision.
//
// The file never snaps (nav-format.md): a FLOOR_Z node is already on the floor
// and is only settled onto ours, within ±SETTLE; any other was authored above
// the floor (MW3's entity origins sit a median 0.7 m up, and up to 5 m) and is
// found by looking straight down from a step above it. A node with nothing to
// stand on in reach, or where a body would be inside something, is unusable
// rather than moved further: moving it would be guessing what the source meant.
//
// Movement collision only (`groundBelow`, `overlapsCapsule`, `resolveCapsule`),
// never `traceRay`: the graph must follow what a player collides with. That
// collision is triangles, so "inside" means touching them: a node deep inside
// a large solid touches none and stands on whatever is below it.

import type { CapsuleWorld, Vec3 } from "../sim/capsule.js";
import { HEIGHT, RADIUS } from "../sim/movement.js";
import { STEP_HEIGHT } from "../sim/stepSlide.js";
import type { NavNodes } from "./format.js";
import { NODE_REASON, NODE_REASON_NAMES } from "./graph.js";
import { NODE_FLAGS, NODE_TYPES } from "./vocab.js";

/** How far a FLOOR_Z node is settled, either way, m. */
export const SNAP_SETTLE = 0.25;
/**
 * How far below its position a node authored above the floor may find it, m.
 * Measured on MW3's entity nodes: see docs/engine/navigation.md, "Snapping".
 */
export const SNAP_SEARCH = 2.5;
/** How far a node against a wall may be pushed out of it and still be the same place, m. */
export const SNAP_NUDGE = 0.35;

/**
 * Where a traversal's begin looks for its lip when nothing is straight below it,
 * as offsets within a body's radius. The game places a jump down's begin where
 * its clip starts, which can be just past the edge it leaves from (theater's VIP
 * roof: 0.15 m out, with nothing under it for 6 m).
 */
const LIP_SAMPLES = Array.from({ length: 8 }, (_, k) => [Math.cos((k * Math.PI) / 4) * RADIUS, Math.sin((k * Math.PI) / 4) * RADIUS] as const);

/** A body's height above a step: what `bodyClear` tests, so a kerb or a slope underfoot is not "inside". */
const UPPER_HEIGHT = HEIGHT - STEP_HEIGHT;

const probe: Vec3 = { x: 0, y: 0, z: 0 };
const resolved = { position: { x: 0, y: 0, z: 0 }, grounded: false };

/**
 * Whether a body standing at (x, ground, z) is clear of everything above a
 * step's height. Below that is the step-up's business, and a capsule's rounded
 * bottom on a slope or at the foot of a stair would otherwise count as inside.
 */
export function bodyClear(world: CapsuleWorld, x: number, ground: number, z: number): boolean {
  probe.x = x;
  probe.y = ground + STEP_HEIGHT;
  probe.z = z;
  return !world.overlapsCapsule(probe, RADIUS, UPPER_HEIGHT);
}

export interface SnapStats {
  usable: number;
  /** By NODE_REASON name, unusable nodes only. */
  unusable: Record<string, number>;
  /** Usable nodes a wall pushed sideways to stand clear. */
  nudged: number;
  /** Position height above the feet it snapped to, m, per usable node: the measurement SNAP_SEARCH is tuned by. */
  drops: number[];
}

export function createSnapStats(): SnapStats {
  return { usable: 0, unusable: {}, nudged: 0, drops: [] };
}

/**
 * Snap nodes `start` up to `end`: write feet, usable and reason, and count them
 * into `stats`. `feet` gets the file's own position for an unusable node, so a
 * debug view still has somewhere to draw it.
 */
export function snapNodes(
  nodes: NavNodes,
  world: CapsuleWorld,
  feet: Float32Array,
  usable: Uint8Array,
  reason: Uint8Array,
  stats: SnapStats,
  start = 0,
  end = nodes.count,
): SnapStats {
  for (let i = start; i < end; i++) {
    const x = nodes.position[i * 3]!;
    const y = nodes.position[i * 3 + 1]!;
    const z = nodes.position[i * 3 + 2]!;
    feet[i * 3] = x;
    feet[i * 3 + 1] = y;
    feet[i * 3 + 2] = z;
    const why = snapOne(nodes.type[i]!, nodes.flags[i]!, x, y, z, world, feet, i);
    reason[i] = why;
    usable[i] = why === NODE_REASON.NONE ? 1 : 0;
    if (why === NODE_REASON.NONE) {
      stats.usable++;
      stats.drops.push(y - feet[i * 3 + 1]!);
      if (feet[i * 3] !== x || feet[i * 3 + 2] !== z) {
        stats.nudged++;
      }
    } else {
      const name = NODE_REASON_NAMES[why]!;
      stats.unusable[name] = (stats.unusable[name] ?? 0) + 1;
    }
  }
  return stats;
}

function snapOne(type: number, flags: number, x: number, y: number, z: number, world: CapsuleWorld, feet: Float32Array, i: number): number {
  if (flags & NODE_FLAGS.DYNAMIC) {
    return NODE_REASON.DYNAMIC;
  }
  const floorZ = (flags & NODE_FLAGS.FLOOR_Z) !== 0;
  const top = floorZ ? y + SNAP_SETTLE : y + STEP_HEIGHT;
  const reach = floorZ ? 2 * SNAP_SETTLE : STEP_HEIGHT + SNAP_SEARCH;
  probe.x = x;
  probe.y = top;
  probe.z = z;
  const ground = world.groundBelow(probe, reach);
  if (ground === null && type === NODE_TYPES.TRAVERSE_BEGIN) {
    // Over the lip: stand on the highest ground a body's footprint reaches, there.
    let best: number | null = null;
    for (const [ox, oz] of LIP_SAMPLES) {
      probe.x = x + ox;
      probe.y = top;
      probe.z = z + oz;
      const found = world.groundBelow(probe, reach);
      if (found !== null && (best === null || found > best) && bodyClear(world, probe.x, found, probe.z)) {
        best = found;
        feet[i * 3] = probe.x;
        feet[i * 3 + 2] = probe.z;
      }
    }
    if (best !== null) {
      feet[i * 3 + 1] = best;
      return NODE_REASON.NONE;
    }
  }
  if (ground === null) {
    return NODE_REASON.NO_GROUND;
  }
  if (bodyClear(world, x, ground, z)) {
    feet[i * 3 + 1] = ground;
    return NODE_REASON.NONE;
  }

  // Against a wall (a cover node is placed at one): push the body above the
  // step out of it, and keep the result only if it moved a little and stands.
  probe.x = x;
  probe.y = ground + STEP_HEIGHT;
  probe.z = z;
  const out = world.resolveCapsule(probe, RADIUS, UPPER_HEIGHT, resolved).position;
  const nx = out.x;
  const nz = out.z;
  if (Math.hypot(nx - x, nz - z) > SNAP_NUDGE) {
    return NODE_REASON.INSIDE;
  }
  probe.x = nx;
  probe.y = ground + STEP_HEIGHT;
  probe.z = nz;
  const moved = world.groundBelow(probe, 2 * STEP_HEIGHT);
  if (moved === null || !bodyClear(world, nx, moved, nz)) {
    return NODE_REASON.INSIDE;
  }
  feet[i * 3] = nx;
  feet[i * 3 + 1] = moved;
  feet[i * 3 + 2] = nz;
  return NODE_REASON.NONE;
}
