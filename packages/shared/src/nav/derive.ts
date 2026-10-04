// The walk links a file asks to be derived (`DERIVE_WALK_LINKS`): which pairs
// of nodes are worth probing and simulating at all.
//
// The source games all link by one rule (reverse/cod-pathdata §3): every pair
// within 256 in (6.5 m) horizontally that the compiler can trace, up to 128 in
// (3.25 m) apart vertically, with no cap on how many a node gets. So the
// candidates are every usable pair inside those bounds, nearest NEIGHBOURS per
// node, with no collinear pruning — a cap of 12 drops real links on about 10% of
// MW3's nodes. Whether a candidate is a link is not decided here: nav/probe.ts
// and nav/validate.ts decide it, per direction, against our collision.

import type { NavGraphData } from "./graph.js";
import { NavGrid } from "./grid.js";

/** Horizontal reach, m: the games' longest walk link, 256 in. */
export const DERIVE_RADIUS = 6.5;
/** Vertical reach, m: the games' largest linked height difference, 128 in. */
export const DERIVE_MAX_DY = 3.25;
/** Nearest candidates per node. MW3's own nodes carry up to 25 links. */
export const DERIVE_NEIGHBOURS = 24;

export interface DeriveOptions {
  radius: number;
  maxDy: number;
  neighbours: number;
}

export const DERIVE_DEFAULTS: DeriveOptions = { radius: DERIVE_RADIUS, maxDy: DERIVE_MAX_DY, neighbours: DERIVE_NEIGHBOURS };

/**
 * Candidate pairs as (a, b) with a < b, ascending, each once. A pair is in if
 * either end has the other among its nearest. Unusable nodes take no part.
 */
export function derivePairs(nodes: Pick<NavGraphData, "nodeCount" | "feet" | "usable">, options: DeriveOptions = DERIVE_DEFAULTS): Uint32Array {
  const grid = new NavGrid(nodes.feet, nodes.usable);
  const f = nodes.feet;
  const near: number[] = [];
  const scored: { j: number; d2: number }[] = [];
  const pairs = new Set<number>();
  const keys: number[] = [];
  for (let i = 0; i < nodes.nodeCount; i++) {
    if (!nodes.usable[i]) {
      continue;
    }
    const x = f[i * 3]!;
    const y = f[i * 3 + 1]!;
    const z = f[i * 3 + 2]!;
    grid.within(x, y, z, options.radius, options.maxDy, near);
    scored.length = 0;
    for (const j of near) {
      if (j !== i) {
        const dx = f[j * 3]! - x;
        const dz = f[j * 3 + 2]! - z;
        scored.push({ j, d2: dx * dx + dz * dz });
      }
    }
    scored.sort((p, q) => p.d2 - q.d2 || p.j - q.j);
    for (let k = 0; k < Math.min(options.neighbours, scored.length); k++) {
      const j = scored[k]!.j;
      const key = Math.min(i, j) * nodes.nodeCount + Math.max(i, j);
      if (!pairs.has(key)) {
        pairs.add(key);
        keys.push(key);
      }
    }
  }
  keys.sort((p, q) => p - q);
  const out = new Uint32Array(keys.length * 2);
  for (let k = 0; k < keys.length; k++) {
    out[k * 2] = Math.floor(keys[k]! / nodes.nodeCount);
    out[k * 2 + 1] = keys[k]! % nodes.nodeCount;
  }
  return out;
}
