// The two BVH push paths — the merged world mesh, and a per-placement prop
// hull — are the subtlest code in engine/collision.ts and, until this file,
// the only part of it with no coverage at all (tests/collision.test.ts builds
// an empty group on purpose, to isolate the analytic ground pass).
//
// Both go through the same `pushOutOfBvh`, so these pin down the behaviour
// that sharing it has to preserve: a floor stops a falling capsule and reads
// as ground, a wall pushes it sideways without doing so, and a hull's push is
// carried back out of the placement's local space — through its rotation,
// translation and scale — into the world.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { CollisionWorld } from "../src/collision/world.js";
import { GRAVITY, HEIGHT, RADIUS } from "../src/sim/movement.js";
import type { HullPlacement } from "../src/collision/hulls.js";

const DT = 1 / 60;

/** An axis-aligned box mesh tagged so `rebuild` picks it up. */
function collider(size: [number, number, number], at: [number, number, number]): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size));
  mesh.position.set(...at);
  mesh.userData.collide = true;
  return mesh;
}

function worldWith(...meshes: THREE.Mesh[]): CollisionWorld {
  const root = new THREE.Group();
  for (const m of meshes) {
    root.add(m);
  }
  const collision = new CollisionWorld();
  collision.rebuild(root); // no terrain: isolate the BVH pass
  return collision;
}

describe("resolveCapsule — the world-mesh BVH pass", () => {
  it("stands a capsule dropped into a floor back on top of it, and calls it grounded", () => {
    // Slab spanning y -0.5..0, so its top face is y = 0.
    const collision = worldWith(collider([10, 0.5, 10], [0, -0.25, 0]));

    const resolved = collision.resolveCapsule(new THREE.Vector3(0, -0.4, 0), RADIUS, HEIGHT);

    expect(resolved.position.y).toBeCloseTo(0, 5);
    expect(resolved.grounded).toBe(true);
    // Pushed straight up: no lateral drift off a flat floor.
    expect(resolved.position.x).toBeCloseTo(0, 5);
    expect(resolved.position.z).toBeCloseTo(0, 5);
  });

  it("leaves a capsule already clear of everything exactly where it is", () => {
    const collision = worldWith(collider([10, 0.5, 10], [0, -0.25, 0]));

    const resolved = collision.resolveCapsule(new THREE.Vector3(1, 5, -2), RADIUS, HEIGHT);

    expect(resolved.position.toArray()).toEqual([1, 5, -2]);
    expect(resolved.grounded).toBe(false);
  });

  it("pushes a capsule that walked into a wall back off its face, without reporting ground", () => {
    // Wall occupying x 0..1, tall enough to cover the whole capsule.
    const collision = worldWith(collider([1, 4, 10], [0.5, 2, 0]));

    // Axis 0.15 outside the -x face, so the capsule overlaps it by 0.15 —
    // what walking into a wall actually looks like on the frame it happens.
    const resolved = collision.resolveCapsule(new THREE.Vector3(-0.15, 1, 0), RADIUS, HEIGHT);

    expect(resolved.position.x).toBeCloseTo(-RADIUS, 5); // resting exactly against the face
    expect(resolved.position.y).toBeCloseTo(1, 5); // a vertical wall lifts nothing
    expect(resolved.grounded).toBe(false);
  });

  /**
   * Not a defect but a property of the technique (see the module header): the
   * push is always *away from the nearest triangle*, so a capsule already
   * deep inside a solid is pushed toward that solid's middle rather than out
   * of it. Recorded so a future reader does not mistake it for a regression —
   * nothing in the engine ever puts the player there (spawns are resolved onto
   * a surface, and movement is resolved every frame from a legal position).
   */
  it("does not claim to rescue a capsule already buried deep inside a solid", () => {
    const collision = worldWith(collider([1, 4, 10], [0.5, 2, 0]));

    const resolved = collision.resolveCapsule(new THREE.Vector3(0.9, 1, 0), RADIUS, HEIGHT);

    expect(resolved.position.x).toBeCloseTo(0.7, 5); // pushed off the near face, still inside
  });

  it("does not mutate the position it was handed", () => {
    const collision = worldWith(collider([10, 0.5, 10], [0, -0.25, 0]));
    const feet = new THREE.Vector3(0, -0.4, 0);

    collision.resolveCapsule(feet, RADIUS, HEIGHT);

    expect(feet.toArray()).toEqual([0, -0.4, 0]);
  });
});

describe("resolveCapsule — the prop-hull pass", () => {
  /** A 2x2x2 box centred on its own origin, as an asset-space hull geometry. */
  function hullGeometry(): THREE.BufferGeometry {
    return new THREE.BoxGeometry(2, 2, 2).toNonIndexed();
  }

  function hullWorld(matrix: THREE.Matrix4): CollisionWorld {
    const collision = new CollisionWorld();
    collision.rebuild(new THREE.Group()); // no world mesh: isolate the hull pass
    const placements: HullPlacement[] = [{ asset: "crate", matrix }];
    collision.setHulls(new Map([["crate", hullGeometry()]]), placements);
    return collision;
  }

  it("reports the hull as one instance of one shared asset BVH", () => {
    const collision = hullWorld(new THREE.Matrix4());
    expect(collision.hullStats).toEqual({ instances: 1, assets: 1 });
  });

  it("stands a capsule on top of a translated hull", () => {
    // Crate centred at y = 1, so it spans y 0..2 — its top face is y = 2.
    const collision = hullWorld(new THREE.Matrix4().makeTranslation(0, 1, 0));

    const resolved = collision.resolveCapsule(new THREE.Vector3(0, 1.6, 0), RADIUS, HEIGHT);

    expect(resolved.position.y).toBeCloseTo(2, 4);
    expect(resolved.grounded).toBe(true);
  });

  it("accounts for the placement's scale — a scaled hull is taller", () => {
    // Same crate at 3x: spans y 0..6 once lifted, so its top face is y = 6.
    const matrix = new THREE.Matrix4().compose(new THREE.Vector3(0, 3, 0), new THREE.Quaternion(), new THREE.Vector3(3, 3, 3));
    const collision = hullWorld(matrix);

    const resolved = collision.resolveCapsule(new THREE.Vector3(0, 5.6, 0), RADIUS, HEIGHT);

    expect(resolved.position.y).toBeCloseTo(6, 4);
    expect(resolved.grounded).toBe(true);
  });

  it("carries a sideways push back through the placement's rotation", () => {
    // Rotating a cube 45° about Y turns its +x face into a diagonal edge, so a
    // capsule pushed out of it must come back out along world x/z together —
    // which only happens if the local push is rotated on its way to the world.
    const matrix = new THREE.Matrix4().compose(
      new THREE.Vector3(0, 1, 0),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 4),
      new THREE.Vector3(1, 1, 1),
    );
    const collision = hullWorld(matrix);

    // Start just inside the rotated crate, level with its middle.
    const resolved = collision.resolveCapsule(new THREE.Vector3(0.9, 0.4, 0.9), RADIUS, HEIGHT);

    // Out along the diagonal: both horizontal components grew together.
    expect(resolved.position.x).toBeGreaterThan(0.9);
    expect(resolved.position.z).toBeGreaterThan(0.9);
    expect(resolved.position.x).toBeCloseTo(resolved.position.z, 4);
  });

  it("ignores a placement whose asset never produced a hull geometry", () => {
    const collision = new CollisionWorld();
    collision.rebuild(new THREE.Group());
    // An asset still in flight is held as an attribute-less placeholder.
    collision.setHulls(new Map([["crate", new THREE.BufferGeometry()]]), [{ asset: "crate", matrix: new THREE.Matrix4() }]);

    expect(collision.hullStats).toEqual({ instances: 0, assets: 0 });
    const feet = new THREE.Vector3(0, 0, 0);
    expect(collision.resolveCapsule(feet, RADIUS, HEIGHT).position.toArray()).toEqual([0, 0, 0]);
  });
});

/**
 * P9: a hot reload keeps the AssetStore, so hull BVHs are now reused when their
 * geometry is the same object as last mount. A stale tree would collide the
 * player against a shape that is no longer there.
 */
describe("setHulls — reusing a BVH across mounts", () => {
  /** A box hull of the given half-extents, as asset-space geometry. */
  function box(size: number): THREE.BufferGeometry {
    return new THREE.BoxGeometry(size, size, size).toNonIndexed();
  }

  function world(): CollisionWorld {
    const collision = new CollisionWorld();
    collision.rebuild(new THREE.Group()); // hull pass only
    return collision;
  }

  /** Where a capsule standing inside the crate at the origin is pushed up to. */
  function topOf(collision: CollisionWorld, from: number): number {
    return collision.resolveCapsule(new THREE.Vector3(0, from, 0), RADIUS, HEIGHT).position.y;
  }

  it("resolves identically when the same geometry is installed again", () => {
    const collision = world();
    const geometry = box(2);
    const placements: HullPlacement[] = [{ asset: "crate", matrix: new THREE.Matrix4().makeTranslation(0, 1, 0) }];

    collision.setHulls(new Map([["crate", geometry]]), placements);
    const first = topOf(collision, 1.6);
    collision.setHulls(new Map([["crate", geometry]]), placements);

    expect(first).toBeCloseTo(2, 4); // a 2 m crate centred at y = 1 tops out at y = 2
    expect(topOf(collision, 1.6)).toBeCloseTo(first, 6);
  });

  it("takes the new shape when an asset's geometry is replaced", () => {
    // What a re-exported .glb looks like: same asset name, a different geometry
    // object. Keying the cache on the name rather than the geometry would keep
    // colliding against the old hull.
    const collision = world();
    const placements: HullPlacement[] = [{ asset: "crate", matrix: new THREE.Matrix4().makeTranslation(0, 1, 0) }];

    collision.setHulls(new Map([["crate", box(2)]]), placements);
    expect(topOf(collision, 2.6)).toBeCloseTo(2.6, 4); // clear of the 2 m crate: untouched

    collision.setHulls(new Map([["crate", box(4)]]), placements);
    expect(topOf(collision, 2.6)).toBeCloseTo(3, 4); // the 4 m crate reaches y = 3, and now pushes
  });
});

/**
 * P3: the per-tick path promises to allocate nothing, so a caller may hand in
 * the resolution to fill, and the broad phase deduplicates with a stamp rather
 * than a Set. Both are easy to get subtly wrong: a shared result object leaking
 * out of the no-out path, or a hull in two cells pushed twice as far.
 */
describe("resolveCapsule — reusing the caller's resolution", () => {
  function floor(): CollisionWorld {
    return worldWith(collider([20, 0.5, 20], [0, -0.25, 0])); // top face at y = 0
  }

  it("fills the resolution it was handed, and returns that same object", () => {
    const collision = floor();
    const out = { position: new THREE.Vector3(), grounded: false };

    const resolved = collision.resolveCapsule(new THREE.Vector3(0, -0.4, 0), RADIUS, HEIGHT, out);

    expect(resolved).toBe(out);
    expect(out.position.y).toBeCloseTo(0, 4);
    expect(out.grounded).toBe(true);

    // And it is reused, not reallocated: a second call overwrites the same vector.
    collision.resolveCapsule(new THREE.Vector3(5, 4, 5), RADIUS, HEIGHT, out);
    expect(resolved.position.toArray()).toEqual(out.position.toArray());
    expect(out.position.y).toBeCloseTo(4, 4);
    expect(out.grounded).toBe(false);
  });

  it("hands back independent results when the caller brings nothing", () => {
    const collision = floor();
    const first = collision.resolveCapsule(new THREE.Vector3(0, -0.4, 0), RADIUS, HEIGHT);
    const second = collision.resolveCapsule(new THREE.Vector3(5, 4, 5), RADIUS, HEIGHT);

    expect(first.position).not.toBe(second.position);
    expect(first.position.y).toBeCloseTo(0, 4); // not overwritten by the second call
    expect(first.grounded).toBe(true);
    expect(second.grounded).toBe(false);
  });

  it("pushes a hull that straddles two broad-phase cells exactly once", () => {
    // Cells are 8 m. A 2 m crate centred on x = 8 sits in both of them, so a
    // broad phase that forgot to deduplicate would resolve it twice.
    const geometries = new Map([["crate", new THREE.BoxGeometry(2, 2, 2).toNonIndexed()]]);
    const world = (x: number): CollisionWorld => {
      const collision = new CollisionWorld();
      collision.rebuild(new THREE.Group());
      collision.setHulls(geometries, [{ asset: "crate", matrix: new THREE.Matrix4().makeTranslation(x, 1, 0) }]);
      return collision;
    };

    const straddling = world(8).resolveCapsule(new THREE.Vector3(8, 1.6, 0), RADIUS, HEIGHT);
    const withinOneCell = world(4).resolveCapsule(new THREE.Vector3(4, 1.6, 0), RADIUS, HEIGHT);

    expect(straddling.position.y).toBeCloseTo(withinOneCell.position.y, 6);
    expect(straddling.position.y).toBeCloseTo(2, 4); // the crate's top face, once
  });
});

/**
 * Standing perfectly still on sloped ground used to creep downhill forever.
 *
 * Gravity buries the capsule a little every frame; the resolver pushed it back
 * out *along the surface normal*, which returns only the normal component of
 * that and leaves the rest as horizontal displacement. Measured before the fix:
 * ~4.5cm/s on a 10° ramp and ~13cm/s on a 30° one — but exactly zero on the
 * flat, which is why it only ever showed up on slopes. `MIN_GROUND_NORMAL_Y` in
 * collision/world.ts is the gate that fixes it; deleting it brings this back.
 */
describe("resolveCapsule — no drift while standing still", () => {
  /** The vertical part of engine/player/movement.ts's step, with no input. */
  function standStill(collision: CollisionWorld, start: THREE.Vector3, frames: number): THREE.Vector3 {
    const feet = start.clone();
    const velocity = new THREE.Vector3();
    for (let i = 0; i < frames; i++) {
      velocity.x = 0;
      velocity.z = 0;
      velocity.y -= GRAVITY * DT;
      feet.addScaledVector(velocity, DT);
      const resolved = collision.resolveCapsule(feet, RADIUS, HEIGHT);
      feet.copy(resolved.position);
      if (resolved.grounded && velocity.y < 0) {
        velocity.y = 0;
      }
    }
    return feet;
  }

  /** A big slab tilted `deg` about Z, so its surface falls away along x. */
  function ramp(deg: number): CollisionWorld {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(60, 1, 60));
    mesh.rotation.z = (deg * Math.PI) / 180;
    mesh.position.set(0, -0.5, 0);
    mesh.userData.collide = true;
    return worldWith(mesh);
  }

  it.each([0, 5, 10, 20, 30, 45])("holds position on a %i° slope", (deg) => {
    const collision = ramp(deg);
    const settled = standStill(collision, new THREE.Vector3(0, 0.6, 0), 60);

    const after = standStill(collision, settled, 300); // 5 s at 60fps

    const drift = Math.hypot(after.x - settled.x, after.z - settled.z);
    expect(drift).toBeLessThan(0.001);
  });

  it("still slides off a slope too steep to stand on", () => {
    // Past MIN_GROUND_NORMAL_Y (~60°) the push stays along the normal, so the
    // player slides rather than sticking to a cliff face.
    const collision = ramp(70);
    const settled = standStill(collision, new THREE.Vector3(0, 0.6, 0), 10);

    const after = standStill(collision, settled, 300);

    expect(Math.hypot(after.x - settled.x, after.z - settled.z)).toBeGreaterThan(1);
  });
});
