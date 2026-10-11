// What a movement step is given besides the state and the input: everything
// that comes with the world and the body, and what the held weapon says.
//
// Its own file so the step (sim/movement.ts), the moves (sim/moves/) and the
// rules a world imposes (sim/worldRules.ts) can all name these without
// importing one another.

import type { CapsuleWorld } from "./capsule.js";
import { NO_LADDERS, type LadderVolumes } from "./moves/ladder.js";
import { NO_MANTLES, type MantleVolumes } from "./moves/mantle.js";
import type { MovementParams } from "./movementState.js";

/** The climbs a world allows. Built from a world by `movementRules` (sim/worldRules.ts), the one way a player gets them. */
export interface MovementRules {
  readonly mantles: MantleVolumes;
  readonly ladders: LadderVolumes;
}

/** A world that allows no climbs, so a caller always has rules to hold. */
export const NO_CLIMBS: MovementRules = { mantles: NO_MANTLES, ladders: NO_LADDERS };

/**
 * Where a step happens and what is stepped: the collision, the world's climbs
 * and the body. Built once by whoever owns the mover — a `Player`, an actor
 * host, a link's validation — and handed to every step, so a client predicting
 * and a server replaying cannot disagree about any of it.
 */
export interface MovementEnv extends MovementRules {
  readonly world: CapsuleWorld;
  readonly body: MovementParams;
}

export function movementEnv(world: CapsuleWorld, rules: MovementRules, body: MovementParams): MovementEnv {
  return { world, mantles: rules.mantles, ladders: rules.ladders, body };
}

/** What the held weapon says about a step. */
export interface Carry {
  /** A sprint may run: false while the weapon is doing something a sprint waits for (a reload, the sights, the trigger). */
  readonly sprint: boolean;
  /** The weapon is aimed or firing, which holds a lying body where it is: nobody crawls while they shoot. */
  readonly braced: boolean;
}

/** Nothing in hand, so nothing holds a sprint back or a crawl still. */
export const EMPTY_HANDS: Carry = { sprint: true, braced: false };
