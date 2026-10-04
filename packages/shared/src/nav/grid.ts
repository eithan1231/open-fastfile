// Where things are on the ground plane: a hash of 4 m cells over X and Z.
//
// Two of them. `NavGrid` holds nodes, for "the usable node nearest here" and
// "every node within R" (the bake's candidate search). `NavLinkGrid` holds each
// link's corridor, for "which links does this box cross" (a blocker, nav/dynamic.ts).
//
// Deterministic by construction: every cell lists its items in ascending index,
// and every query breaks a tie by the lower index.

/** Metres. About a link's typical length: a query touches a handful of cells. */
export const CELL = 4;

/** One cell as a number, not a string: a query in a bot's tick must not allocate a key. */
function cellKey(cx: number, cz: number): number {
  return (cx + 0x8000) * 0x10000 + (cz + 0x8000);
}

function cellOf(v: number): number {
  return Math.floor(v / CELL);
}

/** Nodes by cell. Only the ones `include` admits are in it. */
export class NavGrid {
  private readonly cells = new Map<number, number[]>();

  constructor(
    /** x y z per item. */
    private readonly positions: Float32Array,
    include?: Uint8Array,
  ) {
    const count = positions.length / 3;
    for (let i = 0; i < count; i++) {
      if (include && !include[i]) {
        continue;
      }
      const key = cellKey(cellOf(positions[i * 3]!), cellOf(positions[i * 3 + 2]!));
      let cell = this.cells.get(key);
      if (!cell) {
        this.cells.set(key, (cell = []));
      }
      cell.push(i);
    }
  }

  /**
   * Every item within `radius` of (x, z) horizontally and `maxDy` of `y`, into
   * `out` (cleared first), in ascending index.
   */
  within(x: number, y: number, z: number, radius: number, maxDy: number, out: number[]): number[] {
    out.length = 0;
    const p = this.positions;
    const r2 = radius * radius;
    for (let cx = cellOf(x - radius); cx <= cellOf(x + radius); cx++) {
      for (let cz = cellOf(z - radius); cz <= cellOf(z + radius); cz++) {
        const cell = this.cells.get(cellKey(cx, cz));
        if (!cell) {
          continue;
        }
        for (const i of cell) {
          const dx = p[i * 3]! - x;
          const dz = p[i * 3 + 2]! - z;
          if (dx * dx + dz * dz <= r2 && Math.abs(p[i * 3 + 1]! - y) <= maxDy) {
            out.push(i);
          }
        }
      }
    }
    return out.sort((a, b) => a - b);
  }

  /**
   * The item nearest (x, z) horizontally, within `maxDy` of `y` and `maxDistance`
   * horizontally, or -1. Rings of cells outward, stopping once no nearer item can
   * be in the next ring.
   */
  nearest(x: number, y: number, z: number, maxDy: number, maxDistance = Infinity): number {
    const p = this.positions;
    const cx0 = cellOf(x);
    const cz0 = cellOf(z);
    let best = -1;
    let bestD2 = maxDistance * maxDistance;
    // Past this ring nothing is in reach; a cap keeps an empty map from looping forever.
    const lastRing = Math.min(Number.isFinite(maxDistance) ? Math.ceil(maxDistance / CELL) + 1 : 64, 64);
    for (let ring = 0; ring <= lastRing; ring++) {
      // The nearest a point in this ring can be is (ring - 1) cells away.
      const floor = Math.max(0, ring - 1) * CELL;
      if (best >= 0 && floor * floor > bestD2) {
        break;
      }
      for (let cx = cx0 - ring; cx <= cx0 + ring; cx++) {
        for (let cz = cz0 - ring; cz <= cz0 + ring; cz++) {
          if (Math.max(Math.abs(cx - cx0), Math.abs(cz - cz0)) !== ring) {
            continue;
          }
          const cell = this.cells.get(cellKey(cx, cz));
          if (!cell) {
            continue;
          }
          for (const i of cell) {
            if (Math.abs(p[i * 3 + 1]! - y) > maxDy) {
              continue;
            }
            const dx = p[i * 3]! - x;
            const dz = p[i * 3 + 2]! - z;
            const d2 = dx * dx + dz * dz;
            if (d2 < bestD2 || (d2 === bestD2 && i < best)) {
              best = i;
              bestD2 = d2;
            }
          }
        }
      }
    }
    return best;
  }
}

/** The ends of each link, as a link grid reads them. `NavGraph` satisfies it. */
export interface LinkEnds {
  readonly linkCount: number;
  readonly source: Uint32Array;
  readonly target: Uint32Array;
  readonly feet: Float32Array;
}

/** Links by the cells their corridor (the segment between their ends' feet, grown by `inflate`) covers. */
export class NavLinkGrid {
  private readonly cells = new Map<number, number[]>();
  /** Per link, the query that last reported it: a link in several cells is reported once. */
  private readonly seen: Uint32Array;
  private query = 0;

  constructor(links: LinkEnds, inflate: number) {
    this.seen = new Uint32Array(links.linkCount);
    const f = links.feet;
    for (let l = 0; l < links.linkCount; l++) {
      const a = links.source[l]! * 3;
      const b = links.target[l]! * 3;
      const minX = cellOf(Math.min(f[a]!, f[b]!) - inflate);
      const maxX = cellOf(Math.max(f[a]!, f[b]!) + inflate);
      const minZ = cellOf(Math.min(f[a + 2]!, f[b + 2]!) - inflate);
      const maxZ = cellOf(Math.max(f[a + 2]!, f[b + 2]!) + inflate);
      for (let cx = minX; cx <= maxX; cx++) {
        for (let cz = minZ; cz <= maxZ; cz++) {
          const key = cellKey(cx, cz);
          let cell = this.cells.get(key);
          if (!cell) {
            this.cells.set(key, (cell = []));
          }
          cell.push(l);
        }
      }
    }
  }

  /** Every link whose corridor's cells meet the rectangle, into `out` (cleared first), ascending. */
  near(minX: number, minZ: number, maxX: number, maxZ: number, out: number[]): number[] {
    out.length = 0;
    this.query = (this.query + 1) >>> 0 || 1;
    for (let cx = cellOf(minX); cx <= cellOf(maxX); cx++) {
      for (let cz = cellOf(minZ); cz <= cellOf(maxZ); cz++) {
        const cell = this.cells.get(cellKey(cx, cz));
        if (!cell) {
          continue;
        }
        for (const l of cell) {
          if (this.seen[l] !== this.query) {
            this.seen[l] = this.query;
            out.push(l);
          }
        }
      }
    }
    return out.sort((a, b) => a - b);
  }
}
