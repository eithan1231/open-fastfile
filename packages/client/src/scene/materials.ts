// The render resources that outlive a world, and so must never be disposed.
//
// Both are shared by every world and by every placement in one. `disposeScene`
// walks a finished scene freeing geometries and materials, so anything here has
// to be excluded from that: `HIDDEN_COLLIDER` is a material it never visits,
// and `unitBox` is tagged `shared` for the check in scene/scene.ts.

import * as THREE from "three";

/**
 * For geometry that collides but never renders. Hiding it with `visible =
 * false` would drop it from the BVH (`traverseVisible`); a non-drawing material
 * keeps it in and costs no draw call. Shared by every world, never disposed.
 */
export const HIDDEN_COLLIDER = new THREE.MeshBasicMaterial({ visible: false });

let box: THREE.BoxGeometry | undefined;

/**
 * The unit box every `collide: box` proxy is scaled from (scene/models.ts).
 * One geometry for the whole process rather than one per proxy — an imported
 * map places thousands.
 *
 * Tagged `shared` so `disposeScene` leaves it alone: freeing it on leaving a
 * world would leave every later world's proxies drawing from freed buffers.
 */
export function unitBox(): THREE.BoxGeometry {
  if (!box) {
    box = new THREE.BoxGeometry(1, 1, 1);
    box.userData.shared = true;
  }
  return box;
}
