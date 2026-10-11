// An actor as a script names it, spawns it and reads it back.
//
// Types only, like `bots/objective.ts`: a script names a brain by id and a kind
// by id, so the script table a browser imports pulls in neither the brains nor a
// game server's actor runtime.

import type { PlayerId } from "../../net/messages/fields.js";
import type { Vec3 } from "../../sim/capsule.js";
import type { BrainId, BrainParams, Objective } from "../bots/objective.js";
import type { ActorKindId } from "./kinds.js";

/**
 * An actor's id: counts up from 1 for the life of a match and is never reused,
 * so a script holding one never finds it naming somebody else. Sixteen bits, as
 * the wire carries it.
 */
export type ActorId = number;

/** The most actors one match may ever spawn: ids are 16 bits and none is reused. */
export const MAX_ACTOR_ID = 0xffff;

/**
 * An actor's id where a brain expects a player's (`BotSelf.id`, a brain's seed).
 * `#a` is outside the api's player-id alphabet, as a bot's `#b` is, so it can
 * never be taken for a player.
 */
export function actorKey(id: ActorId): PlayerId {
  return `#a${id.toString(36)}`;
}

/** What an actor is doing, as the wire carries it and a body is posed from. Append only. */
export const ACTOR_ACTIONS = ["idle", "move", "attack", "die", "traverse"] as const;
export type ActorAction = (typeof ACTOR_ACTIONS)[number];

/**
 * How an actor moves: a CoD zombie is a walker, a runner or a sprinter, chosen
 * per zombie by the script. It picks the clip it moves in, and so its speed,
 * which is that clip's root motion (docs/engine/actors.md#gait). Append only.
 */
export const ACTOR_GAITS = ["walk", "run", "sprint"] as const;
export type ActorGait = (typeof ACTOR_GAITS)[number];

/**
 * One actor as a snapshot carries it: everything a client draws it from, and
 * nothing else. Spawned when its id first appears, gone when it stops appearing.
 */
export interface ActorState {
  id: ActorId;
  /** Its kind's index in `ACTOR_KINDS`. */
  kind: number;
  feet: Vec3;
  yaw: number;
  /** m/s along the ground: what fades the idle into the gait's clip. */
  speed: number;
  gait: ActorGait;
  action: ActorAction;
  /**
   * Where in the action's clip, 0..1: through the idle's loop or the gait's cycle
   * for `idle` and `move`, through the swing or the fall for `attack` and `die`,
   * and through the climb (and along the link, in step) for `traverse`.
   */
  phase: number;
  /**
   * For `traverse`: which of the look's traversal clips plays (`ActorLook.traversals`),
   * as its index plus one; 0 for the gait's climb. 0 for every other action.
   */
  traversal: number;
}

/** An actor a script spawns (`ServerContext.actors.spawn`). */
export interface ActorSpec {
  /** A kind in `ACTOR_KINDS`. A name nothing declares throws. */
  readonly kind: ActorKindId;
  /** Where its feet go. */
  readonly at: Vec3;
  /** A point to face. Absent: whichever way it happens to face. */
  readonly look?: Vec3;
  /** The brain in `BRAINS` that drives it. A name nothing declares throws. */
  readonly brain: BrainId;
  readonly objective?: Objective;
  /** Handed to the brain's `init`, over the kind's own reach. */
  readonly params?: BrainParams;
  /** Health at spawn instead of the kind's: a gametype prices it per round. */
  readonly health?: number;
  /** Walker, runner or sprinter. Absent: a walker. */
  readonly gait?: ActorGait;
}

/** Where an actor is and how it is, as a script reads it. A copy. */
export interface ActorStateView {
  readonly id: ActorId;
  readonly kind: ActorKindId;
  readonly feet: Vec3;
  readonly yaw: number;
  readonly alive: boolean;
  readonly health: number;
}
