// @vitest-environment happy-dom
// Where a fitted attachment actually ends up on the gun.
//
// This is the one part of the viewmodel that fails *plausibly*: an ACOG whose
// mount transform is wrong still renders, just at the origin of the rig, inside
// the player's wrist, or a hundred times too big. Nothing throws and nothing in
// a type catches it — the only check is measuring where the mesh lands.
//
// So it is measured, against the real catalogue: the M4 as the exporter packs
// it, the ACOG as it ships, mounted by the same code the game and the class
// preview both call. The catalogue is the game's own content and is not in the
// repository, so this skips without one (`python3 -m scripts.cod catalog --dump mw3`).

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { GltfAsset } from "../src/scene/assets.js";
import { mountAttachments } from "../src/scene/viewmodel.js";

const CATALOG = path.resolve(import.meta.dirname, "../../../worlds/catalog");

/** A skinned attachment: its root joint names the gun tag it belongs on. */
const SKINNED = {
  gun: path.join(CATALOG, "weapons/iw5/iw5_m4_mp/iw5_m4_mp.glb"),
  model: path.join(CATALOG, "attachments/iw5/viewmodel_acog/viewmodel_acog.glb"),
  id: "acog",
  tag: "tag_acog_2",
  weapon: "iw5_m4_mp",
};

/**
 * A **rigid** attachment: no joints at all, so nothing in the file says where it
 * goes (the exporter asks the gun) and OAT has baked its axis change into the
 * vertices (so mounting has to undo the rig's). Five of IW5's sniper scopes are
 * like this, and the MSR's is the one that was noticed floating.
 */
const RIGID = {
  gun: path.join(CATALOG, "weapons/iw5/iw5_msr_mp/iw5_msr_mp.glb"),
  model: path.join(CATALOG, "attachments/iw5/viewmodel_remington_msr_scope_iw5/viewmodel_remington_msr_scope_iw5.glb"),
  id: "msrscope",
  tag: "tag_scope",
  weapon: "iw5_msr_mp",
};

const built = [SKINNED, RIGID].every((c) => fs.existsSync(c.gun) && fs.existsSync(c.model));

async function load(file: string): Promise<GltfAsset> {
  const bytes = fs.readFileSync(file);
  const gltf = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), "");
  return { scene: gltf.scene, clips: gltf.animations };
}

function jointsOf(root: THREE.Object3D): Map<string, THREE.Object3D> {
  const joints = new Map<string, THREE.Object3D>();
  root.traverse((item) => {
    if (item instanceof THREE.Bone) {
      joints.set(item.name, item);
    }
  });
  return joints;
}

describe.skipIf(!built)("mounting an attachment on a real weapon", () => {
  it.each([
    ["a skinned attachment, which names its own mount", SKINNED],
    ["a rigid one, which has no joints to name it with", RIGID],
  ])("puts %s on the gun's tag, at the gun's scale", async (_what, fitted) => {
    const [gun, acog] = await Promise.all([load(fitted.gun), load(fitted.model)]);
    const root = gun.scene;
    const joints = jointsOf(root);
    const tag = joints.get(fitted.tag);
    expect(tag, `${fitted.weapon} should carry a ${fitted.tag} joint`).toBeTruthy();

    // Where the gun itself is, before anything is fitted: the yardstick for
    // "near the gun" rather than "at the origin".
    root.updateMatrixWorld(true);
    const gunBounds = new THREE.Box3().setFromObject(root);
    const gunSize = gunBounds.getSize(new THREE.Vector3()).length();

    const before = new Set<THREE.Object3D>();
    root.traverse((item) => before.add(item));
    mountAttachments(root, joints, [{ entry: { id: fitted.id, tag: fitted.tag, model: "model" }, asset: acog }], fitted.weapon);

    const added: THREE.Object3D[] = [];
    root.traverse((item) => {
      if (!before.has(item) && item instanceof THREE.Mesh) {
        added.push(item);
      }
    });
    expect(added.length, "the attachment should have brought at least one mesh").toBeGreaterThan(0);

    root.updateMatrixWorld(true);
    const scope = new THREE.Box3();
    for (const mesh of added) {
      scope.expandByObject(mesh);
    }

    // On the tag, not at the rig's origin: an unmounted attachment lands there,
    // which is exactly the failure that still renders.
    const at = tag!.getWorldPosition(new THREE.Vector3());
    const centre = scope.getCenter(new THREE.Vector3());
    expect(centre.distanceTo(at)).toBeLessThan(gunSize * 0.15);
    expect(centre.length()).toBeGreaterThan(0.01);

    // And at the gun's scale: the attachment GLB carries a unit-scale root of
    // its own, which is left behind when its meshes are reparented. Kept, it
    // would shrink the scope by 40x; applied twice, the same again.
    const scopeSize = scope.getSize(new THREE.Vector3()).length();
    expect(scopeSize).toBeGreaterThan(gunSize * 0.05);
    expect(scopeSize).toBeLessThan(gunSize);

    // Inside the gun's own box, give or take: a scope sits on a rifle.
    expect(
      gunBounds
        .clone()
        .expandByScalar(gunSize * 0.1)
        .containsBox(scope),
    ).toBe(true);
  });
});
