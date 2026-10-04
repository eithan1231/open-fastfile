// Navigation view (engine/navView.ts): the graph a bot walks, baked in the
// browser and drawn as lines.
//
// What would be quiet if it broke: a link drawn in the wrong colour (a rejected
// candidate shown as walkable is a lie about where bots go), the two directions
// of a pair drawn on top of each other (a one-way drop then looks two-way), and
// the geometry of a finished bake left behind when the world is left.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { CollisionWorld } from "@3d/shared/collision/world.js";
import { NO_INDEX_16, NO_INDEX_32, type NavFile } from "@3d/shared/nav/format.js";
import { allocateGraph, LINK_ORIGIN, LINK_REASON, LINK_STATUS, NODE_REASON, NavGraph } from "@3d/shared/nav/graph.js";
import { SNAP_SEARCH } from "@3d/shared/nav/snap.js";
import { HEADER_FLAGS, LINK_FLAGS, LINK_KINDS, NODE_FLAGS, NODE_TYPES, TRAVERSAL_KINDS } from "@3d/shared/nav/vocab.js";
import { movementRules } from "@3d/shared/sim/worldRules.js";
import { describeNode, drawsLink, legend, linkCategory, linkLines, NavView, nodeCategory, nodeLines, type LinkCategory } from "../src/engine/navView.js";

/** A file of these nodes (all PATH unless typed) with no links of its own: walk links derived at load. */
function navFile(nodes: { at: [number, number, number]; type?: number; yaw?: number }[]): NavFile {
  const n = nodes.length;
  const position = new Float32Array(n * 3);
  const type = new Uint8Array(n);
  const flags = new Uint8Array(n);
  const yaw = new Uint16Array(n);
  nodes.forEach((node, i) => {
    position.set(node.at, i * 3);
    type[i] = node.type ?? NODE_TYPES.PATH;
    if (node.yaw !== undefined) {
      flags[i] = NODE_FLAGS.HAS_YAW;
      yaw[i] = node.yaw;
    }
  });
  return {
    major: 1,
    minor: 0,
    flags: HEADER_FLAGS.DERIVE_WALK_LINKS,
    nodes: {
      count: n,
      position,
      yaw,
      type,
      flags,
      abilities: new Uint32Array(n),
      source: new Uint32Array(n).fill(NO_INDEX_32),
      name: new Uint32Array(n),
      group: new Uint16Array(n).fill(NO_INDEX_16),
      stance: new Uint8Array(n),
    },
    links: {
      count: 0,
      first: new Uint32Array(n + 1),
      target: new Uint32Array(0),
      gameCost: new Float32Array(0),
      kind: new Uint8Array(0),
      flags: new Uint8Array(0),
      traversal: new Uint16Array(0),
    },
    traversals: { count: 0, begin: new Uint32Array(0), end: new Uint32Array(0), kind: new Uint8Array(0), animscript: new Uint32Array(0) },
    strings: [""],
    meta: null,
    sections: [],
  };
}

/** A floor with its top at y = 0, and a wall across x = 5 from z = -1 to z = 1. */
function walledWorld(): CollisionWorld {
  const root = new THREE.Group();
  for (const [size, at] of [
    [
      [40, 1, 40],
      [0, -0.5, 0],
    ],
    [
      [0.4, 3, 2],
      [5, 1.5, 0],
    ],
  ] as [[number, number, number], [number, number, number]][]) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size));
    mesh.position.set(...at);
    mesh.userData.collide = true;
    root.add(mesh);
  }
  root.updateMatrixWorld(true);
  const world = new CollisionWorld();
  world.rebuild(root);
  return world;
}

/** A hand-made graph of four nodes on a line, and one link of each kind the view tells apart. */
function handGraph(): NavGraph {
  const file = navFile([
    { at: [0, 0, 0] },
    { at: [3, 0, 0], type: NODE_TYPES.COVER_STAND },
    { at: [6, 0, 0], type: NODE_TYPES.TRAVERSE_BEGIN },
    { at: [6, 2, 1] },
  ]);
  const g = allocateGraph(4, 6);
  g.feet.set(file.nodes.position);
  g.usable.fill(1);
  g.usable[3] = 0;
  g.nodeReason[3] = NODE_REASON.NO_GROUND;
  // [from, to, origin, kind, flags, status, reason, traversal kind], grouped by `from`
  const links: [number, number, number, number, number, number, number, number][] = [
    [0, 1, LINK_ORIGIN.FILE, LINK_KINDS.WALK, LINK_FLAGS.GAME, LINK_STATUS.VALID, LINK_REASON.NONE, 0],
    [1, 0, LINK_ORIGIN.DERIVED, LINK_KINDS.WALK, 0, LINK_STATUS.VALID, LINK_REASON.NONE, 0],
    [1, 2, LINK_ORIGIN.DERIVED, LINK_KINDS.WALK, 0, LINK_STATUS.INVALID, LINK_REASON.RISE, 0],
    [2, 1, LINK_ORIGIN.DERIVED, LINK_KINDS.WALK, 0, LINK_STATUS.INVALID, LINK_REASON.STUCK, 0],
    [2, 3, LINK_ORIGIN.FILE, LINK_KINDS.TRAVERSE, LINK_FLAGS.NEGOTIATION, LINK_STATUS.VALID, LINK_REASON.NONE, TRAVERSAL_KINDS.MANTLE_ON],
    [2, 0, LINK_ORIGIN.FILE, LINK_KINDS.TRAVERSE, LINK_FLAGS.NEGOTIATION, LINK_STATUS.INVALID, LINK_REASON.NO_MOVE, TRAVERSAL_KINDS.SPECIAL],
  ];
  let row = 0;
  links.forEach(([from, to, origin, kind, flags, status, reason, traversalKind], l) => {
    while (row <= from) {
      g.first[row++] = l;
    }
    g.source[l] = from;
    g.target[l] = to;
    g.origin[l] = origin;
    g.kind[l] = kind;
    g.flags[l] = flags;
    g.status[l] = status;
    g.reason[l] = reason;
    g.traversalKind[l] = traversalKind;
  });
  while (row <= 4) {
    g.first[row++] = links.length;
  }
  return new NavGraph(g, file);
}

function segments(lines: { positions: Float32Array }): number {
  return lines.positions.length / 6;
}

describe("the navigation view's colours", () => {
  it("sorts node types into path, cover and traverse", () => {
    expect(nodeCategory(NODE_TYPES.PATH)).toBe("path");
    expect(nodeCategory(NODE_TYPES.COVER_PILLAR)).toBe("cover");
    expect(nodeCategory(NODE_TYPES.CONCEALMENT_PRONE)).toBe("cover");
    expect(nodeCategory(NODE_TYPES.TRAVERSE_END)).toBe("traverse");
    expect(nodeCategory(NODE_TYPES.DOOR)).toBe("path");
    expect(nodeCategory(200)).toBe("path"); // a type from a later file is a plain place
  });

  it("tells a game link from a derived one, and the probe's rejections from the simulation's", () => {
    const graph = handGraph();
    const categories = Array.from({ length: graph.linkCount }, (_, l) => linkCategory(graph, l));
    expect(categories).toEqual<LinkCategory[]>([
      "game walk",
      "derived walk",
      "rejected by the probe",
      "failed in simulation",
      "traversal",
      "invalid traversal",
    ]);
  });

  it("leaves the invalid walk links out of `graph`, but never a traversal", () => {
    const shown = (mode: "graph" | "everything") =>
      (
        ["game walk", "derived walk", "traversal", "invalid traversal", "rejected by the probe", "failed in simulation", "unusable end or no move"] as const
      ).filter((c) => drawsLink(mode, c));
    expect(shown("graph")).toEqual(["game walk", "derived walk", "traversal", "invalid traversal"]);
    expect(shown("everything")).toHaveLength(7);
    expect(drawsLink("off", "game walk")).toBe(false);
  });
});

describe("the navigation view's lines", () => {
  it("draws a walk as one segment and a traversal as a two-segment arc over the higher end", () => {
    const graph = handGraph();
    // 2 valid walks + 2 traversals × 2 segments.
    expect(segments(linkLines(graph, "graph"))).toBe(2 + 4);
    // ...and the two invalid walks.
    expect(segments(linkLines(graph, "everything"))).toBe(2 + 4 + 2);
    const lines = linkLines(graph, "graph");
    const topOfArc = lines.positions[2 * 6 + 4]!; // the third segment's end: the mantle's midpoint
    expect(topOfArc).toBeGreaterThan(2);
  });

  it("draws the two directions of a pair apart, each dim at its source and bright at its target", () => {
    const graph = handGraph();
    const { positions, colours } = linkLines(graph, "graph");
    // Segment 0 is 0 → 1 along +X; segment 1 is 1 → 0.
    const z0 = positions[2]!;
    const z1 = positions[6 + 2]!;
    expect(Math.abs(z0 - z1)).toBeGreaterThan(0.05);
    const brightness = (v: number) => colours[v * 3]! + colours[v * 3 + 1]! + colours[v * 3 + 2]!;
    expect(brightness(0)).toBeLessThan(brightness(1));
  });

  it("marks an unusable node with its reason, and a node with no ground with how far the snap looked", () => {
    const graph = handGraph();
    const nodes = { ...graph.file.nodes, position: graph.feet, usable: graph.usable, nodeReason: graph.nodeReason };
    const baked = nodeLines(nodes);
    // Three usable nodes of three segments; the unusable one: an X, a post and the line down.
    expect(segments(baked)).toBe(3 * 3 + 4);
    const lowest = Math.min(...Array.from({ length: baked.positions.length / 3 }, (_, v) => baked.positions[v * 3 + 1]!));
    expect(lowest).toBeCloseTo(2 - SNAP_SEARCH, 5); // node 3 is at y = 2, and the line goes as far down as the snap looked
  });

  it("gives a yawed node a tick toward where it faces", () => {
    const file = navFile([{ at: [0, 0, 0], yaw: 0 }]);
    const lines = nodeLines(file.nodes);
    expect(segments(lines)).toBe(4);
    // Yaw 0 faces -Z, as the player does.
    expect(lines.positions[3 * 6 + 5]!).toBeLessThan(0);
  });

  it("counts what each colour means, with every invalid link's reason", () => {
    const graph = handGraph();
    const { nodes, links, reasons } = legend(graph, graph.file.nodes.type);
    expect(nodes.reduce((n, row) => n + row.count, 0)).toBe(4);
    expect(nodes.find((row) => row.label === "unusable: NO_GROUND")?.count).toBe(1);
    expect(links.reduce((n, row) => n + row.count, 0)).toBe(graph.linkCount);
    expect(links.find((row) => row.label === "traversal MANTLE_ON")?.count).toBe(1);
    expect(reasons).toEqual({ RISE: 1, STUCK: 1, NO_MOVE: 1 });
    expect(describeNode(graph, 2)).toBe("node #2 traverse_begin: 1 link out, 2 invalid (STUCK, NO_MOVE)");
  });
});

describe("NavView", () => {
  it("draws the file's nodes at once, bakes in slices, then draws the graph", () => {
    const view = new NavView();
    view.setMode("graph");
    // Three nodes in a row, the wall between the second and the third.
    const file = navFile([{ at: [0, 0.7, 0] }, { at: [3, 0.7, 0] }, { at: [7, 0.7, 0] }]);
    view.bake(file, walledWorld(), movementRules({ mantles: [], ladders: [] }), 60, 0);
    expect(view.state).toBe("baking");
    expect(view.nodeObject.geometry.getAttribute("position").count).toBe(3 * 3 * 2);
    let clock = 0;
    const now = () => clock++;
    let finished = false;
    let slices = 0;
    while (!finished) {
      finished = view.update(now, 3);
      slices++;
      expect(slices).toBeLessThan(100_000);
    }
    expect(slices).toBeGreaterThan(1);
    expect(view.state).toBe("ready");
    expect(view.progress).toBe(1);
    const graph = view.graph!;
    // Snapped: the nodes now stand on the floor rather than 0.7 m above it.
    expect(graph.feet[1]).toBeCloseTo(0, 2);
    const drawn = view.linkObject.geometry.getAttribute("position").count;
    expect(drawn).toBeGreaterThan(0);
    view.setMode("everything");
    expect(view.linkObject.geometry.getAttribute("position").count).toBeGreaterThan(drawn);
    expect(view.legend()!.reasons).not.toEqual({});
  });

  it("frees what it drew when cleared, and keeps its mode", () => {
    const view = new NavView();
    view.setMode("graph");
    const file = navFile([{ at: [0, 0.7, 0] }, { at: [3, 0.7, 0] }]);
    view.bake(file, walledWorld(), movementRules({ mantles: [], ladders: [] }), 60, 0);
    while (!view.update(() => 0, Infinity)) {
      // one slice with no clock limit finishes it
    }
    const geometry = view.linkObject.geometry;
    let disposed = false;
    geometry.addEventListener("dispose", () => (disposed = true));
    view.clear();
    expect(disposed).toBe(true);
    expect(view.state).toBe("empty");
    expect(view.graph).toBeNull();
    expect(view.linkObject.geometry.getAttribute("position")).toBeUndefined();
    expect(view.mode).toBe("graph");
  });

  it("stops a bake that throws, and says why, without throwing into the frame", () => {
    const view = new NavView();
    view.setMode("graph");
    const world = walledWorld();
    const broken = Object.create(world) as CollisionWorld;
    broken.groundBelow = () => {
      throw new Error("no ground today");
    };
    view.bake(navFile([{ at: [0, 0.7, 0] }]), broken, movementRules({ mantles: [], ladders: [] }), 60, 0);
    expect(view.update(() => 0, Infinity)).toBe(false);
    expect(view.state).toBe("failed");
    expect(view.failure).toMatch(/no ground today/);
  });
});
