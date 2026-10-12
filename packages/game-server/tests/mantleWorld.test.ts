// The mantle query against an imported map's real collision: how many of its
// volumes a player can mantle at all. The unit tests build their obstacles out
// of boxes, and a ledge test that only works on boxes passes every one of them.
//
// Skipped where the world is not on disk, as the navigation bakes are.

import { describe, expect, it } from "vitest";
import type { ResolvedMantle, ResolvedWorld } from "@3d/shared/dsl/resolved.js";
import type { CapsuleWorld, Vec3 } from "@3d/shared/sim/capsule.js";
import { idleInput } from "@3d/shared/sim/input.js";
import { createMovement, EMPTY_HANDS, movementEnv, PLAYER_MOVEMENT, stepMovement, type MovementEnv } from "@3d/shared/sim/movement.js";
import { movementRules } from "@3d/shared/sim/worldRules.js";
import { hasCollision, loadCollision } from "./navBakeWorld.js";

const DT = 1 / 60;
/** Where along a side a body tries, as shares of its length from the middle. */
const ALONG = [-0.4, -0.2, 0, 0.2, 0.4];
/** How far out from the side, metres: against most obstacles at the near end, a step back at the far one. */
const OUT = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7];
const SIDES = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

/** A body stood at (x, z) and left to settle, or null where there is no floor there or no room. */
function standAt(x: number, z: number, volume: ResolvedMantle, yaw: number, collision: CapsuleWorld, env: MovementEnv): Vec3 | null {
  const bottom = volume.position.y - volume.size.y / 2;
  for (const y of [bottom + 0.3, volume.position.y, bottom + 1]) {
    const floor = collision.groundBelow({ x, y, z }, 3);
    if (floor === null || collision.overlapsCapsule({ x, y: floor + 0.01, z }, PLAYER_MOVEMENT.radius, PLAYER_MOVEMENT.height)) {
      continue;
    }
    const state = createMovement({ x, y: floor + 0.01, z }, yaw, 0);
    const input = idleInput(yaw, 0);
    for (let i = 0; i < 30; i++) {
      stepMovement(state, input, DT, env, EMPTY_HANDS);
    }
    if (state.grounded) {
      return state.feet;
    }
  }
  return null;
}

/** The volumes a body facing straight in can mantle from somewhere beside them, and how many places that was. */
function mantled(world: ResolvedWorld, collision: CapsuleWorld): { volumes: number[]; spots: number } {
  const rules = movementRules(world);
  const env = movementEnv(collision, rules, PLAYER_MOVEMENT);
  const volumes: number[] = [];
  let spots = 0;
  for (const volume of world.mantles) {
    const c = Math.cos(volume.yaw);
    const s = Math.sin(volume.yaw);
    let here = 0;
    for (const [lx, lz] of SIDES) {
      const half = lx !== 0 ? volume.size.x / 2 : volume.size.z / 2;
      const span = lx !== 0 ? volume.size.z : volume.size.x;
      // Straight in through this side, turned out of the box's frame (see ResolvedMantle).
      const yaw = Math.atan2(lx * c + lz * s, -lx * s + lz * c);
      for (const along of ALONG) {
        for (const out of OUT) {
          const dx = lx * (half + out) + (lx === 0 ? along * span : 0);
          const dz = lz * (half + out) + (lz === 0 ? along * span : 0);
          const feet = standAt(volume.position.x + dx * c + dz * s, volume.position.z - dx * s + dz * c, volume, yaw, collision, env);
          if (feet && rules.mantles.find(feet, yaw, PLAYER_MOVEMENT, collision)) {
            here++;
          }
        }
      }
    }
    spots += here;
    if (here > 0) {
      volumes.push(volume.id);
    }
  }
  return { volumes, spots };
}

describe.skipIf(!hasCollision("dome-mw3"))("dome-mw3's mantle volumes", () => {
  it("can nearly all be mantled from somewhere beside them", async () => {
    const { world, collision } = await loadCollision("dome-mw3");
    const { volumes, spots } = mantled(world, collision);
    expect(world.mantles).toHaveLength(29);
    // The two that cannot have nothing above a step inside them in the map's collision.
    expect(volumes).toHaveLength(27);
    const refused = world.mantles.filter((m) => !volumes.includes(m.id)).map((m) => world.mantles.indexOf(m));
    expect(refused).toEqual([14, 24]);
    // A ledge test that takes a top only where the ball lands squarely on it
    // keeps every one of those volumes and loses a third of these places.
    expect(spots).toBe(557);
  }, 60_000);
});
