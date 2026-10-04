// Which links a removable part shuts while it is present.
//
// A world's graph is baked once, against its base collision with every part
// absent, so a door's links are in it and valid. A part is then a blocker over
// the links whose corridor it fills — found here, once per world after the
// bake — and a match holds it shut while the part is present (`part:<name>` in
// `NavMatchState`). Opening a door opens its blocker; nothing is re-baked.
//
// The corridor is sampled as the probe samples it (probe.ts): every
// PROBE_SPACING along the straight line between the feet, a body standing on the
// base's ground there, tested for the upper body only (`bodyClear`). Both ends
// are sampled too, so a node standing inside the part shuts every link it has.
// It errs towards shutting: a link beside a closed door that is shut too is a
// detour, and one through it left open is a bot walking into a wall.
//
// A part only ever shuts. One that is a floor (a bridge that comes and goes)
// adds no link, since the bake saw a gap there.

import type { CapsuleWorld, Vec3 } from "../sim/capsule.js";
import { HEIGHT, RADIUS, STEP_HEIGHT } from "../sim/movement.js";
import { LINK_STATUS, type NavGraph } from "./graph.js";
import { NavLinkGrid } from "./grid.js";
import { PROBE_MAX_DROP, PROBE_SPACING } from "./probe.js";
import { bodyClear } from "./snap.js";

/** One part as the sampling needs it: where it is, and the part alone to test a body against. */
export interface NavPart {
  /** World-space bounds of the part's triangles. */
  min: Vec3;
  max: Vec3;
  /** The part and nothing else (`CollisionWorld.partView`). */
  world: CapsuleWorld;
}

const at: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * The links `part` shuts, ascending. `ground` is the world the graph was baked
 * against (the base), which is where a walker's feet are found along a link.
 * Links the mover may not take are skipped — they are never walked anyway: the
 * bake's INVALID ones, or those `valid` (a mover's mask, nav/mover.ts) leaves out.
 */
export function linksThroughPart(
  graph: NavGraph,
  ground: CapsuleWorld,
  part: NavPart,
  grid = new NavLinkGrid(graph, RADIUS),
  valid: Uint8Array | null = null,
): number[] {
  const feet = graph.feet;
  const out: number[] = [];
  const near = grid.near(part.min.x - RADIUS, part.min.z - RADIUS, part.max.x + RADIUS, part.max.z + RADIUS, []);
  for (const l of near) {
    if (valid ? valid[l] !== 1 : graph.status[l] === LINK_STATUS.INVALID) {
      continue;
    }
    const a = graph.source[l]! * 3;
    const b = graph.target[l]! * 3;
    const ay = feet[a + 1]!;
    const by = feet[b + 1]!;
    // Nothing a body on this link could reach: below the part, or wholly above it.
    if (Math.max(ay, by) + HEIGHT < part.min.y || Math.min(ay, by) - PROBE_MAX_DROP > part.max.y) {
      continue;
    }
    const dx = feet[b]! - feet[a]!;
    const dz = feet[b + 2]! - feet[a + 2]!;
    const n = Math.max(1, Math.ceil(Math.hypot(dx, dz) / PROBE_SPACING));
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      at.x = feet[a]! + dx * t;
      at.z = feet[a + 2]! + dz * t;
      const lerp = ay + (by - ay) * t;
      at.y = lerp + STEP_HEIGHT;
      const found = ground.groundBelow(at, STEP_HEIGHT + PROBE_MAX_DROP + 1) ?? lerp;
      // At the ground a walker finds, and at the straight line between the feet
      // where that is somewhere else (a stair, a traversal through the air).
      if (!bodyClear(part.world, at.x, found, at.z) || (Math.abs(found - lerp) > 0.01 && !bodyClear(part.world, at.x, lerp, at.z))) {
        out.push(l);
        break;
      }
    }
  }
  return out.sort((x, y) => x - y);
}

/**
 * Every part's links, by the part's index; empty for a part with nothing to test.
 * One link grid for all of them. `valid` as `linksThroughPart` takes it: an
 * actor's parts are found over the actor's links, against its own channel.
 */
export function linksThroughParts(graph: NavGraph, ground: CapsuleWorld, parts: readonly (NavPart | undefined)[], valid: Uint8Array | null = null): number[][] {
  const grid = new NavLinkGrid(graph, RADIUS);
  return parts.map((part) => (part ? linksThroughPart(graph, ground, part, grid, valid) : []));
}
