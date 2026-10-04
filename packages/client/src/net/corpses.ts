// The bodies on the floor.
//
// Owns its own root added straight to the scene, beside `remotePlayers.ts` and
// `engine/fx/system.ts` and for the same reason: it outlives any one world and it
// drives its own matrices. Against CLAUDE.md's list of things that do not move in a
// built world, one at a time, because getting this wrong is invisible until it is
// not:
//
//  1. `scene.matrixWorldAutoUpdate = false` — **opted out of**: `step` calls
//     `updateMatrixWorld` on each corpse itself, and only while one is awake.
//  2. `matrixAutoUpdate = false` per node — **does not apply, and must not be
//     applied.** `WorldSession`'s freeze traverses the built world's root; a corpse
//     rig came from `CharacterKit.build` and was never under it. There is nothing
//     to undo here, which is worth saying because `engine/animator.ts` *does* undo
//     it and the reflex is to copy that.
//  3. `shadowMap.autoUpdate = false` — nothing to do: every mesh of a character rig
//     is already `castShadow = false` (`rig/character.ts`), because a body that
//     moves while the shadow map does not would leave its shadow where it stood.
//  4. Skinning baked out at load — a corpse comes from `CharacterKit.build`, which
//     uses the **unbaked** rig the `AssetStore` keeps beside the baked one. True by
//     construction, and written down so that nobody later "optimises" a corpse into
//     a fresh load from the baked asset and gets a body frozen in its bind pose.
//  5. Instancing skips skinned meshes — a corpse is skinned and is never instanced.
//     Eight identical corpses look like an `InstancedMesh` and are not one.
//  6. The collision BVH built once per load — a corpse is never in it. Its collision
//     is the physics world's and only the physics world's, which is the sentence
//     that keeps the two systems from overlapping.
//
// A corpse is drawn at whatever the last step left, with no interpolation between
// steps. Deliberate: it moves for about a second and is still forever after, so the
// second state buffer `RemotePlayers` keeps would be paid on every body for the
// benefit of one second of one of them.

import * as THREE from "three";
import type { PhysicsWorld } from "@3d/shared/physics/world.js";
import type { RagdollShape } from "@3d/shared/physics/ragdoll.js";
import type { SpawnEvent } from "@3d/shared/net/messages/events.js";
import type { CharacterRig } from "@3d/shared/rig/character.js";
import { readHitboxes } from "@3d/shared/rig/hitboxes.js";
import { releaseRig } from "@3d/shared/rig/release.js";
import { hitboxUrl, type SidecarSource } from "../engine/hitboxView.js";
import type { RemotePlayers } from "./remotePlayers.js";

/**
 * The ragdoll half of `@3d/shared/physics`, handed in rather than imported.
 *
 * **Nothing in the client may import that subtree for its value**, and this is the
 * seam that keeps it honest: the engine inlines its wasm as base64, so one ordinary
 * `import` anywhere in the static graph puts 2.9 MB of JavaScript into the bundle a
 * menu is drawn from — which is exactly what it did, until the build was looked at.
 * `WorldSession`'s `"physics"` step is the one dynamic import, and what it loads
 * arrives here. `eslint.config.js` holds the rest of the client to it.
 *
 * `import type` is erased, so the types above cost nothing.
 */
export type RagdollApi = typeof import("@3d/shared/physics/ragdoll.js");

/**
 * One death's body, out of the living and onto the floor. Where `corpses` will not
 * take it (no physics, or its hit boxes have not arrived) nothing may hold it, so it
 * is released here and the player handed back: out of both is a player invisible
 * until they respawn, and the next snapshot draws them standing instead.
 */
export function dropBody(remotes: RemotePlayers, corpses: Corpses, event: SpawnEvent): void {
  const rig = remotes.handOver(event.ragdoll.victim);
  if (rig && !corpses.spawn(rig, event)) {
    releaseRig(rig.root);
    remotes.takeBack(event.ragdoll.victim);
  }
}

interface Corpse {
  id: number;
  rig: CharacterRig;
  shape: RagdollShape;
}

export class Corpses {
  readonly root = new THREE.Group();

  private physics: PhysicsWorld | undefined;
  private ragdoll: RagdollApi | undefined;
  private sidecars: SidecarSource | undefined;
  private readonly corpses = new Map<number, Corpse>();
  /**
   * A body's ragdoll shape by its sidecar URL: `null` where the boxes could not be
   * read, absent while they are in flight.
   *
   * Per body rather than per corpse, because a shape depends only on the GLB and
   * its hit boxes — the same split `ragdollShape` is built around, and the reason
   * eight corpses of one body measure it once.
   */
  private readonly shapes = new Map<string, RagdollShape | null>();
  private readonly pending = new Set<string>();
  /**
   * The world every corpse is simulated in, and the module that builds one.
   *
   * Both or neither: the api is the dynamically-loaded half of the engine, so
   * holding a world without it would be holding something nothing can put a body
   * into. Undefined for both is a world with no physics, which plays exactly as it
   * did before there was any.
   */
  setWorld(physics: PhysicsWorld | undefined, ragdoll?: RagdollApi): void {
    this.clear();
    this.physics = physics;
    this.ragdoll = physics ? ragdoll : undefined;
  }

  /** Where the hit boxes a corpse is made of are read from. The same route the debug view uses. */
  setSidecars(sidecars: SidecarSource | undefined): void {
    this.sidecars = sidecars;
  }

  get count(): number {
    return this.corpses.size;
  }

  /**
   * Somebody fell over, and **the server said exactly how**.
   *
   * The pose comes off the wire rather than off the rig in hand, and that is the
   * whole of why corpses agree between clients. Two machines posing the same
   * skeleton from the same snapshot land within a nanometre of each other
   * (docs/engine/rendering.md#player-characters) — ample for a hit box, and not
   * remotely enough for sixteen jointed boxes in contact, where a nanometre is a
   * different pile of bodies a second later. So the initial conditions are sent,
   * quantised, and every end simulates the value it decoded.
   *
   * `event.rotations` are world-space; the positions are not sent at all, because
   * the skeleton's own bind offsets give them — multiplies and adds, with no
   * transcendental anywhere, so every machine derives the same ones.
   *
   * Returns false where it could not be done — no physics, or the body's hit boxes
   * have not arrived yet — and the caller is expected to put the body back rather
   * than lose it.
   */
  spawn(rig: CharacterRig, event: SpawnEvent): boolean {
    const api = this.ragdoll;
    const shape = api ? this.shapeFor(rig, api) : undefined;
    if (!this.physics || !api || !shape || this.corpses.has(event.entity)) {
      return false;
    }

    // The pose the server sent, walked out along this body's own skeleton. Every
    // segment's rotation is given; its position is its parent's plus the rest
    // offset between them, turned into the parent's new frame.
    const pose = api.poseFromSpawn(shape, event.ragdoll);
    const id = event.entity;
    const spawn = event.ragdoll;
    this.physics.spawn(id, event.what, event.tick, (world) => {
      const ragdoll = api.buildRagdoll(world, shape, pose);
      // Momentum, knock and the round's snap, in the one order that works —
      // `startRagdoll` owns all three so that nothing here can get it subtly wrong.
      api.startRagdoll(ragdoll, shape, spawn);
      return ragdoll;
    });
    this.corpses.set(id, { id, rig, shape });
    this.root.add(rig.root);
    return true;
  }

  /**
   * One server tick.
   *
   * The count of steps is `tick`, not a frame's worth of time — see
   * `PhysicsWorld.step`, and the note there about never driving this from the
   * render loop's accumulator, which gives up under load in a way that is right for
   * a player and permanent for a corpse.
   */
  step(tick: number): void {
    if (!this.physics) {
      return;
    }
    this.physics.step(tick);

    for (const [id, corpse] of this.corpses) {
      const entity = this.physics.entity(id);
      if (!entity) {
        // Retired by its lifetime or pushed out by a newer one — both derived
        // inside the world, on rules every end computes the same way.
        releaseRig(corpse.rig.root);
        this.corpses.delete(id);
        continue;
      }
      this.ragdoll?.poseRagdoll(corpse.rig, corpse.shape, entity);
    }
  }

  /** Every corpse goes: a world change, a hot reload, the connection going away. */
  clear(): void {
    for (const corpse of this.corpses.values()) {
      this.physics?.despawn(corpse.id);
      releaseRig(corpse.rig.root);
    }
    this.corpses.clear();
  }

  dispose(): void {
    this.clear();
    this.physics = undefined;
    this.ragdoll = undefined;
    this.shapes.clear();
    this.pending.clear();
  }

  /**
   * This body's shape, measuring it the first time it is asked for.
   *
   * The sidecar is fetched rather than shipped: the ordinary client has never
   * needed `.hitboxes.json` — only the debug view did — so this is the first thing
   * that makes a body's boxes part of playing rather than of looking. It is a
   * couple of kilobytes per body over the same public catalogue route, and the
   * first corpse of a body is the one that pays for it.
   */
  private shapeFor(rig: CharacterRig, api: RagdollApi): RagdollShape | undefined {
    const url = hitboxUrl(rig);
    const known = this.shapes.get(url);
    if (known !== undefined) {
      return known ?? undefined;
    }
    if (this.sidecars && !this.pending.has(url)) {
      this.pending.add(url);
      void this.sidecars
        .json(url)
        .then((raw) => {
          this.shapes.set(url, api.ragdollShape(rig, readHitboxes(raw)));
        })
        .catch((error: unknown) => {
          // Cached as a failure so it is asked for once. A body with no boxes is a
          // body that cannot fall over, which is a blemish and not a fault.
          console.warn(`[corpses] ${url}: ${error instanceof Error ? error.message : String(error)}`);
          this.shapes.set(url, null);
        })
        .finally(() => this.pending.delete(url));
    }
    return undefined;
  }
}
