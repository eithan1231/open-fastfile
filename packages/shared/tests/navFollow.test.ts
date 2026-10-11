// The follower: a path turned into a player's input, and its corner cases —
// arriving means standing, a node mid-path is run through rather than stopped
// at, a wall is "stuck" rather than for ever, a mantle that climbs away from its
// target first is not stuck, and a link it has no move for says so at once.

import { describe, expect, it } from "vitest";
import type { ResolvedMantle } from "../src/dsl/resolved.js";
import { createCursor, followPath, FOLLOW_STUCK_TICKS, type FollowGraph, type FollowStatus } from "../src/nav/follow.js";
import { allocateGraph } from "../src/nav/graph.js";
import { LINK_KINDS, TRAVERSAL_KINDS, type TraversalKind } from "../src/nav/vocab.js";
import type { CapsuleWorld } from "../src/sim/capsule.js";
import { idleInput } from "../src/sim/input.js";
import {
  createMovement,
  EMPTY_HANDS,
  horizontalSpeed,
  movementEnv,
  PLAYER_MOVEMENT,
  RUN_SPEED,
  stepMovement,
  type MovementState,
} from "../src/sim/movement.js";
import { movementRules } from "../src/sim/worldRules.js";
import { boxWorld, FLOOR, type Box } from "./navWorld.js";

const DT = 1 / 60;

/** A follow graph over these feet, one link per consecutive pair: a walk, or a traversal where named. */
function chain(feet: [number, number, number][], kinds: (TraversalKind | "walk" | number)[] = []): FollowGraph {
  const g = allocateGraph(feet.length, feet.length - 1);
  feet.forEach((p, i) => g.feet.set(p, i * 3));
  for (let l = 0; l < feet.length - 1; l++) {
    const kind = kinds[l] ?? "walk";
    g.source[l] = l;
    g.target[l] = l + 1;
    if (typeof kind === "number") {
      g.kind[l] = kind;
    } else if (kind === "walk") {
      g.kind[l] = LINK_KINDS.WALK;
    } else {
      g.kind[l] = LINK_KINDS.TRAVERSE;
      g.traversalKind[l] = TRAVERSAL_KINDS[kind];
    }
  }
  return g;
}

/** Drive a player from the first node along every link, until the follower says it is done. */
function drive(
  world: CapsuleWorld,
  graph: FollowGraph,
  links: number[],
  opts: { goal?: { x: number; y: number; z: number }; mantles?: ResolvedMantle[]; ticks?: number } = {},
) {
  const env = movementEnv(world, movementRules({ mantles: opts.mantles ?? [], ladders: [] }), PLAYER_MOVEMENT);
  const s = createMovement({ x: graph.feet[0]!, y: graph.feet[1]!, z: graph.feet[2]! }, 0, 0);
  const cursor = createCursor(links, DT, opts.goal ?? null);
  const input = idleInput(0, 0);
  const trace: MovementState[] = [];
  let status: FollowStatus = "moving";
  let ticks = 0;
  for (; ticks < (opts.ticks ?? 900); ticks++) {
    status = followPath(s, cursor, graph, input);
    if (status !== "moving") {
      break;
    }
    stepMovement(s, input, DT, env, EMPTY_HANDS);
    trace.push(structuredClone(s));
  }
  return { s, status, ticks, trace, cursor };
}

describe("following a path", () => {
  it("arrives standing within reach of the last node", () => {
    const world = boxWorld([FLOOR]);
    const { s, status } = drive(
      world,
      chain([
        [0, 0, 0],
        [0, 0, -5],
      ]),
      [0],
    );
    expect(status).toBe("arrived");
    expect(Math.hypot(s.feet.x, s.feet.z + 5)).toBeLessThanOrEqual(0.4);
    expect(s.grounded).toBe(true);
  });

  it("runs through a node in the middle of a path rather than stopping at it", () => {
    const world = boxWorld([FLOOR]);
    const graph = chain([
      [0, 0, 0],
      [0, 0, -6],
      [4, 0, -10],
      [4, 0, -16],
    ]);
    const { status, trace, cursor } = drive(world, graph, [0, 1, 2]);
    expect(status).toBe("arrived");
    expect(cursor.index).toBe(3);
    // Near each corner the player is still moving at most of a run's speed.
    for (const [x, z] of [
      [0, -6],
      [4, -10],
    ]) {
      const nearest = trace.reduce((best, s) => (Math.hypot(s.feet.x - x!, s.feet.z - z!) < Math.hypot(best.feet.x - x!, best.feet.z - z!) ? s : best));
      expect(horizontalSpeed(nearest)).toBeGreaterThan(0.6 * RUN_SPEED);
    }
  });

  it("walks on to a goal point after the last link, and with no links at all", () => {
    const world = boxWorld([FLOOR]);
    const graph = chain([
      [0, 0, 0],
      [0, 0, -4],
    ]);
    const after = drive(world, graph, [0], { goal: { x: 3, y: 0, z: -6 } });
    expect(after.status).toBe("arrived");
    expect(Math.hypot(after.s.feet.x - 3, after.s.feet.z + 6)).toBeLessThanOrEqual(0.4);
    const straight = drive(world, graph, [], { goal: { x: -2, y: 0, z: 2 } });
    expect(straight.status).toBe("arrived");
    expect(Math.hypot(straight.s.feet.x + 2, straight.s.feet.z - 2)).toBeLessThanOrEqual(0.4);
  });

  it("has arrived at once with nothing to follow", () => {
    const graph = chain([[0, 0, 0]]);
    const s = createMovement({ x: 0, y: 0, z: 0 }, 0, 0);
    expect(followPath(s, createCursor([], DT), graph, idleInput(0, 0))).toBe("arrived");
  });

  it("has not arrived while still in the air over the node", () => {
    const graph = chain([
      [0, 0, 0],
      [0, 0, -1],
    ]);
    const s = createMovement({ x: 0, y: 0.3, z: -1 }, 0, 0);
    const cursor = createCursor([0], DT);
    s.grounded = false;
    expect(followPath(s, cursor, graph, idleInput(0, 0))).toBe("moving");
    s.grounded = true;
    s.feet.y = 0;
    expect(followPath(s, cursor, graph, idleInput(0, 0))).toBe("arrived");
  });

  it("is stuck against a wall, not for ever", () => {
    const world = boxWorld([FLOOR, { size: [6, 3, 0.4], at: [0, 1.5, -2] }]);
    const { status, ticks } = drive(
      world,
      chain([
        [0, 0, 0],
        [0, 0, -4],
      ]),
      [0],
    );
    expect(status).toBe("stuck");
    expect(ticks).toBeLessThan(3 * FOLLOW_STUCK_TICKS + 60);
  });

  it("is stuck at once on a link it has no move for", () => {
    for (const kind of ["SPECIAL", "UNKNOWN", 7] as const) {
      const graph = chain(
        [
          [0, 0, 0],
          [0, 0, -3],
        ],
        [kind],
      );
      const s = createMovement({ x: 0, y: 0, z: 0 }, 0, 0);
      expect(followPath(s, createCursor([0], DT), graph, idleInput(0, 0)), String(kind)).toBe("stuck");
    }
  });

  it("does not call a mantle that climbs away from its target stuck", () => {
    // A wall 1 m tall and 1.5 m deep with an `onto` volume: the climb goes up,
    // away from a target on the floor beyond, and takes longer than the stuck window.
    const wall: Box = { size: [6, 1, 1.5], at: [0, 0.5, -2] };
    const volume: ResolvedMantle = { id: 1, tags: [], position: { x: 0, y: 0.5, z: -2 }, yaw: 0, size: { x: 6.8, y: 1, z: 2.3 }, kind: "onto" };
    const world = boxWorld([FLOOR, wall]);
    const graph = chain(
      [
        [0, 0, -0.6],
        [0, 0, -3.6],
      ],
      ["MANTLE_OVER"],
    );
    const { status, trace } = drive(world, graph, [0], { mantles: [volume] });
    expect(trace.some((s) => s.move.kind === "mantle")).toBe(true);
    expect(status).toBe("arrived");
  });
});
