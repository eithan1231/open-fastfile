// A physics world: the ordering and step rules replication rests on.
//
// The layer is general on purpose — a corpse, a grenade, a rocket and a care
// package are meant to be one mechanism (`sim/entityKinds.ts`) — so what is pinned
// here is the mechanism rather than any one kind. Three things have to be identical
// on every machine for a simulation to be: the initial conditions, the order of
// construction, and the number of steps. The wire owns the first; this file is the
// other two.
//
// It imports Rapier directly, which `eslint.config.js` allows nowhere outside
// `src/physics/`: a `build` callback is handed the raw world, so a test that stands
// an entity up has to hold one. That is the same licence
// physicsDeterminism.test.ts takes, and for the same reason — these are tests *of*
// the engine's behaviour, not of something layered over it.

import { describe, expect, it, beforeAll } from "vitest";
import RAPIER from "@dimforge/rapier3d-deterministic-compat";
import { initPhysics } from "../src/physics/engine.js";
import { PhysicsWorld } from "../src/physics/world.js";
import { ENTITY_KINDS, ENTITY_POLICY } from "../src/sim/entityKinds.js";
import { TICK_RATE } from "../src/net/messages/fields.js";
import * as THREE from "three";
import { CollisionWorld } from "../src/collision/world.js";
import { Presence } from "../src/worlds/presence.js";

/** One dynamic box, which is the smallest entity there is. */
function box(at: { x: number; y: number; z: number }) {
  return (world: RAPIER.World) => {
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(at.x, at.y, at.z));
    world.createCollider(RAPIER.ColliderDesc.cuboid(0.2, 0.2, 0.2).setMass(5), body);
    return { bodies: [body], joints: [] };
  };
}

beforeAll(async () => {
  await initPhysics();
});

describe("a physics world", () => {
  it("steps once per tick, and catches a caller up rather than approximately", () => {
    const world = new PhysicsWorld(TICK_RATE);
    try {
      expect(world.at).toBe(0);
      world.step(10);
      expect(world.at).toBe(10);

      // A second call for a tick already stepped does nothing: the step count is
      // the thing every end has to agree on, so it cannot depend on how often a
      // caller happens to call.
      world.step(10);
      expect(world.at).toBe(10);
      world.step(4);
      expect(world.at).toBe(10);

      // And a caller that missed a second of snapshots catches up exactly.
      world.step(70);
      expect(world.at).toBe(70);
    } finally {
      world.free();
    }
  });

  it("gives up rather than stalling when it is hopelessly behind", () => {
    const world = new PhysicsWorld(TICK_RATE);
    try {
      // Past the catch-up bound the world is declared to be at the tick asked for.
      // That is an entity in the wrong place, which is a blemish; simulating five
      // minutes of physics inside one frame is a hang.
      world.step(60 * 60);
      expect(world.at).toBe(60 * 60);
    } finally {
      world.free();
    }
  });

  it("builds spawns in id order, whatever order they arrived in", () => {
    const world = new PhysicsWorld(TICK_RATE);
    const built: number[] = [];
    try {
      // Two deaths on one tick is exactly the case where a server iterating its
      // roster and a client reading a packet disagree about order — and Rapier's
      // determinism is a promise about construction order.
      for (const id of [7, 3, 9, 1]) {
        world.spawn(id, "ragdoll", 1, (raw) => {
          built.push(id);
          return box({ x: id, y: 5, z: 0 })(raw);
        });
      }
      world.step(1);
      expect(built).toEqual([1, 3, 7, 9]);
      expect(world.count).toBe(4);
    } finally {
      world.free();
    }
  });

  it("ignores a repeated spawn", () => {
    const world = new PhysicsWorld(TICK_RATE);
    let builds = 0;
    try {
      // A spawn rides the snapshot tail and is repeated for as long as it is worth
      // repeating, so this is the ordinary case and not the exotic one. Building it
      // twice would double the bodies and re-apply the impulse.
      for (let i = 0; i < 4; i++) {
        world.spawn(1, "ragdoll", 1, (raw) => {
          builds++;
          return box({ x: 0, y: 5, z: 0 })(raw);
        });
      }
      world.step(2);
      expect(builds).toBe(1);
      world.spawn(1, "ragdoll", 2, box({ x: 0, y: 5, z: 0 }));
      world.step(3);
      expect(builds).toBe(1);
      expect(world.count).toBe(1);
    } finally {
      world.free();
    }
  });

  it("retires an entity at its kind's lifetime, with nothing sent to end it", () => {
    const world = new PhysicsWorld(TICK_RATE);
    try {
      world.spawn(1, "ragdoll", 1, box({ x: 0, y: 5, z: 0 }));
      world.step(1);
      expect(world.count).toBe(1);

      const life = ENTITY_POLICY.ragdoll.lifetimeSeconds * TICK_RATE;
      world.step(life);
      expect(world.count).toBe(1);
      world.step(life + 2);
      expect(world.count).toBe(0);
    } finally {
      world.free();
    }
  });

  it("drops the oldest when a kind is over its cap", () => {
    const world = new PhysicsWorld(TICK_RATE);
    try {
      const cap = ENTITY_POLICY.ragdoll.maxLive;
      for (let i = 1; i <= cap + 3; i++) {
        world.spawn(i, "ragdoll", i, box({ x: i, y: 5, z: 0 }));
        world.step(i);
      }
      expect(world.count).toBe(cap);
      // Oldest out first, by spawn tick then id, so every machine drops the same one.
      expect(world.entity(1)).toBeUndefined();
      expect(world.entity(3)).toBeUndefined();
      expect(world.entity(cap + 3)).toBeDefined();
    } finally {
      world.free();
    }
  });

  it("refuses to load terrain twice", () => {
    // Terrain is part of the construction order, so a world that gained some later
    // would be running a different simulation from one that had it from the start.
    const world = new PhysicsWorld(TICK_RATE);
    try {
      const empty = { mapSurfaces: () => ({}) } as never;
      world.loadTerrain(empty);
      expect(() => world.loadTerrain(empty)).toThrow(/already loaded/);
    } finally {
      world.free();
    }
  });
});

/** A floor, and a slab one metre up that is the removable part `*1`. */
function shelf(): CollisionWorld {
  const root = new THREE.Group();
  for (const [geometry, part] of [
    [new THREE.BoxGeometry(20, 0.2, 20).translate(0, -0.1, 0), undefined],
    [new THREE.BoxGeometry(4, 0.2, 4).translate(0, 1, 0), "*1"],
  ] as const) {
    const mesh = new THREE.Mesh(geometry);
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

describe("a removable part", () => {
  /** Drop a box on the shelf, take the shelf away at tick 30 and put it back at 120; where is the box then? */
  function run(): { y: number; colliders: number[] } {
    const world = new PhysicsWorld(TICK_RATE);
    try {
      world.loadTerrain(shelf(), "shots", new Presence(1));
      const colliders = [world.partColliders(0)];
      world.spawn(1, ENTITY_KINDS[0]!, 0, box({ x: 0, y: 2, z: 0 }));
      world.step(30);
      world.setPart(0, false);
      colliders.push(world.partColliders(0));
      world.step(120);
      world.setPart(0, true);
      colliders.push(world.partColliders(0));
      return { y: world.entity(1)!.bodies[0]!.translation().y, colliders };
    } finally {
      world.free();
    }
  }

  it("is a collider while present and none once taken out, at the tick it is told", () => {
    const world = new PhysicsWorld(TICK_RATE);
    try {
      world.loadTerrain(shelf(), "shots", new Presence(1));
      world.spawn(1, ENTITY_KINDS[0]!, 0, box({ x: 0, y: 2, z: 0 }));
      world.step(30);
      // Resting on the shelf, a box's half-height above its top.
      expect(world.entity(1)!.bodies[0]!.translation().y).toBeCloseTo(1.3, 1);
    } finally {
      world.free();
    }
    const { y, colliders } = run();
    expect(colliders).toEqual([1, 0, 1]);
    // On the floor: the shelf went, and came back beneath it.
    expect(y).toBeCloseTo(0.2, 1);
  });

  it("is not built for a world whose presence starts without it", () => {
    const world = new PhysicsWorld(TICK_RATE);
    try {
      world.loadTerrain(shelf(), "shots", new Presence(1, undefined, false));
      expect(world.partColliders(0)).toBe(0);
    } finally {
      world.free();
    }
  });

  it("changes the same way on every end that changes it at the same tick", () => {
    expect(run()).toEqual(run());
  });
});

describe("the kind table", () => {
  it("gives a correction to everything the server simulates, and to nothing else", () => {
    for (const kind of ENTITY_KINDS) {
      const policy = ENTITY_POLICY[kind];
      // The two policies are a pair: the server's copy is the authority only if it
      // is both simulated and published, and a cosmetic kind publishes nothing
      // because there is nothing for a client's copy to be wrong about.
      expect(policy.correctEvery > 0, `${kind}`).toBe(policy.serverSimulates);
      expect(policy.lifetimeSeconds, kind).toBeGreaterThan(0);
      expect(policy.maxLive, kind).toBeGreaterThan(0);
    }
  });
});
