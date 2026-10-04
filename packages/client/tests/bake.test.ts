// Resolving a static rig into plain vertex data (src/scene/bake.ts).
//
// The correctness bar is exact: whatever three.js would have drawn for the
// skinned mesh is what the baked mesh must draw. So the central assertion here
// compares against three.js's own `SkinnedMesh.applyBoneTransform` rather than
// against hand-computed numbers — if the skinning composition is wrong, props
// come out subtly deformed, which is very hard to spot in a 8,000-prop map.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { bakeSkinnedMeshes } from "../src/scene/bake.js";

/**
 * A two-bone skinned mesh. Each vertex is bound entirely to one bone, so posing
 * a bone moves a known half of the geometry and nothing else.
 */
function makeSkinned(shared?: THREE.BufferGeometry): { mesh: THREE.SkinnedMesh; bones: THREE.Bone[] } {
  if (shared) {
    return bindSkinned(shared);
  }
  const geometry = new THREE.BufferGeometry();
  // prettier-ignore
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([
    0, 0, 0,   1, 0, 0,   0, 1, 0,   1, 1, 0,
  ], 3));
  // prettier-ignore
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute([
    0, 0, 1,   0, 0, 1,   0, 0, 1,   0, 0, 1,
  ], 3));
  geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4));
  geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4));
  geometry.setIndex([0, 1, 2, 1, 3, 2]);

  const root = new THREE.Bone();
  const tip = new THREE.Bone();
  tip.position.set(0, 1, 0);
  root.add(tip);

  return bindSkinned(geometry);
}

/** A fresh two-bone rig over existing geometry — what `SkeletonUtils.clone` hands AssetStore, which shares the geometry. */
function bindSkinned(geometry: THREE.BufferGeometry): { mesh: THREE.SkinnedMesh; bones: THREE.Bone[] } {
  const root = new THREE.Bone();
  const tip = new THREE.Bone();
  tip.position.set(0, 1, 0);
  root.add(tip);

  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial());
  mesh.add(root);
  mesh.bind(new THREE.Skeleton([root, tip]));
  mesh.updateMatrixWorld(true);
  return { mesh, bones: [root, tip] };
}

/** What three.js itself would put on screen for each vertex, in local space. */
function reference(mesh: THREE.SkinnedMesh): THREE.Vector3[] {
  const position = mesh.geometry.getAttribute("position");
  const out: THREE.Vector3[] = [];
  for (let i = 0; i < position.count; i++) {
    const v = new THREE.Vector3().fromBufferAttribute(position, i);
    out.push(mesh.applyBoneTransform(i, v));
  }
  return out;
}

describe("bakeSkinnedMeshes", () => {
  it("replaces a SkinnedMesh with a plain Mesh in the same place", () => {
    const parent = new THREE.Group();
    const { mesh } = makeSkinned();
    mesh.position.set(3, 0, -2);
    mesh.name = "bush";
    mesh.userData = { source: "bush.glb" };
    parent.add(mesh);
    parent.updateMatrixWorld(true);

    expect(bakeSkinnedMeshes(parent)).toBe(1);

    const meshes: THREE.Mesh[] = [];
    parent.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        meshes.push(o);
      }
    });
    expect(meshes).toHaveLength(1);
    expect(meshes[0]).not.toBeInstanceOf(THREE.SkinnedMesh);
    expect(meshes[0]!.name).toBe("bush");
    expect(meshes[0]!.userData).toEqual({ source: "bush.glb" });
    expect(meshes[0]!.position.toArray()).toEqual([3, 0, -2]);
  });

  it("reproduces three.js's own skinning for a posed skeleton", () => {
    const { mesh, bones } = makeSkinned();
    // Pose it well away from bind, so a wrong composition cannot coincidentally pass.
    bones[1]!.rotation.set(0, 0, Math.PI / 3);
    bones[1]!.position.set(0.25, 1, 0);
    const parent = new THREE.Group();
    parent.add(mesh);
    parent.updateMatrixWorld(true);

    const expected = reference(mesh);
    bakeSkinnedMeshes(parent);

    const baked = parent.children.find((c) => c instanceof THREE.Mesh && !(c instanceof THREE.SkinnedMesh)) as THREE.Mesh;
    const position = baked.geometry.getAttribute("position");
    for (let i = 0; i < position.count; i++) {
      const v = new THREE.Vector3().fromBufferAttribute(position, i);
      expect(v.x).toBeCloseTo(expected[i]!.x, 5);
      expect(v.y).toBeCloseTo(expected[i]!.y, 5);
      expect(v.z).toBeCloseTo(expected[i]!.z, 5);
    }
    // The pose must actually have moved something, or the check above is vacuous.
    expect(expected.some((v, i) => v.distanceTo(new THREE.Vector3().fromBufferAttribute(mesh.geometry.getAttribute("position"), i)) > 0.1)).toBe(true);
  });

  it("drops the skinning attributes, which is what makes it instanceable", () => {
    const parent = new THREE.Group();
    parent.add(makeSkinned().mesh);
    parent.updateMatrixWorld(true);
    bakeSkinnedMeshes(parent);

    const baked = parent.children.find((c) => c instanceof THREE.Mesh) as THREE.Mesh;
    expect(baked.geometry.getAttribute("skinIndex")).toBeUndefined();
    expect(baked.geometry.getAttribute("skinWeight")).toBeUndefined();
    expect(baked.geometry.getAttribute("normal")).toBeDefined();
    expect(baked.geometry.getIndex()).not.toBeNull();
  });

  it("leaves the geometry it baked from skinned, clone and all", () => {
    // P2: the bake no longer copies the skin attributes only to delete them, so
    // it detaches them from the source for the copy. AssetStore keeps an
    // unbaked `SkeletonUtils.clone` of a rig with clips, and that clone *shares
    // this geometry* — leaving it stripped would flatten every `animate:` prop.
    const parent = new THREE.Group();
    const { mesh } = makeSkinned();
    const geometry = mesh.geometry;
    parent.add(mesh);
    parent.updateMatrixWorld(true);
    bakeSkinnedMeshes(parent);

    expect(geometry.getAttribute("skinIndex")).toBeDefined();
    expect(geometry.getAttribute("skinWeight")).toBeDefined();

    // And still skins correctly: a second rig over the same geometry, posed,
    // bakes to what three.js itself would draw.
    const second = makeSkinned(geometry);
    second.bones[1]!.rotation.set(0, 0, Math.PI / 3);
    const holder = new THREE.Group();
    holder.add(second.mesh);
    holder.updateMatrixWorld(true);
    const expected = reference(second.mesh);
    expect(bakeSkinnedMeshes(holder)).toBe(1);

    const baked = holder.children.find((c) => c instanceof THREE.Mesh && !(c instanceof THREE.SkinnedMesh)) as THREE.Mesh;
    const position = baked.geometry.getAttribute("position");
    for (let i = 0; i < position.count; i++) {
      expect(new THREE.Vector3().fromBufferAttribute(position, i).distanceTo(expected[i]!)).toBeLessThan(1e-5);
    }
  });

  it("leaves a rig with no skin attributes alone", () => {
    const parent = new THREE.Group();
    const { mesh } = makeSkinned();
    mesh.geometry.deleteAttribute("skinWeight");
    parent.add(mesh);
    parent.updateMatrixWorld(true);

    expect(bakeSkinnedMeshes(parent)).toBe(0);
    expect(parent.children[0]).toBeInstanceOf(THREE.SkinnedMesh);
  });

  it("removes the bones it has orphaned", () => {
    const parent = new THREE.Group();
    parent.add(makeSkinned().mesh);
    parent.updateMatrixWorld(true);
    bakeSkinnedMeshes(parent);

    let bones = 0;
    parent.traverse((o) => {
      if (o instanceof THREE.Bone) {
        bones++;
      }
    });
    expect(bones).toBe(0);
  });

  it("leaves a morph-target rig alone", () => {
    // Morph targets are a second deformation the bake does not resolve, so the
    // mesh has to keep its rig rather than be silently flattened to one pose.
    const parent = new THREE.Group();
    const { mesh } = makeSkinned();
    mesh.geometry.morphAttributes.position = [new THREE.Float32BufferAttribute(new Float32Array(12), 3)];
    parent.add(mesh);
    parent.updateMatrixWorld(true);

    expect(bakeSkinnedMeshes(parent)).toBe(0);
    expect(parent.children[0]).toBeInstanceOf(THREE.SkinnedMesh);
    let bones = 0;
    parent.traverse((o) => {
      if (o instanceof THREE.Bone) {
        bones++;
      }
    });
    expect(bones).toBe(2); // the live rig's bones must survive
  });
});
