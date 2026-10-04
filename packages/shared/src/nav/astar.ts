// Shortest paths over a baked graph: A* in seconds.
//
// One `NavSearch` per graph and caller, reused: its per-node arrays are stamped
// with a generation number rather than cleared, so a query costs what it
// expands and not the size of the map. Deterministic: the open set breaks a tie
// in f by the lower node index, and links are visited in CSR order.
//
// A link is usable when the mover may take it — for a player, the bake did not
// rule it out (status ≠ INVALID) and the mover has every ability it requires;
// for an actor, its own mask (nav/mover.ts) — no blocker holds it shut this
// match, and its target is a usable node.

import { RUN_SPEED } from "../sim/movement.js";
import { LINK_STATUS, type NavGraph } from "./graph.js";
import type { NavMover } from "./mover.js";
import { LINK_KINDS, TRAVERSAL_KINDS, type TraversalKind } from "./vocab.js";

/** The most nodes one query may expand before it gives up. */
export const NAV_MAX_EXPANSIONS = 5000;

/** Multipliers on a link's cost by what it is: `walk`, or a traversal kind. 1 where absent. */
export type NavCostScales = Partial<Record<TraversalKind | "walk", number>>;

/** Index into a scale table: a traversal kind, or WALK_SLOT for a walk. */
const WALK_SLOT = 15;

export interface NavSearchOptions {
  /** `ABILITIES` bits the mover has. */
  abilities: number;
  /** Per-link blocked counts (nav/dynamic.ts); a link with any is shut. */
  blocked?: Uint8Array | null;
  maxExpansions?: number;
  scales?: NavCostScales;
  /** Whose verdict on each link, and whose cost (nav/mover.ts). Absent: a player's, the bake's own. */
  mover?: NavMover;
}

export type NavSearchStatus = "found" | "unreachable" | "capped" | "bad-endpoint";

/** A path found: its nodes (start first), the links between them, and its cost in seconds. */
export interface NavPath {
  nodes: number[];
  links: number[];
  cost: number;
  expansions: number;
}

export function createPath(): NavPath {
  return { nodes: [], links: [], cost: 0, expansions: 0 };
}

export class NavSearch {
  private readonly g: Float64Array;
  private readonly via: Int32Array;
  private readonly seen: Uint32Array;
  private readonly closed: Uint32Array;
  private generation = 0;
  private heapF = new Float64Array(256);
  private heapNode = new Int32Array(256);
  private heapSize = 0;
  private readonly scale = new Float64Array(16);

  constructor(private readonly graph: NavGraph) {
    const n = graph.nodeCount;
    this.g = new Float64Array(n);
    this.via = new Int32Array(n);
    this.seen = new Uint32Array(n);
    this.closed = new Uint32Array(n);
  }

  /** The cheapest path from node `start` to node `goal`, into `out`. */
  find(start: number, goal: number, options: NavSearchOptions, out: NavPath): NavSearchStatus {
    const graph = this.graph;
    out.nodes.length = 0;
    out.links.length = 0;
    out.cost = 0;
    out.expansions = 0;
    if (start < 0 || goal < 0 || start >= graph.nodeCount || goal >= graph.nodeCount || !graph.usable[start] || !graph.usable[goal]) {
      return "bad-endpoint";
    }
    this.fillScales(options.scales);
    const minScale = Math.min(...this.scale);
    const blocked = options.blocked ?? null;
    const abilities = options.abilities;
    const valid = options.mover?.valid ?? null;
    const moverCost = options.mover?.cost ?? null;
    const cap = options.maxExpansions ?? NAV_MAX_EXPANSIONS;

    const gen = this.nextGeneration();
    const f = graph.feet;
    const gx = f[goal * 3]!;
    const gy = f[goal * 3 + 1]!;
    const gz = f[goal * 3 + 2]!;
    const h = (i: number) => (Math.hypot(f[i * 3]! - gx, f[i * 3 + 1]! - gy, f[i * 3 + 2]! - gz) / RUN_SPEED) * minScale;

    this.heapSize = 0;
    this.g[start] = 0;
    this.via[start] = -1;
    this.seen[start] = gen;
    this.push(h(start), start);

    while (this.heapSize > 0) {
      const node = this.pop();
      if (this.closed[node] === gen) {
        continue;
      }
      this.closed[node] = gen;
      if (node === goal) {
        this.unwind(start, goal, out);
        return "found";
      }
      if (++out.expansions > cap) {
        return "capped";
      }
      const base = this.g[node]!;
      for (let l = graph.first[node]!; l < graph.first[node + 1]!; l++) {
        const open = valid ? valid[l] === 1 : graph.status[l] !== LINK_STATUS.INVALID && (graph.requires[l]! & ~abilities) === 0;
        if (!open || (blocked && blocked[l])) {
          continue;
        }
        const to = graph.target[l]!;
        if (!graph.usable[to] || this.closed[to] === gen) {
          continue;
        }
        let cost = moverCost ? moverCost[l]! : graph.cost[l]!;
        if (Number.isNaN(cost)) {
          // Not simulated (a graph read before its bake finished): the distance at a run.
          cost = Math.hypot(f[to * 3]! - f[node * 3]!, f[to * 3 + 1]! - f[node * 3 + 1]!, f[to * 3 + 2]! - f[node * 3 + 2]!) / RUN_SPEED;
        }
        const slot = graph.kind[l] === LINK_KINDS.WALK ? WALK_SLOT : graph.traversalKind[l]! & 15;
        const g = base + cost * this.scale[slot]!;
        if (this.seen[to] !== gen || g < this.g[to]!) {
          this.seen[to] = gen;
          this.g[to] = g;
          this.via[to] = l;
          this.push(g + h(to), to);
        }
      }
    }
    return "unreachable";
  }

  private unwind(start: number, goal: number, out: NavPath): void {
    const graph = this.graph;
    let node = goal;
    while (node !== start) {
      const l = this.via[node]!;
      out.links.push(l);
      out.nodes.push(node);
      node = graph.source[l]!;
    }
    out.nodes.push(start);
    out.links.reverse();
    out.nodes.reverse();
    out.cost = this.g[goal]!;
  }

  private fillScales(scales: NavCostScales | undefined): void {
    this.scale.fill(1);
    if (!scales) {
      return;
    }
    for (const [name, value] of Object.entries(scales)) {
      if (value === undefined) {
        continue;
      }
      const slot = name === "walk" ? WALK_SLOT : TRAVERSAL_KINDS[name as TraversalKind];
      if (slot !== undefined) {
        this.scale[slot] = value;
      }
    }
  }

  private nextGeneration(): number {
    this.generation = (this.generation + 1) >>> 0;
    if (this.generation === 0) {
      // Wrapped: stale stamps could collide with new ones.
      this.seen.fill(0);
      this.closed.fill(0);
      this.generation = 1;
    }
    return this.generation;
  }

  // -- The open set: a binary heap on (f, node) -----------------------------------

  private less(a: number, b: number): boolean {
    const fa = this.heapF[a]!;
    const fb = this.heapF[b]!;
    return fa < fb || (fa === fb && this.heapNode[a]! < this.heapNode[b]!);
  }

  private swap(a: number, b: number): void {
    const f = this.heapF[a]!;
    this.heapF[a] = this.heapF[b]!;
    this.heapF[b] = f;
    const n = this.heapNode[a]!;
    this.heapNode[a] = this.heapNode[b]!;
    this.heapNode[b] = n;
  }

  private push(f: number, node: number): void {
    if (this.heapSize === this.heapF.length) {
      const grownF = new Float64Array(this.heapF.length * 2);
      grownF.set(this.heapF);
      this.heapF = grownF;
      const grownNode = new Int32Array(this.heapNode.length * 2);
      grownNode.set(this.heapNode);
      this.heapNode = grownNode;
    }
    let i = this.heapSize++;
    this.heapF[i] = f;
    this.heapNode[i] = node;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.less(i, parent)) {
        break;
      }
      this.swap(i, parent);
      i = parent;
    }
  }

  private pop(): number {
    const top = this.heapNode[0]!;
    const last = --this.heapSize;
    if (last > 0) {
      this.heapF[0] = this.heapF[last]!;
      this.heapNode[0] = this.heapNode[last]!;
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        const right = left + 1;
        let smallest = i;
        if (left < last && this.less(left, smallest)) {
          smallest = left;
        }
        if (right < last && this.less(right, smallest)) {
          smallest = right;
        }
        if (smallest === i) {
          break;
        }
        this.swap(i, smallest);
        i = smallest;
      }
    }
    return top;
  }
}
