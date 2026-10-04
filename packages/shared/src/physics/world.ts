// One physics world, and everything in it.
//
// The whole of replication rests on three things being identical on every machine
// — the initial conditions, the order of construction, and the number of steps —
// and this file owns the last two. The first is the wire's.
//
//  - **Order.** Rapier promises the same answer given the same order of body,
//    collider and joint construction. So the map goes in first, then entities in
//    ascending spawn id; a spawn that arrives on the same tick as another is
//    buffered and sorted rather than inserted as it was read, because two players
//    dying on one tick is exactly the case where arrival order differs between a
//    server iterating its roster and a client reading a packet.
//  - **Steps.** `step(tick)` advances to a tick rather than by a frame, and an
//    entity's age is `tick - spawnTick`. A client that missed snapshots catches up
//    by stepping the difference; a client with a frame hitch does not silently drop
//    one. **This must never be driven by a render loop's accumulator** — the one in
//    `client/engine/controls/firstPerson.ts` gives up and zeroes itself under load,
//    which is right for a player the next snapshot corrects and permanent for
//    anything here.
//
// Removal is derived rather than sent: an entity dies at `spawnTick + lifetime`,
// and the oldest goes when a kind is over its `maxLive`. Both ends compute the same
// answer from data both ends already hold, so nothing crosses the wire to end one.

import RAPIER from "@dimforge/rapier3d-deterministic-compat";
import type { CollisionWorld } from "../collision/world.js";
import { ENTITY_POLICY, type EntityKindId } from "../sim/entityKinds.js";
import type { Vec3 } from "../sim/hit.js";
import { createPhysicsWorld } from "./engine.js";
import { buildPart, buildTerrain, type TerrainSet, type TerrainStats } from "./terrain.js";
import type { Presence } from "../worlds/presence.js";

/** What a builder hands back: the rigid bodies and joints one entity is made of. */
export interface EntityParts {
  bodies: readonly RAPIER.RigidBody[];
  joints: readonly RAPIER.ImpulseJoint[];
}

/** One thing in the world, and when it arrived. */
export interface Entity extends EntityParts {
  /** Unique for the life of a match. The wire's `spawn`, `despawn` and corrections name this. */
  readonly id: number;
  readonly kind: EntityKindId;
  readonly spawnTick: number;
}

/** A spawn waiting for its tick, or waiting to be sorted against its siblings. */
interface Pending {
  id: number;
  kind: EntityKindId;
  tick: number;
  build: (world: RAPIER.World) => EntityParts;
}

export class PhysicsWorld {
  private readonly world: RAPIER.World;
  private readonly live = new Map<number, Entity>();
  private pending: Pending[] = [];
  private tick = 0;
  private terrain: TerrainStats | undefined;
  /** The collision the terrain came from and which of its sets: what a part coming back is built from. */
  private source: { collision: CollisionWorld; set: TerrainSet | undefined } | undefined;
  /** Each removable part's colliders while it is present, by solid index. */
  private readonly parts = new Map<number, RAPIER.Collider[]>();

  constructor(private readonly tickRate: number) {
    this.world = createPhysicsWorld(1 / tickRate);
  }

  /** What the map cost. Undefined until `loadTerrain`; the number worth logging at boot. */
  get terrainStats(): TerrainStats | undefined {
    return this.terrain;
  }

  /** How many entities are live. `/healthz` reports it, and a test asserts on it. */
  get count(): number {
    return this.live.size;
  }

  /** The tick this world has been stepped to. */
  get at(): number {
    return this.tick;
  }

  entity(id: number): Entity | undefined {
    return this.live.get(id);
  }

  entities(): Iterable<Entity> {
    return this.live.values();
  }

  /**
   * Install the map. Once, before anything is spawned — the terrain is part of the
   * construction order, and a machine that added it later would be running a
   * different simulation from one that added it first.
   */
  loadTerrain(collision: CollisionWorld, set?: TerrainSet, presence?: Presence): TerrainStats {
    if (this.terrain) {
      throw new Error("physics: the terrain is already loaded, and adding to it would change the construction order");
    }
    this.terrain = buildTerrain(this.world, collision, set);
    this.source = { collision, set };
    // The present parts after the map, ascending: the same order on every end
    // that builds this world from the same presence.
    for (let i = 0; i < collision.partCount; i++) {
      if (presence?.has(i)) {
        this.setPart(i, true);
      }
    }
    return this.terrain;
  }

  /**
   * Put a removable part's colliders in or take them out. Called at a tick
   * boundary, between two `step`s, in ascending part order: a collider is part of
   * the construction order, so two ends must change the same parts at the same
   * tick. A part coming back is built again, after everything already here.
   */
  setPart(index: number, on: boolean): void {
    if (!this.source || this.parts.has(index) === on) {
      return;
    }
    if (on) {
      this.parts.set(index, buildPart(this.world, this.source.collision, index, this.source.set));
      return;
    }
    for (const collider of this.parts.get(index)!) {
      this.world.removeCollider(collider, false);
    }
    this.parts.delete(index);
  }

  /** How many colliders a part has in the world now: none while it is absent. */
  partColliders(index: number): number {
    return this.parts.get(index)?.length ?? 0;
  }

  /**
   * Queue a spawn. Nothing is built until the next `step`, which is what lets
   * several arriving together be sorted into one order.
   *
   * A spawn for a tick already past is not refused — a repeat carrying one whose
   * first datagram was dropped is the ordinary case, and a corpse that never
   * appears is worse than one that appears late. It is built and then caught up.
   */
  spawn(id: number, kind: EntityKindId, tick: number, build: (world: RAPIER.World) => EntityParts): void {
    if (this.live.has(id) || this.pending.some((one) => one.id === id)) {
      return; // idempotent: a repeated spawn must not re-create bodies or re-apply an impulse
    }
    this.pending.push({ id, kind, tick, build });
  }

  /** Free one entity and everything it is made of. Safe to call for an id that is gone. */
  despawn(id: number): void {
    const found = this.live.get(id);
    if (!found) {
      this.pending = this.pending.filter((one) => one.id !== id);
      return;
    }
    // Joints first: removing a body a joint still names is the shape of crash that
    // only shows up under load.
    for (const joint of found.joints) {
      this.world.removeImpulseJoint(joint, false);
    }
    for (const body of found.bodies) {
      this.world.removeRigidBody(body);
    }
    this.live.delete(id);
  }

  /**
   * A push at a point, in world space.
   *
   * General rather than a ragdoll's: a blast will want to push every body near it,
   * and a body is a body. Newton-seconds.
   */
  applyImpulse(id: number, bodyIndex: number, impulse: Vec3, at: Vec3): void {
    const body = this.live.get(id)?.bodies[bodyIndex];
    body?.applyImpulseAtPoint(impulse, at, true);
  }

  /**
   * Advance to `tick`.
   *
   * Steps once per tick between where it is and where it is told, so a caller that
   * missed snapshots catches up exactly rather than approximately, and a caller
   * that calls twice for one tick steps once. `maxCatchup` bounds the case where
   * that difference is a stall rather than a gap: past it the world is simply
   * declared to be at `tick`, which is a corpse in the wrong place rather than a
   * frame that takes a second.
   */
  step(tick: number, maxCatchup = this.tickRate): void {
    if (tick <= this.tick) {
      return;
    }
    if (tick - this.tick > maxCatchup) {
      this.tick = tick - maxCatchup;
    }
    while (this.tick < tick) {
      this.tick++;
      this.admit(this.tick);
      this.retire(this.tick);
      this.world.step();
    }
  }

  free(): void {
    // Rapier's is a real deallocation in wasm memory; no garbage collector does it.
    this.world.free();
    this.live.clear();
    this.pending = [];
    this.parts.clear();
  }

  /** Build every spawn due by `tick`, in ascending id — the order is the format. */
  private admit(tick: number): void {
    if (this.pending.length === 0) {
      return;
    }
    const due = this.pending.filter((one) => one.tick <= tick).sort((a, b) => a.id - b.id);
    if (due.length === 0) {
      return;
    }
    this.pending = this.pending.filter((one) => one.tick > tick);
    for (const one of due) {
      const parts = one.build(this.world);
      this.live.set(one.id, { id: one.id, kind: one.kind, spawnTick: one.tick, ...parts });
    }
    this.enforceCaps();
  }

  /** Free anything past its kind's lifetime. Derived on both ends; nothing is sent. */
  private retire(tick: number): void {
    for (const entity of [...this.live.values()]) {
      const policy = ENTITY_POLICY[entity.kind];
      if (tick - entity.spawnTick >= policy.lifetimeSeconds * this.tickRate) {
        this.despawn(entity.id);
      }
    }
  }

  /** Oldest out first, by spawn tick then by id, so every machine drops the same one. */
  private enforceCaps(): void {
    const byKind = new Map<EntityKindId, Entity[]>();
    for (const entity of this.live.values()) {
      const found = byKind.get(entity.kind) ?? [];
      found.push(entity);
      byKind.set(entity.kind, found);
    }
    for (const [kind, found] of byKind) {
      const over = found.length - ENTITY_POLICY[kind].maxLive;
      if (over <= 0) {
        continue;
      }
      found.sort((a, b) => a.spawnTick - b.spawnTick || a.id - b.id);
      for (let i = 0; i < over; i++) {
        this.despawn(found[i]!.id);
      }
    }
  }
}
