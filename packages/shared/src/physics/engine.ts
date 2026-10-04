// Loading Rapier, and the one place a physics world is made.
//
// Everything dynamic and replicated is simulated on *both* ends — see
// tsconfig.physics.json for why that is the design rather than a convenience — and
// the whole of it rests on one promise Rapier makes: the same version, given the
// same initial conditions and the same order of construction, produces the same
// simulation on every machine. Each of those three is something a caller can break,
// so each has a guard:
//
//  - **the same version** is `pnpm-workspace.yaml`'s exact pin, and
//    tests/physicsDeterminism.test.ts's reference hash is what notices a bump;
//  - **the same initial conditions** is the wire — a spawn crosses it quantised and
//    every end, the server included, simulates the value it decoded;
//  - **the same order** is each entity kind's own arrays, which are formats.
//
// This file owns the fourth thing: **the integration parameters**. They stay at
// Rapier's defaults, and this is the only module allowed to change one, because a
// knob turned on one end and not the other is a divergence nothing reports.
//
// `-deterministic-compat` rather than `@dimforge/rapier3d`: the plain build says in
// its own README that it does *not* guarantee cross-platform determinism, and is
// about 8% faster for it. `-compat` inlines the wasm as base64, so one package
// serves Node and the browser without a bundler in the loop — which also means
// importing this module costs ~2.9 MB, and the client must reach it through a
// dynamic `import()` rather than from its entry bundle.

import RAPIER from "@dimforge/rapier3d-deterministic-compat";
import { GRAVITY } from "../sim/movement.js";

/**
 * Load the engine. Idempotent and awaited by everybody: the promise is kept, so a
 * second caller pays nothing and a concurrent one does not start a second load.
 */
export function initPhysics(): Promise<void> {
  loading ??= RAPIER.init();
  return loading;
}

let loading: Promise<void> | undefined;

/**
 * One physics world.
 *
 * `timestep` is `1 / tickRate` and is set once. A varying step is not a slightly
 * different answer, it is a different simulation — so this never takes a frame's
 * `dt`, and `step()` is called exactly once per server tick on both ends.
 *
 * Gravity is the games' own `GRAVITY`, not 9.81: a body that falls at a different
 * rate from the player who shot it reads as a bug, and a grenade that arcs
 * differently from a player's jump reads as a worse one.
 *
 * Must be `free()`d. Rapier's is a real deallocation in wasm memory, which no
 * JavaScript garbage collector will do for you.
 */
export function createPhysicsWorld(timestep: number): RAPIER.World {
  const world = new RAPIER.World({ x: 0, y: -GRAVITY, z: 0 });
  world.timestep = timestep;
  return world;
}
