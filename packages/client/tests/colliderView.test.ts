// The collider wireframe (src/engine/colliderView.ts).
//
// What it has to get right is the world-space transform: a proxy's geometry is
// the shared unit box, and everything about its actual size and place lives in
// the mesh's matrix. Drawing the geometry's own bounds would put a 1m cube at
// the origin for every collider in the world.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { ColliderView } from "../src/engine/colliderView.js";
import { HIDDEN_COLLIDER } from "../src/scene/materials.js";

const unitBox = new THREE.BoxGeometry(1, 1, 1);

function proxy(position: THREE.Vector3Like, scale: THREE.Vector3Like): THREE.Mesh {
  const mesh = new THREE.Mesh(unitBox, HIDDEN_COLLIDER);
  mesh.userData.collider = true;
  mesh.position.set(position.x, position.y, position.z);
  mesh.scale.set(scale.x, scale.y, scale.z);
  return mesh;
}

function bounds(view: ColliderView): THREE.Box3 {
  const box = new THREE.Box3();
  const attr = view.object.geometry.getAttribute("position");
  const v = new THREE.Vector3();
  for (let i = 0; i < attr.count; i++) {
    box.expandByPoint(v.fromBufferAttribute(attr, i));
  }
  return box;
}

describe("ColliderView", () => {
  it("draws proxies at their world transform, not their geometry's", () => {
    const root = new THREE.Group();
    root.add(proxy({ x: 10, y: 2, z: -4 }, { x: 0.74, y: 1.12, z: 0.74 }));
    root.updateMatrixWorld(true);

    const view = new ColliderView();
    view.build(root);

    expect(view.colliderCount).toBe(1);
    const box = bounds(view);
    expect(box.min.x).toBeCloseTo(10 - 0.37, 6);
    expect(box.max.y).toBeCloseTo(2 + 0.56, 6);
    expect(box.min.z).toBeCloseTo(-4 - 0.37, 6);
  });

  it("follows a parent's transform, so a proxy inside a rotated model lands right", () => {
    const root = new THREE.Group();
    const group = new THREE.Group();
    group.position.set(5, 0, 0);
    group.add(proxy({ x: 0, y: 0, z: 0 }, { x: 2, y: 2, z: 2 }));
    root.add(group);
    root.updateMatrixWorld(true);

    const view = new ColliderView();
    view.build(root);
    expect(bounds(view).getCenter(new THREE.Vector3()).x).toBeCloseTo(5, 6);
  });

  it("emits 12 edges per proxy and ignores ordinary geometry", () => {
    const root = new THREE.Group();
    root.add(proxy({ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 }));
    root.add(proxy({ x: 3, y: 0, z: 0 }, { x: 1, y: 1, z: 1 }));
    root.add(new THREE.Mesh(unitBox, new THREE.MeshBasicMaterial())); // drawn, not a proxy
    root.updateMatrixWorld(true);

    const view = new ColliderView();
    view.build(root);

    expect(view.colliderCount).toBe(2);
    // 12 edges x 2 endpoints x 2 proxies
    expect(view.object.geometry.getAttribute("position").count).toBe(48);
  });

  it("starts hidden and rebuilds cleanly", () => {
    const view = new ColliderView();
    expect(view.visible).toBe(false);

    const root = new THREE.Group();
    root.add(proxy({ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 }));
    root.updateMatrixWorld(true);

    view.build(root);
    expect(view.object.geometry.getAttribute("position").count).toBe(24);

    // Rebuilding against an emptier world must not leave the old edges behind.
    view.build(new THREE.Group());
    expect(view.colliderCount).toBe(0);
    expect(view.object.geometry.getAttribute("position").count).toBe(0);
  });
});

// Clip groups from an imported CoD map. Unlike a box proxy these are not
// converted into wireframe geometry — they are meshes already in the scene at
// the right place, so the view shows them by un-hiding them. The catch is the
// ancestor chain: WorldSession hides the whole authored collision subtree once the
// BVH exists, and `visible = false` on a parent abandons the subtree however
// visible the child claims to be.
describe("ColliderView: map clip brushes", () => {
  function collisionSubtree(): { root: THREE.Group; group: THREE.Group; clip: THREE.Mesh; solid: THREE.Mesh } {
    const root = new THREE.Group();
    const group = new THREE.Group();
    group.userData.collisionMesh = true;

    const clip = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), HIDDEN_COLLIDER);
    clip.userData.collisionMesh = true;
    clip.userData.clipOnly = true;
    clip.userData.collisionGroup = "clip:0x08030000";
    clip.userData.clipGroup = "clip:0x08030000";
    clip.userData.clipContents = "0x08030000";
    clip.userData.clipBlocks = ["player", "ai", "detail"];
    clip.userData.clipBrushes = 377;

    // The `solid` half of the same file: real walls, already visible as
    // geometry, and deliberately not drawn by this view.
    const solid = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), HIDDEN_COLLIDER);
    solid.userData.collisionMesh = true;
    solid.userData.collisionGroup = "solid";

    group.add(clip, solid);
    root.add(group);
    root.updateMatrixWorld(true);

    // What WorldSession does after the BVH is built.
    root.traverse((o) => {
      if (o.userData.collisionMesh === true) {
        o.visible = false;
      }
    });
    return { root, group, clip, solid };
  }

  it("finds clip groups without counting them as box proxies", () => {
    const { root, clip } = collisionSubtree();
    const view = new ColliderView();
    view.build(root);

    expect(view.colliderCount).toBe(0);
    expect(view.clipBrushCount).toBe(377);
    expect(view.clipGroups).toHaveLength(1);
    expect(view.clipGroups[0]).toMatchObject({ group: "clip:0x08030000", contents: "0x08030000", brushes: 377 });
    expect(clip.userData.clipOnly).toBe(true);
  });

  it("un-hides the clip's ancestors too, or nothing would draw", () => {
    const { root, group, clip } = collisionSubtree();
    const view = new ColliderView();
    view.build(root);
    view.setVisible(true);

    expect(clip.visible).toBe(true);
    expect(group.visible).toBe(true); // the half that is easy to miss
    expect(clip.material).not.toBe(HIDDEN_COLLIDER);
  });

  it("leaves the solid half hidden, and restores everything on toggle off", () => {
    const { root, group, clip, solid } = collisionSubtree();
    const view = new ColliderView();
    view.build(root);

    view.setVisible(true);
    expect(solid.visible).toBe(false);

    view.setVisible(false);
    expect(clip.visible).toBe(false);
    expect(group.visible).toBe(false);
    expect(clip.material).toBe(HIDDEN_COLLIDER);
  });

  it("draws only colliding groups in the everything view", () => {
    const { root, clip, solid } = collisionSubtree();
    clip.userData.collide = false; // an AI-only hull: named, but not in the BVH
    solid.userData.collide = true;
    const view = new ColliderView();
    view.buildFull(root, []);
    view.setMode("everything");

    expect(solid.visible).toBe(true);
    expect(clip.visible).toBe(false);
  });
});
