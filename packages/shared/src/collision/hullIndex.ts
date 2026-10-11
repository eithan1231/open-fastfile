// The prop hulls of one world and the broad phase over them: a BVH per asset,
// shared by every placement of it, and a grid that says which placements a
// capsule or a ray could touch. What a query then does with a hull is
// collision/world.ts's. See docs/engine/collision.md.

import * as THREE from "three";
import { MeshBVH } from "three-mesh-bvh";
import type { HullPlacement } from "./hulls.js";

/** One prop's collision: the asset's shared BVH plus this placement's transform. Queries move the capsule into local space. */
export interface HullInstance {
  bvh: MeshBVH;
  /** World -> hull local. */
  inverse: THREE.Matrix4;
  /** Rotation only, hull local -> world, for pushing the capsule back out. */
  rotation: THREE.Matrix3;
  /** Uniform placement scale. Props only ever carry a single `scale:` value. */
  scale: number;
  /** World-space AABB, for the broad phase. */
  bounds: THREE.Box3;
  /** The query that last collected this hull, so `near` deduplicates without a Set. */
  mark: number;
  /** The placement's `mode:`: a view leaves it out of a match whose mode it does not name. */
  modes?: readonly string[];
}

/** Grid cell size for the broad phase, metres. Comfortably larger than any prop hull. */
const HULL_CELL = 8;

/**
 * The most grid cells one trace may walk. A map's diagonal is a few hundred
 * metres, so this is generous; it is a guard against float error on a segment
 * that ends exactly on a cell boundary, not a budget.
 */
const MAX_TRACE_CELLS = 4096;

/**
 * One broad-phase cell as a number. A `${x},${z}` key allocates a string per
 * cell per query, and a query reads a dozen; 2^20 keeps cells distinct for any
 * |z| under 2^19 (four million metres at this cell size).
 */
function cellKey(x: number, z: number): number {
  return x * 0x100000 + z;
}

export class HullIndex {
  /** Hull BVHs by asset name, shared across placements. */
  private readonly bvhs = new Map<string, MeshBVH>();
  /**
   * Every hull BVH this index has built, by the geometry it was built from. A
   * hot reload keeps the AssetStore, so all but the changed asset's geometry is
   * the same object it was last mount and its tree still describes it.
   */
  private readonly trees = new WeakMap<THREE.BufferGeometry, MeshBVH>();
  private hulls: HullInstance[] = [];
  /** Hull instances bucketed by grid cell, so a query tests a handful rather than thousands. */
  private readonly grid = new Map<number, HullInstance[]>();
  /** The hulls one query collected, reused across calls, and the stamp that marks them. */
  private readonly found: HullInstance[] = [];
  private queryMark = 0;

  /** Every placement, in the order they were set. */
  get all(): readonly HullInstance[] {
    return this.hulls;
  }

  get count(): number {
    return this.hulls.length;
  }

  /** How many distinct assets the placements are of. */
  get assets(): number {
    return this.bvhs.size;
  }

  /** Install the per-asset hulls and their placements, replacing what was there. */
  set(geometries: Map<string, THREE.BufferGeometry>, placements: readonly HullPlacement[]): void {
    this.clear();

    for (const [name, geometry] of geometries) {
      if (!geometry.getAttribute("position")) {
        continue;
      } // still loading, or failed
      let bvh = this.trees.get(geometry);
      if (!bvh) {
        this.trees.set(geometry, (bvh = new MeshBVH(geometry, { maxLeafTris: 5 })));
      }
      this.bvhs.set(name, bvh);
    }

    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scaleVec = new THREE.Vector3();

    for (const placement of placements) {
      const bvh = this.bvhs.get(placement.asset);
      if (!bvh) {
        continue;
      }

      placement.matrix.decompose(position, quaternion, scaleVec);
      const geometry = bvh.geometry;
      if (!geometry.boundingBox) {
        geometry.computeBoundingBox();
      }
      const bounds = geometry.boundingBox!.clone().applyMatrix4(placement.matrix);

      const instance: HullInstance = {
        bvh,
        inverse: placement.matrix.clone().invert(),
        rotation: new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(quaternion)),
        // Uniform in practice (`scale:` is one value), so the capsule stays a
        // capsule in local space. `max` so an outlier over-approximates.
        scale: Math.max(scaleVec.x, scaleVec.y, scaleVec.z),
        bounds,
        mark: 0,
        modes: placement.modes,
      };
      this.hulls.push(instance);

      for (let x = Math.floor(bounds.min.x / HULL_CELL); x <= Math.floor(bounds.max.x / HULL_CELL); x++) {
        for (let z = Math.floor(bounds.min.z / HULL_CELL); z <= Math.floor(bounds.max.z / HULL_CELL); z++) {
          const key = cellKey(x, z);
          let cell = this.grid.get(key);
          if (!cell) {
            this.grid.set(key, (cell = []));
          }
          cell.push(instance);
        }
      }
    }
  }

  /** Forget every placement. The trees are kept: see `trees`. */
  clear(): void {
    this.bvhs.clear();
    this.hulls = [];
    this.grid.clear();
  }

  /**
   * Hull instances whose grid cells the capsule's swept bounds touch. The result
   * is scratch: it is overwritten by the next query, and a hull straddling two
   * cells appears once because each query stamps what it has already taken.
   */
  near(segment: THREE.Line3, radius: number): readonly HullInstance[] {
    const found = this.found;
    found.length = 0;
    const mark = ++this.queryMark;
    const minX = Math.floor((Math.min(segment.start.x, segment.end.x) - radius) / HULL_CELL);
    const maxX = Math.floor((Math.max(segment.start.x, segment.end.x) + radius) / HULL_CELL);
    const minZ = Math.floor((Math.min(segment.start.z, segment.end.z) - radius) / HULL_CELL);
    const maxZ = Math.floor((Math.max(segment.start.z, segment.end.z) + radius) / HULL_CELL);
    for (let x = minX; x <= maxX; x++) {
      for (let z = minZ; z <= maxZ; z++) {
        const cell = this.grid.get(cellKey(x, z));
        if (!cell) {
          continue;
        }
        for (const h of cell) {
          if (h.mark === mark) {
            continue;
          }
          h.mark = mark;
          found.push(h);
        }
      }
    }
    return found;
  }

  /**
   * Hull instances whose grid cells a *segment* passes through, in the order it
   * reaches them.
   *
   * `near` cannot do this job. It walks every cell in the segment's bounding
   * **rectangle**, which is one to four cells for a capsule's step and about
   * (length / 8 m)² for a bullet: a 200 m diagonal touches ~625 cells and
   * collects most of a map's hull placements — interchange-mw3 has 2,842 — which
   * is worse than testing all of them without a grid at all.
   *
   * So this is a 2D DDA along the segment instead: O(length) cells rather than
   * O(area). The result is scratch, shared with `near`, and a hull straddling
   * two cells appears once because each query stamps what it has taken.
   */
  along(start: THREE.Vector3, end: THREE.Vector3): readonly HullInstance[] {
    const found = this.found;
    found.length = 0;
    if (this.hulls.length === 0) {
      return found;
    }
    const mark = ++this.queryMark;

    const take = (x: number, z: number): void => {
      const cell = this.grid.get(cellKey(x, z));
      if (!cell) {
        return;
      }
      for (const hull of cell) {
        if (hull.mark !== mark) {
          hull.mark = mark;
          found.push(hull);
        }
      }
    };

    let cx = Math.floor(start.x / HULL_CELL);
    let cz = Math.floor(start.z / HULL_CELL);
    const lastX = Math.floor(end.x / HULL_CELL);
    const lastZ = Math.floor(end.z / HULL_CELL);
    take(cx, cz);

    const dx = end.x - start.x;
    const dz = end.z - start.z;
    const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
    const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;
    // How far along the segment (0..1) one cell of travel costs, and how far the
    // first boundary is. Infinite on an axis the segment does not move along,
    // which is what makes a straight-down trace visit exactly one column.
    const perCellX = stepX === 0 ? Infinity : Math.abs(HULL_CELL / dx);
    const perCellZ = stepZ === 0 ? Infinity : Math.abs(HULL_CELL / dz);
    let nextX = stepX === 0 ? Infinity : ((stepX > 0 ? cx + 1 : cx) * HULL_CELL - start.x) / dx;
    let nextZ = stepZ === 0 ? Infinity : ((stepZ > 0 ? cz + 1 : cz) * HULL_CELL - start.z) / dz;

    // Bounded rather than trusted: float error on a segment that ends exactly on a
    // boundary could otherwise step past the last cell and never match it.
    for (let guard = 0; (cx !== lastX || cz !== lastZ) && guard < MAX_TRACE_CELLS; guard++) {
      if (nextX < nextZ) {
        cx += stepX;
        nextX += perCellX;
      } else {
        cz += stepZ;
        nextZ += perCellZ;
      }
      take(cx, cz);
    }
    return found;
  }
}
