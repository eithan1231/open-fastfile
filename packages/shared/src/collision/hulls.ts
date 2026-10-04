// Collision hulls for `model` placements.
//
// A `collide: hull` placement collides against the asset's own mesh rather than
// a box, which for most props is mostly empty air (97.9% across interchange-mw3's
// colliding placements). The hull is shared per *asset* and instanced through
// each placement's transform by engine/collision.ts: interchange's hulls are 191k
// triangles stored once, against 1.74M baked per placement.

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { ResolvedAsset } from "../dsl/resolved.js";

/** Where one hull sits. `matrix` is the placement's full world transform. */
export interface HullPlacement {
  asset: string;
  matrix: THREE.Matrix4;
  /** The placement's `mode:`, if it has one: a match not playing one of them does not collide with it. */
  modes?: readonly string[];
}

/**
 * Flatten an asset's mesh into a single positions-only geometry.
 *
 * A glTF carries a node hierarchy, so each mesh's own transform has to be
 * baked in before the parts can be merged. Everything but position is dropped:
 * a BVH needs vertices, and normals/UVs would triple the memory for nothing.
 */
export function hullGeometryFrom(scene: THREE.Object3D): THREE.BufferGeometry | undefined {
  scene.updateMatrixWorld(true);

  const parts: THREE.BufferGeometry[] = [];
  scene.traverse((child) => {
    if (!(child instanceof THREE.Mesh) || !child.geometry.getAttribute("position")) {
      return;
    }

    const geo = new THREE.BufferGeometry();
    const position = child.geometry.getAttribute("position");
    const copy = new THREE.Float32BufferAttribute(new Float32Array(position.count * 3), 3);
    const v = new THREE.Vector3();
    for (let i = 0; i < position.count; i++) {
      v.fromBufferAttribute(position as THREE.BufferAttribute, i).applyMatrix4(child.matrixWorld);
      copy.setXYZ(i, v.x, v.y, v.z);
    }
    geo.setAttribute("position", copy);

    const index = child.geometry.getIndex();
    // `slice()` rather than reading the index out one boxed number at a time:
    // interchange's hulls are 573k indices, and the copy is the same bytes.
    if (index) {
      geo.setIndex(new THREE.BufferAttribute(index.array.slice(), 1));
    }
    parts.push(geo);
  });

  if (parts.length === 0) {
    return undefined;
  }
  // mergeGeometries needs every part indexed or none of them; the loop above
  // is all-or-nothing per asset in practice, but be explicit rather than let
  // it return null and silently drop the asset's collision.
  const indexed = parts.filter((p) => p.getIndex() !== null);
  const usable = indexed.length === parts.length ? parts : parts.map((p) => p.toNonIndexed());
  return usable.length === 1 ? usable[0]! : (mergeGeometries(usable, false) ?? undefined);
}

/** The mesh an asset collides against, or undefined if it has no hull. */
export function hullSourceOf(asset: ResolvedAsset | undefined): string | undefined {
  if (!asset || asset.hull === undefined) {
    return undefined;
  }
  return asset.source;
}

/** Smallest proxy dimension, so a flat prop cannot produce degenerate BVH triangles. */
export const MIN_PROXY = 0.02;

/**
 * The box that stands in for a model with no hull to give (`collide: box`, or
 * `collide: hull` on an asset without `hull:`), in the asset's own local space.
 *
 * From the asset's *measured* bounds, because a model's pivot is wherever its
 * artist left it. Shared so the client's proxy mesh and the server's proxy
 * geometry are the same box — a placement solid on one end and air on the other
 * is the drift that is hardest to read as a mismatch rather than as netcode.
 */
export function boxProxy(bounds: THREE.Box3): { center: THREE.Vector3; size: THREE.Vector3 } {
  const size = bounds.getSize(new THREE.Vector3());
  return {
    center: bounds.getCenter(new THREE.Vector3()),
    size: new THREE.Vector3(Math.max(size.x, MIN_PROXY), Math.max(size.y, MIN_PROXY), Math.max(size.z, MIN_PROXY)),
  };
}
