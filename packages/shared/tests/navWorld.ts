// Small worlds for the navigation tests: boxes for collision, and a NavFile
// written as plain data rather than bytes (the byte layout is navFormat.test.ts's).

import * as THREE from "three";
import { CollisionWorld } from "../src/collision/world.js";
import type { CapsuleWorld } from "../src/sim/capsule.js";
import { NO_INDEX_16, NO_INDEX_32, type NavFile } from "../src/nav/format.js";
import { HEADER_FLAGS, LINK_FLAGS, LINK_KINDS, NODE_FLAGS, TRAVERSAL_KINDS, type TraversalKind } from "../src/nav/vocab.js";

export type Box = { size: [number, number, number]; at: [number, number, number] };

/** A floor 60 m square with its top at y = 0. */
export const FLOOR: Box = { size: [60, 1, 60], at: [0, -0.5, 0] };

export function boxWorld(boxes: Box[]): CollisionWorld {
  const root = new THREE.Group();
  for (const box of boxes) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...box.size));
    mesh.position.set(...box.at);
    mesh.userData.collide = true;
    root.add(mesh);
  }
  root.updateMatrixWorld(true);
  const world = new CollisionWorld();
  world.rebuild(root);
  return world;
}

/**
 * The movement channel of `world` and nothing else: its `traceRay` throws. A
 * bake run against this proves that navigation never asks what stops a bullet.
 */
export function movementOnly(world: CapsuleWorld): CapsuleWorld {
  return {
    get ready() {
      return world.ready;
    },
    resolveCapsule: (p, r, h, out) => world.resolveCapsule(p, r, h, out),
    overlapsCapsule: (p, r, h) => world.overlapsCapsule(p, r, h),
    groundBelow: (p, d) => world.groundBelow(p, d),
    surfaceAt: (p, d) => world.surfaceAt(p, d),
    traceRay: () => {
      throw new Error("navigation must not trace rays");
    },
  };
}

export interface TestNode {
  at: [number, number, number];
  floorZ?: boolean;
  dynamic?: boolean;
  abilities?: number;
  /** `NODE_TYPES`; PATH when absent. */
  type?: number;
}

export interface TestLink {
  from: number;
  to: number;
  /** A traversal of this kind, begin → end; a walk link when absent. */
  traversal?: TraversalKind;
  flags?: number;
}

/** A decoded file of these nodes and links. `derive` sets DERIVE_WALK_LINKS. */
export function navFile(nodes: TestNode[], links: TestLink[] = [], derive = false): NavFile {
  const n = nodes.length;
  const position = new Float32Array(n * 3);
  const flags = new Uint8Array(n);
  const abilities = new Uint32Array(n);
  const type = new Uint8Array(n);
  nodes.forEach((node, i) => {
    type[i] = node.type ?? 0;
    position.set(node.at, i * 3);
    flags[i] = (node.floorZ ? NODE_FLAGS.FLOOR_Z : 0) | (node.dynamic ? NODE_FLAGS.DYNAMIC : 0);
    abilities[i] = node.abilities ?? 0;
  });
  const sorted = links.map((link, index) => ({ link, index })).sort((a, b) => a.link.from - b.link.from || a.index - b.index);
  const traversals = links.filter((l) => l.traversal !== undefined);
  const first = new Uint32Array(n + 1);
  for (const { link } of sorted) {
    first[link.from + 1]!++;
  }
  for (let i = 0; i < n; i++) {
    first[i + 1]! += first[i]!;
  }
  const count = links.length;
  const target = new Uint32Array(count);
  const gameCost = new Float32Array(count).fill(Number.NaN);
  const kind = new Uint8Array(count);
  const linkFlags = new Uint8Array(count);
  const traversal = new Uint16Array(count).fill(NO_INDEX_16);
  sorted.forEach(({ link }, k) => {
    target[k] = link.to;
    const t = link.traversal === undefined ? -1 : traversals.indexOf(link);
    kind[k] = t < 0 ? LINK_KINDS.WALK : LINK_KINDS.TRAVERSE;
    linkFlags[k] = (link.flags ?? 0) | (t < 0 ? LINK_FLAGS.GAME : LINK_FLAGS.NEGOTIATION);
    if (t >= 0) {
      traversal[k] = t;
    }
  });
  return {
    major: 1,
    minor: 0,
    flags: derive ? HEADER_FLAGS.DERIVE_WALK_LINKS : HEADER_FLAGS.HAS_GAME_WALK_LINKS,
    nodes: {
      count: n,
      position,
      yaw: new Uint16Array(n),
      type,
      flags,
      abilities,
      source: new Uint32Array(n).fill(NO_INDEX_32),
      name: new Uint32Array(n),
      group: new Uint16Array(n).fill(NO_INDEX_16),
      stance: new Uint8Array(n),
    },
    links: { count, first, target, gameCost, kind, flags: linkFlags, traversal },
    traversals: {
      count: traversals.length,
      begin: Uint32Array.from(traversals.map((t) => t.from)),
      end: Uint32Array.from(traversals.map((t) => t.to)),
      kind: Uint8Array.from(traversals.map((t) => TRAVERSAL_KINDS[t.traversal!])),
      animscript: new Uint32Array(traversals.length),
    },
    strings: [""],
    meta: null,
    sections: [],
  };
}
