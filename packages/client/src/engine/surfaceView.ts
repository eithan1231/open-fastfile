// Surface view (`N`): draws the collision the BVHs were built from, coloured by
// what Call of Duty says each triangle is made of.
//
// This exists because the surface a footstep picks its alias from is otherwise
// unfalsifiable: `metal` and `dirt` sound different and look identical, and a
// map whose gantry came out `concrete` plays perfectly. So the check is by eye —
// walk onto the thing and see whether the colour under you is the colour of the
// thing. The stats line carries what is under the player right now, which is the
// same `surfaceAt` a footstep asks (docs/engine/collision.md#what-a-surface-is-made-of).
//
// Colours come from the surface's name rather than a hand-picked palette, so a
// surface is the same colour on every map and a new one in a later game needs no
// entry here. Read `collision.debugSurfaces()`, like collider view's "everything"
// mode, so it cannot disagree with what the queries answer.

import * as THREE from "three";
import { SURFACE_TYPES, type SurfaceType } from "@3d/shared/sim/surfaces.js";
import type { DebugSurface } from "@3d/shared/collision/world.js";

/**
 * One material per surface. `default` is deliberately grey and unsaturated: it
 * is the answer for a face that says nothing, and it should read as absence
 * rather than as a colour someone chose.
 */
const materials = new Map<SurfaceType, THREE.MeshBasicMaterial>();

function surfaceMaterial(surface: SurfaceType): THREE.MeshBasicMaterial {
  let material = materials.get(surface);
  if (!material) {
    let hash = 0;
    for (let i = 0; i < surface.length; i++) {
      hash = (hash * 31 + surface.charCodeAt(i)) >>> 0;
    }
    const grey = surface === "default";
    material = new THREE.MeshBasicMaterial({
      color: new THREE.Color().setHSL((hash % 360) / 360, grey ? 0 : 0.7, grey ? 0.35 : 0.55),
      transparent: true,
      opacity: 0.9,
      depthWrite: true,
      side: THREE.DoubleSide,
      // The collision mesh sits on the geometry it was authored against, so
      // without this the two z-fight and the colour flickers exactly where it
      // matters most: the floor you are standing on.
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    materials.set(surface, material);
  }
  return material;
}

export class SurfaceView {
  readonly object = new THREE.Group();

  private shown = false;
  private counts = new Map<SurfaceType, number>();
  /** Geometries this view made (its own index buffers), as against the ones the BVHs own. */
  private owned: THREE.BufferGeometry[] = [];

  constructor() {
    this.object.name = "surface-view";
    this.object.visible = false;
    this.object.renderOrder = 996;
  }

  get visible(): boolean {
    return this.shown;
  }

  /** How many triangles of each surface the last build found, largest first. */
  get histogram(): { surface: SurfaceType; triangles: number }[] {
    return [...this.counts].map(([surface, triangles]) => ({ surface, triangles })).sort((a, b) => b.triangles - a.triangles);
  }

  /** True when the world's collision carries no surface data at all — every imported map before the pass, and every hand-written world. */
  get empty(): boolean {
    return this.counts.size === 0;
  }

  /**
   * Rebuild from the collision world's own surfaces.
   *
   * One mesh per tree with a **reordered index and one draw group per surface**,
   * rather than a colour per vertex: the positions are the BVH's own and are
   * reused untouched, so a 400k-triangle map costs one index buffer here and not
   * a second copy of the mesh.
   */
  build(surfaces: readonly DebugSurface[]): void {
    this.clear();
    for (const { geometry, matrix, surfaces: table } of surfaces) {
      if (!table) {
        continue; // a prop hull, or a map with nothing to say
      }
      const source = geometry.getIndex();
      if (!source) {
        continue;
      }
      const bySurface = new Map<number, number[]>();
      for (let t = 0; t < table.length; t++) {
        const key = table[t]!;
        let list = bySurface.get(key);
        if (!list) {
          bySurface.set(key, (list = []));
        }
        list.push(source.getX(t * 3), source.getX(t * 3 + 1), source.getX(t * 3 + 2));
      }

      const indices: number[] = [];
      const drawn = new THREE.BufferGeometry();
      drawn.setAttribute("position", geometry.getAttribute("position"));
      const used: SurfaceType[] = [];
      for (const [key, list] of [...bySurface].sort((a, b) => b[1].length - a[1].length)) {
        const surface = SURFACE_TYPES[key] ?? "default";
        drawn.addGroup(indices.length, list.length, used.length);
        used.push(surface);
        indices.push(...list);
        this.counts.set(surface, (this.counts.get(surface) ?? 0) + list.length / 3);
      }
      drawn.setIndex(indices);
      const mesh = new THREE.Mesh(drawn, used.map(surfaceMaterial));
      mesh.applyMatrix4(matrix);
      mesh.frustumCulled = false;
      this.owned.push(drawn);
      this.object.add(mesh);
    }
  }

  setVisible(visible: boolean): void {
    this.shown = visible;
    this.object.visible = visible;
  }

  /** Drop the meshes; the positions belong to the collision world, so only our own index buffers go. */
  clear(): void {
    for (const child of [...this.object.children]) {
      this.object.remove(child);
    }
    for (const geometry of this.owned) {
      // The position attribute is the BVH's; deleting it first keeps dispose()
      // from freeing a buffer the collision world is still querying.
      geometry.deleteAttribute("position");
      geometry.dispose();
    }
    this.owned = [];
    this.counts.clear();
  }

  dispose(): void {
    this.clear();
  }
}
