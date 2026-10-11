// A match's removable parts: `ctx.world.setPresent` and everything that follows
// from it at the tick boundary — the collision a player walks through, the
// navigation links a bot plans over, and the bitset every client is sent.
//
// On a real `CollisionWorld` (a floor, a door across the way and a barrier only
// team deathmatch has) and a graph baked once against its base, as a game server
// bakes one: one set of trees and one bake, however many matches play on it.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import type { ResolvedWorld } from "@3d/shared/dsl/resolved.js";
import { CollisionWorld } from "@3d/shared/collision/world.js";
import { catalogueViewOf } from "@3d/shared/game/catalogueView.js";
import type { ServerContext } from "@3d/shared/game/context.js";
import { defaultGametype } from "@3d/shared/game/gametypes/default.js";
import type { GametypeDecl } from "@3d/shared/game/gametypes/declaration.js";
import { bakeNav } from "@3d/shared/nav/bake.js";
import { NO_INDEX_16, NO_INDEX_32, type NavFile } from "@3d/shared/nav/format.js";
import type { NavGraph } from "@3d/shared/nav/graph.js";
import { linksThroughParts } from "@3d/shared/nav/parts.js";
import { HEADER_FLAGS } from "@3d/shared/nav/vocab.js";
import type { InputMessage } from "@3d/shared/net/messages/input.js";
import { idleInput } from "@3d/shared/sim/input.js";
import { STAND_EYE_HEIGHT } from "@3d/shared/sim/movement.js";
import { movementRules } from "@3d/shared/sim/worldRules.js";
import { CATALOG_VERSION, WeaponRegistry } from "@3d/shared/sim/weaponRegistry.js";
import { basePresence, presenceFor } from "@3d/shared/worlds/presence.js";
import { NO_BODIES } from "../src/bodies.js";
import { Match } from "../src/match/match.js";

const TICK_RATE = 60;

/** A spawn at the origin facing -Z, a door two metres ahead, and a barrier off to the east. */
function world(): ResolvedWorld {
  return {
    name: "doorway",
    spawn: { position: { x: 0, y: STAND_EYE_HEIGHT, z: 0 }, look: { x: 0, y: STAND_EYE_HEIGHT, z: -1 } },
    spawnPoints: [],
    triggers: [],
    mantles: [],
    ladders: [],
    effects: [],
    sounds: [],
    points: [],
    solids: [
      { id: 0, name: "front", part: "*1", tags: ["door"] },
      { id: 1, part: "*2", tags: ["barrier"], modes: ["tdm"] },
    ],
    rooms: [],
    topLevelObjects: [],
  } as unknown as ResolvedWorld;
}

function box(size: [number, number, number], at: [number, number, number], part?: string): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size));
  mesh.position.set(...at);
  mesh.userData.collide = true;
  if (part) {
    mesh.userData.part = part;
  }
  return mesh;
}

let shared: { collision: CollisionWorld; graph: NavGraph; partLinks: number[][] } | undefined;

/** The map, loaded and baked once, as `WorldRegistry` holds it for every game on it. */
function loaded() {
  if (shared) {
    return shared;
  }
  const root = new THREE.Group();
  root.add(box([60, 1, 60], [0, -0.5, 0]), box([10, 3, 0.4], [0, 1.5, -2], "*1"), box([0.4, 3, 4], [6, 1.5, 0], "*2"));
  const collision = new CollisionWorld();
  collision.rebuild(root, ["*1", "*2"]);
  const base = collision.view(basePresence(world()));
  const graph = bakeNav(lineFile(3), base, movementRules(world()), { tickRate: TICK_RATE }).graph;
  const parts = world().solids.map((_, i) => {
    const bounds = collision.partBounds(i)!;
    return { min: bounds.min, max: bounds.max, world: collision.partView(i) };
  });
  shared = { collision, graph, partLinks: linksThroughParts(graph, base, parts) };
  return shared;
}

/** Nodes every 4 m along -Z from the spawn, links derived: the door stands between the first two. */
function lineFile(count: number): NavFile {
  const position = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    position.set([0, 0.5, -4 * i], i * 3);
  }
  return {
    major: 1,
    minor: 0,
    flags: HEADER_FLAGS.DERIVE_WALK_LINKS,
    nodes: {
      count,
      position,
      yaw: new Uint16Array(count),
      type: new Uint8Array(count),
      flags: new Uint8Array(count),
      abilities: new Uint32Array(count),
      source: new Uint32Array(count).fill(NO_INDEX_32),
      name: new Uint32Array(count),
      group: new Uint16Array(count).fill(NO_INDEX_16),
      stance: new Uint8Array(count),
    },
    links: {
      count: 0,
      first: new Uint32Array(count + 1),
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

/** A match as `Games.create` stands one up: its own presence, and a view of the shared trees over it. */
function match(gametype: GametypeDecl = defaultGametype): { m: Match; ctx: () => ServerContext } {
  const { collision, graph, partLinks } = loaded();
  const presence = presenceFor(world(), gametype.mode);
  let context: ServerContext | undefined;
  const m = new Match(collision.view(presence), world(), TICK_RATE, 4, new WeaponRegistry([]), {
    map: "doorway",
    gametype,
    catalogue: catalogueViewOf({ version: CATALOG_VERSION }, new WeaponRegistry([])),
    bodies: NO_BODIES,
    scripts: [{ id: "grab", server: { matchStart: (ctx) => (context = ctx) } }],
    nav: { graph, partLinks },
    presence,
    partView: (index) => collision.partView(index),
  });
  m.step();
  return { m, ctx: () => context! };
}

let seq = 0;
/** One tick of walking forward (-Z), and where it left the player. */
function walk(m: Match, id = "a"): number {
  const movement = m.step().players.find((p) => p.id === id)!.state.movement;
  m.receive(id, {
    seq: ++seq & 0xffff,
    dt: 1 / TICK_RATE,
    input: { ...idleInput(0, 0), forward: 1 },
    claim: { ...movement.feet },
    drawn: { tick: 0, frac: 0 },
  } satisfies InputMessage);
  return movement.feet.z;
}

/** The links between the first two nodes, which the door stands across. */
function doorLinks(graph: NavGraph): number[] {
  const out: number[] = [];
  for (let l = 0; l < graph.linkCount; l++) {
    if (graph.source[l]! + graph.target[l]! === 1) {
      out.push(l);
    }
  }
  return out;
}

describe("a solid in a match", () => {
  it("is baked absent, and its part shuts only the links through it", () => {
    const { graph, partLinks } = loaded();
    expect(doorLinks(graph)).toHaveLength(2);
    expect(partLinks[0]).toEqual(doorLinks(graph));
    expect(partLinks[1]).toEqual([]);
  });

  it("opens for a script: walkable the next tick, its links open and every client told", () => {
    const { m, ctx } = match();
    const { graph } = loaded();
    m.join("a");
    let z = 0;
    for (let i = 0; i < 90; i++) {
      z = walk(m);
    }
    // Against the door's face, a capsule's radius short of it.
    expect(z).toBeGreaterThan(-1.8);
    const shut = m.snapshotFor("a", m.step().players);
    expect(shut.presence).toEqual({ since: 0, bits: [0b01] });
    for (const link of doorLinks(graph)) {
      expect(m.navigation!.state.isOpen(link)).toBe(false);
    }

    const epoch = m.navigation!.state.epoch;
    ctx().world.setPresent("door", false);
    // Queued: still there for the rest of this tick, and gone at its end.
    expect(m.presence.has(0)).toBe(true);
    expect(ctx().world.isPresent("front")).toBe(false);
    const opened = m.snapshotFor("a", m.step().players);
    expect(opened.presence).toEqual({ since: opened.tick & 0xffff, bits: [0b00] });
    expect(m.presence.has(0)).toBe(false);
    for (const link of doorLinks(graph)) {
      expect(m.navigation!.state.isOpen(link)).toBe(true);
    }
    expect(m.navigation!.state.epoch).toBeGreaterThan(epoch);

    for (let i = 0; i < 60; i++) {
      z = walk(m);
    }
    expect(z).toBeLessThan(-3);
  });

  it("will not come back around somebody standing in it", () => {
    const { m, ctx } = match();
    m.join("a");
    ctx().world.setPresent("door", false);
    m.step();
    let z = 0;
    while (z > -2) {
      z = walk(m);
    }
    expect(() => ctx().world.setPresent("front", true)).toThrow(/inside/);
    expect(m.presence.has(0)).toBe(false);
    // Out of the way, it can.
    while (z > -4) {
      z = walk(m);
    }
    ctx().world.setPresent("front", true);
    m.step();
    expect(m.presence.has(0)).toBe(true);
  });

  it("throws on a name or tag no solid carries", () => {
    const { ctx } = match();
    expect(() => ctx().world.setPresent("nothing", false)).toThrow(/no solid/);
    expect(() => ctx().world.isPresent("nothing")).toThrow(/no solid/);
  });

  it("differs between two gametypes on one world, over one set of trees and one bake", () => {
    const tdm: GametypeDecl = { ...defaultGametype, id: "tdm-test", mode: "tdm" };
    const roam = match();
    const war = match(tdm);
    expect(roam.m.snapshotFor("a", roam.m.step().players).presence!.bits).toEqual([0b01]);
    expect(war.m.snapshotFor("a", war.m.step().players).presence!.bits).toEqual([0b11]);
    expect(roam.m.navigation!.graph).toBe(war.m.navigation!.graph);

    // The barrier is a wall in one and air in the other: the same spot, two answers.
    const { collision } = loaded();
    const at = { x: 6, y: 0, z: 0 };
    expect(collision.view(roam.m.presence).overlapsCapsule(at, 0.3, 1.8)).toBe(false);
    expect(collision.view(war.m.presence).overlapsCapsule(at, 0.3, 1.8)).toBe(true);

    // And one match opening a door opens it in that match only.
    war.ctx().world.setPresent("door", false);
    war.m.step();
    expect(war.m.presence.has(0)).toBe(false);
    expect(roam.m.presence.has(0)).toBe(true);
  });

  it("sends nothing for a world with no solids", () => {
    const m = new Match(loaded().collision, { ...world(), solids: [] } as ResolvedWorld, TICK_RATE, 4);
    expect(m.snapshotFor("a", m.step().players).presence).toBeNull();
  });
});
