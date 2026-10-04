// Drops the vertices an indexed geometry's index never names.
//
// A glTF primitive may index a slice of a vertex buffer it shares with others,
// and an exporter that splits one group into parts does exactly that: each
// part's twelve triangles point into the group's ninety thousand vertices.
// Merged as they come, every part's tree carries the whole buffer — its bounds
// become the map's, and a physics collider built from it copies all of it.

import * as THREE from "three";

/** `geometry` with only the vertices its index uses, every attribute remapped alike. In place; returns it. */
export function compactVertices(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  const index = geometry.getIndex();
  const position = geometry.getAttribute("position");
  if (!index || !position) {
    return geometry;
  }
  const remap = new Int32Array(position.count).fill(-1);
  let used = 0;
  for (let i = 0; i < index.count; i++) {
    const v = index.getX(i);
    if (remap[v] === -1) {
      remap[v] = used++;
    }
  }
  if (used === position.count) {
    return geometry;
  }
  for (const [name, attribute] of Object.entries(geometry.attributes)) {
    const size = attribute.itemSize;
    const Typed = attribute.array.constructor as new (length: number) => THREE.TypedArray;
    const out = new Typed(used * size);
    for (let v = 0; v < remap.length; v++) {
      const to = remap[v]!;
      if (to !== -1) {
        for (let k = 0; k < size; k++) {
          out[to * size + k] = attribute.getComponent(v, k);
        }
      }
    }
    geometry.setAttribute(name, new THREE.BufferAttribute(out, size, attribute.normalized));
  }
  const indices = used > 65535 ? new Uint32Array(index.count) : new Uint16Array(index.count);
  for (let i = 0; i < index.count; i++) {
    indices[i] = remap[index.getX(i)]!;
  }
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.boundingBox = null;
  geometry.boundingSphere = null;
  return geometry;
}
