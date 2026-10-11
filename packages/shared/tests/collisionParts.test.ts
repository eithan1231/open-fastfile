// Removable parts in the collision (collision/world.ts): a `solid` names a part of
// the collision glb, which is kept out of the base trees and answered through a
// view whose presence is read at query time.
//
// The wall here is a subdivided box of well over a hundred triangles, for the
// reason surfaces.test.ts gives: under that the BVH leaves its index alone, and a
// per-triangle fact read through the wrong order would pass unnoticed. The
// reorder is asserted rather than assumed.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { CollisionWorld } from "../src/collision/world.js";
import { collisionGroupMesh } from "../src/collision/source.js";
import { RADIUS, STAND_HEIGHT as HEIGHT } from "../src/sim/movement.js";
import { SURFACE_ATTRIBUTE, SURFACE_TYPES } from "../src/sim/surfaces.js";
import { Presence } from "../src/worlds/presence.js";

const EAST = { x: 1, y: 0, z: 0 };
const MATERIAL = new THREE.MeshBasicMaterial();

/** Every vertex on `surface`. */
function withSurface(geometry: THREE.BufferGeometry, surface: string): THREE.BufferGeometry {
  const index = SURFACE_TYPES.indexOf(surface as (typeof SURFACE_TYPES)[number]);
  geometry.setAttribute(SURFACE_ATTRIBUTE, new THREE.BufferAttribute(new Uint8Array(geometry.getAttribute("position").count).fill(index), 1));
  return geometry;
}

/** A glb node as the exporter writes one, through the same reader both ends use. */
function exported(geometry: THREE.BufferGeometry, extras: Record<string, unknown>): THREE.Mesh {
  const source = new THREE.Mesh(geometry);
  Object.assign(source.userData, extras);
  source.updateMatrixWorld(true);
  return collisionGroupMesh(source, MATERIAL);
}

/** A concrete floor, and a metal wall two metres east that is the part `*7`. */
function doorway(): CollisionWorld {
  const root = new THREE.Group();
  const floor = withSurface(new THREE.PlaneGeometry(40, 40, 8, 8).rotateX(-Math.PI / 2), "concrete");
  root.add(exported(floor, { group: "solid" }));
  // 0.4 m thick, 3 m tall, 4 m wide: 8 × 8 segments a face is 768 triangles.
  const wall = withSurface(new THREE.BoxGeometry(0.4, 3, 4, 8, 8, 8).translate(2.2, 1.5, 0), "metal");
  root.add(exported(wall, { group: "solid", part: "*7" }));
  // A part the world declares nothing for is base, however the glb tags it.
  const post = new THREE.BoxGeometry(0.4, 3, 0.4).translate(-5, 1.5, 0);
  root.add(exported(post, { group: "solid", part: "*99" }));
  const collision = new CollisionWorld();
  collision.rebuild(root, ["*3", "*7"]);
  return collision;
}

/** Feet a capsule's radius west of the wall, less ten centimetres: pressed into its face. */
const INSIDE = { x: 2 - RADIUS + 0.1, y: 0, z: 0 };

describe("a removable part", () => {
  it("is kept out of the base and in trees of its own", () => {
    const collision = doorway();
    expect(collision.partCount).toBe(2);
    // `*3` is listed and has nothing that collides: absent here, and not an error.
    expect(collision.partBounds(0)).toBeUndefined();
    expect(collision.partBounds(1)!.min.x).toBeCloseTo(2);
    expect(collision.mapSurfaces().shots!.getIndex()!.count / 3).toBe(128 + 12);
    expect(collision.partSurfaces(1).shots!.getIndex()!.count / 3).toBe(768);
    // The untagged post stayed in the base, where a solid-less part belongs.
    expect(collision.view(new Presence(2, undefined, false)).overlapsCapsule({ x: -5, y: 0, z: 0 }, RADIUS, HEIGHT)).toBe(true);
  });

  it("stops a capsule while present, lets it through once removed, and stops it again when restored", () => {
    const collision = doorway();
    const presence = new Presence(2);
    const view = collision.view(presence);
    expect(view.overlapsCapsule(INSIDE, RADIUS, HEIGHT)).toBe(true);
    expect(view.resolveCapsule(INSIDE, RADIUS, HEIGHT).position.x).toBeCloseTo(2 - RADIUS, 2);

    presence.set(1, false);
    expect(view.overlapsCapsule(INSIDE, RADIUS, HEIGHT)).toBe(false);
    expect(view.resolveCapsule(INSIDE, RADIUS, HEIGHT).position.x).toBeCloseTo(INSIDE.x);

    presence.set(1, true);
    expect(view.overlapsCapsule(INSIDE, RADIUS, HEIGHT)).toBe(true);
  });

  it("stops a bullet while present and not once removed", () => {
    const collision = doorway();
    const presence = new Presence(2);
    const view = collision.view(presence);
    const from = { x: 0, y: 1, z: 0 };
    const hit = view.traceRay(from, EAST, 50, "shots");
    expect(hit?.distance).toBeCloseTo(2);
    expect(hit?.surface).toBe("metal");

    presence.set(1, false);
    expect(view.traceRay(from, EAST, 50, "shots")).toBeNull();
    // Nor is the floor under it stood on through a removed wall's top.
    expect(view.groundBelow({ x: 2.2, y: 5, z: 0 }, 10)).toBeCloseTo(0);
    presence.set(1, true);
    expect(view.groundBelow({ x: 2.2, y: 5, z: 0 }, 10)).toBeCloseTo(3);
  });

  it("gives two views over one world their own answers", () => {
    const collision = doorway();
    const open = new Presence(2);
    open.set(1, false);
    const shut = new Presence(2);
    const a = collision.view(open);
    const b = collision.view(shut);
    expect(a.overlapsCapsule(INSIDE, RADIUS, HEIGHT)).toBe(false);
    expect(b.overlapsCapsule(INSIDE, RADIUS, HEIGHT)).toBe(true);
    shut.set(1, false);
    open.set(1, true);
    expect(a.overlapsCapsule(INSIDE, RADIUS, HEIGHT)).toBe(true);
    expect(b.overlapsCapsule(INSIDE, RADIUS, HEIGHT)).toBe(false);
  });

  it("is answered alone by a part view, with no base under it", () => {
    const collision = doorway();
    const wall = collision.partView(1);
    expect(wall.overlapsCapsule(INSIDE, RADIUS, HEIGHT)).toBe(true);
    expect(wall.groundBelow({ x: 0, y: 2, z: 0 }, 5)).toBeNull();
  });

  it("names its own surface through the BVH's reordered index", () => {
    const collision = doorway();
    const wall = collision.debugSurfaces().find((surface) => surface.part === 1)!;
    const index = wall.geometry.getIndex()!;
    let sorted = true;
    for (let t = 1; t < index.count / 3; t++) {
      if (index.getX(t * 3) < index.getX((t - 1) * 3)) {
        sorted = false;
        break;
      }
    }
    // The guard on the guard: the part's tree really was reordered.
    expect(sorted).toBe(false);
    expect(new Set(wall.surfaces)).toEqual(new Set([SURFACE_TYPES.indexOf("metal")]));
    const presence = new Presence(2);
    expect(collision.view(presence).surfaceAt({ x: 2.2, y: 5, z: 0 }, 10)).toBe("metal");
    expect(collision.view(presence).surfaceAt({ x: 0, y: 5, z: 0 }, 10)).toBe("concrete");
  });

  it("masks a prop by its mode, and only in a view", () => {
    const collision = new CollisionWorld();
    const box = new THREE.BoxGeometry(1, 1, 1);
    collision.setHulls(new Map([["crate", box]]), [
      { asset: "crate", matrix: new THREE.Matrix4().makeTranslation(0, 0.5, 0), modes: ["sd"] },
      { asset: "crate", matrix: new THREE.Matrix4().makeTranslation(5, 0.5, 0) },
    ]);
    const at = { x: 0, y: 0, z: 0 };
    expect(collision.overlapsCapsule(at, RADIUS, HEIGHT)).toBe(true);
    expect(collision.view(new Presence(0, "sd")).overlapsCapsule(at, RADIUS, HEIGHT)).toBe(true);
    expect(collision.view(new Presence(0, "tdm")).overlapsCapsule(at, RADIUS, HEIGHT)).toBe(false);
    expect(collision.view(new Presence(0)).overlapsCapsule(at, RADIUS, HEIGHT)).toBe(false);
    expect(collision.view(new Presence(0, "tdm")).overlapsCapsule({ x: 5, y: 0, z: 0 }, RADIUS, HEIGHT)).toBe(true);
  });
});
