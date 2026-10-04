// Fetching a world's authored collision mesh and hanging it in the scene. What
// the file *means* — the exporter's groups and their decoded contents bits — is
// @3d/shared/collision/source.js, because the server reads the same file and
// the two must agree about which groups stop a player.
//
// Hidden by material, not `visible`, or the BVH build would skip it.

import type * as THREE from "three";
import { collisionGroupMeshes, createCollisionGroup } from "@3d/shared/collision/source.js";
import type { AssetStore } from "./assets.js";
import { HIDDEN_COLLIDER } from "./materials.js";

/** A group that fills with the collision mesh once it loads; the load goes on `pending`, which the BVH build awaits. */
export function buildCollisionMesh(source: string, baseUrl: string | undefined, pending: Promise<void>[], assets: AssetStore): THREE.Object3D {
  const group = createCollisionGroup();

  // Through the store, so a hot reload of anything else does not refetch and
  // reparse a file that can be tens of megabytes.
  pending.push(
    assets.gltf((baseUrl ?? "") + source).then((loaded) => {
      if (!loaded) {
        // Still explorable without it, but the player falls through the map.
        console.error(`Failed to load collision mesh: ${source} — the world will have no collision`);
        return;
      }

      for (const mesh of collisionGroupMeshes(loaded.scene, HIDDEN_COLLIDER)) {
        group.add(mesh);
      }
    }),
  );

  return group;
}
