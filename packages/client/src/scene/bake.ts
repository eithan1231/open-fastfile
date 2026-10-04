// Bakes skinning out of rigged props into plain meshes. CoD rigs foliage and
// vehicles, and a SkinnedMesh cannot be instanced (on interchange-mw3, 3,654 of
// ~4,100 draw calls). A one-way door: AssetStore clones the rig of an asset
// with clips before calling this, and `animate:` placements use that clone.

import * as THREE from "three";

/** Replace every SkinnedMesh under `root` with a static Mesh; returns how many. Call `updateMatrixWorld(true)` first. */
export function bakeSkinnedMeshes(root: THREE.Object3D): number {
  const skinned: { mesh: THREE.SkinnedMesh; skin: Skin }[] = [];

  root.traverse((child) => {
    // Morph targets are not resolved here; leave such a mesh rigged. So is one
    // with no skin attributes to resolve, which nothing here could bake.
    if (!(child instanceof THREE.SkinnedMesh) || Object.keys(child.geometry.morphAttributes).length > 0) {
      return;
    }

    const skin = skinOf(child.geometry);
    if (skin) {
      skinned.push({ mesh: child, skin });
    }
  });

  for (const { mesh, skin } of skinned) {
    const baked = new THREE.Mesh(bakeGeometry(mesh, skin), mesh.material);
    baked.name = mesh.name;
    baked.userData = { ...mesh.userData }; // a copy: the baked mesh replaces `mesh`, it does not share its tags
    baked.visible = mesh.visible;
    baked.renderOrder = mesh.renderOrder;
    baked.position.copy(mesh.position);
    baked.quaternion.copy(mesh.quaternion);
    baked.scale.copy(mesh.scale);

    mesh.parent?.add(baked);
    mesh.removeFromParent();
  }

  if (skinned.length > 0) {
    pruneDeadBones(root);
  }

  return skinned.length;
}

/**
 * Per-vertex working matrices for `skinningMatrix`. Hoisted because a bake
 * walks millions of vertices — 3,654 skinned meshes on interchange-mw3 — and
 * two Matrix4 per vertex is nothing but garbage. No state survives a call.
 */
const BLENDED = new THREE.Matrix4();
const BONE = new THREE.Matrix4();

/** One mesh's skin attributes, read once rather than per vertex. `getComponent` also handles the InterleavedBufferAttributes GLTFLoader can return. */
interface Skin {
  index: THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
  weight: THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
}

function skinOf(geometry: THREE.BufferGeometry): Skin | undefined {
  const index = geometry.getAttribute("skinIndex");
  const weight = geometry.getAttribute("skinWeight");
  return index && weight ? { index, weight } : undefined;
}

/**
 * Everything but the skin attributes, copied. `clone()` would copy those too,
 * for the loop below to delete again: 24 bytes per vertex of pure churn, and
 * the values are read from `source` anyway.
 */
function cloneWithoutSkin(source: THREE.BufferGeometry, skin: Skin): THREE.BufferGeometry {
  source.deleteAttribute("skinIndex");
  source.deleteAttribute("skinWeight");
  try {
    return source.clone();
  } finally {
    source.setAttribute("skinIndex", skin.index);
    source.setAttribute("skinWeight", skin.weight);
  }
}

/** The geometry with skinning resolved, in the mesh's own local space, so its transform still applies. */
function bakeGeometry(mesh: THREE.SkinnedMesh, skin: Skin): THREE.BufferGeometry {
  const source = mesh.geometry;
  const out = cloneWithoutSkin(source, skin);
  const position = out.getAttribute("position");
  const normal = out.getAttribute("normal") as THREE.BufferAttribute | undefined;
  const tangent = out.getAttribute("tangent") as THREE.BufferAttribute | undefined;

  const matrix = new THREE.Matrix4();
  const normalMatrix = new THREE.Matrix3();
  const vector = new THREE.Vector3();

  for (let i = 0; i < position.count; i++) {
    skinningMatrix(mesh, skin, i, matrix);

    vector.fromBufferAttribute(position, i).applyMatrix4(matrix);
    position.setXYZ(i, vector.x, vector.y, vector.z);

    // Normals need the inverse-transpose, not the matrix itself, or any
    // non-uniform scale in a bone would shear them off the surface.
    if (normal || tangent) {
      normalMatrix.getNormalMatrix(matrix);
    }

    if (normal) {
      vector.fromBufferAttribute(normal, i).applyMatrix3(normalMatrix).normalize();
      normal.setXYZ(i, vector.x, vector.y, vector.z);
    }

    if (tangent) {
      // xyz is the direction; w is a handedness sign and must survive untouched.
      vector.set(tangent.getX(i), tangent.getY(i), tangent.getZ(i)).applyMatrix3(normalMatrix).normalize();
      tangent.setXYZW(i, vector.x, vector.y, vector.z, tangent.getW(i));
    }
  }

  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}

/**
 * `SkinnedMesh.applyBoneTransform` as one matrix, so it can transform normals and tangents too:
 *     bindMatrixInverse · Σ(weight_i · bone_i.matrixWorld · boneInverse_i) · bindMatrix
 */
function skinningMatrix(mesh: THREE.SkinnedMesh, skin: Skin, index: number, target: THREE.Matrix4): THREE.Matrix4 {
  const skeleton = mesh.skeleton;
  const blended = BLENDED;
  blended.elements.fill(0);
  for (let k = 0; k < 4; k++) {
    const weight = skin.weight.getComponent(index, k);
    if (weight === 0) {
      continue;
    }

    const b = skin.index.getComponent(index, k);
    const boneObject = skeleton.bones[b];
    const boneInverse = skeleton.boneInverses[b];
    if (!boneObject || !boneInverse) {
      continue; // a malformed skin must not poison the whole asset
    }

    BONE.multiplyMatrices(boneObject.matrixWorld, boneInverse);
    for (let e = 0; e < 16; e++) {
      blended.elements[e]! += BONE.elements[e]! * weight;
    }
  }

  return target.multiplyMatrices(mesh.bindMatrixInverse, blended).multiply(mesh.bindMatrix);
}

/** Drop bone hierarchies nothing is skinned to any more; instancing's pruning keeps every Bone. */
function pruneDeadBones(root: THREE.Object3D): void {
  if (hasSkinnedMesh(root)) {
    return; // some rig here is still live; leave every bone alone
  }

  for (const bone of root.children.flatMap(collectRootBones)) {
    if (!containsMesh(bone)) {
      bone.removeFromParent();
    }
  }
}

function collectRootBones(node: THREE.Object3D): THREE.Bone[] {
  if (node instanceof THREE.Bone) {
    return [node];
  }
  return node.children.flatMap(collectRootBones);
}

function hasSkinnedMesh(node: THREE.Object3D): boolean {
  let found = false;

  node.traverse((child) => {
    if (child instanceof THREE.SkinnedMesh) {
      found = true;
    }
  });

  return found;
}

function containsMesh(node: THREE.Object3D): boolean {
  let found = false;

  node.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      found = true;
    }
  });

  return found;
}
