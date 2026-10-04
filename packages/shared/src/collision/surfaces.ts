// What each triangle of a collision mesh is made of, carried from the exporter's
// glTF to the BVH the engine queries. The names themselves are sim/surfaces.ts,
// which is where a footstep reads them; this is the three.js half.

import * as THREE from "three";
import { DEFAULT_SURFACE, SURFACE_ATTRIBUTE, surfaceType, type SurfaceType } from "../sim/surfaces.js";

/** Triangles in a geometry, indexed or not. */
function triangleCount(geometry: THREE.BufferGeometry): number {
  return Math.floor((geometry.getIndex()?.count ?? geometry.getAttribute("position")?.count ?? 0) / 3);
}

/**
 * Carry the source meshes' `_SURFACE` attribute onto the geometry the BVH was
 * merged into. Silent when no source mesh has one, which is every hand-written
 * world, every prop hull, and every map exported before surfaces existed.
 *
 * **Per vertex, and copied here rather than by the generator.** Naming
 * `_SURFACE` in `generator.attributes` would carry it — but only while *every*
 * mesh in the tree has one: `mergeBufferGeometries` throws outright on a set
 * whose geometries do not all hold the same attributes, and the mixed set is the
 * ordinary case (a hand-written world's own meshes, a map that predates this, a
 * prop hull). So the copy is made here, and a mesh with nothing to say leaves
 * zeros, which is `default`.
 *
 * **Per vertex rather than per triangle** because `MeshBVH` **reorders the
 * geometry's index** as it builds: a raycast's `faceIndex` counts triangles in
 * the tree's order and not in the merge's, so a per-triangle table built from the
 * merge answers with some other triangle's material — a wrong answer that looks
 * exactly like a right one, and did, until a probe of mp_dome's spawn points
 * came back concrete on its dirt yard. Vertices are never moved, so a surface
 * attached to one survives: `faceSurface` reads it back through whatever index
 * the BVH has left behind.
 */
export function applyMergedSurfaces(merged: THREE.BufferGeometry, meshes: readonly THREE.Mesh[]): void {
  const total = merged.getAttribute("position")?.count ?? 0;
  const out = new Uint8Array(total);
  let offset = 0;
  let found = false;
  for (const mesh of meshes) {
    const geometry = mesh.geometry;
    const count = geometry.getAttribute("position")?.count ?? 0;
    const attribute = geometry.getAttribute(SURFACE_ATTRIBUTE);
    if (attribute && offset + count <= total) {
      found = true;
      for (let v = 0; v < count; v++) {
        out[offset + v] = attribute.getX(v);
      }
    }
    offset += count;
  }
  // `mergeBufferGeometries` concatenates each attribute in mesh order, so the
  // counts have to add up exactly; if they ever do not, this table is shifted
  // and every surface on the map is someone else's. Say nothing instead.
  if (found && offset === total) {
    merged.setAttribute(SURFACE_ATTRIBUTE, new THREE.BufferAttribute(out, 1));
  }
}

/** What one triangle of `geometry` is made of, `default` when it does not say. */
export function faceSurface(geometry: THREE.BufferGeometry, faceIndex: number): SurfaceType {
  const attribute = geometry.getAttribute(SURFACE_ATTRIBUTE);
  if (!attribute) {
    return DEFAULT_SURFACE;
  }
  const index = geometry.getIndex();
  const vertex = index ? index.getX(faceIndex * 3) : faceIndex * 3;
  // The exporter's weld keeps a triangle's three vertices on one surface, so the
  // first answers for the triangle. tests/surfaces.test.ts pins that.
  return surfaceType(attribute.getX(vertex));
}

/**
 * One surface index per triangle, in the geometry's **current** index order —
 * which after a `MeshBVH` build is the tree's, not the merge's. For a view that
 * colours triangles; undefined when the geometry carries no surfaces.
 */
export function triangleSurfaces(geometry: THREE.BufferGeometry): Uint8Array | undefined {
  const attribute = geometry.getAttribute(SURFACE_ATTRIBUTE);
  if (!attribute) {
    return undefined;
  }
  const index = geometry.getIndex();
  const count = triangleCount(geometry);
  const out = new Uint8Array(count);
  for (let t = 0; t < count; t++) {
    out[t] = attribute.getX(index ? index.getX(t * 3) : t * 3);
  }
  return out;
}
