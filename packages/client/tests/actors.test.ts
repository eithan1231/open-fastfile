// ActorsView: actors drawn from snapshots — spawned when an id appears, gone when
// it stops, interpolated one tick behind like a peer, a capsule for a kind with no
// body, lying down when dead. ActorRigs: the rigs they wear, kept between them.

import { describe, expect, it } from "vitest";
import type { ActorState } from "@3d/shared/game/actors/actor.js";
import { ZOMBIE_KIND } from "@3d/shared/game/actors/kinds.js";
import * as THREE from "three";
import { actorLook, readActorAssets, type ActorClipSetEntry, type ActorEntry } from "@3d/shared/game/actors/assets.js";
import type { GltfAsset } from "../src/scene/character.js";
import { ActorsView } from "../src/net/actors.js";
import { ActorRigs } from "../src/net/actorRigs.js";

const TICK_MS = 1000 / 60;

const actor = (id: number, z: number, overrides: Partial<ActorState> = {}): ActorState => ({
  id,
  kind: 0,
  feet: { x: 0, y: 0, z },
  yaw: 0,
  speed: 1,
  gait: "walk",
  action: "move",
  phase: 0,
  traversal: 0,
  dead: false,
  ...overrides,
});

describe("ActorsView", () => {
  it("follows the snapshot's membership", () => {
    const view = new ActorsView();
    view.apply([actor(1, 0), actor(2, -3)], 1, 0);
    expect(view.size).toBe(2);
    expect(view.root.children).toHaveLength(2);
    view.apply([actor(2, -3)], 2, TICK_MS);
    expect(view.size).toBe(1);
    expect(view.root.children).toHaveLength(1);
    view.clear();
    expect(view.root.children).toHaveLength(0);
  });

  it("draws a capsule one tick behind the newest snapshot, standing on its feet", () => {
    const view = new ActorsView();
    view.apply([actor(1, 0)], 10, 0);
    view.apply([actor(1, -1)], 11, TICK_MS);
    // Half a tick after the newer arrived: halfway between the two.
    view.update(TICK_MS * 1.5);
    const capsule = view.root.children[0]!;
    expect(capsule.position.z).toBeCloseTo(-0.5, 6);
    expect(capsule.position.y).toBeCloseTo(ZOMBIE_KIND.height / 2, 6);
    expect(view.renderTick()).toEqual({ tick: 10, frac: 0.5 });
  });

  it("lays a dead capsule down", () => {
    const view = new ActorsView();
    view.apply([actor(1, 0, { dead: true, action: "die" })], 1, 0);
    view.update(TICK_MS);
    const capsule = view.root.children[0]!;
    expect(capsule.position.y).toBeCloseTo(ZOMBIE_KIND.radius, 6);
    expect(Math.abs(capsule.rotation.z)).toBeCloseTo(Math.PI / 2, 6);
  });
});

// A kind with a creature: each actor wears the body and plays the clips its look
// draws for it — the same draw the server makes — and a body that did not load
// leaves that actor a capsule.
describe("ActorsView with a creature", () => {
  const info = (duration: number, speed: number | null) => ({
    duration,
    looped: true,
    notes: [],
    rootMotion: speed === null ? null : { forward: 0, left: 0, up: 0, yaw: 0, speed },
  });
  const entry: ActorEntry = {
    id: "z",
    game: "t5",
    kind: "zombie",
    version: 1,
    bodies: ["b0.glb", "b1.glb"],
    heads: ["h.glb"],
    animations: "zombie",
    hitboxes: "z.json",
  };
  const set: ActorClipSetEntry = {
    id: "zombie",
    game: "t5",
    actor: true,
    version: 1,
    clips: "animations.glb",
    roles: { idle: ["idle"], walk: ["walk"] },
    clipTable: { idle: info(2, null), walk: info(1, 1) },
  };
  const assets = readActorAssets(entry, set);

  /** A skinned mesh bound to `bones`, in a scene of its own. */
  function skinned(bones: THREE.Bone[], roots: THREE.Bone[]): GltfAsset {
    const scene = new THREE.Group();
    scene.add(...roots);
    const mesh = new THREE.SkinnedMesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
    mesh.bind(new THREE.Skeleton(bones));
    scene.add(mesh);
    return { scene, clips: [] };
  }
  const bone = (name: string) => Object.assign(new THREE.Bone(), { name });
  /** A body whose marker joint is named for it, so a test can tell which one an actor wears. */
  function body(marker: string): GltfAsset {
    const [root, mark, head] = [bone("tag_origin"), bone(marker), bone("j_head")];
    root.add(mark, head);
    return skinned([root, mark, head], [root]);
  }
  const head = (): GltfAsset => {
    const joint = bone("j_head");
    return skinned([joint], [joint]);
  };
  /** The walk turns the head a quarter turn over its cycle; the idle holds it. */
  const quarter = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2).toArray();
  const clips = [
    new THREE.AnimationClip("idle", 2, [new THREE.QuaternionKeyframeTrack("j_head.quaternion", [0, 2], [0, 0, 0, 1, 0, 0, 0, 1])]),
    new THREE.AnimationClip("walk", 1, [new THREE.QuaternionKeyframeTrack("j_head.quaternion", [0, 1], [0, 0, 0, 1, ...quarter])]),
  ];
  const SEED = 99;

  it("builds each actor the body its look names, head and all, and poses it from the wire", () => {
    const view = new ActorsView();
    view.setKits(new Map([["zombie", { assets, clips, bodies: [body("b0"), body("b1")], heads: [head()] }]]), SEED);
    const ids = [1, 2, 3, 4, 5, 6];
    view.apply(
      ids.map((id) => actor(id, -id)),
      1,
      0,
    );
    view.update(TICK_MS);
    const worn = new Set<number>();
    ids.forEach((id, i) => {
      const drawn = view.root.children[i]!;
      const look = actorLook(assets, SEED, id, "walk");
      worn.add(look.body);
      expect(drawn.getObjectByName(`b${look.body}`)).toBeDefined();
      expect(drawn.getObjectByName(`b${1 - look.body}`)).toBeUndefined();
      let meshes = 0;
      drawn.traverse((o) => (meshes += o instanceof THREE.SkinnedMesh ? 1 : 0));
      expect(meshes).toBe(2); // the body and the head
    });
    expect(worn.size).toBe(2);

    // Walking at the clip's speed, half way through its cycle: the head is an eighth of a turn round.
    view.apply([actor(1, -1, { speed: 1, phase: 0.5 })], 2, TICK_MS);
    view.update(TICK_MS * 2);
    const turned = view.root.children[0]!.getObjectByName("j_head")!.quaternion;
    expect(2 * Math.acos(Math.min(1, Math.abs(turned.w)))).toBeCloseTo(Math.PI / 4, 2);
    view.dispose();
    expect(view.root.children).toHaveLength(0);
  });

  describe("ActorRigs", () => {
    const kits = () => new Map([["zombie" as const, { assets, clips, bodies: [body("b0"), body("b1")], heads: [head()] }]]);
    /** Two ids whose looks wear the same body, and so (one head) the same rig. */
    const twins = (): [number, number] => {
      const on = (id: number) => actorLook(assets, SEED, id, "walk").body;
      const [a, b] = [2, 3, 4, 5, 6, 7, 8, 9].filter((id) => on(id) === on(1));
      return [a!, b!];
    };

    it("builds a rig per actor standing, sharing one body's clips between them", () => {
      const rigs = new ActorRigs();
      rigs.setKits(kits(), SEED);
      const [a, b] = twins();
      const first = rigs.take("zombie", a, "walk")!;
      const second = rigs.take("zombie", b, "walk")!;
      expect(second.rig.root).not.toBe(first.rig.root);
      expect(second.rig.clips.get("walk")).toBe(first.rig.clips.get("walk"));
    });

    it("hands a given-back rig to the next actor in that look, and lets it go when the kits change", () => {
      const rigs = new ActorRigs();
      rigs.setKits(kits(), SEED);
      const [a, b] = twins();
      const first = rigs.take("zombie", a, "walk")!;
      rigs.give(first);
      const next = rigs.take("zombie", b, "walk")!;
      expect(next).toBe(first);
      expect(next.look).toEqual(actorLook(assets, SEED, b, "walk"));

      const disposed: THREE.Skeleton[] = [];
      next.rig.root.traverse((o) => {
        if (o instanceof THREE.SkinnedMesh) {
          o.skeleton.dispose = () => void disposed.push(o.skeleton);
        }
      });
      rigs.give(next);
      rigs.setKits(kits(), SEED);
      expect(disposed).toHaveLength(2); // the body's skeleton and the head's
      expect(rigs.take("zombie", a, "walk")).not.toBe(first);
    });
  });

  it("draws an actor whose body did not load as its capsule", () => {
    const view = new ActorsView();
    view.setKits(new Map([["zombie", { assets, clips, bodies: [undefined, undefined], heads: [] }]]), SEED);
    view.apply([actor(1, 0)], 1, 0);
    expect(view.root.children[0]).toBeInstanceOf(THREE.Mesh);
    expect(view.root.children[0]).not.toBeInstanceOf(THREE.SkinnedMesh);
  });
});
