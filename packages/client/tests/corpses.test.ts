// A body leaving the living and becoming one on the floor.
//
// The physics itself is pinned where it lives — `shared/tests/physicsWorld.test.ts`
// for the stepping and ordering, `game-server/tests/ragdollTable.test.ts` for the
// sixteen segments and the pose round trip. What is left for here is the hand-over,
// and it is the part with something to lose: a rig is taken out of `RemotePlayers`
// and put into `Corpses`, and a rig in neither is a player who never reappears when
// they respawn.

import { afterEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { createMovement } from "@3d/shared/sim/movement.js";
import type { PlayerSnapshot } from "@3d/shared/net/messages/snapshot.js";
import type { SpawnEvent } from "@3d/shared/net/messages/events.js";
import { RAGDOLL_SEGMENTS } from "@3d/shared/sim/ragdollBones.js";
import { RemotePlayers } from "../src/net/remotePlayers.js";
import { Corpses, dropBody, type RagdollApi } from "../src/net/corpses.js";
import type { PhysicsWorld } from "@3d/shared/physics/world.js";
import { HITBOX_FORMAT_VERSION } from "@3d/shared/rig/hitboxes.js";
import type { CharacterRig } from "@3d/shared/rig/character.js";

/** A spawn as the server sends one: sixteen rotations, a push, and where it started. */
function spawnEvent(victim: string, entity = 1): SpawnEvent {
  return {
    kind: "spawn",
    id: entity,
    entity,
    what: "ragdoll",
    tick: 1,
    ragdoll: {
      victim,
      origin: { x: 0, y: 1, z: 0 },
      rotations: RAGDOLL_SEGMENTS.map(() => ({ x: 0, y: 0, z: 0, w: 1 })),
      velocity: { x: 0, y: 0, z: 0 },
      knock: { x: 0, y: 0, z: -1.2 },
      segment: RAGDOLL_SEGMENTS.indexOf("rightHand"),
      impulse: { x: 20, y: 0, z: 0 },
    },
  };
}
import { CharacterKit, type CharacterSet } from "../src/scene/character.js";

function at(id: string, dead = false): PlayerSnapshot {
  return {
    id,
    state: {
      movement: createMovement({ x: 0, y: 0, z: 0 }, 0, 0),
      weaponIndex: null,
      attachments: [],
      weapon: null,
      slot: 0,
      spareIndex: null,
      spareAttachments: [],
      armed: 0,
      swapping: false,
      stowed: false,
      team: null,
      health: dead ? 0 : 100,
      dead,
      sinceDamage: 0,
      respawnIn: dead ? 3 : 0,
      points: 0,
    },
  };
}

/** The same two-bone skeleton remotePlayers.test.ts uses: enough to be a rig, and no more. */
function kit(): CharacterKit {
  const set: CharacterSet = {
    game: "iw5",
    weapon: "w",
    animType: "autorifle",
    roles: { idle: "pb_stand_alert" },
    torsoRoles: [],
    aimJoint: "torso_stabilizer",
    clips: {},
  };
  const body = () => {
    const scene = new THREE.Group();
    const root = new THREE.Bone();
    root.name = "tag_origin";
    const stabilizer = new THREE.Bone();
    stabilizer.name = "torso_stabilizer";
    root.add(stabilizer);
    scene.add(root);
    const mesh = new THREE.SkinnedMesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
    mesh.bind(new THREE.Skeleton([root, stabilizer]));
    scene.add(mesh);
    return { scene, clips: [] };
  };
  const clip = new THREE.AnimationClip("pb_stand_alert", 1, [new THREE.QuaternionKeyframeTrack("tag_origin.quaternion", [0, 1], [0, 0, 0, 1, 0, 0, 0, 1])]);
  return new CharacterKit(
    set,
    [clip],
    [
      { name: "allies", body: body() },
      { name: "axis", body: body() },
    ],
  );
}

describe("handing a body over", () => {
  it("takes it out of the living and yields the rig that was drawn", () => {
    const remotes = new RemotePlayers();
    remotes.setKit(kit());
    remotes.apply([at("a"), at("b")], 1, 0);
    expect(remotes.root.children).toHaveLength(2);

    const drawn = remotes.drawnBodies().find((one) => one.id === "a")!.rig;
    const handed = remotes.handOver("a");

    // The same object, not a second body wearing the same clothes: `bodyIndex`
    // chose this one from the player's id, and it is the body the server traced
    // the killing round against.
    expect(handed).toBe(drawn);
    expect(remotes.root.children).toHaveLength(1);
    expect(remotes.drawnBodies().map((one) => one.id)).toEqual(["b"]);
    remotes.dispose();
  });

  it("gives a respawning player a fresh body", () => {
    const remotes = new RemotePlayers();
    remotes.setKit(kit());
    remotes.apply([at("a")], 1, 0);
    const first = remotes.handOver("a")!;

    // The next snapshot that names them spawns them again — which is right, since
    // the old one is on the floor.
    remotes.apply([at("a")], 2, 16);
    const second = remotes.drawnBodies().find((one) => one.id === "a")!.rig;
    expect(second).not.toBe(first);
    expect(remotes.root.children).toHaveLength(1);
    remotes.dispose();
  });

  it("gives nothing back for a peer drawn as a capsule", () => {
    // A world with no cast draws capsules, which have no bones to fall over. The
    // caller has to cope rather than assume, or a world with no characters throws
    // on the first death.
    const remotes = new RemotePlayers();
    remotes.apply([at("a")], 1, 0);
    expect(remotes.handOver("a")).toBeUndefined();
    remotes.dispose();
  });

  it("gives nothing back for a player who is not here", () => {
    const remotes = new RemotePlayers();
    expect(remotes.handOver("nobody")).toBeUndefined();
    remotes.dispose();
  });
});

describe("corpses with no physics", () => {
  it("refuse the body rather than swallowing it", () => {
    // The case a world whose physics did not load is in, and the one that decides
    // whether a failure is a blemish or a player who never comes back. `spawn`
    // says no, and `App.dropTheDead` puts the body back.
    const remotes = new RemotePlayers();
    remotes.setKit(kit());
    remotes.apply([at("a")], 1, 0);
    const rig = remotes.handOver("a")!;

    const corpses = new Corpses();
    expect(corpses.spawn(rig, spawnEvent("a"))).toBe(false);
    expect(corpses.count).toBe(0);
    expect(corpses.root.children).toHaveLength(0);

    // And stepping one that holds nothing is not an error either.
    corpses.step(2);
    corpses.dispose();
    remotes.dispose();
  });

  it("stops drawing a dead player who has been handed over", () => {
    // **The clone.** A dead player keeps arriving in every snapshot, frozen where
    // they fell, for the whole respawn countdown — so a hand-over that only removed
    // them left the very next snapshot spawning a fresh standing rig beside the
    // corpse. One player, two bodies.
    const remotes = new RemotePlayers();
    remotes.setKit(kit());
    remotes.apply([at("a"), at("b")], 1, 0);
    expect(remotes.root.children).toHaveLength(2);

    remotes.handOver("a");
    expect(remotes.root.children).toHaveLength(1);

    // Still being sent, still dead, still not drawn — for as long as it lasts.
    for (let tick = 2; tick < 12; tick++) {
      remotes.apply([at("a", true), at("b")], tick, tick * 16);
      expect(remotes.root.children, `tick ${tick}`).toHaveLength(1);
      expect(remotes.drawnBodies().map((one) => one.id)).toEqual(["b"]);
    }

    // And the respawn brings them back, in a body of their own.
    remotes.apply([at("a"), at("b")], 12, 200);
    expect(remotes.root.children).toHaveLength(2);
    expect(
      remotes
        .drawnBodies()
        .map((one) => one.id)
        .sort(),
    ).toEqual(["a", "b"]);
    remotes.dispose();
  });

  it("still notices a handed-over player leaving for good", () => {
    // Membership is the snapshot's, and a handed-over player is *present* but not
    // drawn — so the count that decides who left has to allow for them, or a
    // disconnect while dead would leave the others behind.
    const remotes = new RemotePlayers();
    remotes.setKit(kit());
    remotes.apply([at("a"), at("b")], 1, 0);
    remotes.handOver("a");

    remotes.apply([at("b")], 2, 16);
    expect(remotes.drawnBodies().map((one) => one.id)).toEqual(["b"]);

    // They come back as a new player later; nothing is left stuck.
    remotes.apply([at("a"), at("b")], 3, 32);
    expect(
      remotes
        .drawnBodies()
        .map((one) => one.id)
        .sort(),
    ).toEqual(["a", "b"]);
    remotes.dispose();
  });

  it("puts a body back where nothing could take it", () => {
    // No physics in this world, so `Corpses.spawn` says no — and the player must go
    // on being drawn standing rather than vanishing until they respawn.
    const remotes = new RemotePlayers();
    remotes.setKit(kit());
    remotes.apply([at("a")], 1, 0);
    const rig = remotes.handOver("a")!;
    const corpses = new Corpses();

    expect(corpses.spawn(rig, spawnEvent("a"))).toBe(false);
    remotes.takeBack("a");
    remotes.apply([at("a", true)], 2, 16);
    expect(remotes.drawnBodies().map((one) => one.id)).toEqual(["a"]);

    corpses.dispose();
    remotes.dispose();
  });
});

describe("letting go of a body", () => {
  // three.js gives every rendered skeleton a bone texture that only
  // `Skeleton.dispose` frees, so whoever holds a rig last has to release it — once.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function disposals(): Map<THREE.Skeleton, number> {
    const counts = new Map<THREE.Skeleton, number>();
    const original = THREE.Skeleton.prototype.dispose;
    vi.spyOn(THREE.Skeleton.prototype, "dispose").mockImplementation(function (this: THREE.Skeleton) {
      counts.set(this, (counts.get(this) ?? 0) + 1);
      original.call(this);
    });
    return counts;
  }

  function skeletonOf(rig: CharacterRig): THREE.Skeleton {
    let found: THREE.Skeleton | undefined;
    rig.root.traverse((item) => {
      if (item instanceof THREE.SkinnedMesh) {
        found = item.skeleton;
      }
    });
    return found!;
  }

  /** Physics that holds an entity until it is despawned or `retire`d, and an api that builds nothing. */
  function fakePhysics() {
    const live = new Set<number>();
    const physics = {
      spawn: (id: number) => live.add(id),
      despawn: (id: number) => live.delete(id),
      step: () => {},
      entity: (id: number) => (live.has(id) ? {} : undefined),
    } as unknown as PhysicsWorld;
    const api = {
      ragdollShape: () => ({}),
      poseFromSpawn: () => [],
      buildRagdoll: () => ({}),
      startRagdoll: () => {},
      poseRagdoll: () => {},
    } as unknown as RagdollApi;
    const sidecars = {
      json: () => Promise.resolve({ version: HITBOX_FORMAT_VERSION, bones: [{ bone: "tag_origin", location: "head", min: [0, 0, 0], max: [1, 1, 1] }] }),
    };
    return { physics, api, sidecars, retire: (id: number) => live.delete(id) };
  }

  it("releases a peer who leaves, once", () => {
    const counts = disposals();
    const remotes = new RemotePlayers();
    remotes.setKit(kit());
    remotes.apply([at("a")], 1, 0);
    const skeleton = skeletonOf(remotes.drawnBodies()[0]!.rig);
    remotes.apply([], 2, 16);
    remotes.dispose();
    expect(counts.get(skeleton)).toBe(1);
  });

  it("releases a body nothing would take, once, and the player is drawn again from a fresh rig", () => {
    const counts = disposals();
    const remotes = new RemotePlayers();
    remotes.setKit(kit());
    remotes.apply([at("a")], 1, 0);
    const skeleton = skeletonOf(remotes.drawnBodies()[0]!.rig);
    const corpses = new Corpses(); // no physics: refuses every body
    dropBody(remotes, corpses, spawnEvent("a"));
    expect(counts.get(skeleton)).toBe(1);

    remotes.apply([at("a", true)], 2, 16);
    expect(skeletonOf(remotes.drawnBodies()[0]!.rig)).not.toBe(skeleton);
    corpses.dispose();
    remotes.dispose();
    expect(counts.get(skeleton)).toBe(1);
  });

  it("releases a corpse once, whether it is retired or cleared, and never while the living held it", async () => {
    const counts = disposals();
    const { physics, api, sidecars, retire } = fakePhysics();
    const corpses = new Corpses();
    corpses.setWorld(physics, api);
    corpses.setSidecars(sidecars);
    const remotes = new RemotePlayers();
    remotes.setKit(kit());
    remotes.apply([at("a"), at("b")], 1, 0);

    // The first of each body waits for its hit boxes, so it is released, not kept.
    dropBody(remotes, corpses, spawnEvent("a", 10));
    dropBody(remotes, corpses, spawnEvent("b", 11));
    await new Promise((resolve) => setTimeout(resolve, 0));
    remotes.apply([at("a"), at("b")], 2, 16);

    const [a, b] = ["a", "b"].map((id) => remotes.drawnBodies().find((one) => one.id === id)!.rig);
    dropBody(remotes, corpses, spawnEvent("a", 2));
    dropBody(remotes, corpses, spawnEvent("b", 3));
    expect(corpses.count).toBe(2);
    expect(counts.get(skeletonOf(a!))).toBeUndefined();

    retire(2);
    corpses.step(3);
    expect(counts.get(skeletonOf(a!))).toBe(1);
    expect(counts.get(skeletonOf(b!))).toBeUndefined();

    corpses.clear();
    remotes.dispose();
    corpses.dispose();
    expect(counts.get(skeletonOf(a!))).toBe(1);
    expect(counts.get(skeletonOf(b!))).toBe(1);
  });
});
