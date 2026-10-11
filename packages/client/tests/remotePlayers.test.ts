// The other players: that membership follows the snapshot, that a body is drawn
// between the last two ticks rather than jumping between them, and that the
// capsule matches the capsule the simulation actually resolves.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { RADIUS, STAND_HEIGHT as HEIGHT } from "@3d/shared/sim/movement.js";
import type { PlayerSnapshot } from "@3d/shared/net/messages/snapshot.js";
import { createMovement } from "@3d/shared/sim/movement.js";
import { lerpMovement } from "@3d/shared/sim/interpolate.js";
import { RemotePlayers } from "../src/net/remotePlayers.js";
import { ActorsView } from "../src/net/actors.js";
import type { ActorState } from "@3d/shared/game/actors/actor.js";
import { CharacterKit, type CharacterSet } from "../src/scene/character.js";

function at(id: string, x: number, z: number, yaw = 0): PlayerSnapshot {
  return {
    id,
    state: {
      movement: createMovement({ x, y: 0, z }, yaw, 0),
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
      health: 100,
      dead: false,
      respawnIn: 0,
      points: 0,
    },
  };
}

function zombie(z: number): ActorState {
  return { id: 1, kind: 0, feet: { x: 0, y: 0, z }, yaw: 0, speed: 1, gait: "walk", action: "move", phase: 0, traversal: 0 };
}

describe("remote players", () => {
  it("adds a body for a player who appears and removes one who stops being sent", () => {
    const remotes = new RemotePlayers();
    remotes.apply([at("a", 0, 0), at("b", 1, 1)], 1, 0);
    expect(remotes.root.children).toHaveLength(2);

    // Snapshot membership is authoritative, and the only thing that says a
    // player has gone.
    remotes.apply([at("a", 0, 0)], 2, 100);
    expect(remotes.root.children).toHaveLength(1);

    remotes.apply([], 3, 200);
    expect(remotes.root.children).toHaveLength(0);
    remotes.dispose();
  });

  it("draws between the last two snapshots at the rate they actually arrive", () => {
    // At the cadence the server really sends: one snapshot per tick. Spacing a
    // test's snapshots further apart than that hides the thing worth testing,
    // because the draw time then falls inside a span that never exists in play.
    const remotes = new RemotePlayers();
    const TICK = 1000 / 60;
    let clock = 1000;
    let x = 0;
    for (let i = 0; i < 6; i++) {
      remotes.apply([at("a", x, 0)], i + 1, clock);
      clock += TICK;
      x += 0.097; // a sprint, in metres per tick
    }

    // Half a tick after the newest snapshot.
    remotes.update(clock - TICK / 2);
    const drawn = (remotes.root.children[0] as THREE.Mesh).position.x;
    const newest = 5 * 0.097;
    const previous = 4 * 0.097;

    // Strictly between the last two samples: pinned to either end would mean the
    // body is stepping between snapshots rather than moving between them.
    expect(drawn).toBeGreaterThan(previous);
    expect(drawn).toBeLessThan(newest);
    remotes.dispose();
  });

  it("never falls more than one tick behind the newest snapshot", () => {
    const remotes = new RemotePlayers();
    const TICK = 1000 / 60;
    let clock = 1000;
    for (let i = 0; i < 6; i++) {
      remotes.apply([at("a", i, 0)], i + 1, clock);
      clock += TICK;
    }
    remotes.update(clock);
    // Latency imposed on a peer's position is one tick of distance, not more:
    // the newest sample is x=5 and the one before it x=4.
    expect((remotes.root.children[0] as THREE.Mesh).position.x).toBeGreaterThanOrEqual(4);
    remotes.dispose();
  });

  it("stands the body on the feet the state gives, not through the floor", () => {
    const remotes = new RemotePlayers();
    remotes.apply([at("a", 0, 0)], 1, 0);
    remotes.update(1000);
    const mesh = remotes.root.children[0] as THREE.Mesh;
    // A capsule's origin is its middle; the simulation's is the feet.
    expect(mesh.position.y).toBeCloseTo(HEIGHT / 2, 6);

    // three names the straight section between the caps `length`.
    const geometry = mesh.geometry as THREE.CapsuleGeometry;
    expect(geometry.parameters.radius).toBe(RADIUS);
    expect(geometry.parameters.radius * 2 + geometry.parameters.length).toBeCloseTo(HEIGHT, 6);
    remotes.dispose();
  });

  it("snaps rather than sliding when a player is placed somewhere new", () => {
    const remotes = new RemotePlayers();
    remotes.apply([at("a", 0, 0)], 1, 1000);
    remotes.apply([at("a", 400, 0)], 2, 1100); // a respawn, not a sprint
    remotes.update(1150);
    expect((remotes.root.children[0] as THREE.Mesh).position.x).toBe(400);
    remotes.dispose();
  });

  it("turns the short way round, so crossing behind does not spin the body", () => {
    const remotes = new RemotePlayers();
    remotes.apply([at("a", 0, 0, Math.PI - 0.1)], 1, 1000);
    remotes.apply([at("a", 0, 0, -Math.PI + 0.1)], 2, 1100);
    remotes.update(1150);
    const y = (remotes.root.children[0] as THREE.Mesh).rotation.y;
    // Halfway across the ±π seam, not most of the way around the other side.
    expect(Math.abs(y)).toBeGreaterThan(Math.PI - 0.11);
    remotes.dispose();
  });

  // Lag compensation rests on these two. A shot names the moment it was aimed at
  // in the *server's* clock, and the server rewinds by calling the same
  // interpolation this client drew with — so "where the body was drawn" and "what
  // the server reproduces" have to be one answer, not two that nearly agree.
  it("reports where it drew, in the server's clock and not this machine's", () => {
    const remotes = new RemotePlayers();
    const TICK = 1000 / 60;
    expect(remotes.renderTick()).toBeUndefined(); // nobody drawn yet: no answer to give

    let clock = 1000;
    for (let i = 0; i < 6; i++) {
      remotes.apply([at("a", i * 0.097, 0)], 100 + i, clock);
      clock += TICK;
    }
    remotes.update(clock - TICK / 2);

    const at1 = remotes.renderTick()!;
    // Drawn one tick behind the newest (105), half a tick further back again.
    expect(at1.tick).toBe(104);
    expect(at1.frac).toBeGreaterThan(0);
    expect(at1.frac).toBeLessThan(1);
    // And never past what the server has actually sent.
    expect(at1.tick + at1.frac).toBeLessThanOrEqual(105);
    remotes.dispose();
  });

  it("stops naming the last peer's tick once they leave, so a shot falls through to the actors' clock", () => {
    // App sends `remotes.renderTick() ?? actors.renderTick()`. A stale peer tick
    // here never falls through, and every shot in a zombies match names a frozen
    // moment the server clamps to its whole rewind window.
    const remotes = new RemotePlayers();
    const actors = new ActorsView();
    const TICK = 1000 / 60;
    for (let i = 0; i < 2; i++) {
      remotes.apply([at("a", 0, 0)], 10 + i, i * TICK);
      actors.apply([zombie(-i)], 10 + i, i * TICK);
    }
    remotes.update(TICK * 1.5);
    actors.update(TICK * 1.5);
    expect(remotes.renderTick()).toEqual({ tick: 10, frac: 0.5 });

    // The peer leaves; the actors go on.
    for (let i = 2; i < 4; i++) {
      remotes.apply([], 10 + i, i * TICK);
      actors.apply([zombie(-i)], 10 + i, i * TICK);
    }
    remotes.update(TICK * 3.5);
    actors.update(TICK * 3.5);
    expect(remotes.renderTick()).toBeUndefined();
    expect(remotes.renderTick() ?? actors.renderTick()).toEqual({ tick: 12, frac: 0.5 });

    // And the next match starts with no answer from either, not the last one's.
    remotes.apply([at("b", 0, 0)], 13, TICK * 4);
    remotes.update(TICK * 4.5);
    expect(remotes.renderTick()).toBeDefined();
    remotes.clear();
    actors.clear();
    expect(remotes.renderTick()).toBeUndefined();
    expect(actors.renderTick()).toBeUndefined();
    remotes.dispose();
    actors.dispose();
  });

  it("draws a body exactly where lerpMovement puts it, which is what the server rewinds to", () => {
    // The cross-check that matters: if this client drew with its own arithmetic and
    // the server rewound with `lerpMovement`, a hit would land where nobody was.
    const remotes = new RemotePlayers();
    const TICK = 1000 / 60;
    const a = createMovement({ x: 0, y: 0, z: 0 }, 0, 0);
    const b = createMovement({ x: 1, y: 0, z: 2 }, 0.4, 0);
    remotes.apply(
      [
        {
          id: "a",
          state: {
            movement: a,
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
            health: 100,
            dead: false,
            respawnIn: 0,
            points: 0,
          },
        },
      ],
      10,
      1000,
    );
    remotes.apply(
      [
        {
          id: "a",
          state: {
            movement: b,
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
            health: 100,
            dead: false,
            respawnIn: 0,
            points: 0,
          },
        },
      ],
      11,
      1000 + TICK,
    );

    // Drawn one tick behind the newest arrival, i.e. exactly at `a`.
    remotes.update(1000 + TICK);
    const drawn = (remotes.root.children[0] as THREE.Mesh).position;
    const expected = lerpMovement(a, b, 0, createMovement({ x: 0, y: 0, z: 0 }, 0, 0));
    expect(drawn.x).toBeCloseTo(expected.feet.x, 10);
    expect(drawn.z).toBeCloseTo(expected.feet.z, 10);
    // Half a tick later it is half way, by the same function.
    remotes.update(1000 + TICK * 1.5);
    const half = (remotes.root.children[0] as THREE.Mesh).position;
    const mid = lerpMovement(a, b, 0.5, createMovement({ x: 0, y: 0, z: 0 }, 0, 0));
    expect(half.x).toBeCloseTo(mid.feet.x, 10);
    expect(half.z).toBeCloseTo(mid.feet.z, 10);
    remotes.dispose();
  });

  it("does not cast shadows, because the shadow map is not redrawn per frame", () => {
    const remotes = new RemotePlayers();
    remotes.apply([at("a", 0, 0)], 1, 0);
    expect((remotes.root.children[0] as THREE.Mesh).castShadow).toBe(false);
    remotes.dispose();
  });
});

/** A minimal kit: one body per side, no head or weapon, and one clip that keys the root. */
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

describe("remote players wearing a world's characters", () => {
  it("dresses everyone in a body, and stands it on its feet rather than lifting it like a capsule", () => {
    const remotes = new RemotePlayers();
    remotes.setKit(kit());
    remotes.apply([at("a", 0, 0), at("b", 3, 0)], 1, 0);
    expect(remotes.root.children).toHaveLength(2);
    remotes.update(16);
    // The state's origin is the feet, and so is a character's; only a capsule is lifted.
    expect(remotes.root.children[0]!.position.y).toBe(0);
    // A CoD rig faces +X where the engine's yaw 0 faces -Z.
    expect(remotes.root.children[0]!.rotation.y).toBeCloseTo(Math.PI / 2, 6);
    remotes.dispose();
  });

  it("falls back to capsules when the world ships no characters", () => {
    const remotes = new RemotePlayers();
    remotes.setKit(kit());
    remotes.apply([at("a", 0, 0)], 1, 0);
    remotes.setKit(undefined);
    remotes.update(16);
    // Re-dressed in place, so the body is not left standing in the map.
    expect(remotes.root.children).toHaveLength(1);
    expect(remotes.root.children[0]).toBeInstanceOf(THREE.Mesh);
    expect(remotes.root.children[0]!.position.y).toBe(HEIGHT / 2);
    remotes.dispose();
  });

  it("gives one player the same character on every client, since the id picks it", () => {
    const shown = () => {
      const remotes = new RemotePlayers();
      remotes.setKit(kit());
      remotes.apply([at("a", 0, 0), at("b", 1, 0)], 1, 0);
      const names = remotes.root.children.map((c) => c.userData.name as string);
      remotes.dispose();
      return names;
    };
    expect(shown()).toEqual(shown());
    expect(new Set(shown())).toEqual(new Set(["allies", "axis"])); // and the two ids do not land on one body
  });
});
