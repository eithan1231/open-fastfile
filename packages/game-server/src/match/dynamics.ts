// The dynamics a match is simulating, if it is simulating any: a physics world
// built the first time something needs one, stepped once a tick, and freed with
// the match.
//
// **Built on demand, and today never.** A physics world costs a Rapier trimesh
// over the map — 88k triangles on dome-mw3, 296k on interchange — and a Rapier
// collider belongs to one world, so two games on one map would pay it twice.
// Nothing the server reads depends on a corpse (`ENTITY_POLICY.ragdoll` is
// `serverSimulates: false`), so no game builds one. The first kind gameplay reads
// — a grenade, whose resting place decides who dies — is what turns this on.

import type { PhysicsWorld } from "@3d/shared/physics/world.js";
import { ENTITY_POLICY, type EntityKindId } from "@3d/shared/sim/entityKinds.js";
import type { MatchClock } from "./clock.js";

export class Dynamics {
  private world: PhysicsWorld | undefined;
  /** Makes one, when something finally needs it. Set by `Games`; absent in a test that does not care. */
  private factory: (() => PhysicsWorld | undefined) | undefined;

  constructor(private readonly clock: MatchClock) {}

  /** The world being simulated, or undefined while there is none. */
  get current(): PhysicsWorld | undefined {
    return this.world;
  }

  /**
   * How a world may be built, should anything need one. A factory rather than a
   * world, because most games never build one and a map's trimesh is the most
   * expensive thing in the subtree. What comes back is ready, terrain included.
   */
  setFactory(factory: () => PhysicsWorld | undefined): void {
    this.factory = factory;
  }

  /**
   * Queue a spawn, building the world if this is the first thing to need it. A
   * kind whose policy says the server does not simulate it never gets here: the
   * server decides its spawn, says it once, and the clients do the rest.
   */
  spawn(id: number, kind: EntityKindId, build: Parameters<PhysicsWorld["spawn"]>[3]): void {
    if (!ENTITY_POLICY[kind].serverSimulates) {
      return;
    }
    this.world ??= this.factory?.();
    this.world?.spawn(id, kind, this.clock.tick, build);
  }

  /** Exactly once per tick: the step count is what every end has to agree on. */
  step(): void {
    this.world?.step(this.clock.tick);
  }

  /** What is being simulated, for `/healthz`. Zeroes where it is nothing. */
  report(): { entities: number; triangles: number } {
    return { entities: this.world?.count ?? 0, triangles: this.world?.terrainStats?.triangles ?? 0 };
  }

  /**
   * Give back what is held outside the JavaScript heap. A Rapier world is wasm
   * memory and no garbage collector frees it, so a game server that hosted a
   * thousand games would hold a thousand worlds.
   */
  free(): void {
    this.world?.free();
    this.world = undefined;
  }
}
