// Planning over a baked graph, and what one match changes about it: A* over
// grids with masks, blockers and an epoch that says when to replan; the grid a
// nearest-node question is answered from; components.

import { describe, expect, it } from "vitest";
import { createPath, NavSearch } from "../src/nav/astar.js";
import { NavMatchState, START_DISCONNECTED_BLOCKER } from "../src/nav/dynamic.js";
import { allocateGraph, components, LINK_STATUS, NavGraph } from "../src/nav/graph.js";
import { ABILITIES, LINK_FLAGS, LINK_KINDS, TRAVERSAL_KINDS, type TraversalKind } from "../src/nav/vocab.js";
import { actorMover, PLAYER_MOVER } from "../src/nav/mover.js";
import { navFile } from "./navWorld.js";

const ALL = ABILITIES.WALK | ABILITIES.DROP | ABILITIES.MANTLE | ABILITIES.LADDER | ABILITIES.JUMP;

interface Edge {
  from: number;
  to: number;
  cost?: number;
  requires?: number;
  status?: number;
  traversal?: TraversalKind;
  flags?: number;
}

/** A finished graph of these nodes and links, every link VALID at cost 1 unless it says otherwise. */
function graphOf(positions: [number, number, number][], edges: Edge[], unusable: number[] = []): NavGraph {
  const n = positions.length;
  const sorted = [...edges].sort((a, b) => a.from - b.from);
  const g = allocateGraph(n, sorted.length);
  positions.forEach((p, i) => g.feet.set(p, i * 3));
  g.usable.fill(1);
  for (const i of unusable) {
    g.usable[i] = 0;
  }
  sorted.forEach((e, l) => {
    g.first[e.from + 1]!++;
    g.source[l] = e.from;
    g.target[l] = e.to;
    g.kind[l] = e.traversal ? LINK_KINDS.TRAVERSE : LINK_KINDS.WALK;
    g.traversalKind[l] = e.traversal ? TRAVERSAL_KINDS[e.traversal] : 0;
    g.status[l] = e.status ?? LINK_STATUS.VALID;
    g.cost[l] = e.cost ?? 1;
    g.requires[l] = e.requires ?? ABILITIES.WALK;
    g.flags[l] = e.flags ?? 0;
  });
  for (let i = 0; i < n; i++) {
    g.first[i + 1]! += g.first[i]!;
  }
  return new NavGraph(g, navFile(positions.map((at) => ({ at }))));
}

/** A w × h grid, 2 m apart, linked both ways to its four neighbours. Node (x, z) is z * w + x. */
function grid(w: number, h: number, extra: Edge[] = [], unusable: number[] = []): NavGraph {
  const positions: [number, number, number][] = [];
  const edges: Edge[] = [...extra];
  for (let z = 0; z < h; z++) {
    for (let x = 0; x < w; x++) {
      positions.push([x * 2, 0, z * 2]);
      const i = z * w + x;
      if (x + 1 < w) {
        edges.push({ from: i, to: i + 1 }, { from: i + 1, to: i });
      }
      if (z + 1 < h) {
        edges.push({ from: i, to: i + w }, { from: i + w, to: i });
      }
    }
  }
  return graphOf(positions, edges, unusable);
}

function linkBetween(graph: NavGraph, a: number, b: number): number {
  for (let l = graph.first[a]!; l < graph.first[a + 1]!; l++) {
    if (graph.target[l] === b) {
      return l;
    }
  }
  throw new Error(`no link ${a} → ${b}`);
}

describe("A*", () => {
  it("finds a shortest path, as nodes and the links between them", () => {
    const graph = grid(5, 5);
    const search = new NavSearch(graph);
    const path = createPath();
    expect(search.find(0, 24, { abilities: ALL }, path)).toBe("found");
    expect(path.cost).toBe(8);
    expect(path.nodes[0]).toBe(0);
    expect(path.nodes.at(-1)).toBe(24);
    expect(path.links).toHaveLength(8);
    path.links.forEach((l, k) => {
      expect(graph.source[l]).toBe(path.nodes[k]);
      expect(graph.target[l]).toBe(path.nodes[k + 1]);
    });
  });

  it("breaks ties the same way every time, on a fresh search or a reused one", () => {
    const graph = grid(6, 6);
    const reused = new NavSearch(graph);
    const first = createPath();
    reused.find(0, 35, { abilities: ALL }, first);
    for (let run = 0; run < 3; run++) {
      const again = createPath();
      reused.find(0, 35, { abilities: ALL }, again);
      expect(again.links).toEqual(first.links);
      const fresh = createPath();
      new NavSearch(graph).find(0, 35, { abilities: ALL }, fresh);
      expect(fresh.links).toEqual(first.links);
    }
  });

  it("takes a link only with every ability it requires", () => {
    // A ladder straight from corner to corner, cheaper than any walk.
    const graph = grid(4, 4, [{ from: 0, to: 15, cost: 0.5, requires: ABILITIES.WALK | ABILITIES.LADDER, traversal: "LADDER_UP" }]);
    const search = new NavSearch(graph);
    const path = createPath();
    search.find(0, 15, { abilities: ALL }, path);
    expect(path.links).toHaveLength(1);
    search.find(0, 15, { abilities: ABILITIES.WALK }, path);
    expect(path.links).toHaveLength(6);
  });

  it("scales a kind's cost when asked", () => {
    const graph = grid(4, 4, [{ from: 0, to: 15, cost: 0.5, traversal: "LADDER_UP" }]);
    const path = createPath();
    new NavSearch(graph).find(0, 15, { abilities: ALL, scales: { LADDER_UP: 20 } }, path);
    expect(path.links).toHaveLength(6);
  });

  it("never walks an INVALID link or onto an unusable node", () => {
    const graph = grid(3, 1, [{ from: 0, to: 2, cost: 0.1, status: LINK_STATUS.INVALID }], [1]);
    const path = createPath();
    expect(new NavSearch(graph).find(0, 2, { abilities: ALL }, path)).toBe("unreachable");
  });

  it("says why it found nothing", () => {
    const graph = grid(10, 10, [], [99]);
    const search = new NavSearch(graph);
    const path = createPath();
    expect(search.find(0, 99, { abilities: ALL }, path)).toBe("bad-endpoint");
    expect(search.find(0, 98, { abilities: ALL, maxExpansions: 3 }, path)).toBe("capped");
    expect(path.expansions).toBe(4);
    expect(search.find(0, 98, { abilities: ALL }, path)).toBe("found");
  });
});

describe("a match's blockers", () => {
  it("shuts links, moves the epoch, and a planned path sees it only by checking", () => {
    const graph = grid(3, 3);
    const match = new NavMatchState(graph);
    const search = new NavSearch(graph);
    const path = createPath();
    search.find(0, 2, { abilities: ALL, blocked: match.blocked }, path);
    expect(path.nodes).toEqual([0, 1, 2]);
    const planned = match.epoch;

    match.addBlocker("door", { links: [linkBetween(graph, 1, 2)] });
    expect(match.epoch).not.toBe(planned);
    expect(match.pathOpen(path.links)).toBe(false);
    expect(match.pathOpen(path.links, 2)).toBe(true); // what is left, once past the door
    search.find(0, 2, { abilities: ALL, blocked: match.blocked }, path);
    expect(path.cost).toBe(4);

    expect(match.setBlocked("door", false)).toBe(true);
    expect(match.setBlocked("door", false)).toBe(false);
    search.find(0, 2, { abilities: ALL, blocked: match.blocked }, path);
    expect(path.cost).toBe(2);
  });

  it("adds up overlapping blockers, so opening one leaves the other shut", () => {
    const graph = grid(3, 1);
    const match = new NavMatchState(graph);
    const l = linkBetween(graph, 0, 1);
    match.addBlocker("a", { links: [l] });
    match.addBlocker("b", { links: [l] });
    match.setBlocked("a", false);
    expect(match.isOpen(l)).toBe(false);
    match.removeBlocker("b");
    expect(match.isOpen(l)).toBe(true);
  });

  it("finds the links a box stands across, both directions, and none it does not", () => {
    const graph = grid(3, 3);
    const match = new NavMatchState(graph);
    // Over the middle of the link between (0,0) and (1,0), at x = 1, z = 0.
    const shut = match.addBlocker("crate", { center: { x: 1, y: 0.5, z: 0 }, halfExtents: { x: 0.2, y: 0.5, z: 0.2 }, yaw: 0.3 });
    expect(new Set(shut)).toEqual(new Set([linkBetween(graph, 0, 1), linkBetween(graph, 1, 0)]));
    // High overhead: a body walking under it is not stopped.
    expect(match.addBlocker("sign", { center: { x: 1, y: 3, z: 0 }, halfExtents: { x: 0.2, y: 0.2, z: 0.2 }, yaw: 0 })).toEqual([]);
  });

  it("starts a file's START_DISCONNECTED links shut, behind a blocker that can be opened", () => {
    const disconnected = graphOf(
      [
        [0, 0, 0],
        [2, 0, 0],
      ],
      [
        { from: 0, to: 1, flags: LINK_FLAGS.START_DISCONNECTED },
        { from: 1, to: 0 },
      ],
    );
    const match = new NavMatchState(disconnected);
    expect(match.isOpen(0)).toBe(false);
    expect(match.isOpen(1)).toBe(true);
    match.setBlocked(START_DISCONNECTED_BLOCKER, false);
    expect(match.isOpen(0)).toBe(true);
  });
});

describe("components", () => {
  it("counts a one-way link as joining weakly and not strongly", () => {
    const graph = graphOf(
      [
        [0, 0, 0],
        [2, 0, 0],
        [4, 0, 0],
      ],
      [
        { from: 0, to: 1 },
        { from: 1, to: 0 },
        { from: 1, to: 2 },
      ],
    );
    expect(components(graph, "weak").count).toBe(1);
    const strong = components(graph, "strong");
    expect(strong.count).toBe(2);
    expect(strong.component[0]).toBe(strong.component[1]);
    expect(strong.component[2]).not.toBe(strong.component[0]);
  });
});

describe("the node grid", () => {
  it("answers the nearest usable node within a height, lower index on a tie", () => {
    const graph = graphOf(
      [
        [1, 0, 0],
        [-1, 0, 0],
        [0, 5, 0],
        [10, 0, 0],
      ],
      [],
      [3],
    );
    expect(graph.nearestNode({ x: 0, y: 0, z: 0 })).toBe(0);
    expect(graph.nearestNode({ x: 0, y: 5, z: 0 }, 1)).toBe(2);
    expect(graph.nearestNode({ x: 10, y: 0, z: 0 }, 1, 3)).toBe(-1);
    expect(graph.nearestNode({ x: 30, y: 0, z: 0 }, 1)).toBe(0);
  });
});

describe("an actor's links", () => {
  const GAME = LINK_FLAGS.GAME;
  // 0 → 1 → 2 in a row, 4 m apart; 1 → 3 a window climb; 3 → 2 a SPECIAL; 0 → 4 → 2 a long detour the player walked.
  const graph = graphOf(
    [
      [0, 0, 0],
      [4, 0, 0],
      [8, 0, 0],
      [6, 0, 3],
      [4, 0, -12],
    ],
    [
      // The game's walk, which our player could not walk (a player clip): an actor's all the same.
      { from: 0, to: 1, flags: GAME, status: LINK_STATUS.INVALID },
      // The game's window climb, invalid for our player too.
      { from: 1, to: 2, flags: GAME, traversal: "MANTLE_OVER", status: LINK_STATUS.INVALID },
      { from: 1, to: 3, flags: GAME, traversal: "SPECIAL", status: LINK_STATUS.INVALID },
      { from: 3, to: 2, flags: GAME },
      // Derived, and walked in simulation: both go by the bake's verdict.
      { from: 0, to: 4, cost: 20 },
      { from: 4, to: 2, cost: 20 },
    ],
  );

  it("takes the game's compiled walks and traversals whatever the player's bake said, and a derived link by it", () => {
    const mover = actorMover(graph);
    // In CSR order: 0→1, 0→4, 1→2, 1→3 (SPECIAL: no motion), 3→2, 4→2.
    expect([...mover.valid!]).toEqual([1, 1, 1, 0, 1, 1]);
    expect(actorMover(graph)).toBe(mover); // one per graph

    const search = new NavSearch(graph);
    const path = createPath();
    expect(search.find(0, 2, { abilities: ALL, mover }, path)).toBe("found");
    expect(path.nodes).toEqual([0, 1, 2]);
    // A player has only the detour, at the bake's cost.
    expect(search.find(0, 2, { abilities: ALL, mover: PLAYER_MOVER }, path)).toBe("found");
    expect(path.nodes).toEqual([0, 4, 2]);
    expect(path.cost).toBe(40);
  });

  it("honours blockers on the same link ids, and never stands on an unusable node", () => {
    const mover = actorMover(graph);
    const state = new NavMatchState(graph);
    state.addBlocker("part:*9", { links: [linkBetween(graph, 1, 2)] });
    const search = new NavSearch(graph);
    const path = createPath();
    expect(search.find(0, 2, { abilities: ALL, mover, blocked: state.blocked }, path)).toBe("found");
    expect(path.nodes).toEqual([0, 4, 2]);

    const cut = graphOf(
      [
        [0, 0, 0],
        [4, 0, 0],
      ],
      [{ from: 0, to: 1, flags: GAME, status: LINK_STATUS.INVALID }],
      [1],
    );
    expect(actorMover(cut).valid![0]).toBe(0);
  });
});
