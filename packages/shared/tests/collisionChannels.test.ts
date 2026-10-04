// The collision's two capsule channels (collision/world.ts): a player is stopped
// by what names `player`, an actor by what names `ai`, and both by the solid
// world. The groups here are written as the exporter writes an imported map's —
// a player-only clip, an AI-only clip with `collides: false`, a Black Ops soup
// clip — and read through the same reader both ends use.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { CollisionWorld } from "../src/collision/world.js";
import { collisionGroupMesh } from "../src/collision/source.js";
import { HEIGHT, RADIUS } from "../src/sim/movement.js";
import { Presence } from "../src/worlds/presence.js";

const MATERIAL = new THREE.MeshBasicMaterial();

function exported(geometry: THREE.BufferGeometry, extras: Record<string, unknown>): THREE.Mesh {
  const source = new THREE.Mesh(geometry);
  Object.assign(source.userData, extras);
  source.updateMatrixWorld(true);
  return collisionGroupMesh(source, MATERIAL);
}

/** A wall 0.4 m thick and 3 m tall, its west face at `x`, centred on `z`. */
function wall(x: number, z: number): THREE.BufferGeometry {
  return new THREE.BoxGeometry(0.4, 3, 2, 4, 4, 4).translate(x + 0.2, 1.5, z);
}

const PLAYER_CLIP = { group: "clip:0x08010000", contents: 0x08010000, blocks: ["player", "detail"] };
const AI_CLIP = { group: "clip:0x08020000", contents: 0x08020000, blocks: ["ai", "detail"], collides: false };
const BOTH_CLIP = { group: "clip:0x08030200", contents: 0x08030200, blocks: ["vehicle", "player", "ai", "detail"] };
const SOUP_CLIP = { group: "clip:soup:0x00030200", contents: 0x30200, blocks: ["vehicle", "player", "ai"], collides: false };

/**
 * A floor, and five walls along z: player-only clip at z=0, AI-only clip at
 * z=4, clip for both at z=8, a soup clip at z=12. Two parts: `*5` an AI-only
 * window clip at z=16, `*6` a solid door at z=20.
 */
function yard(ai: boolean): CollisionWorld {
  const root = new THREE.Group();
  root.add(exported(new THREE.PlaneGeometry(60, 60, 6, 6).rotateX(-Math.PI / 2).translate(0, 0, 10), { group: "solid", blocks: ["solid", "detail"] }));
  root.add(exported(wall(2, 0), PLAYER_CLIP));
  root.add(exported(wall(2, 4), AI_CLIP));
  root.add(exported(wall(2, 8), BOTH_CLIP));
  root.add(exported(wall(2, 12), SOUP_CLIP));
  root.add(exported(wall(2, 16), { ...AI_CLIP, part: "*5" }));
  root.add(exported(wall(2, 20), { group: "solid", blocks: ["solid", "detail"], part: "*6" }));
  const collision = new CollisionWorld();
  collision.rebuild(root, ["*5", "*6"], { ai });
  return collision;
}

/** Feet pressed ten centimetres into the west face of the wall at `z`. */
function against(z: number): { x: number; y: number; z: number } {
  return { x: 2 - RADIUS + 0.1, y: 0, z };
}

describe("collision channels", () => {
  it("a player-only clip stops a player and not an actor; an AI-only clip the reverse", () => {
    const collision = yard(true);
    const presence = new Presence(2);
    const player = collision.view(presence);
    const actor = collision.view(presence, "ai");

    expect(player.overlapsCapsule(against(0), RADIUS, HEIGHT)).toBe(true);
    expect(actor.overlapsCapsule(against(0), RADIUS, HEIGHT)).toBe(false);
    expect(actor.resolveCapsule(against(0), RADIUS, HEIGHT).position.x).toBeCloseTo(against(0).x);

    expect(player.overlapsCapsule(against(4), RADIUS, HEIGHT)).toBe(false);
    expect(actor.overlapsCapsule(against(4), RADIUS, HEIGHT)).toBe(true);
    expect(actor.resolveCapsule(against(4), RADIUS, HEIGHT).position.x).toBeCloseTo(2 - RADIUS, 2);

    // Clip naming both stops both; a soup clip naming `ai` stops an actor though no player collides with it.
    expect(player.overlapsCapsule(against(8), RADIUS, HEIGHT)).toBe(true);
    expect(actor.overlapsCapsule(against(8), RADIUS, HEIGHT)).toBe(true);
    expect(player.overlapsCapsule(against(12), RADIUS, HEIGHT)).toBe(false);
    expect(actor.overlapsCapsule(against(12), RADIUS, HEIGHT)).toBe(true);

    // Both stand on the solid floor.
    expect(actor.groundBelow({ x: -3, y: 1, z: 2 }, 5)).toBeCloseTo(0);
    expect(player.groundBelow({ x: -3, y: 1, z: 2 }, 5)).toBeCloseTo(0);
  });

  it("masks a part on both channels: an AI-only window stops only actors, a door both, each while present", () => {
    const collision = yard(true);
    const presence = new Presence(2);
    const player = collision.view(presence);
    const actor = collision.view(presence, "ai");

    expect(player.overlapsCapsule(against(16), RADIUS, HEIGHT)).toBe(false);
    expect(actor.overlapsCapsule(against(16), RADIUS, HEIGHT)).toBe(true);
    expect(player.overlapsCapsule(against(20), RADIUS, HEIGHT)).toBe(true);
    expect(actor.overlapsCapsule(against(20), RADIUS, HEIGHT)).toBe(true);

    presence.set(0, false);
    presence.set(1, false);
    for (const z of [16, 20]) {
      expect(player.overlapsCapsule(against(z), RADIUS, HEIGHT), `player z=${z}`).toBe(false);
      expect(actor.overlapsCapsule(against(z), RADIUS, HEIGHT), `actor z=${z}`).toBe(false);
    }

    // A part's own view on the ai channel, and its bounds as each channel meets it.
    expect(collision.partView(0, "ai").overlapsCapsule(against(16), RADIUS, HEIGHT)).toBe(true);
    expect(collision.partView(0).overlapsCapsule(against(16), RADIUS, HEIGHT)).toBe(false);
    expect(collision.partBounds(0)).toBeUndefined();
    expect(collision.partBounds(0, "ai")!.min.x).toBeCloseTo(2);
    expect(collision.partBounds(1)!.min.x).toBeCloseTo(2);
  });

  it("leaves the players' trees and every bullet exactly as they are without the ai channel", () => {
    const plain = yard(false);
    const withAi = yard(true);
    expect(() => plain.view(new Presence(2), "ai")).toThrow(/ai channel/);
    expect(plain.mapSurfaces().clip!.getIndex()!.count).toBe(withAi.mapSurfaces().clip!.getIndex()!.count);
    expect(plain.debugSurfaces().length).toBe(withAi.debugSurfaces().length);

    const a = plain.view(new Presence(2));
    const b = withAi.view(new Presence(2));
    // A lattice of feet over every wall, and a ray east from each.
    for (let z = -1; z <= 21; z += 0.37) {
      for (let x = 1.4; x <= 2.3; x += 0.11) {
        const feet = { x, y: 0.02, z };
        expect(b.resolveCapsule(feet, RADIUS, HEIGHT)).toEqual(a.resolveCapsule(feet, RADIUS, HEIGHT));
        expect(b.overlapsCapsule(feet, RADIUS, HEIGHT)).toBe(a.overlapsCapsule(feet, RADIUS, HEIGHT));
      }
      const from = { x: -3, y: 1, z };
      expect(b.traceRay(from, { x: 1, y: 0, z: 0 }, 20, "shots")).toEqual(a.traceRay(from, { x: 1, y: 0, z: 0 }, 20, "shots"));
      // An actor's view traces a bullet as a player's does: clip of neither kind stops one.
      expect(withAi.view(new Presence(2), "ai").traceRay(from, { x: 1, y: 0, z: 0 }, 20, "shots")).toEqual(a.traceRay(from, { x: 1, y: 0, z: 0 }, 20, "shots"));
    }
  });
});
