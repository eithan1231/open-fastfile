// Letting go of a rig nobody will draw again.

import * as THREE from "three";

/**
 * Take a rig out of the scene graph and free what is its own: each skeleton's
 * bone texture, which three.js makes on first render and only `dispose` frees.
 * Geometry and materials are the asset store's and are not touched, and a
 * mixer or poser is its owner's to dispose. Call it once, from the last holder.
 */
export function releaseRig(root: THREE.Object3D): void {
  root.removeFromParent();
  const skeletons = new Set<THREE.Skeleton>();
  root.traverse((item) => {
    if (item instanceof THREE.SkinnedMesh) {
      skeletons.add(item.skeleton);
    }
  });
  for (const skeleton of skeletons) {
    skeleton.dispose();
  }
}
