// Animated `model` placements (`animate:`): the rig a placement clones, and
// what the scene hands engine/animator.ts to play. Why an animated prop keeps
// its rig while every other prop is baked, and why its shadow stays at rest:
// docs/engine/rendering.md#animated-props.

import * as THREE from "three";
import { addPatch } from "../engine/render/patches.js";

/** One placement to animate: its cloned rig and the clip it loops. */
export interface AnimatedPlacement {
  root: THREE.Object3D;
  clip: THREE.AnimationClip;
}

/** Poses sampled per clip when measuring how far an animated mesh reaches. */
const BOUNDS_SAMPLES = 16;

/**
 * Depth material that draws a skinned mesh in its bind pose, so the shadow map
 * (rendered only when invalidated) never freezes a prop mid-motion. With the
 * skinning chunks gone the vertices are the mesh's own, which glTF defines as
 * the bind pose. three copies the source's map and alpha test onto it per draw,
 * so one is made per source material (AssetStore.bindPoseDepth).
 */
export function bindPoseDepthMaterial(): THREE.MeshDepthMaterial {
  const material = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  addPatch(material, {
    name: "bind-pose-depth",
    key: "bind-pose-depth",
    apply: (shader) => {
      shader.vertexShader = shader.vertexShader.replace("#include <skinbase_vertex>", "").replace("#include <skinning_vertex>", "");
    },
  });
  return material;
}

/**
 * Give every skinned mesh under `rig` bounds that hold every pose `clips` reach,
 * then return it to its bind pose. A SkinnedMesh measures its bounds once, at
 * rest, so without this a tarp blown sideways is culled while still on screen.
 */
export function sampleAnimatedBounds(rig: THREE.Object3D, clips: readonly THREE.AnimationClip[]): void {
  const meshes: THREE.SkinnedMesh[] = [];
  rig.traverse((o) => {
    if (o instanceof THREE.SkinnedMesh) {
      meshes.push(o);
    }
  });
  if (meshes.length === 0 || clips.length === 0) {
    return;
  }

  const rest: [THREE.Object3D, THREE.Vector3, THREE.Quaternion, THREE.Vector3][] = [];
  rig.traverse((o) => rest.push([o, o.position.clone(), o.quaternion.clone(), o.scale.clone()]));

  const boxes = meshes.map(() => new THREE.Box3());
  const mixer = new THREE.AnimationMixer(rig);
  for (const clip of clips) {
    // Clamped, or the last sample (t = duration) wraps back to the first pose.
    const action = mixer.clipAction(clip).setLoop(THREE.LoopOnce, 1).play();
    action.clampWhenFinished = true;
    for (let i = 0; i <= BOUNDS_SAMPLES; i++) {
      mixer.setTime((clip.duration * i) / BOUNDS_SAMPLES);
      rig.updateMatrixWorld(true);
      meshes.forEach((mesh, k) => {
        mesh.computeBoundingBox(); // from the current pose (SkinnedMesh.applyBoneTransform)
        boxes[k]!.union(mesh.boundingBox!);
      });
    }
    action.stop();
  }
  mixer.uncacheRoot(rig);

  for (const [node, position, quaternion, scale] of rest) {
    node.position.copy(position);
    node.quaternion.copy(quaternion);
    node.scale.copy(scale);
  }
  meshes.forEach((mesh, k) => {
    mesh.boundingBox = boxes[k]!;
    mesh.boundingSphere = boxes[k]!.getBoundingSphere(new THREE.Sphere());
  });
  rig.updateMatrixWorld(true);
}
