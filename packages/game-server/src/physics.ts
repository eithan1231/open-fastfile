// The physics engine, loaded once for the process.
//
// A singleton for the reason `Weapons` and `Bodies` are: it is a one-off cost that
// every game afterwards depends on, so it is paid at boot where a failure is a boot
// failure, rather than on the first death in the first game where it is a mystery.
//
// It holds no world. A world belongs to a game — Rapier colliders belong to one
// `World`, so two games on one map cannot share one — and `Match` asks for its own.
//
// **Nothing here is reached unless a kind needs it.** Today the only kind is the
// ragdoll and its policy is `serverSimulates: false`, so no game builds a world and
// no map is turned into a trimesh: the server decides a corpse's spawn and the
// clients simulate it. The moment a kind arrives that gameplay reads — a grenade,
// whose resting place decides who dies — `Match` builds its world on that kind's
// first spawn and this is what it builds it with.

import { singleton } from "tsyringe";
import { initPhysics } from "@3d/shared/physics/engine.js";
import { PhysicsWorld } from "@3d/shared/physics/world.js";
import { config } from "./config.js";

@singleton()
export class Physics {
  private ready = false;

  /**
   * Load the engine.
   *
   * Never fatal, and that is deliberate. An instance that cannot start a physics
   * engine can still host every game it hosts today — but it says so loudly,
   * because "nobody leaves a body" reads as a netcode fault and is not one, the
   * same argument `Bodies` and `Weapons` make about their own failures.
   */
  async load(): Promise<void> {
    const started = Date.now();
    try {
      await initPhysics();
      this.ready = true;
      console.log(`physics: ready in ${Date.now() - started}ms`);
    } catch (error) {
      console.warn(`physics: unavailable (${String(error)}) — this instance will host games with no dynamics`);
    }
  }

  get available(): boolean {
    return this.ready;
  }

  /**
   * A world for one game, at this instance's tick rate.
   *
   * Undefined where the engine did not load, so a caller that cannot have one
   * carries on without it rather than failing a game nobody else would notice was
   * different.
   */
  create(): PhysicsWorld | undefined {
    return this.ready ? new PhysicsWorld(config.tickRate) : undefined;
  }
}
