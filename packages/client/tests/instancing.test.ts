// Pooling repeated `model` placements into InstancedMeshes
// (src/scene/instancing.ts), and the picking contract that has to survive it.
//
// The risk this guards is specific: an InstancedMesh collapses many placements
// into one object, so the "walk up to the nearest tagged ancestor" rule that
// engine/picking.ts is built on stops reaching anything. If the instanceId
// mapping is wrong, every prop in the world reports as the same one — which
// looks entirely normal until you point at something.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { instanceModels } from "../src/scene/instancing.js";
import { ScenePicker } from "../src/engine/picking.js";
import { HIDDEN_COLLIDER } from "../src/scene/materials.js";

const sharedGeometry = new THREE.BoxGeometry(1, 1, 1);
const sharedMaterial = new THREE.MeshBasicMaterial();

/** What scene/models.ts produces for one `model`: a tagged group wrapping the glTF's own nodes. */
function placement(source: string, x: number, geometry = sharedGeometry, material = sharedMaterial): THREE.Group {
  const group = new THREE.Group();
  group.userData = { model: true, source };
  const inner = new THREE.Group(); // the glTF scene node
  inner.add(new THREE.Mesh(geometry, material));
  group.add(inner);
  group.position.set(x, 0, -5);
  return group;
}

function camera(x = 0): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(70, 1, 0.1, 100);
  cam.position.set(x, 0, 0);
  cam.lookAt(x, 0, -1);
  cam.updateMatrixWorld(true);
  return cam;
}

const CENTER = new THREE.Vector2(0, 0);

describe("instanceModels", () => {
  it("never pools a removable part's mesh, which is shown and hidden on its own", () => {
    const root = new THREE.Group();
    for (let i = 0; i < 3; i++) {
      root.add(placement("door.glb", i * 2));
    }
    root.children[0]!.traverse((node) => {
      if (node instanceof THREE.Mesh) {
        node.userData.renderPart = 0;
      }
    });

    const stats = instanceModels(root);

    expect(stats.instances).toBe(2);
    let kept = 0;
    root.children[0]!.traverse((node) => {
      kept += node instanceof THREE.Mesh && !(node instanceof THREE.InstancedMesh) ? 1 : 0;
    });
    expect(kept).toBe(1);
  });

  it("pools placements sharing geometry and material into one batch", () => {
    const root = new THREE.Group();
    for (let i = 0; i < 5; i++) {
      root.add(placement("barrel.glb", i * 2));
    }

    const stats = instanceModels(root);

    expect(stats.batches).toBe(1);
    expect(stats.instances).toBe(5);

    const batches = root.children.filter((c): c is THREE.InstancedMesh => c instanceof THREE.InstancedMesh);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.count).toBe(5);
    // Geometry is borrowed from the asset, never rebuilt.
    expect(batches[0]!.geometry).toBe(sharedGeometry);
  });

  it("places each instance where its placement actually was", () => {
    const root = new THREE.Group();
    for (let i = 0; i < 3; i++) {
      root.add(placement("barrel.glb", i * 2));
    }
    instanceModels(root);

    const batch = root.children.find((c): c is THREE.InstancedMesh => c instanceof THREE.InstancedMesh)!;
    const m = new THREE.Matrix4();
    const at = new THREE.Vector3();
    for (let i = 0; i < 3; i++) {
      batch.getMatrixAt(i, m);
      at.setFromMatrixPosition(m);
      expect(at.x).toBeCloseTo(i * 2, 6);
      expect(at.z).toBeCloseTo(-5, 6);
    }
  });

  it("leaves a one-off alone rather than paying for a batch of one", () => {
    // The map shell: 123 primitives, each used exactly once. Instancing it
    // would cost a matrix buffer and give up per-object frustum culling to
    // save nothing.
    const root = new THREE.Group();
    root.add(placement("shell.glb", 0, new THREE.BoxGeometry(2, 2, 2), new THREE.MeshBasicMaterial()));

    const stats = instanceModels(root);

    expect(stats.batches).toBe(0);
    expect(root.children.some((c) => c instanceof THREE.InstancedMesh)).toBe(false);
  });

  it("removes the emptied glTF wrapper nodes, not just the meshes", () => {
    // The node count is the whole point of the exercise — leaving the wrappers
    // behind would keep most of the per-frame projectObject walk.
    const root = new THREE.Group();
    for (let i = 0; i < 4; i++) {
      root.add(placement("barrel.glb", i * 2));
    }
    const before = countNodes(root);

    instanceModels(root);

    // 4 meshes + 4 wrapper groups gone, 1 batch added.
    expect(countNodes(root)).toBe(before - 8 + 1);
    // The authored nodes themselves survive: they carry the identity.
    expect(root.children.filter((c) => c.userData.model === true)).toHaveLength(4);
  });

  it("never pools a hidden placement into a drawn batch", () => {
    // `visible: false` is authored, and a batch is one visible object: pooling
    // a hidden mesh into it would put that mesh back on screen. The bug this
    // guards looks like props reappearing that the world file switched off.
    const root = new THREE.Group();
    const shown = placement("barrel.glb", 0);
    const hidden = placement("barrel.glb", 4);
    hidden.visible = false;
    root.add(shown, hidden);

    const stats = instanceModels(root);

    // One visible placement is below MIN_INSTANCES, so nothing is pooled.
    expect(stats.instances).toBe(0);
    expect(root.children.some((c) => c instanceof THREE.InstancedMesh)).toBe(false);
    // And the hidden placement keeps its own mesh rather than losing it to a batch.
    let meshes = 0;
    hidden.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        meshes++;
      }
    });
    expect(meshes).toBe(1);
  });

  it("pools only the visible placements when both kinds are present", () => {
    const root = new THREE.Group();
    for (let i = 0; i < 3; i++) {
      root.add(placement("barrel.glb", i * 2));
    }
    const hidden = placement("barrel.glb", 99);
    hidden.visible = false;
    root.add(hidden);

    const stats = instanceModels(root);

    expect(stats.instances).toBe(3);
    const batch = root.children.find((c): c is THREE.InstancedMesh => c instanceof THREE.InstancedMesh)!;
    expect(batch.count).toBe(3);
    // No instance sits where the hidden placement was.
    const m = new THREE.Matrix4();
    const at = new THREE.Vector3();
    for (let i = 0; i < batch.count; i++) {
      batch.getMatrixAt(i, m);
      at.setFromMatrixPosition(m);
      expect(at.x).not.toBeCloseTo(99, 3);
    }
  });

  it("respects a mesh hidden inside the asset, not just a hidden placement", () => {
    const root = new THREE.Group();
    for (let i = 0; i < 3; i++) {
      const group = placement("barrel.glb", i * 2);
      (group.children[0] as THREE.Group).visible = false; // the glTF's own node
      root.add(group);
    }

    expect(instanceModels(root).instances).toBe(0);
  });

  it("never pools a collision proxy", () => {
    // engine/colliderView.ts reads each proxy's own world matrix; pooled, they
    // would have no individual matrices to read.
    const root = new THREE.Group();
    for (let i = 0; i < 3; i++) {
      const group = placement("barrel.glb", i * 2);
      const proxy = new THREE.Mesh(sharedGeometry, HIDDEN_COLLIDER);
      proxy.userData.collider = true;
      group.add(proxy);
      root.add(group);
    }

    instanceModels(root);

    let proxies = 0;
    root.traverse((o) => {
      if (o.userData.collider === true) {
        proxies++;
      }
    });
    expect(proxies).toBe(3);
  });
});

describe("picking an instanced prop", () => {
  it("resolves the instance under the cursor to its own authored node", () => {
    // The failure this catches: every instance reporting as placement 0.
    const root = new THREE.Group();
    const groups = [0, 1, 2].map((i) => placement(`prop-${i}.glb`, i * 4));
    for (const g of groups) {
      root.add(g);
    }
    instanceModels(root);
    root.updateMatrixWorld(true);

    for (const [i, group] of groups.entries()) {
      const pick = new ScenePicker().pick(CENTER, camera(i * 4), root);
      expect(pick?.entity).toBe(group);
      expect(pick?.source).toBe(`prop-${i}.glb`);
    }
  });

  it("reports the instance's own position, not the batch's origin", () => {
    const root = new THREE.Group();
    root.add(placement("a.glb", 0));
    root.add(placement("b.glb", 8));
    instanceModels(root);
    root.updateMatrixWorld(true);

    const pick = new ScenePicker().pick(CENTER, camera(8), root)!;
    expect(pick.position.x).toBeCloseTo(8, 6);
    expect(pick.position.z).toBeCloseTo(-5, 6);
    expect(pick.size.x).toBeCloseTo(1, 6);
  });

  it("highlights the instance in place, still borrowing its geometry", () => {
    const root = new THREE.Group();
    root.add(placement("a.glb", 0));
    root.add(placement("b.glb", 8));
    instanceModels(root);
    root.updateMatrixWorld(true);

    const picker = new ScenePicker();
    const pick = picker.pick(CENTER, camera(8), root)!;
    picker.highlight(pick);

    const clone = picker.overlay.children.find((c): c is THREE.Mesh => c instanceof THREE.Mesh)!;
    expect(clone.geometry).toBe(sharedGeometry); // borrowed, never cloned
    const at = new THREE.Vector3().setFromMatrixPosition(clone.matrix);
    expect(at.x).toBeCloseTo(8, 6);
    expect(at.z).toBeCloseTo(-5, 6);
  });

  it("still finds a collision proxy that has been hidden for the renderer", () => {
    // WorldSession sets `visible = false` on every proxy once the BVH is built.
    // THREE.Raycaster ignores `visible`, which is what keeps collider view
    // pointable — if that ever changed, collider mode would silently go dead.
    const root = new THREE.Group();
    const group = placement("barrel.glb", 0);
    const proxy = new THREE.Mesh(sharedGeometry, HIDDEN_COLLIDER);
    proxy.userData.collider = true;
    proxy.scale.set(1.5, 1.5, 1.5);
    proxy.visible = false;
    group.add(proxy);
    root.add(group);
    instanceModels(root);
    root.updateMatrixWorld(true);

    const pick = new ScenePicker().pick(CENTER, camera(0), root, true);
    expect(pick?.collider).toBe(true);
    expect(pick?.entity).toBe(group);
  });
});

function countNodes(obj: THREE.Object3D): number {
  let n = 0;
  obj.traverse(() => n++);
  return n;
}

describe("entity ids survive instancing", () => {
  /**
   * The whole point of the id side-table: addressing one prop at runtime after
   * the batch has taken its meshes away. The group is what carries identity, and
   * `pruneEmpty` must not collect it — `isDisposable` keeps anything tagged with
   * a `shape`, which every placement has.
   */
  it("keeps the placement group, and a reference to it stays valid", () => {
    const root = new THREE.Group();
    const nodes = new Map<number, THREE.Object3D>();
    for (let i = 0; i < 5; i++) {
      const group = placement("barrel.glb", i * 2);
      group.userData.id = i;
      nodes.set(i, group);
      root.add(group);
    }

    instanceModels(root);

    for (let i = 0; i < 5; i++) {
      const node = nodes.get(i)!;
      expect(node.parent).toBe(root);
      expect(node.userData.id).toBe(i);
      // Its meshes moved into the batch, so it is drawn through these instead.
      expect(node.userData.instancedParts).toHaveLength(1);
    }
  });

  it("maps an id to the instance actually drawing it", () => {
    const root = new THREE.Group();
    for (let i = 0; i < 3; i++) {
      const group = placement("barrel.glb", i * 2);
      group.userData.id = 10 + i;
      root.add(group);
    }

    instanceModels(root);

    const batch = root.children.find((c): c is THREE.InstancedMesh => c instanceof THREE.InstancedMesh)!;
    const owners = batch.userData.instanceOwners as THREE.Object3D[];
    // Each instance reports the id of the placement it came from, so a hit on
    // the batch resolves to one prop rather than to all of them.
    expect(owners.map((o) => o.userData.id).sort((a, b) => a - b)).toEqual([10, 11, 12]);
  });
});
