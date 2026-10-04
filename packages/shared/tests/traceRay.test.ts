// Tracing a line through the world (collision/world.ts): what a bullet meets.
//
// Two of these catch things no ordinary correctness test would, and they are the
// reason this file exists rather than a couple of assertions bolted onto
// capsulePush.test.ts:
//
//   - a *scaled* prop hull. The ray goes into the hull's own frame, where it is no
//     longer unit length, so a hit's distance has to be scaled back out. Get it
//     wrong and every unscaled prop in the game is still right.
//   - the number of hull cells one trace visits. A grid walked by bounding
//     rectangle is O(area) in the ray's length; a 200 m shot then collects most of
//     a map's props and is slower than having no grid at all. Nothing about the
//     *answer* changes, so only a count can see it.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { CollisionWorld } from "../src/collision/world.js";
import type { HullPlacement } from "../src/collision/hulls.js";
import { DEFAULT_SURFACE } from "../src/sim/surfaces.js";

/** A collision group as the exporter tags one: `blocks` decides what it stops. */
function group(size: [number, number, number], at: [number, number, number], blocks?: string[]): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size));
  mesh.position.set(...at);
  mesh.userData.collide = true;
  if (blocks) {
    mesh.userData.clipGroup = `clip:${blocks.join("+")}`;
    mesh.userData.clipBlocks = blocks;
  }
  return mesh;
}

function world(...meshes: THREE.Mesh[]): CollisionWorld {
  const root = new THREE.Group();
  for (const mesh of meshes) {
    root.add(mesh);
  }
  const collision = new CollisionWorld();
  collision.rebuild(root);
  return collision;
}

const EAST = { x: 1, y: 0, z: 0 };
const DOWN = { x: 0, y: -1, z: 0 };

describe("traceRay", () => {
  it("finds a wall at the distance it really is, with its normal", () => {
    // A 2 m cube centred at x = 10, so its near face is at x = 9.
    const collision = world(group([2, 2, 2], [10, 0, 0]));
    const hit = collision.traceRay({ x: 0, y: 0, z: 0 }, EAST, 100, "shots");
    expect(hit).not.toBeNull();
    expect(hit!.distance).toBeCloseTo(9, 6);
    expect(Math.abs(hit!.normal.x)).toBeCloseTo(1, 6);
    expect(hit!.kind).toBe("map");
  });

  it("misses what is further than it was asked to look", () => {
    const collision = world(group([2, 2, 2], [10, 0, 0]));
    expect(collision.traceRay({ x: 0, y: 0, z: 0 }, EAST, 8, "shots")).toBeNull();
    expect(collision.traceRay({ x: 0, y: 0, z: 0 }, EAST, 9.5, "shots")).not.toBeNull();
  });

  it("returns the nearest of several things in the way", () => {
    const collision = world(group([2, 2, 2], [10, 0, 0]), group([2, 2, 2], [5, 0, 0]), group([2, 2, 2], [20, 0, 0]));
    expect(collision.traceRay({ x: 0, y: 0, z: 0 }, EAST, 100, "shots")!.distance).toBeCloseTo(4, 6);
  });

  it("writes into the buffer it is given, so firing allocates nothing", () => {
    const collision = world(group([2, 2, 2], [10, 0, 0]));
    const out = { distance: 0, normal: { x: 0, y: 0, z: 0 }, kind: "map" as const, surface: DEFAULT_SURFACE };
    const hit = collision.traceRay({ x: 0, y: 0, z: 0 }, EAST, 100, "shots", out);
    expect(hit).toBe(out);
    expect(out.distance).toBeCloseTo(9, 6);
  });

  it("passes straight through what stops a player and not a bullet", () => {
    // The bug this is here for. `clip_player` brushes are invisible and a map is
    // full of them over windows and railings — dome-mw3 has seven groups and
    // 30,536 triangles of them. A bullet traced against everything that stops a
    // capsule dies in mid-air in front of the shooter.
    const collision = world(group([2, 2, 2], [5, 0, 0], ["player", "ai", "detail"]), group([2, 2, 2], [10, 0, 0]));
    const hit = collision.traceRay({ x: 0, y: 0, z: 0 }, EAST, 100, "shots");
    expect(hit!.distance).toBeCloseTo(9, 6); // the solid one behind it, not the clip at 4

    // And the clip still stops a player, which is the other half of the claim.
    expect(collision.overlapsCapsule({ x: 5, y: -0.5, z: 0 }, 0.3, 1.7)).toBe(true);
  });

  it("is stopped by a clip group that does carry `solid`", () => {
    const collision = world(group([2, 2, 2], [5, 0, 0], ["solid", "player"]));
    expect(collision.traceRay({ x: 0, y: 0, z: 0 }, EAST, 100, "shots")!.distance).toBeCloseTo(4, 6);
  });
});

describe("traceRay against prop hulls", () => {
  /** One asset, placed by `matrix`. A 2 m cube at the origin in its own frame. */
  function withHull(matrix: THREE.Matrix4, ...map: THREE.Mesh[]): CollisionWorld {
    const collision = world(...map);
    const geometry = new THREE.BoxGeometry(2, 2, 2);
    const placements: HullPlacement[] = [{ asset: "crate", matrix }];
    collision.setHulls(new Map([["crate", geometry]]), placements);
    return collision;
  }

  it("finds a hull placed by a plain translation", () => {
    const collision = withHull(new THREE.Matrix4().makeTranslation(10, 0, 0));
    const hit = collision.traceRay({ x: 0, y: 0, z: 0 }, EAST, 100, "shots");
    expect(hit!.distance).toBeCloseTo(9, 6);
    expect(hit!.kind).toBe("prop");
  });

  it("scales a hit back out of a scaled hull's frame", () => {
    // The whole point. A hull scaled 3x is a 6 m cube in the world, so its near
    // face is at x = 10 - 3 = 7. Inside the hull's frame the ray is a third as
    // long, and a hit reported in those units without the correction comes back
    // at three times the distance — plausible, and wrong only for scaled props.
    const matrix = new THREE.Matrix4().compose(
      new THREE.Vector3(10, 0, 0),
      new THREE.Quaternion(),
      new THREE.Vector3(3, 3, 3),
    );
    const collision = withHull(matrix);
    const hit = collision.traceRay({ x: 0, y: 0, z: 0 }, EAST, 100, "shots");
    expect(hit).not.toBeNull();
    expect(hit!.distance).toBeCloseTo(7, 4);

    // And it agrees with the same geometry baked into the map instead, which is
    // the cross-check that makes the number above mean something.
    const baked = world(group([6, 6, 6], [10, 0, 0]));
    expect(hit!.distance).toBeCloseTo(baked.traceRay({ x: 0, y: 0, z: 0 }, EAST, 100, "shots")!.distance, 4);
  });

  it("gives a rotated hull's normal in world space", () => {
    const matrix = new THREE.Matrix4().compose(
      new THREE.Vector3(10, 0, 0),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 4),
      new THREE.Vector3(1, 1, 1),
    );
    const collision = withHull(matrix);
    const hit = collision.traceRay({ x: 0, y: 0, z: 0 }, EAST, 100, "shots");
    expect(hit).not.toBeNull();
    // Turned 45° about Y, so the face the ray meets is no longer axis-aligned.
    expect(Math.hypot(hit!.normal.x, hit!.normal.y, hit!.normal.z)).toBeCloseTo(1, 4);
    expect(Math.abs(hit!.normal.x)).toBeLessThan(0.999);
  });

  it("prefers the map when the map is nearer, and the hull when it is not", () => {
    const near = withHull(new THREE.Matrix4().makeTranslation(20, 0, 0), group([2, 2, 2], [10, 0, 0]));
    expect(near.traceRay({ x: 0, y: 0, z: 0 }, EAST, 100, "shots")!.kind).toBe("map");
    const far = withHull(new THREE.Matrix4().makeTranslation(5, 0, 0), group([2, 2, 2], [10, 0, 0]));
    expect(far.traceRay({ x: 0, y: 0, z: 0 }, EAST, 100, "shots")!.kind).toBe("prop");
  });

  it("walks cells along the ray, not the rectangle around it", () => {
    // A performance bug that no assertion about the *answer* can see. The grid is
    // 8 m; a 200 m diagonal covers ~625 cells by bounding rectangle and 50 along
    // the line. So: scatter one hull per cell down a diagonal corridor and a great
    // many off to the side, and count what a trace collects by how many it can
    // possibly hit.
    const collision = new CollisionWorld();
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const placements: HullPlacement[] = [];
    // 24 hulls along the diagonal the ray follows.
    for (let i = 1; i <= 24; i++) {
      placements.push({ asset: "crate", matrix: new THREE.Matrix4().makeTranslation(i * 8, 0, i * 8) });
    }
    // And a thick block of them beside it, inside the bounding rectangle but
    // nowhere near the line.
    for (let x = 1; x <= 24; x++) {
      for (let z = 1; z <= 24; z++) {
        if (Math.abs(x - z) > 2) {
          placements.push({ asset: "crate", matrix: new THREE.Matrix4().makeTranslation(x * 8, 40, z * 8) });
        }
      }
    }
    collision.setHulls(new Map([["crate", geometry]]), placements);

    // The ray runs up the diagonal at y = 0 and must find the first crate on it.
    // Its faces are at 7.5 on both axes, so the entry point is (7.5, _, 7.5).
    const diagonal = { x: Math.SQRT1_2, y: 0, z: Math.SQRT1_2 };
    const hit = collision.traceRay({ x: 0, y: 0, z: 0 }, diagonal, 300, "shots");
    expect(hit).not.toBeNull();
    expect(hit!.distance).toBeCloseTo(Math.hypot(7.5, 7.5), 3);

    // And this is the assertion that matters. Walking the line touches ~50 cells
    // and so a few tens of hulls; walking the bounding rectangle touches ~625 and
    // takes very nearly all of them. The hit above is identical either way, which
    // is exactly why the count has to be checked instead.
    expect(placements.length).toBeGreaterThan(400);
    expect(collision.traceCandidates).toBeLessThan(80);
  });

  it("visits one column for a straight-down trace", () => {
    // The degenerate case the DDA has to get right: no movement in x or z, so the
    // per-cell step is infinite on both axes and the walk must stop after one cell
    // instead of looping.
    const collision = withHull(new THREE.Matrix4().makeTranslation(0, -10, 0));
    const hit = collision.traceRay({ x: 0, y: 0, z: 0 }, DOWN, 100, "shots");
    expect(hit).not.toBeNull();
    expect(hit!.distance).toBeCloseTo(9, 6);
  });
});
