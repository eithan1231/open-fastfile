// Surface view (engine/surfaceView.ts): the only thing that can check a map's
// surfaces by eye, so the thing that must not quietly draw nothing.
//
// It reuses the BVH's own position buffer and builds only an index, which is
// what makes it affordable on a 400k-triangle map — and also what would make a
// mistake invisible: a view that drew the right colours over the wrong triangles,
// or none at all, looks like a map with no surfaces.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { CollisionWorld } from "@3d/shared/collision/world.js";
import { SURFACE_ATTRIBUTE, SURFACE_TYPES } from "@3d/shared/sim/surfaces.js";
import { SurfaceView } from "../src/engine/surfaceView.js";

function slab(surface: string | undefined, x0: number, x1: number): THREE.Mesh {
  const geometry = new THREE.PlaneGeometry(x1 - x0, 40, 8, 8).rotateX(-Math.PI / 2).translate((x0 + x1) / 2, 0, 0);
  if (surface !== undefined) {
    const index = SURFACE_TYPES.indexOf(surface as (typeof SURFACE_TYPES)[number]);
    const count = geometry.getAttribute("position").count;
    geometry.setAttribute(SURFACE_ATTRIBUTE, new THREE.BufferAttribute(new Uint8Array(count).fill(index), 1));
  }
  const mesh = new THREE.Mesh(geometry);
  mesh.userData.collide = true;
  return mesh;
}

function collisionOf(...meshes: THREE.Mesh[]): CollisionWorld {
  const root = new THREE.Group();
  for (const mesh of meshes) {
    root.add(mesh);
  }
  const collision = new CollisionWorld();
  collision.rebuild(root);
  return collision;
}

describe("SurfaceView", () => {
  it("draws one group per surface, over the triangles that surface actually covers", () => {
    const collision = collisionOf(slab("metal", -30, -10), slab("dirt", -10, 10));
    const view = new SurfaceView();
    view.build(collision.debugSurfaces());

    const mesh = view.object.children[0];
    expect(mesh).toBeInstanceOf(THREE.Mesh);
    const drawn = (mesh as THREE.Mesh).geometry;
    const materials = (mesh as THREE.Mesh).material as THREE.Material[];
    expect(drawn.groups.length).toBe(2);
    expect(materials.length).toBe(2);
    // Every triangle is drawn exactly once, and the groups tile the index.
    expect(drawn.groups.reduce((n, g) => n + g.count, 0)).toBe(drawn.getIndex()!.count);
    expect(view.histogram.map((r) => r.surface).sort()).toEqual(["dirt", "metal"]);
    expect(view.histogram.reduce((n, r) => n + r.triangles, 0)).toBe(256);
    // The positions are the collision world's own, not a copy.
    expect(drawn.getAttribute("position")).toBe(collision.debugSurfaces()[0]!.geometry.getAttribute("position"));
    view.dispose();
  });

  it("says so rather than drawing grey when a world has no surfaces at all", () => {
    const view = new SurfaceView();
    view.build(collisionOf(slab(undefined, -10, 10)).debugSurfaces());
    expect(view.empty).toBe(true);
    expect(view.object.children.length).toBe(0);
  });

  it("frees only what it made, so the collision world can still be queried after", () => {
    const collision = collisionOf(slab("gravel", -10, 10));
    const view = new SurfaceView();
    view.build(collision.debugSurfaces());
    view.clear();
    expect(view.object.children.length).toBe(0);
    expect(collision.surfaceAt({ x: 0, y: 2, z: 0 }, 5)).toBe("gravel");
  });
});
