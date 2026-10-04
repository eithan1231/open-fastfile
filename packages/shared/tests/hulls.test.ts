// Per-asset hull collision (src/engine/collision.ts + src/scene/hulls.ts).
//
// The point of hulls is that a bounding box is a bad stand-in for most props:
// across interchange-mw3's 2,842 colliding placements the box is 97.9% empty
// air, and a streetlight's is a 13.7m tall wall of nothing around a pole. So
// the assertions here are about the *shape* being respected — that you can walk
// through the gap a box would have blocked, and are still stopped by the solid
// part — and about the transform, since one BVH is shared by every placement
// and a wrong inverse would put a prop's collision somewhere else entirely.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { CollisionWorld } from "../src/collision/world.js";
import { hullGeometryFrom } from "../src/collision/hulls.js";

const RADIUS = 0.3;
const HEIGHT = 1.7;

/** A thin vertical post: 0.2m square, 4m tall, standing on the origin. */
function post(): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(0.2, 4, 0.2);
  g.translate(0, 2, 0);
  return g;
}

function world(geometries: Record<string, THREE.BufferGeometry>, placements: { asset: string; matrix: THREE.Matrix4 }[]): CollisionWorld {
  const c = new CollisionWorld();
  c.setHulls(new Map(Object.entries(geometries)), placements);
  return c;
}

const at = (x: number, y: number, z: number, scale = 1, yaw = 0) =>
  new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0)),
    new THREE.Vector3(scale, scale, scale),
  );

describe("hull collision", () => {
  it("stops a capsule that walks into the post", () => {
    const c = world({ post: post() }, [{ asset: "post", matrix: at(0, 0, 0) }]);
    const from = new THREE.Vector3(0.25, 0, 0); // overlapping the 0.2m post
    const { position } = c.resolveCapsule(from, RADIUS, HEIGHT);
    expect(position.distanceTo(new THREE.Vector3(0, 0, 0))).toBeGreaterThan(from.length());
  });

  // The whole reason for hulls: a box proxy around this post would be its
  // bounding box, and anything inside that box would be blocked. The post is
  // 0.2m wide, so 1m to the side is air — and must stay air.
  it("leaves the air around a thin prop walkable", () => {
    const c = world({ post: post() }, [{ asset: "post", matrix: at(0, 0, 0) }]);
    const from = new THREE.Vector3(1, 0, 0);
    const { position } = c.resolveCapsule(from, RADIUS, HEIGHT);
    expect(position.x).toBeCloseTo(1, 5);
    expect(position.z).toBeCloseTo(0, 5);
  });

  it("respects a placement's translation", () => {
    const c = world({ post: post() }, [{ asset: "post", matrix: at(10, 0, 0) }]);
    // Where the post now is:
    const hit = c.resolveCapsule(new THREE.Vector3(10.25, 0, 0), RADIUS, HEIGHT).position;
    expect(hit.x).toBeGreaterThan(10.25);
    // Where it used to be must now be clear.
    const clear = c.resolveCapsule(new THREE.Vector3(0.25, 0, 0), RADIUS, HEIGHT).position;
    expect(clear.x).toBeCloseTo(0.25, 5);
  });

  // Same point, two scales, opposite answers. Deliberately just *outside* the
  // scaled surface: a capsule whose centre is fully inside a solid has no
  // well-defined way out, which is a property of push-out collision generally
  // rather than anything about hulls.
  it("respects a placement's scale", () => {
    const where = new THREE.Vector3(1.15, 0, 0);

    // 0.2m post: the surface is at x = 0.1, so 1.15 is open air.
    const small = world({ post: post() }, [{ asset: "post", matrix: at(0, 0, 0, 1) }]);
    expect(small.resolveCapsule(where, RADIUS, HEIGHT).position.x).toBeCloseTo(1.15, 5);

    // At 10x it is 2m across, surface at x = 1.0, so the capsule overlaps and
    // gets pushed clear of it.
    const big = world({ post: post() }, [{ asset: "post", matrix: at(0, 0, 0, 10) }]);
    expect(big.resolveCapsule(where, RADIUS, HEIGHT).position.x).toBeGreaterThan(1.29);
  });

  it("respects a placement's rotation", () => {
    // A plank 4m long in x, 0.2m in z, lying along the x axis.
    const plank = new THREE.BoxGeometry(4, 2, 0.2);
    plank.translate(0, 1, 0);
    // Beside the plank's thin axis rather than on it, so the way out is
    // unambiguous once it does overlap.
    const probe = new THREE.Vector3(0.25, 0, 1.5);

    // Unrotated the plank runs along x and is only 0.2m deep in z, so it comes
    // nowhere near z = 1.5.
    const flat = world({ plank }, [{ asset: "plank", matrix: at(0, 0, 0) }]);
    expect(flat.resolveCapsule(probe, RADIUS, HEIGHT).position.x).toBeCloseTo(0.25, 5);

    // Turned 90 degrees its length runs along z, reaching the probe and pushing
    // it out along x.
    const turned = world({ plank }, [{ asset: "plank", matrix: at(0, 0, 0, 1, Math.PI / 2) }]);
    expect(turned.resolveCapsule(probe, RADIUS, HEIGHT).position.x).toBeGreaterThan(0.25);
  });

  it("shares one hull across many placements", () => {
    const placements = Array.from({ length: 50 }, (_, i) => ({ asset: "post", matrix: at(i * 5, 0, 0) }));
    const c = world({ post: post() }, placements);
    expect(c.hullStats).toEqual({ instances: 50, assets: 1 });
    // Every one of them collides, from one shared BVH.
    for (const i of [0, 17, 49]) {
      const p = c.resolveCapsule(new THREE.Vector3(i * 5 + 0.25, 0, 0), RADIUS, HEIGHT).position;
      expect(p.x).toBeGreaterThan(i * 5 + 0.25);
    }
  });

  it("ignores a placement whose asset has no geometry", () => {
    const c = world({}, [{ asset: "missing", matrix: at(0, 0, 0) }]);
    expect(c.hullStats).toEqual({ instances: 0, assets: 0 });
    const from = new THREE.Vector3(0, 0, 0);
    expect(c.resolveCapsule(from, RADIUS, HEIGHT).position).toEqual(from);
  });
});

describe("hullGeometryFrom", () => {
  it("bakes each mesh's own transform into one merged geometry", () => {
    const root = new THREE.Group();
    const a = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    const b = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    b.position.set(10, 0, 0); // only correct if the node transform is applied
    root.add(a, b);

    const geo = hullGeometryFrom(root)!;
    geo.computeBoundingBox();
    expect(geo.boundingBox!.min.x).toBeCloseTo(-0.5);
    expect(geo.boundingBox!.max.x).toBeCloseTo(10.5);
  });

  it("returns nothing for a subtree with no meshes", () => {
    expect(hullGeometryFrom(new THREE.Group())).toBeUndefined();
  });
});
