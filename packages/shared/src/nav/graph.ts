// A world's navigation graph as the bots walk it: the file's nodes settled onto
// our collision, the file's links and the ones derived at load in one CSR, and
// per link whether a player can walk it and how long that takes.
//
// Built by nav/bake.ts and immutable after that: one graph is shared by every
// game on a world, so nothing a match does is written here. What a match changes
// (a door shut, a link a bot got stuck on) is nav/dynamic.ts's `NavMatchState`.
// The arrays are plain typed arrays for speed and are read-only by contract.
//
// docs/engine/navigation.md has the model; the file it starts from is
// docs/engine/nav-format.md.

import type { NavFile } from "./format.js";
import { NavGrid } from "./grid.js";
import { LINK_KINDS, TRAVERSAL_KINDS, type TraversalKind } from "./vocab.js";

/** A link's verdict. UNKNOWN only before the bake has reached it. */
export const LINK_STATUS = {
  UNKNOWN: 0,
  VALID: 1,
  INVALID: 2,
} as const;

/** Why a link is INVALID; NONE otherwise. Numbered for a Uint8Array, never persisted. */
export const LINK_REASON = {
  NONE: 0,
  /** One of its ends is not a usable node. */
  NODE: 1,
  /** A move our player has none for: a SPECIAL or UNKNOWN traversal, or a link kind this build does not know. */
  NO_MOVE: 2,
  /** Probe: nothing to stand on within reach below some point of the corridor. */
  GAP: 3,
  /** Probe: something at body height in the corridor. */
  BLOCKED: 4,
  /** Probe: a rise taller than a step, in this direction. */
  RISE: 5,
  /** Probe: a drop deeper than a walk link may fall. */
  DROP: 6,
  /** Probe: the corridor's ground does not arrive at the target's height (it ends on another level). */
  LEVEL: 7,
  /** Simulation: the follower had not arrived when time ran out. */
  TIMEOUT: 8,
  /** Simulation: the follower stopped getting closer. */
  STUCK: 9,
  /** Simulation: the follower fell far below both ends. */
  FELL: 10,
} as const;

/** Why a node is unusable; NONE for a usable one. */
export const NODE_REASON = {
  NONE: 0,
  /** Nothing to stand on within the snap's reach. */
  NO_GROUND: 1,
  /** A body standing there would be inside something. */
  INSIDE: 2,
  /** In a moving frame no version-1 file resolves (nav-format.md, "DYNAMIC"). */
  DYNAMIC: 3,
} as const;

/** Where a link came from. */
export const LINK_ORIGIN = {
  /** The file's LINK section: a game link or a traversal. */
  FILE: 0,
  /** Derived at load (`DERIVE_WALK_LINKS`, nav/derive.ts). */
  DERIVED: 1,
} as const;

export type LinkReasonName = keyof typeof LINK_REASON;
export type NodeReasonName = keyof typeof NODE_REASON;

/** `LINK_REASON` value → name, for summaries and the debug view. */
export const LINK_REASON_NAMES: readonly LinkReasonName[] = invert(LINK_REASON);
export const NODE_REASON_NAMES: readonly NodeReasonName[] = invert(NODE_REASON);
export const TRAVERSAL_KIND_NAMES: readonly TraversalKind[] = invert(TRAVERSAL_KINDS);

/** The arrays a graph is made of. The bake fills one of these, then freezes it into a `NavGraph`. */
export interface NavGraphData {
  readonly nodeCount: number;
  /** Snapped feet, x y z per node; the file's position where the node is unusable. */
  readonly feet: Float32Array;
  /** 1 for a node a mover may stand on. */
  readonly usable: Uint8Array;
  /** `NODE_REASON`. */
  readonly nodeReason: Uint8Array;

  readonly linkCount: number;
  /** Node i's links are `first[i]` up to `first[i + 1]`. */
  readonly first: Uint32Array;
  /** The node each link leaves: the row it is in, per link, so a link id alone names both ends. */
  readonly source: Uint32Array;
  readonly target: Uint32Array;
  /** `LINK_KINDS`, as the file had it (a derived link is WALK). An unknown value is kept, and is not walked. */
  readonly kind: Uint8Array;
  /** `TRAVERSAL_KINDS` of a TRAVERSE link's traversal; UNKNOWN on a walk. */
  readonly traversalKind: Uint8Array;
  /** The TRAV index, or NO_INDEX_16. */
  readonly traversal: Uint16Array;
  /** `LINK_FLAGS`, as the file had it; 0 on a derived link. */
  readonly flags: Uint8Array;
  /** `LINK_ORIGIN`. */
  readonly origin: Uint8Array;
  /** `ABILITIES` a mover needs: what the simulation had to do to cross it, and the target node's own. */
  readonly requires: Uint32Array;
  /** `LINK_STATUS`. */
  readonly status: Uint8Array;
  /** `LINK_REASON`. */
  readonly reason: Uint8Array;
  /** Seconds the follower took to cross it in simulation; NaN unless VALID. */
  readonly cost: Float32Array;
  /** The file's own number, NaN for a derived link. Never read as a length. */
  readonly gameCost: Float32Array;
}

/** A finished graph. Everything on it is read-only by contract: one graph serves every game on its world. */
export class NavGraph implements NavGraphData {
  readonly nodeCount: number;
  readonly feet: Float32Array;
  readonly usable: Uint8Array;
  readonly nodeReason: Uint8Array;
  readonly linkCount: number;
  readonly first: Uint32Array;
  readonly source: Uint32Array;
  readonly target: Uint32Array;
  readonly kind: Uint8Array;
  readonly traversalKind: Uint8Array;
  readonly traversal: Uint16Array;
  readonly flags: Uint8Array;
  readonly origin: Uint8Array;
  readonly requires: Uint32Array;
  readonly status: Uint8Array;
  readonly reason: Uint8Array;
  readonly cost: Float32Array;
  readonly gameCost: Float32Array;
  /** Usable nodes by where they stand, for nearest-node questions. */
  readonly grid: NavGrid;

  constructor(
    data: NavGraphData,
    /** The file it came from: node types, names and flags are read there, not copied. */
    readonly file: NavFile,
  ) {
    this.nodeCount = data.nodeCount;
    this.feet = data.feet;
    this.usable = data.usable;
    this.nodeReason = data.nodeReason;
    this.linkCount = data.linkCount;
    this.first = data.first;
    this.source = data.source;
    this.target = data.target;
    this.kind = data.kind;
    this.traversalKind = data.traversalKind;
    this.traversal = data.traversal;
    this.flags = data.flags;
    this.origin = data.origin;
    this.requires = data.requires;
    this.status = data.status;
    this.reason = data.reason;
    this.cost = data.cost;
    this.gameCost = data.gameCost;
    this.grid = new NavGrid(this.feet, this.usable);
  }

  /** The usable node nearest `p` horizontally, within `maxDy` of its height, or -1. */
  nearestNode(p: { x: number; y: number; z: number }, maxDy = 2, maxDistance = Infinity): number {
    return this.grid.nearest(p.x, p.y, p.z, maxDy, maxDistance);
  }

  /** Whether `link` is a walk rather than a traversal. */
  isWalk(link: number): boolean {
    return this.kind[link] === LINK_KINDS.WALK;
  }
}

/** Empty arrays for `nodeCount` nodes and `linkCount` links, every link UNKNOWN. */
export function allocateGraph(nodeCount: number, linkCount: number): NavGraphData {
  const cost = new Float32Array(linkCount);
  cost.fill(Number.NaN);
  return {
    nodeCount,
    feet: new Float32Array(nodeCount * 3),
    usable: new Uint8Array(nodeCount),
    nodeReason: new Uint8Array(nodeCount),
    linkCount,
    first: new Uint32Array(nodeCount + 1),
    source: new Uint32Array(linkCount),
    target: new Uint32Array(linkCount),
    kind: new Uint8Array(linkCount),
    traversalKind: new Uint8Array(linkCount),
    traversal: new Uint16Array(linkCount),
    flags: new Uint8Array(linkCount),
    origin: new Uint8Array(linkCount),
    requires: new Uint32Array(linkCount),
    status: new Uint8Array(linkCount),
    reason: new Uint8Array(linkCount),
    cost,
    gameCost: new Float32Array(linkCount),
  };
}

/**
 * Each node's component over the VALID links, and how many components there are.
 *
 * `strong` is mutual reachability — what "a bot here can reach a player there
 * and come back" means, and the honest number for a directed graph with drops
 * in it. `weak` ignores direction. An unusable node is its own component.
 */
export function components(graph: NavGraphData, mode: "strong" | "weak"): { component: Int32Array; count: number; sizes: number[] } {
  return mode === "weak" ? weakComponents(graph) : strongComponents(graph);
}

function weakComponents(graph: NavGraphData): { component: Int32Array; count: number; sizes: number[] } {
  const parent = new Int32Array(graph.nodeCount);
  for (let i = 0; i < parent.length; i++) {
    parent[i] = i;
  }
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  for (let l = 0; l < graph.linkCount; l++) {
    if (graph.status[l] === LINK_STATUS.VALID) {
      const a = find(graph.source[l]!);
      const b = find(graph.target[l]!);
      if (a !== b) {
        parent[Math.max(a, b)] = Math.min(a, b);
      }
    }
  }
  return label(graph.nodeCount, (i) => find(i));
}

/** Tarjan's, iteratively: a big map's longest path would overflow a recursive one. */
function strongComponents(graph: NavGraphData): { component: Int32Array; count: number; sizes: number[] } {
  const n = graph.nodeCount;
  const index = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const onStack = new Uint8Array(n);
  const root = new Int32Array(n).fill(-1);
  const stack: number[] = [];
  const work: number[] = []; // node, next link, interleaved
  let counter = 0;
  for (let start = 0; start < n; start++) {
    if (index[start] !== -1) {
      continue;
    }
    work.push(start, graph.first[start]!);
    index[start] = low[start] = counter++;
    stack.push(start);
    onStack[start] = 1;
    while (work.length > 0) {
      const v = work[work.length - 2]!;
      const l = work[work.length - 1]!;
      if (l < graph.first[v + 1]!) {
        work[work.length - 1] = l + 1;
        if (graph.status[l] !== LINK_STATUS.VALID) {
          continue;
        }
        const w = graph.target[l]!;
        if (index[w] === -1) {
          index[w] = low[w] = counter++;
          stack.push(w);
          onStack[w] = 1;
          work.push(w, graph.first[w]!);
        } else if (onStack[w]) {
          low[v] = Math.min(low[v]!, index[w]!);
        }
        continue;
      }
      work.length -= 2;
      if (work.length > 0) {
        const parent = work[work.length - 2]!;
        low[parent] = Math.min(low[parent]!, low[v]!);
      }
      if (low[v] === index[v]) {
        let w: number;
        do {
          w = stack.pop()!;
          onStack[w] = 0;
          root[w] = v;
        } while (w !== v);
      }
    }
  }
  return label(n, (i) => root[i]!);
}

/** Number components 0.. by their smallest node, so the labels are the same whichever algorithm found them. */
function label(n: number, rootOf: (i: number) => number): { component: Int32Array; count: number; sizes: number[] } {
  const component = new Int32Array(n);
  const ids = new Map<number, number>();
  const sizes: number[] = [];
  for (let i = 0; i < n; i++) {
    const r = rootOf(i);
    let id = ids.get(r);
    if (id === undefined) {
      id = sizes.length;
      ids.set(r, id);
      sizes.push(0);
    }
    component[i] = id;
    sizes[id]!++;
  }
  return { component, count: sizes.length, sizes };
}

function invert<T extends string>(table: Readonly<Record<T, number>>): T[] {
  const out: T[] = [];
  for (const [name, value] of Object.entries(table) as [T, number][]) {
    out[value] = name;
  }
  return out;
}
