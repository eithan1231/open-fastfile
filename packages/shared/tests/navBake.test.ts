// The navigation bake on box worlds: what it snaps, what it derives, and what
// the simulation decides a player can walk — a wall, a step, a ledge, a mantle,
// a ladder, a gap.
//
// The three that would be quiet if they broke: the bake must never trace a ray
// (a future change to what stops bullets must not change what a bot can walk),
// two bakes must be byte-equal however they were sliced, and a link must be
// judged per direction (a ledge is a drop one way and a wall the other).

import { describe, expect, it } from "vitest";
import type { ResolvedLadder, ResolvedMantle } from "../src/dsl/resolved.js";
import { bakeNav, NavBake } from "../src/nav/bake.js";
import { LINK_ORIGIN, LINK_REASON, LINK_STATUS, NODE_REASON, type NavGraph } from "../src/nav/graph.js";
import { ABILITIES, NODE_TYPES } from "../src/nav/vocab.js";
import { RUN_SPEED, WALK_SPEED } from "../src/sim/movement.js";
import { movementRules } from "../src/sim/worldRules.js";
import { boxWorld, FLOOR, movementOnly, navFile, type Box, type TestLink, type TestNode } from "./navWorld.js";

const TICK_RATE = 60;

function bake(
  boxes: Box[],
  nodes: TestNode[],
  links: TestLink[] = [],
  derive = false,
  climbs: { mantles?: ResolvedMantle[]; ladders?: ResolvedLadder[] } = {},
) {
  const world = movementOnly(boxWorld(boxes));
  const rules = movementRules({ mantles: climbs.mantles ?? [], ladders: climbs.ladders ?? [] });
  return bakeNav(navFile(nodes, links, derive), world, rules, { tickRate: TICK_RATE });
}

/** The link from `a` to `b`, or -1. */
function link(graph: NavGraph, a: number, b: number): number {
  for (let l = graph.first[a]!; l < graph.first[a + 1]!; l++) {
    if (graph.target[l] === b) {
      return l;
    }
  }
  return -1;
}

function verdict(graph: NavGraph, a: number, b: number): { status: number; reason: number; cost: number; requires: number } {
  const l = link(graph, a, b);
  expect(l, `a link ${a} → ${b}`).toBeGreaterThanOrEqual(0);
  return { status: graph.status[l]!, reason: graph.reason[l]!, cost: graph.cost[l]!, requires: graph.requires[l]! };
}

/** Nodes authored 0.7 m above the floor, as MW3's entity nodes are. */
const UP = 0.7;

describe("snapping nodes", () => {
  it("drops an authored node onto the floor below it, and settles a FLOOR_Z one", () => {
    const { graph, summary } = bake([FLOOR], [{ at: [0, UP, 0] }, { at: [3, 0.1, 0], floorZ: true }]);
    expect(graph.usable[0]).toBe(1);
    expect(graph.feet[1]).toBeCloseTo(0, 3);
    expect(graph.feet[4]).toBeCloseTo(0, 3);
    expect(summary.usable).toBe(2);
    expect(summary.snapDrop.max).toBeCloseTo(UP, 3);
  });

  it("finds nothing past its reach, and refuses a node inside something or in a moving frame", () => {
    // Thinner than a body: collision is triangles, so a body wholly inside a
    // big closed box touches none of them and is not "inside" anything.
    const pillar: Box = { size: [0.5, 3, 0.5], at: [6, 1.5, 0] };
    const { graph, summary } = bake(
      [FLOOR, pillar],
      [
        { at: [0, 4, 0] }, // 4 m up: past SNAP_SEARCH
        { at: [0, 0.2, 0], floorZ: true }, // a FLOOR_Z node 0.2 m up still settles
        { at: [6, 1, 0] }, // inside the pillar
        { at: [3, UP, 0], dynamic: true },
      ],
    );
    expect([...graph.nodeReason]).toEqual([NODE_REASON.NO_GROUND, NODE_REASON.NONE, NODE_REASON.INSIDE, NODE_REASON.DYNAMIC]);
    expect(summary.unusable).toEqual({ NO_GROUND: 1, INSIDE: 1, DYNAMIC: 1 });
  });

  it("pushes a node against a wall out of it, a little", () => {
    const wall: Box = { size: [0.4, 3, 6], at: [0.2, 1.5, 0] }; // face at x = 0.4
    const { graph, summary } = bake([FLOOR, wall], [{ at: [0.55, UP, 0] }]);
    expect(graph.usable[0]).toBe(1);
    expect(summary.nudged).toBe(1);
    expect(graph.feet[0]).toBeGreaterThanOrEqual(0.4 + 0.3 - 0.01);
  });

  // The game places a jump down's begin where its clip starts, which can be just
  // past the edge (theater's VIP roof: 0.15 m out, 6 m over the floor below).
  it("stands a traversal's begin hanging past its lip on the lip, and nothing else", () => {
    const roof: Box = { size: [6, 2, 6], at: [0, 1, 0] }; // edge at x = 3
    const over: [number, number, number] = [3.15, 2 + UP, 0];
    const { graph } = bake(
      [FLOOR, roof],
      [{ at: over, type: NODE_TYPES.TRAVERSE_BEGIN }, { at: [4.5, UP, 0], type: NODE_TYPES.TRAVERSE_END }, { at: over }],
      [{ from: 0, to: 1, traversal: "JUMP_DOWN" }],
    );
    expect(graph.usable[0]).toBe(1);
    expect(graph.feet[1]).toBeCloseTo(2, 3);
    expect(graph.feet[0]).toBeLessThanOrEqual(3);
    expect(verdict(graph, 0, 1).status).toBe(LINK_STATUS.VALID);
    // A path node there is over nothing in reach, as before.
    expect(graph.nodeReason[2]).toBe(NODE_REASON.NO_GROUND);
  });
});

describe("derived walk links", () => {
  it("links two nodes on open floor both ways, at the time the walk takes", () => {
    const { graph, summary } = bake([FLOOR], [{ at: [0, UP, 0] }, { at: [4, UP, 0] }], [], true);
    for (const [a, b] of [
      [0, 1],
      [1, 0],
    ] as const) {
      const v = verdict(graph, a, b);
      expect(v.status).toBe(LINK_STATUS.VALID);
      expect(v.requires).toBe(ABILITIES.WALK);
      // No faster than a run, no slower than a walk plus getting going.
      expect(v.cost).toBeGreaterThan(4 / RUN_SPEED);
      expect(v.cost).toBeLessThan(4 / WALK_SPEED + 0.5);
      expect(graph.origin[link(graph, a, b)]).toBe(LINK_ORIGIN.DERIVED);
    }
    expect(summary.derived).toEqual({ pairs: 1, candidates: 2, probed: 2, valid: 2 });
  });

  it("does not link through a wall", () => {
    const wall: Box = { size: [0.4, 3, 6], at: [2, 1.5, 0] };
    const { graph } = bake([FLOOR, wall], [{ at: [0, UP, 0] }, { at: [4, UP, 0] }], [], true);
    expect(verdict(graph, 0, 1)).toMatchObject({ status: LINK_STATUS.INVALID, reason: LINK_REASON.BLOCKED });
    expect(verdict(graph, 1, 0)).toMatchObject({ status: LINK_STATUS.INVALID, reason: LINK_REASON.BLOCKED });
  });

  it("steps onto a step, and off it", () => {
    const step: Box = { size: [4, 0.3, 6], at: [5, 0.15, 0] };
    const { graph } = bake([FLOOR, step], [{ at: [0, UP, 0] }, { at: [5, 0.3 + UP, 0] }], [], true);
    expect(verdict(graph, 0, 1).status).toBe(LINK_STATUS.VALID);
    expect(verdict(graph, 1, 0).status).toBe(LINK_STATUS.VALID);
  });

  it("drops off a ledge it cannot walk back up: one direction, not both", () => {
    const ledge: Box = { size: [4, 1.5, 6], at: [5, 0.75, 0] };
    const { graph } = bake([FLOOR, ledge], [{ at: [0, UP, 0] }, { at: [5, 1.5 + UP, 0] }], [], true);
    expect(verdict(graph, 0, 1).status).toBe(LINK_STATUS.INVALID);
    const down = verdict(graph, 1, 0);
    expect(down.status).toBe(LINK_STATUS.VALID);
    expect(down.requires & ABILITIES.DROP).toBe(ABILITIES.DROP);
  });

  it("leaves pairs beyond reach alone", () => {
    const { summary } = bake([FLOOR], [{ at: [0, UP, 0] }, { at: [7, UP, 0] }], [], true);
    expect(summary.derived.pairs).toBe(0);
  });
});

describe("simulated links", () => {
  it("fails a game walk link through a wall in simulation, where no probe looked", () => {
    const wall: Box = { size: [0.4, 3, 6], at: [2, 1.5, 0] };
    const { graph } = bake([FLOOR, wall], [{ at: [0, UP, 0] }, { at: [4, UP, 0] }], [{ from: 0, to: 1 }]);
    expect(verdict(graph, 0, 1)).toMatchObject({ status: LINK_STATUS.INVALID, reason: LINK_REASON.STUCK });
  });

  it("gives an unusable end's links NODE, and a move we do not have NO_MOVE, without simulating either", () => {
    const { graph, summary } = bake(
      [FLOOR],
      [{ at: [0, UP, 0] }, { at: [3, 5, 0] }, { at: [0, UP, 3] }],
      [
        { from: 0, to: 1 },
        { from: 0, to: 2, traversal: "SPECIAL" },
        { from: 2, to: 0, traversal: "UNKNOWN" },
      ],
    );
    expect(verdict(graph, 0, 1)).toMatchObject({ status: LINK_STATUS.INVALID, reason: LINK_REASON.NODE });
    expect(verdict(graph, 0, 2)).toMatchObject({ status: LINK_STATUS.INVALID, reason: LINK_REASON.NO_MOVE });
    expect(verdict(graph, 2, 0)).toMatchObject({ status: LINK_STATUS.INVALID, reason: LINK_REASON.NO_MOVE });
    expect(summary.simulated).toBe(0);
  });

  it("carries a target node's own abilities into what its links require", () => {
    const { graph } = bake([FLOOR], [{ at: [0, UP, 0] }, { at: [3, UP, 0], abilities: ABILITIES.BOOST }], [{ from: 0, to: 1 }]);
    expect(verdict(graph, 0, 1).requires).toBe(ABILITIES.WALK | ABILITIES.BOOST);
  });
});

describe("traversals", () => {
  /** A crate 1.2 m tall and 2 m deep, across the way, with a mantle volume around it. */
  const CRATE: Box = { size: [2, 1.2, 4], at: [3, 0.6, 0] };
  const CRATE_VOLUME: ResolvedMantle = { id: 1, tags: [], position: { x: 3, y: 0.6, z: 0 }, yaw: 0, size: { x: 2.8, y: 1.2, z: 4.8 }, kind: "over" };
  const OVER_CRATE: TestNode[] = [{ at: [0.8, UP, 0] }, { at: [5.2, UP, 0] }];

  it("mantles over a crate that has a mantle volume", () => {
    const { graph } = bake([FLOOR, CRATE], OVER_CRATE, [{ from: 0, to: 1, traversal: "MANTLE_OVER" }], false, { mantles: [CRATE_VOLUME] });
    const v = verdict(graph, 0, 1);
    expect(v.status).toBe(LINK_STATUS.VALID);
    expect(v.requires & ABILITIES.MANTLE).toBe(ABILITIES.MANTLE);
  });

  it("does not get over the same crate without one: it is taller than a jump", () => {
    const { graph } = bake([FLOOR, CRATE], OVER_CRATE, [{ from: 0, to: 1, traversal: "MANTLE_OVER" }]);
    expect(verdict(graph, 0, 1).status).toBe(LINK_STATUS.INVALID);
  });

  it("climbs a step-up a jump clears, with no volume, and says it jumped", () => {
    const ledge: Box = { size: [4, 0.7, 6], at: [4, 0.35, 0] };
    const { graph } = bake([FLOOR, ledge], [{ at: [0.8, UP, 0] }, { at: [3.5, 0.7 + UP, 0] }], [{ from: 0, to: 1, traversal: "STEP_UP" }]);
    const v = verdict(graph, 0, 1);
    expect(v.status).toBe(LINK_STATUS.VALID);
    expect(v.requires & ABILITIES.JUMP).toBe(ABILITIES.JUMP);
  });

  /** The ladder movement tests' ladder: a 3 m platform from z = -2.1 back, the ladder against its face. */
  const PLATFORM: Box = { size: [40, 3, 8], at: [0, 1.5, -6.1] };
  const LADDER_BOX: Box = { size: [0.8, 3, 0.2], at: [0, 1.5, -2] };
  const LADDER: ResolvedLadder = { id: 0, tags: [], position: { x: 0, y: 1.5, z: -2 }, yaw: 0, size: { x: 0.8, y: 3, z: 0.2 } };

  it("climbs a ladder up", () => {
    const { graph } = bake(
      [FLOOR, PLATFORM, LADDER_BOX],
      [{ at: [0, UP, 0] }, { at: [0, 3 + UP, -3.5] }],
      [{ from: 0, to: 1, traversal: "LADDER_UP" }],
      false,
      {
        ladders: [LADDER],
      },
    );
    const v = verdict(graph, 0, 1);
    expect(v.status).toBe(LINK_STATUS.VALID);
    expect(v.requires & ABILITIES.LADDER).toBe(ABILITIES.LADDER);
  });

  it("climbs a ladder down, backing off the top", () => {
    const { graph } = bake(
      [FLOOR, PLATFORM, LADDER_BOX],
      [{ at: [0, 3 + UP, -3] }, { at: [0, UP, 0.5] }],
      [{ from: 0, to: 1, traversal: "LADDER_DOWN" }],
      false,
      {
        ladders: [LADDER],
      },
    );
    const v = verdict(graph, 0, 1);
    expect(v.status).toBe(LINK_STATUS.VALID);
    expect(v.requires & ABILITIES.LADDER).toBe(ABILITIES.LADDER);
  });

  it("does not climb where the world declares no ladder", () => {
    const { graph } = bake([FLOOR, PLATFORM, LADDER_BOX], [{ at: [0, UP, 0] }, { at: [0, 3 + UP, -3.5] }], [{ from: 0, to: 1, traversal: "LADDER_UP" }]);
    expect(verdict(graph, 0, 1).status).toBe(LINK_STATUS.INVALID);
  });

  it("jumps down off a ledge", () => {
    const ledge: Box = { size: [6, 2, 6], at: [0, 1, 0] };
    const { graph } = bake([FLOOR, ledge], [{ at: [2.3, 2 + UP, 0] }, { at: [4.5, UP, 0] }], [{ from: 0, to: 1, traversal: "JUMP_DOWN" }]);
    const v = verdict(graph, 0, 1);
    expect(v.status).toBe(LINK_STATUS.VALID);
    expect(v.requires & ABILITIES.DROP).toBe(ABILITIES.DROP);
  });

  /** Two floors either side of a gap `width` wide, over a pit 10 m deep. */
  function gap(width: number): Box[] {
    return [
      { size: [20, 1, 20], at: [-10, -0.5, 0] },
      { size: [20, 1, 20], at: [width + 10, -0.5, 0] },
      { size: [60, 1, 60], at: [0, -10.5, 0] },
    ];
  }

  it("jumps across a gap a running jump clears", () => {
    const { graph } = bake(gap(1.5), [{ at: [-0.8, UP, 0] }, { at: [2.3, UP, 0] }], [{ from: 0, to: 1, traversal: "JUMP_ACROSS" }]);
    const v = verdict(graph, 0, 1);
    expect(v.status).toBe(LINK_STATUS.VALID);
    expect(v.requires & ABILITIES.JUMP).toBe(ABILITIES.JUMP);
  });

  it("falls into a gap too wide to jump", () => {
    const { graph } = bake(gap(5), [{ at: [-0.8, UP, 0] }, { at: [5.8, UP, 0] }], [{ from: 0, to: 1, traversal: "JUMP_ACROSS" }]);
    expect(verdict(graph, 0, 1)).toMatchObject({ status: LINK_STATUS.INVALID, reason: LINK_REASON.FELL });
  });
});

describe("the bake itself", () => {
  /** Every kind of link at once, on one map. */
  function everything() {
    const boxes: Box[] = [FLOOR, { size: [0.4, 3, 6], at: [2, 1.5, 10] }, { size: [4, 0.3, 6], at: [5, 0.15, -10] }, { size: [2, 1.2, 4], at: [13, 0.6, 0] }];
    const nodes: TestNode[] = [
      { at: [0, UP, 10] },
      { at: [4, UP, 10] },
      { at: [0, UP, -10] },
      { at: [5, 0.3 + UP, -10] },
      { at: [10.8, UP, 0] },
      { at: [15.2, UP, 0] },
      { at: [0, UP, 0] },
      { at: [3, UP, 0] },
    ];
    const links: TestLink[] = [{ from: 4, to: 5, traversal: "MANTLE_OVER" }];
    const mantles: ResolvedMantle[] = [{ id: 1, tags: [], position: { x: 13, y: 0.6, z: 0 }, yaw: 0, size: { x: 2.8, y: 1.2, z: 4.8 }, kind: "over" }];
    return { boxes, file: navFile(nodes, links, true), rules: movementRules({ mantles, ladders: [] }) };
  }

  it("never traces a ray: what a bot can walk is the movement collision's to say", () => {
    const { boxes, file, rules } = everything();
    const world = movementOnly(boxWorld(boxes));
    expect(() => world.traceRay({ x: 0, y: 1, z: 0 }, { x: 1, y: 0, z: 0 }, 5, "shots")).toThrow();
    const { summary } = bakeNav(file, world, rules, { tickRate: TICK_RATE });
    expect(summary.valid).toBeGreaterThan(0);
    expect(summary.invalid).toBeGreaterThan(0);
  });

  it("bakes the same graph byte for byte, however it is sliced", () => {
    const { boxes, file, rules } = everything();
    const world = boxWorld(boxes);
    const one = bakeNav(file, world, rules, { tickRate: TICK_RATE }).graph;
    const job = new NavBake(file, world, rules, { tickRate: TICK_RATE });
    let calls = 0;
    while (!job.run({ units: 1 })) {
      calls++;
    }
    expect(calls).toBeGreaterThan(3);
    const two = job.graph;
    const fields = [
      "feet",
      "usable",
      "nodeReason",
      "first",
      "source",
      "target",
      "kind",
      "traversalKind",
      "traversal",
      "flags",
      "origin",
      "requires",
      "status",
      "reason",
      "cost",
      "gameCost",
    ] as const;
    for (const field of fields) {
      const a = one[field];
      const b = two[field];
      expect(Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength)), field).toBe(true);
    }
  });

  it("stops a clocked slice when its time is up, and counts the time", () => {
    const { boxes, file, rules } = everything();
    const job = new NavBake(file, boxWorld(boxes), rules, { tickRate: TICK_RATE });
    let clock = 0;
    // Every reading of the clock advances it 1 ms: a 3 ms slice does a few units and stops.
    const now = () => clock++;
    expect(job.run({ now, ms: 3 })).toBe(false);
    while (!job.run({ now, ms: 3 })) {
      // carry on
    }
    expect(job.summary.cpuMs!.total).toBeGreaterThan(0);
    expect(job.summary.cpuMs!.total).toBe(job.summary.cpuMs!.snap + job.summary.cpuMs!.derive + job.summary.cpuMs!.validate);
  });

  it("reports progress that only grows, from 0 to 1, through the stages in order", () => {
    const { boxes, file, rules } = everything();
    const job = new NavBake(file, boxWorld(boxes), rules, { tickRate: TICK_RATE });
    expect(job.progress).toBe(0);
    const seen: number[] = [];
    const stages = new Set<string>();
    while (!job.run({ units: 1 })) {
      seen.push(job.progress);
      stages.add(job.currentStage);
    }
    expect(job.progress).toBe(1);
    expect([...stages]).toEqual(["snap", "derive", "validate"]);
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]!);
    }
    expect(seen.some((p) => p > 0.2 && p < 0.99)).toBe(true);
  });

  it("refuses to hand out a graph before it has one", () => {
    const { boxes, file, rules } = everything();
    const job = new NavBake(file, boxWorld(boxes), rules, { tickRate: TICK_RATE });
    expect(() => job.graph).toThrow(/not finished/);
    expect(job.done).toBe(false);
  });
});
