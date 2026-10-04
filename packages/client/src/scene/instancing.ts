// Pools repeated `model` meshes into InstancedMeshes, by shared geometry and
// material. Per-object CPU cost (graph walk, frustum test, one submit each) was
// the bottleneck: ~8 ms a frame for the props while the GPU sat at 0.3 ms.
// Placement Groups stay in the graph, since they carry the authored identity;
// `instanceOwners` maps an `instanceId` back to one for picking.

import * as THREE from "three";

/** Below this, instancing costs more (a matrix buffer, no per-object culling) than the draw calls it saves. */
const MIN_INSTANCES = 2;

export interface InstancingStats {
  /** How many InstancedMeshes were created. */
  batches: number;
  /** How many individual meshes they replaced. */
  instances: number;
  /** Nodes removed from the graph — the meshes, plus the glTF wrapper groups left empty behind them. */
  removedNodes: number;
}

interface Placement {
  /** The authored `model` node — what picking reports. */
  group: THREE.Object3D;
  mesh: THREE.Mesh;
}

/** Whether a mesh can pool: not with a skeleton, morph weights, or a material array, which live on the mesh. */
function isInstanceable(mesh: THREE.Mesh): boolean {
  if (mesh instanceof THREE.InstancedMesh || mesh instanceof THREE.SkinnedMesh) {
    return false;
  }

  if (Array.isArray(mesh.material)) {
    return false;
  }

  if (mesh.userData.collider === true) {
    return false; // proxies are read individually by engine/colliderView.ts
  }

  if (mesh.userData.renderPart !== undefined) {
    return false; // a removable part is shown and hidden on its own (WorldSession.applyPresence)
  }

  const morphs = mesh.geometry.morphAttributes;

  return !morphs || Object.keys(morphs).length === 0;
}

/** Whether `node` draws, up to and including `top`. Pooling a hidden mesh into a batch would show it. */
function visibleUpTo(node: THREE.Object3D, top: THREE.Object3D): boolean {
  for (let item: THREE.Object3D | null = node; item; item = item.parent) {
    if (!item.visible) {
      return false;
    }

    if (item === top) {
      break;
    }
  }
  return true;
}

export function instanceModels(root: THREE.Object3D): InstancingStats {
  root.updateMatrixWorld(true);

  // Collect before mutating — the traversal below reparents nodes.
  const buckets = new Map<string, Placement[]>();
  const models: THREE.Object3D[] = [];
  root.traverse((obj) => {
    if (obj.userData.model === true) {
      models.push(obj);
    }
  });

  for (const group of models) {
    if (!group.visible) {
      continue;
    }

    group.traverse((child) => {
      if (!(child instanceof THREE.Mesh) || !isInstanceable(child)) {
        return;
      }

      if (!visibleUpTo(child, group)) {
        return;
      }

      const material = child.material as THREE.Material;

      // Shared per asset, so this pair is the asset's identity.
      const key = `${child.geometry.uuid}|${material.uuid}`;
      let bucket = buckets.get(key);
      if (!bucket) {
        buckets.set(key, (bucket = []));
      }

      bucket.push({ group, mesh: child });
    });
  }

  // Instance matrices are relative to `root`, which need not stay untransformed.
  const toRoot = root.matrixWorld.clone().invert();

  const stats: InstancingStats = { batches: 0, instances: 0, removedNodes: 0 };
  const touched = new Set<THREE.Object3D>();

  for (const placements of buckets.values()) {
    if (placements.length < MIN_INSTANCES) {
      continue;
    }

    const template = placements[0]!.mesh;
    const instanced = new THREE.InstancedMesh(template.geometry, template.material as THREE.Material, placements.length);
    instanced.name = `instanced:${placements.length}`;

    // Per batch; placements agree in practice. `some`, so one caster is not demoted.
    instanced.castShadow = placements.some((p) => p.mesh.castShadow);
    instanced.receiveShadow = placements.some((p) => p.mesh.receiveShadow);

    const owners: THREE.Object3D[] = [];
    const matrix = new THREE.Matrix4();

    placements.forEach((placement, i) => {
      matrix.multiplyMatrices(toRoot, placement.mesh.matrixWorld);
      instanced.setMatrixAt(i, matrix);
      owners[i] = placement.group;

      // And back, so picking can highlight the whole prop.
      const parts = (placement.group.userData.instancedParts ??= []) as InstancedPart[];
      parts.push({ mesh: instanced, instanceId: i });

      placement.mesh.removeFromParent();
      stats.removedNodes++;
      touched.add(placement.group);
    });

    instanced.instanceMatrix.needsUpdate = true;
    instanced.userData.instanceOwners = owners;
    // The sphere for raycasting and culling, the box for contentBounds.
    instanced.computeBoundingSphere();
    instanced.computeBoundingBox();

    root.add(instanced);
    stats.batches++;
    stats.instances += placements.length;
  }

  // The glTF's own wrapper nodes are left childless once their meshes move out.
  for (const group of touched) {
    stats.removedNodes += pruneEmpty(group);
  }

  return stats;
}

export interface InstancedPart {
  mesh: THREE.InstancedMesh;
  instanceId: number;
}

/** Drop descendant subtrees that no longer contain anything drawable or identifiable. Returns how many nodes went. */
function pruneEmpty(group: THREE.Object3D): number {
  let removed = 0;

  for (const child of [...group.children]) {
    if (!isDisposable(child)) {
      continue;
    }

    removed += countNodes(child);
    child.removeFromParent();
  }

  return removed;
}

/** A node worth keeping is one that draws, collides, or carries authored identity. */
function isDisposable(obj: THREE.Object3D): boolean {
  // Bone: a SkinnedMesh is never pooled, but its skeleton hangs off sibling
  // nodes that carry no mesh and would otherwise read as empty.
  if (obj instanceof THREE.Mesh || obj instanceof THREE.Light || obj instanceof THREE.Bone) {
    return false;
  }

  const d = obj.userData;
  if (d.name !== undefined || d.model === true || d.source !== undefined || d.collider === true) {
    return false;
  }

  return obj.children.every(isDisposable);
}

function countNodes(obj: THREE.Object3D): number {
  let n = 0;

  obj.traverse(() => n++);

  return n;
}
