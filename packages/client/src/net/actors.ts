// The actors: the creatures a game server runs that are not players.
//
// Drawn the way peers are (remotePlayers.ts): two snapshots kept, the body drawn
// one tick behind the newer, membership following the snapshot — an id that
// appears is a spawn and one that stops appearing is gone. Nothing here predicts
// an actor; the server is the only one that moves them.
//
// A kind whose creature the session loaded (`setKits`) is a rig per actor — the
// body, head and clips `actorLook` draws for its id, as the server draws them —
// posed by `ActorPoser` from the action and phase the wire carries, which is the
// pose the server traced its shots against. A kind with none, or one still
// loading, is drawn as its capsule at its own radius and height.
//
// **Beside the scene, not in it**, for the reason CLAUDE.md gives corpses: a built
// world's matrices are frozen and its shadow map is not redrawn, so this owns a
// root of its own, updates its own matrices, and nothing here casts a shadow.
//
// The rigs come from `ActorRigs` (actorRigs.ts): built once per look, and handed
// on from an actor that is gone to the next one wearing the same body and head.

import * as THREE from "three";
import type { ActorId, ActorState } from "@3d/shared/game/actors/actor.js";
import { ACTOR_KINDS, type ActorKindDef, type ActorKindId } from "@3d/shared/game/actors/kinds.js";
import { TICK_RATE } from "@3d/shared/net/messages/fields.js";
import { MODEL_FACING } from "../scene/character.js";
import { ActorRigs, type ActorBody, type ActorKit } from "./actorRigs.js";

export type { ActorKit } from "./actorRigs.js";

/** One tick behind the newer snapshot, as peers are drawn (see `RemotePlayers`' INTERPOLATION_TICKS). */
const INTERPOLATION_TICKS = 1;

interface Sample {
  at: number;
  tick: number;
  state: ActorState;
}

interface Drawn {
  id: ActorId;
  kind: ActorKindDef;
  object: THREE.Object3D;
  /** The rig it wears, or none when it is drawn as its kind's capsule. */
  body?: ActorBody;
  from: Sample;
  to: Sample;
}

export class ActorsView {
  readonly root = new THREE.Group();
  private readonly actors = new Map<number, Drawn>();
  private readonly capsules = new Map<ActorKindId, THREE.CapsuleGeometry>();
  private readonly material: THREE.Material;
  private readonly rigs = new ActorRigs();
  private snapshotInterval = 1000 / TICK_RATE;
  private lastFrame = 0;
  private drawnAt: { tick: number; frac: number } | undefined;

  constructor() {
    this.root.name = "actors";
    // Unlit, for the reason a peer's placeholder capsule is: a lightmapped map
    // barely lights a dynamic object, and a placeholder must be visible.
    this.material = new THREE.MeshBasicMaterial({ color: 0x6fbf3a });
  }

  /**
   * The kinds whose creatures loaded, and the match seed looks are drawn from.
   * Anyone standing is rebuilt, so this may follow a hot reload.
   */
  setKits(kits: Map<ActorKindId, ActorKit>, seed = 0): void {
    for (const drawn of this.actors.values()) {
      this.release(drawn);
    }
    this.rigs.setKits(kits, seed);
    for (const drawn of this.actors.values()) {
      Object.assign(drawn, this.build(drawn.kind, drawn.to.state));
      this.root.add(drawn.object);
    }
  }

  setTickRate(hz: number): void {
    if (hz > 0 && Number.isFinite(hz)) {
      this.snapshotInterval = 1000 / hz;
    }
  }

  /** One snapshot's actors. Membership is the snapshot's. */
  apply(actors: readonly ActorState[], tick: number, now: number): void {
    for (const state of actors) {
      const sample: Sample = { at: now, tick, state };
      const drawn = this.actors.get(state.id);
      if (drawn) {
        drawn.from = drawn.to;
        drawn.to = sample;
        continue;
      }
      const kind = ACTOR_KINDS[state.kind];
      if (!kind) {
        continue; // a kind this build does not have: the protocol version should have refused us
      }
      const built = this.build(kind, state);
      this.root.add(built.object);
      this.actors.set(state.id, { id: state.id, kind, ...built, from: sample, to: sample });
    }
    if (actors.length !== this.actors.size) {
      const present = new Set(actors.map((a) => a.id));
      for (const [id, drawn] of this.actors) {
        if (!present.has(id)) {
          this.release(drawn);
          this.actors.delete(id);
        }
      }
    }
  }

  /** Draw between the last two samples. Every frame. */
  update(now: number): void {
    const dt = this.lastFrame ? Math.min((now - this.lastFrame) / 1000, 0.1) : 0;
    this.lastFrame = now;
    this.drawnAt = undefined;
    if (this.actors.size === 0) {
      return;
    }
    const at = now - this.snapshotInterval * INTERPOLATION_TICKS;
    for (const drawn of this.actors.values()) {
      const { from, to, object, kind } = drawn;
      const span = to.at - from.at;
      const t = span > 0 ? Math.min(Math.max((at - from.at) / span, 0), 1) : 1;
      if (this.drawnAt === undefined) {
        const exact = from.tick + t * (to.tick - from.tick);
        const whole = Math.floor(exact);
        this.drawnAt = { tick: whole, frac: exact - whole };
      }
      const a = from.state.feet;
      const b = to.state.feet;
      const x = a.x + (b.x - a.x) * t;
      const y = a.y + (b.y - a.y) * t;
      const z = a.z + (b.z - a.z) * t;
      const turn = Math.atan2(Math.sin(to.state.yaw - from.state.yaw), Math.cos(to.state.yaw - from.state.yaw));
      const yaw = from.state.yaw + turn * t;
      if (drawn.body) {
        object.position.set(x, y, z);
        object.rotation.set(0, yaw + MODEL_FACING, 0);
        drawn.body.poser.update(to.state, drawn.body.look, dt);
      } else if (to.state.dead) {
        // A capsule has no death to play: it lies down where it fell.
        object.position.set(x, y + kind.radius, z);
        object.rotation.set(0, yaw, Math.PI / 2, "YXZ");
      } else {
        object.position.set(x, y + kind.height / 2, z);
        object.rotation.set(0, yaw, 0);
      }
    }
    this.root.updateMatrixWorld(true);
  }

  /** The server tick, and the fraction past it, the last frame drew actors at: what a shot fired now was aimed at. */
  renderTick(): { tick: number; frac: number } | undefined {
    return this.drawnAt;
  }

  get size(): number {
    return this.actors.size;
  }

  clear(): void {
    for (const drawn of this.actors.values()) {
      this.release(drawn);
    }
    this.actors.clear();
    this.rigs.clear();
    this.drawnAt = undefined;
  }

  dispose(): void {
    this.clear();
    this.rigs.dispose();
    for (const geometry of this.capsules.values()) {
      geometry.dispose();
    }
    this.capsules.clear();
    this.material.dispose();
  }

  /** A rig where the kind's creature loaded and this actor's body builds, else its capsule. */
  private build(kind: ActorKindDef, { id, gait }: Pick<ActorState, "id" | "gait">): { object: THREE.Object3D; body?: ActorBody } {
    try {
      const body = this.rigs.take(kind.id, id, gait);
      if (body) {
        return { object: body.rig.root, body };
      }
    } catch (e) {
      // Said once: a kit that will not build is dropped, and the rest of its kind are capsules.
      console.warn(`[actors] ${kind.id}: ${e instanceof Error ? e.message : String(e)}; drawn as its capsule`);
    }
    let geometry = this.capsules.get(kind.id);
    if (!geometry) {
      geometry = new THREE.CapsuleGeometry(kind.radius, kind.height - 2 * kind.radius, 4, 12);
      this.capsules.set(kind.id, geometry);
    }
    const mesh = new THREE.Mesh(geometry, this.material);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    return { object: mesh };
  }

  /** Out of the scene, its rig given back for the next actor in the same look. */
  private release(drawn: Drawn): void {
    this.root.remove(drawn.object);
    if (drawn.body) {
      this.rigs.give(drawn.body);
      drawn.body = undefined;
    }
  }
}
