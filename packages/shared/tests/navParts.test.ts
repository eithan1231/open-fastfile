// A removable part as a navigation blocker (nav/parts.ts): the graph is baked
// once with every part absent, and a part shuts the links its triangles fill.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { CollisionWorld } from "../src/collision/world.js";
import { bakeNav } from "../src/nav/bake.js";
import { createPath, NavSearch } from "../src/nav/astar.js";
import { NavMatchState } from "../src/nav/dynamic.js";
import { LINK_STATUS, type NavGraph } from "../src/nav/graph.js";
import { linksThroughParts } from "../src/nav/parts.js";
import { ABILITIES } from "../src/nav/vocab.js";
import { movementRules } from "../src/sim/worldRules.js";
import { basePresence } from "../src/worlds/presence.js";
import { FLOOR, movementOnly, navFile, type Box } from "./navWorld.js";

const UP = 0.7;
const RULES = movementRules({ mantles: [], ladders: [] });

/** A wall along x = 2 with a doorway 2 m wide at z = 0, and the door in it as part `*1`. */
function doorway(): CollisionWorld {
  const root = new THREE.Group();
  const boxes: [Box, string | undefined][] = [
    [FLOOR, undefined],
    [{ size: [0.4, 3, 8], at: [2, 1.5, -5] }, undefined],
    [{ size: [0.4, 3, 8], at: [2, 1.5, 5] }, undefined],
    [{ size: [0.4, 3, 2], at: [2, 1.5, 0] }, "*1"],
  ];
  for (const [box, part] of boxes) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...box.size));
    mesh.position.set(...box.at);
    mesh.userData.collide = true;
    if (part) {
      mesh.userData.part = part;
    }
    root.add(mesh);
  }
  const collision = new CollisionWorld();
  collision.rebuild(root, ["*1"]);
  return collision;
}

/** West and east of the doorway, and west and east of the wall beside it. */
const NODES = [{ at: [0, UP, 0] }, { at: [4, UP, 0] }, { at: [0, UP, -4] }, { at: [4, UP, -4] }] as const;

function linkBetween(graph: NavGraph, a: number, b: number): number {
  for (let l = graph.first[a]!; l < graph.first[a + 1]!; l++) {
    if (graph.target[l] === b) {
      return l;
    }
  }
  return -1;
}

function bake() {
  const collision = doorway();
  const base = collision.view(basePresence({ solids: [{ id: 0, part: "*1", tags: [] }] }));
  const { graph } = bakeNav(
    navFile(
      NODES.map((n) => ({ at: [...n.at] as [number, number, number] })),
      [],
      true,
    ),
    movementOnly(base),
    RULES,
    { tickRate: 60 },
  );
  const bounds = collision.partBounds(0)!;
  const [links] = linksThroughParts(graph, base, [{ min: bounds.min, max: bounds.max, world: collision.partView(0) }]);
  return { graph, links: links! };
}

function route(graph: NavGraph, state: NavMatchState, from: number, to: number): string {
  return new NavSearch(graph).find(from, to, { abilities: ABILITIES.WALK, blocked: state.blocked }, createPath());
}

describe("a removable part in navigation", () => {
  it("is baked absent, so the doorway's links are valid and the wall's are not", () => {
    const { graph } = bake();
    expect(graph.status[linkBetween(graph, 0, 1)]).toBe(LINK_STATUS.VALID);
    expect(graph.status[linkBetween(graph, 1, 0)]).toBe(LINK_STATUS.VALID);
    expect(graph.status[linkBetween(graph, 2, 3)]).toBe(LINK_STATUS.INVALID);
  });

  it("shuts exactly the links through the doorway", () => {
    const { graph, links } = bake();
    expect(links).toEqual([linkBetween(graph, 0, 1), linkBetween(graph, 1, 0)].sort((a, b) => a - b));
  });

  it("disconnects the two sides while present and reconnects them once removed", () => {
    const { graph, links } = bake();
    const state = new NavMatchState(graph);
    state.addBlocker("part:*1", { links }, true);
    expect(route(graph, state, 2, 3)).toBe("unreachable");
    const epoch = state.epoch;
    expect(state.setBlocked("part:*1", false)).toBe(true);
    // The epoch moving is what makes a bot walking a planned path look again.
    expect(state.epoch).toBeGreaterThan(epoch);
    expect(route(graph, state, 2, 3)).toBe("found");
    state.setBlocked("part:*1", true);
    expect(route(graph, state, 0, 1)).toBe("unreachable");
  });

  it("finds nothing for a part nobody could walk into", () => {
    const { graph } = bake();
    const collision = doorway();
    const base = collision.view(basePresence({ solids: [{ id: 0, part: "*1", tags: [] }] }));
    const far = { min: { x: 20, y: 10, z: 20 }, max: { x: 21, y: 11, z: 21 }, world: collision.partView(0) };
    expect(linksThroughParts(graph, base, [far, undefined])).toEqual([[], []]);
  });
});
