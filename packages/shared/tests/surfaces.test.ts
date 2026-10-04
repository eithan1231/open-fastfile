// What is under this point, and what it is made of (collision/surfaces.ts).
//
// Two mechanisms each lose a per-triangle fact on their own, and both fail as a
// plausible answer rather than as an error — a footstep on the wrong material,
// which nobody can hear is wrong:
//
//   - the meshes are merged into one geometry by `StaticGeometryGenerator`, so a
//     table has to be per mesh and concatenated in the merge's own order;
//   - `MeshBVH` then **reorders that geometry's index**, so a raycast's
//     `faceIndex` counts triangles in the tree's order, not the merge's. A table
//     in merge order names some other triangle's material and looks fine.
//
// So the fixtures here are three meshes of 128 triangles each rather than three
// quads: with one mesh the first mistake is the identity, and under about a
// hundred triangles the BVH leaves the index alone and so is the second. The
// reorder is asserted below rather than assumed, because a fixture that stopped
// triggering it would leave the test passing and guarding nothing.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { CollisionWorld } from "../src/collision/world.js";
import { faceSurface, triangleSurfaces } from "../src/collision/surfaces.js";
import { SURFACE_ATTRIBUTE, SURFACE_TYPES, surfaceType } from "../src/sim/surfaces.js";
import type { CapsuleWorld } from "../src/sim/capsule.js";

/** A floor slab at `y`, spanning `x0..x1`, every vertex on `surface`. 128 triangles: see the note above. */
function slab(surface: string | undefined, y: number, x0: number, x1: number): THREE.Mesh {
  const geometry = new THREE.PlaneGeometry(x1 - x0, 40, 8, 8).rotateX(-Math.PI / 2).translate((x0 + x1) / 2, y, 0);
  if (surface !== undefined) {
    const index = SURFACE_TYPES.indexOf(surface as (typeof SURFACE_TYPES)[number]);
    const count = geometry.getAttribute("position").count;
    geometry.setAttribute(SURFACE_ATTRIBUTE, new THREE.BufferAttribute(new Uint8Array(count).fill(index), 1));
  }
  const mesh = new THREE.Mesh(geometry);
  mesh.userData.collide = true;
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

describe("the surface list", () => {
  it("starts at `default` and is read by index, because that index is the wire value", () => {
    expect(SURFACE_TYPES[0]).toBe("default");
    expect(surfaceType(0)).toBe("default");
    expect(surfaceType(13)).toBe("metal");
    // Black Ops' table diverges from IW's here; the exporter maps each game's
    // own index into this one, so both spellings have a slot.
    expect(surfaceType(29)).toBe("riotshield");
    expect(surfaceType(31)).toBe("player");
    // An index this build has never heard of is `default`, not undefined: a
    // world exported by a newer exporter must still be walkable.
    expect(surfaceType(200)).toBe("default");
    expect(surfaceType(-1)).toBe("default");
  });
});

describe("surfaceAt", () => {
  it("names the surface under a point", () => {
    const collision = world(slab("metal", 0, -10, 10));
    expect(collision.surfaceAt({ x: 0, y: 2, z: 0 }, 5)).toBe("metal");
  });

  it("is `default` for a world whose collision says nothing, and that is not an error", () => {
    // Every hand-written world, and every imported map exported before the
    // surface pass existed. A footstep still plays; it plays `default`.
    const collision = world(slab(undefined, 0, -10, 10));
    expect(collision.surfaceAt({ x: 0, y: 2, z: 0 }, 5)).toBe("default");
    expect(collision.groundBelow({ x: 0, y: 2, z: 0 }, 5)).toBeCloseTo(0);
  });

  it("is null when there is nothing under the point at all", () => {
    const collision = world(slab("metal", 0, -10, 10));
    expect(collision.surfaceAt({ x: 100, y: 2, z: 0 }, 5)).toBeNull();
    // Out of reach is the same answer as out of the world.
    expect(collision.surfaceAt({ x: 0, y: 2, z: 0 }, 1)).toBeNull();
  });

  it("names each of several meshes' own surface, not the first mesh's", () => {
    // The merge case. Three slabs side by side at the same height: a table that
    // lost the attribute answers `default` everywhere, and one built in merge
    // order but read through the BVH's reordered index answers at random.
    const collision = world(slab("metal", 0, -30, -10), slab("dirt", 0, -10, 10), slab("wood", 0, 10, 30));
    // Off the half metre, so no probe lands on a seam where two slabs share an edge.
    for (let x = -29.5; x < 30; x += 1) {
      expect(collision.surfaceAt({ x, y: 2, z: 0 }, 5)).toBe(x < -10 ? "metal" : x < 10 ? "dirt" : "wood");
    }
    expect(collision.surfaceAt({ x: -20, y: 2, z: 0 }, 5)).toBe("metal");
    expect(collision.surfaceAt({ x: 0, y: 2, z: 0 }, 5)).toBe("dirt");
    expect(collision.surfaceAt({ x: 20, y: 2, z: 0 }, 5)).toBe("wood");
  });

  it("gives a mesh with no surfaces `default` beside meshes that have them", () => {
    const collision = world(slab("gravel", 0, -30, -10), slab(undefined, 0, 10, 30));
    expect(collision.surfaceAt({ x: -20, y: 2, z: 0 }, 5)).toBe("gravel");
    expect(collision.surfaceAt({ x: 20, y: 2, z: 0 }, 5)).toBe("default");
  });

  it("reads the same hit `groundBelow` measures", () => {
    // Two floors, one above the other: whichever height is reported, the surface
    // has to be that floor's. They are one query behind the scenes for this reason.
    const collision = world(slab("metal", 3, -10, 10), slab("dirt", 0, -10, 10));
    expect(collision.groundBelow({ x: 0, y: 6, z: 0 }, 10)).toBeCloseTo(3);
    expect(collision.surfaceAt({ x: 0, y: 6, z: 0 }, 10)).toBe("metal");
    expect(collision.groundBelow({ x: 0, y: 2, z: 0 }, 10)).toBeCloseTo(0);
    expect(collision.surfaceAt({ x: 0, y: 2, z: 0 }, 10)).toBe("dirt");
  });

  it("is on `CapsuleWorld`, which is all the simulation is allowed to see", () => {
    // sim/ may not import collision/ at all (eslint.config.js), so a footstep
    // reaches this through the interface or not at all.
    const capsule: CapsuleWorld = world(slab("snow", 0, -10, 10));
    expect(capsule.surfaceAt({ x: 0, y: 2, z: 0 }, 5)).toBe("snow");
  });
});

describe("the per-triangle table a debug view draws", () => {
  it("follows the BVH's reordering, so it colours the triangle it names", () => {
    const collision = world(slab("metal", 0, -30, -10), slab("dirt", 0, -10, 10));
    const surfaces = collision.debugSurfaces();
    const map = surfaces.find((s) => s.surfaces);
    expect(map?.surfaces).toBeDefined();
    const table = map!.surfaces!;
    const geometry = map!.geometry;
    expect(table.length).toBe(geometry.getIndex()!.count / 3);
    for (let t = 0; t < table.length; t++) {
      expect(surfaceType(table[t]!)).toBe(faceSurface(geometry, t));
    }
    expect(new Set([...table].map(surfaceType))).toEqual(new Set(["metal", "dirt"]));
  });

  it("says nothing at all for geometry that carries no surfaces", () => {
    const collision = world(slab(undefined, 0, -10, 10));
    expect(collision.debugSurfaces()[0]?.surfaces).toBeUndefined();
    expect(triangleSurfaces(collision.debugSurfaces()[0]!.geometry)).toBeUndefined();
  });
});

describe("the fixtures themselves", () => {
  it("are big enough that the BVH really does reorder the index", () => {
    // The guard on the guard: `faceSurface` goes through the index precisely
    // because the BVH rewrites it, and a fixture too small to provoke that would
    // pass either way. Measured: 24 triangles are left alone, 96 are not.
    const meshes = [slab("metal", 0, -30, -10), slab("dirt", 0, -10, 10), slab("wood", 0, 10, 30)];
    const root = new THREE.Group();
    for (const mesh of meshes) {
      root.add(mesh);
    }
    const collision = new CollisionWorld();
    collision.rebuild(root);
    const geometry = collision.debugSurfaces()[0]!.geometry;
    const index = geometry.getIndex()!;
    let sorted = true;
    for (let t = 1; t < index.count / 3; t++) {
      if (index.getX(t * 3) < index.getX((t - 1) * 3)) {
        sorted = false;
        break;
      }
    }
    expect(sorted).toBe(false);
  });
});
