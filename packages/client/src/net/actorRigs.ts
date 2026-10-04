// The rigs actors are drawn as, kept between the actors that wear them.
//
// A zombie round spawns and kills a creature every second or two, and building a
// rig from nothing each time — the body cloned, the head rebound, every clip's
// tracks copied — cost milliseconds and a few megabytes of garbage per spawn,
// which the browser paid back as a stutter. So a rig is built once per look and
// handed on: a released one waits for the next actor with the same body and head,
// and every rig on one body shares one fitted copy of the clips. Both are bounded
// by the most actors that ever stood at once.
//
// A rig's geometry and materials are the AssetStore's. The mixer and each
// skeleton's bone texture are ours, and are freed when a rig is let go for good.

import * as THREE from "three";
import type { ActorGait, ActorId } from "@3d/shared/game/actors/actor.js";
import { actorLook, type ActorAssets, type ActorLook } from "@3d/shared/game/actors/assets.js";
import type { ActorKindId } from "@3d/shared/game/actors/kinds.js";
import { ActorPoser } from "@3d/shared/rig/actorPoser.js";
import { buildActorRig } from "@3d/shared/rig/actorRig.js";
import { releaseRig } from "@3d/shared/rig/release.js";
import type { CharacterRig, FittedClips } from "@3d/shared/rig/character.js";
import type { GltfAsset } from "../scene/character.js";

/** The files one kind's rigs are built from: its catalogue creature and what of it loaded. */
export interface ActorKit {
  assets: ActorAssets;
  clips: readonly THREE.AnimationClip[];
  /** Parallel to `assets.bodies`; undefined where that file did not load. */
  bodies: readonly (GltfAsset | undefined)[];
  /** Parallel to `assets.heads`; undefined where that file did not load, which leaves the body bare. */
  heads: readonly (GltfAsset | undefined)[];
}

/** One rig an actor is wearing, until it is given back. */
export interface ActorBody {
  readonly rig: CharacterRig;
  poser: ActorPoser;
  look: ActorLook;
  readonly kind: ActorKindId;
  /** Which rigs it can stand in for: its kind, body and head. */
  readonly key: string;
}

export class ActorRigs {
  private kits = new Map<ActorKindId, ActorKit>();
  /** The match seed every actor's look is drawn from, as the server draws it. */
  private seed = 0;
  /** Per kind and body: the clips the first rig on it fitted. */
  private readonly fitted = new Map<string, FittedClips>();
  /** Rigs nobody is wearing, by key. */
  private readonly free = new Map<string, ActorBody[]>();

  /** The kinds whose creatures loaded, and the seed. Every rig kept for the old ones is let go. */
  setKits(kits: Map<ActorKindId, ActorKit>, seed = 0): void {
    this.clear();
    this.kits = kits;
    this.seed = seed;
  }

  /**
   * A rig for this actor's look, kept or built: undefined for a kind with no kit
   * or a body that did not load. Throws when the kit will not build, after which
   * the kind has no kit.
   */
  take(kind: ActorKindId, id: ActorId, gait: ActorGait): ActorBody | undefined {
    const kit = this.kits.get(kind);
    if (!kit) {
      return undefined;
    }
    try {
      const look = actorLook(kit.assets, this.seed, id, gait);
      const body = kit.bodies[look.body];
      if (!body) {
        return undefined;
      }
      const key = `${kind}/${look.body}/${look.head ?? "-"}`;
      const kept = this.free.get(key)?.pop();
      if (kept) {
        kept.look = look;
        return kept;
      }
      const shared = this.fitted.get(`${kind}/${look.body}`);
      const head = look.head === undefined ? undefined : kit.heads[look.head];
      const rig = buildActorRig(`${kind} ${id}`, kit.assets, shared ?? kit.clips, body, head);
      if (!shared) {
        this.fitted.set(`${kind}/${look.body}`, rig.clips);
      }
      return { rig, poser: new ActorPoser(rig), look, kind, key };
    } catch (e) {
      this.kits.delete(kind);
      throw e;
    }
  }

  /** Done with: kept for the next actor in the same look, or let go if its kind has no kit now. */
  give(body: ActorBody): void {
    body.rig.root.removeFromParent();
    if (!this.kits.has(body.kind)) {
      release(body);
      return;
    }
    const free = this.free.get(body.key) ?? [];
    free.push(body);
    this.free.set(body.key, free);
  }

  /** Let go of every kept rig and the fitted clips: the kits are changing, or the world is. */
  clear(): void {
    for (const free of this.free.values()) {
      free.forEach(release);
    }
    this.free.clear();
    this.fitted.clear();
  }

  dispose(): void {
    this.clear();
    this.kits = new Map();
  }
}

/** A rig nobody will wear again: its mixer, and each skeleton's bone texture. */
function release(body: ActorBody): void {
  body.poser.dispose();
  releaseRig(body.rig.root);
}
