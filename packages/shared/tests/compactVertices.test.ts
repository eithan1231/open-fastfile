import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { compactVertices } from "../src/collision/compact.js";
import { CollisionWorld } from "../src/collision/world.js";

/** A triangle at `x` indexing into a buffer of `spread` other, far-flung vertices it never uses. */
function sharedBufferTriangle(x: number, spread: number): THREE.BufferGeometry {
  const positions: number[] = [];
  for (let i = 0; i < spread; i++) {
    positions.push(1000 + i, -1000, 1000);
  }
  const first = positions.length / 3;
  positions.push(x, 0, 0, x + 1, 0, 0, x, 0, 1);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("_SURFACE", new THREE.BufferAttribute(new Uint8Array(positions.length / 3).fill(7), 1));
  geometry.setIndex([first, first + 1, first + 2]);
  return geometry;
}

describe("compactVertices", () => {
  it("keeps only the vertices the index names, every attribute alike", () => {
    const geometry = compactVertices(sharedBufferTriangle(5, 100));
    expect(geometry.getAttribute("position").count).toBe(3);
    expect(geometry.getAttribute("_SURFACE").count).toBe(3);
    expect(geometry.getAttribute("_SURFACE").getX(2)).toBe(7);
    expect(Array.from(geometry.getIndex()!.array)).toEqual([0, 1, 2]);
    geometry.computeBoundingBox();
    expect(geometry.boundingBox!.min.toArray()).toEqual([5, 0, 0]);
    expect(geometry.boundingBox!.max.toArray()).toEqual([6, 0, 1]);
  });

  it("gives a part sharing its group's buffer its own bounds", () => {
    const root = new THREE.Group();
    const part = new THREE.Mesh(sharedBufferTriangle(5, 100), new THREE.MeshBasicMaterial());
    part.userData.collide = true;
    part.userData.part = "*1";
    root.add(part);
    const collision = new CollisionWorld();
    collision.rebuild(root, ["*1"]);
    const bounds = collision.partBounds(0)!;
    expect(bounds.min.toArray()).toEqual([5, 0, 0]);
    expect(bounds.max.toArray()).toEqual([6, 0, 1]);
  });
});
