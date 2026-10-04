// The real zombie — `t5/zombie_ger` and its `zombie` clip set — through the code
// both ends run: `actorAssetsFor` over the catalogue the api serves, every body
// with every head rebound onto it (`buildActorRig`, as the client builds one per
// actor), each gait, the swing and the fall posed (`ActorPoser`), and the boxes
// `Bodies` binds for the server traced where a head and a chest are.
//
// Over a real api on the repo's own `worlds/`, like bodies.test.ts, and skipped
// where no actor catalogue has been built (it is gitignored and needs game files).

import "reflect-metadata";
import "../src/gltfGlobals.js";

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { describe, expect, it, vi } from "vitest";
import { testApp } from "@3d/api/testing/app.js";
import { ACTOR_GAITS, type ActorAction, type ActorGait } from "@3d/shared/game/actors/actor.js";
import { actorAssetsFor, gaitRole, type ActorAssets, type ActorClip } from "@3d/shared/game/actors/assets.js";
import { TRANSIT_ZOMBIE_KIND, ZOMBIE_KIND, type ActorBodyRef } from "@3d/shared/game/actors/kinds.js";
import type { CatalogRef } from "@3d/shared/game/cast.js";
import { catalogueViewOf, type CatalogueView } from "@3d/shared/game/catalogueView.js";
import { createApiClient, type ApiClient } from "@3d/shared/protocol/api.js";
import type { HttpFetch } from "@3d/shared/protocol/http.js";
import { ActorPoser } from "@3d/shared/rig/actorPoser.js";
import { buildActorRig } from "@3d/shared/rig/actorRig.js";
import type { CharacterRig, GltfAsset } from "@3d/shared/rig/character.js";
import { BoundHitboxes, readHitboxes } from "@3d/shared/rig/hitboxes.js";
import type { CreatureRole } from "@3d/shared/sim/characterDef.js";
import { WeaponRegistry } from "@3d/shared/sim/weaponRegistry.js";
import type { Api } from "../src/api.js";
import { Bodies } from "../src/bodies.js";
import type { Weapons } from "../src/weapons.js";

interface Real {
  client: ApiClient;
  catalogue: CatalogueView;
  assets: ActorAssets;
}

/** The catalogue this checkout serves, narrowed to its actors, or null where it holds no such creature. */
async function realZombie(ref: ActorBodyRef = ZOMBIE_KIND.body!): Promise<Real | null> {
  const { app } = testApp();
  const client = createApiClient({ fetch: app.request.bind(app) as HttpFetch });
  const index = (await client.catalogIndex()) as { version: number; actors?: unknown[]; animations?: unknown[] };
  // Actors and clip sets only: `Bodies.load` then builds no player bodies, which is a minute of GLBs this does not need.
  const catalogue = catalogueViewOf({ version: index.version, actors: index.actors, animations: index.animations }, new WeaponRegistry([]));
  const assets = actorAssetsFor(ref, catalogue);
  return assets ? { client, catalogue, assets } : null;
}

const loader = new GLTFLoader();

async function gltf(client: ApiClient, ref: CatalogRef): Promise<GltfAsset> {
  const bytes = await client.catalogFile({ kind: ref.kind, game: ref.game, id: ref.id, rest: ref.file });
  const parsed = await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, "");
  return { scene: parsed.scene, clips: parsed.animations };
}

/** Every bone's local rotation, flattened: what one pose is, to compare with another. */
function pose(rig: CharacterRig): number[] {
  const out: number[] = [];
  rig.root.traverse((o) => {
    if (o instanceof THREE.Bone) {
      out.push(...o.quaternion.toArray(), ...o.position.toArray());
    }
  });
  return out;
}

const apart = (a: number[], b: number[]) => Math.max(...a.map((v, i) => Math.abs(v - b[i]!)));

/** One action in one clip, as the wire would carry it. */
function state(action: ActorAction, gait: ActorGait, clip: ActorClip, phase: number, traversal = 0) {
  return { action, gait, speed: action === "move" ? clip.speed : 0, phase, traversal };
}

describe("the real zombie", () => {
  it("builds every body with every head, and poses each gait, the swing and the fall", async () => {
    const real = await realZombie();
    if (!real) {
      return; // no actor catalogue built in this checkout
    }
    const { client, assets } = real;
    const [clips, bodies, heads] = await Promise.all([
      gltf(client, assets.clips),
      Promise.all(assets.bodies.map((ref) => gltf(client, ref))),
      Promise.all(assets.heads.map((ref) => gltf(client, ref))),
    ]);
    expect(bodies).toHaveLength(2);
    expect(heads).toHaveLength(4);

    const idle = assets.roles.idle![0]!;
    const played: Record<string, number> = {};
    for (const [b, body] of bodies.entries()) {
      for (const [h, head] of heads.entries()) {
        // Throws on a head joint the body lacks: the graft's promise, checked.
        const rig = buildActorRig(`zombie ${b}/${h}`, assets, clips.clips, body, head);
        const poser = new ActorPoser(rig);
        poser.update(state("idle", "walk", idle, 0.5), { clips: { idle }, traversals: [] }, 0);
        const standing = pose(rig);
        const swings = [...new Set([...assets.swings.walk, ...assets.swings.run])];
        for (const [role, action] of [
          ["walk", "move"],
          ["run", "move"],
          ["sprint", "move"],
          ["attack", "attack"],
          ["die", "die"],
        ] as [CreatureRole, ActorAction][]) {
          const gait: ActorGait = ACTOR_GAITS.includes(role as ActorGait) ? (role as ActorGait) : "walk";
          for (const clip of role === "attack" ? swings : assets.roles[role]!) {
            // Every variant is in the rig, and moves the body away from the idle.
            expect(rig.clips.has(clip.name), clip.name).toBe(true);
            poser.update(state(action, gait, clip, 0.5), { clips: { idle, [role]: clip }, traversals: [] }, 0);
            expect(apart(pose(rig), standing), `${clip.name} on body ${b} head ${h}`).toBeGreaterThan(0.01);
            played[clip.name] = rig.clips.get(clip.name)!.tracks.length;
          }
        }
        // Every jump down too, named on the wire by its place in the set's list.
        for (const [i, jump] of assets.traversals.entries()) {
          expect(rig.clips.has(jump.name), jump.name).toBe(true);
          poser.update(state("traverse", "walk", idle, 0.5, i + 1), { clips: { idle }, traversals: assets.traversals }, 0);
          expect(apart(pose(rig), standing), `${jump.name} on body ${b} head ${h}`).toBeGreaterThan(0.01);
        }
        poser.dispose();
      }
    }
    expect(Object.keys(played).length).toBeGreaterThan(20);
  }, 60_000);

  it("moves each gait at its clips' root-motion speeds", async () => {
    const real = await realZombie();
    if (!real) {
      return;
    }
    const speeds = (gait: ActorGait) => real.assets.roles[gaitRole(gait, (r) => real.assets.roles[r] !== undefined)!]!.map((c) => c.speed);
    // The bands the game's own clips fall in (docs/cod/reference.md#ai-bodies-black-ops-zombies).
    for (const [gait, low, high] of [
      ["walk", 0.5, 1.3],
      ["run", 1.6, 2.8],
      ["sprint", 3.5, 3.7],
    ] as const) {
      for (const speed of speeds(gait)) {
        expect(speed, gait).toBeGreaterThanOrEqual(low);
        expect(speed, gait).toBeLessThanOrEqual(high);
      }
    }
    // Every swing a walker or a runner draws lands at least once, inside the clip.
    const { walk, run } = real.assets.swings;
    expect(walk.length).toBeGreaterThan(real.assets.roles.attack!.length);
    expect(run.length).toBeGreaterThan(real.assets.roles.attack!.length);
    for (const clip of [...walk, ...run]) {
      expect(clip.hits.length, clip.name).toBeGreaterThan(0);
      expect(Math.max(...clip.hits), clip.name).toBeLessThan(clip.duration);
    }
  });

  it("drops each of theater's jump downs in the game's own clip, falling as far as the clip does", async () => {
    const real = await realZombie();
    if (!real) {
      return;
    }
    const byScript = new Map(real.assets.traversals.map((t) => [t.animscript, t]));
    for (const height of [40, 72, 120, 127, 190, 240, 286]) {
      const jump = byScript.get(`zombie_jump_down_${height}`);
      expect(jump, `zombie_jump_down_${height}`).toBeDefined();
      // Its name is the height it drops in inches, and its path drops about that far.
      const drop = -jump!.path.at(-1)![3];
      expect(drop).toBeGreaterThan(height * 0.0254 * 0.8);
      expect(drop).toBeLessThan(height * 0.0254 * 1.2);
    }
  });

  it("is shot in the head, the chest and the legs through the boxes the server binds", async () => {
    const real = await realZombie();
    if (!real) {
      return;
    }
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bodies = new Bodies({ client: real.client } as unknown as Api, { catalogue: real.catalogue } as unknown as Weapons);
    await bodies.load();
    warn.mockRestore();
    const loaded = bodies.actor("zombie");
    expect(loaded?.bodies).toHaveLength(2);

    const sidecar = readHitboxes(
      JSON.parse(new TextDecoder().decode(await real.client.catalogFile({ kind: "actors", game: "t5", id: "zombie_ger", rest: real.assets.entry.hitboxes }))),
    );
    const idle = real.assets.roles.idle![0]!;
    for (const { rig, poser, boxes } of loaded!.bodies) {
      expect(boxes.size).toBe(sidecar.length);
      expect(new BoundHitboxes(rig, sidecar).size).toBe(sidecar.length);
      rig.root.position.set(0, 0, 0);
      rig.root.rotation.set(0, 0, 0);
      poser.update(state("idle", "walk", idle, 0), { clips: { idle }, traversals: [] }, 0);
      rig.root.updateMatrixWorld(true);
      // A box's middle, in the world: its bone's joint is at one end of it (a head's at the neck).
      const at = (bone: string) => {
        const box = sidecar.find((b) => b.bone === bone)!;
        const middle = new THREE.Vector3((box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2, (box.min.z + box.max.z) / 2);
        return rig.root.getObjectByName(bone)!.localToWorld(middle);
      };
      const head = at("j_head");
      const chest = at("j_spine4");
      const knee = at("j_knee_le");
      expect(head.y).toBeGreaterThan(1.4);
      expect(head.y).toBeLessThan(2);
      expect(knee.y).toBeLessThan(0.6);
      // Level rays along X, which a CoD rig faces: the head, the chest and a shin in turn.
      const across = (p: THREE.Vector3) => boxes.trace({ x: p.x - 3, y: p.y, z: p.z }, { x: p.x + 3, y: p.y, z: p.z })?.location;
      const side = (p: THREE.Vector3) => boxes.trace({ x: p.x, y: p.y, z: p.z - 3 }, { x: p.x, y: p.y, z: p.z + 3 })?.location;
      expect(across(head)).toBe("head");
      expect(across(chest)).toBe("torsoUpper");
      expect(side(knee)).toMatch(/Leg/);
    }
  }, 60_000);
});

// Black Ops II's TranZit walkers (`t6/zm_transit_basic`, `python3 -m scripts.cod actors
// --game bo2`): ten bodies, four heads, and a clip set read out of the game's own
// animation state machine, as `TRANSIT_ZOMBIE_KIND` names them.
const TRANSIT: ActorBodyRef = TRANSIT_ZOMBIE_KIND.body!;

describe("Black Ops II's zombie", () => {
  it("builds every body and every head, and poses each gait, the swing, the fall and the traversals", async () => {
    const real = await realZombie(TRANSIT);
    if (!real) {
      return; // no BO2 actor built in this checkout
    }
    const { client, assets } = real;
    const [clips, bodies, heads] = await Promise.all([
      gltf(client, assets.clips),
      Promise.all(assets.bodies.map((ref) => gltf(client, ref))),
      Promise.all(assets.heads.map((ref) => gltf(client, ref))),
    ]);
    expect(bodies).toHaveLength(10);
    expect(heads).toHaveLength(4);
    const idle = assets.roles.idle![0]!;
    // Every body with the first head, and the first body with every head: forty rigs would say nothing more.
    const pairs: [number, number][] = [...bodies.map((_, b): [number, number] => [b, 0]), ...heads.slice(1).map((_, h): [number, number] => [0, h + 1])];
    for (const [b, h] of pairs) {
      const rig = buildActorRig(`zombie ${b}/${h}`, assets, clips.clips, bodies[b]!, heads[h]!);
      const poser = new ActorPoser(rig);
      poser.update(state("idle", "walk", idle, 0.5), { clips: { idle }, traversals: [] }, 0);
      const standing = pose(rig);
      const swings = [...new Set([...assets.swings.walk, ...assets.swings.run])];
      for (const [role, action] of [
        ["walk", "move"],
        ["run", "move"],
        ["sprint", "move"],
        ["climb", "traverse"],
        ["attack", "attack"],
        ["die", "die"],
      ] as [CreatureRole, ActorAction][]) {
        const gait: ActorGait = ACTOR_GAITS.includes(role as ActorGait) ? (role as ActorGait) : "walk";
        for (const clip of role === "attack" ? swings : assets.roles[role]!) {
          expect(rig.clips.has(clip.name), clip.name).toBe(true);
          poser.update(state(action, gait, clip, 0.5), { clips: { idle, [role]: clip }, traversals: [] }, 0);
          expect(apart(pose(rig), standing), `${clip.name} on body ${b} head ${h}`).toBeGreaterThan(0.01);
        }
      }
      for (const [i, jump] of assets.traversals.entries()) {
        poser.update(state("traverse", "walk", idle, 0.5, i + 1), { clips: { idle }, traversals: assets.traversals }, 0);
        expect(apart(pose(rig), standing), `${jump.name} on body ${b} head ${h}`).toBeGreaterThan(0.01);
      }
      poser.dispose();
    }
  }, 120_000);

  it("walks, runs and sprints at its clips' speeds, and every swing lands", async () => {
    const real = await realZombie(TRANSIT);
    if (!real) {
      return;
    }
    const { roles, swings } = real.assets;
    // BO1's clips, shipped again: the same bands (docs/cod/reference.md#ai-bodies-black-ops-zombies).
    for (const [role, low, high] of [
      ["walk", 0.5, 1.3],
      ["run", 1.6, 2.8],
      ["sprint", 3.5, 3.7],
    ] as const) {
      for (const clip of roles[role]!) {
        expect(clip.speed, clip.name).toBeGreaterThanOrEqual(low);
        expect(clip.speed, clip.name).toBeLessThanOrEqual(high);
      }
    }
    expect(roles.walk).toHaveLength(8); // v9 twice: a repeat is a weight
    for (const clip of [...swings.walk, ...swings.run]) {
      expect(clip.hits.length, clip.name).toBeGreaterThan(0);
      expect(Math.max(...clip.hits), clip.name).toBeLessThan(clip.duration);
    }
  });

  it("crosses each of TranZit's drops in its own clip, falling as far as the name says", async () => {
    const real = await realZombie(TRANSIT);
    if (!real) {
      return;
    }
    const byScript = new Map(real.assets.traversals.map((t) => [t.animscript, t]));
    for (const height of [48, 96, 127, 190, 222]) {
      const jump = byScript.get(`zm_jump_down_${height}`);
      expect(jump, `zm_jump_down_${height}`).toBeDefined();
      const drop = -jump!.path.at(-1)![3];
      expect(drop).toBeGreaterThan(height * 0.0254 * 0.95);
      expect(drop).toBeLessThan(height * 0.0254 * 1.05);
    }
    // The window climb is a role, as BO1's: not a traversal clip.
    expect(byScript.has("zm_mantle_over_40")).toBe(false);
    expect(real.assets.roles.climb!.length).toBe(2);
  });

  it("is shot in the head, the chest and the legs through its boxes", async () => {
    const real = await realZombie(TRANSIT);
    if (!real) {
      return;
    }
    const { client, assets } = real;
    const [clips, body] = await Promise.all([gltf(client, assets.clips), gltf(client, assets.bodies[0]!)]);
    const sidecar = readHitboxes(
      JSON.parse(new TextDecoder().decode(await client.catalogFile({ kind: "actors", game: TRANSIT.game, id: TRANSIT.id, rest: assets.entry.hitboxes }))),
    );
    const rig = buildActorRig("zombie", assets, clips.clips, body, undefined);
    const boxes = new BoundHitboxes(rig, sidecar);
    expect(boxes.size).toBe(sidecar.length);
    const idle = assets.roles.idle![0]!;
    const poser = new ActorPoser(rig);
    poser.update(state("idle", "walk", idle, 0), { clips: { idle }, traversals: [] }, 0);
    rig.root.updateMatrixWorld(true);
    const at = (bone: string) => {
      const box = sidecar.find((b) => b.bone === bone)!;
      const middle = new THREE.Vector3((box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2, (box.min.z + box.max.z) / 2);
      return rig.root.getObjectByName(bone)!.localToWorld(middle);
    };
    const head = at("j_head");
    const knee = at("j_knee_le");
    expect(head.y).toBeGreaterThan(1.4);
    expect(head.y).toBeLessThan(2);
    expect(knee.y).toBeLessThan(0.6);
    // From in front, as a player facing it shoots: a hunched walker's upper back rises behind its head.
    const front = (p: THREE.Vector3) => boxes.trace({ x: p.x + 3, y: p.y, z: p.z }, { x: p.x - 3, y: p.y, z: p.z })?.location;
    const side = (p: THREE.Vector3) => boxes.trace({ x: p.x, y: p.y, z: p.z - 3 }, { x: p.x, y: p.y, z: p.z + 3 })?.location;
    expect(front(head)).toBe("head");
    expect(side(head)).toBe("head");
    expect(front(at("j_spine4"))).toBe("torsoUpper");
    expect(side(knee)).toMatch(/Leg/);
    poser.dispose();
  });
});
