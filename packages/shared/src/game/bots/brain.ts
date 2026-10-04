// What a brain is: the middle of a bot's three layers.
//
// A script sets a bot's **objective** (objective.ts): what it is for. A brain
// turns the objective and what it can see into a **goal**: where to go and what
// to face, now. The **motor** (motor.ts) turns the goal into the input a player
// would send. A brain never writes input and never plans a path itself — it may
// ask whether one exists (`BrainContext.nav.route`), and hand the answer over.
//
// Brains are compiled in (`BRAINS`, registry.ts), run on the server only, and
// keep their memory there: nothing a brain remembers is replicated, so a client
// sees a bot only as the player it moves. A brain must still be deterministic —
// its randomness is the `rng` it is handed and its clock is `ctx.now` — because
// two runs of one match must play out the same (tested on a real map).

import type { PlayerId } from "../../net/messages/fields.js";
import type { Vec3 } from "../../sim/capsule.js";
import type { MovementState } from "../../sim/movement.js";
import type { GameView, PlayerStateView } from "../context.js";
import type { TeamId } from "../gametypes/declaration.js";
import type { BrainId, BrainParams, Objective } from "./objective.js";
import type { Route } from "./planner.js";

/** What a brain wants of its body right now. The motor carries it out every tick until the next think. */
export type Goal =
  /** Stand. Facing `look` if given, else wherever it faces. */
  | { readonly kind: "idle"; readonly look?: Vec3 }
  /** Stand, facing a point. */
  | { readonly kind: "look"; readonly point: Vec3 }
  /**
   * Stand, facing this player, and hit them. The motor only stands and faces;
   * the blow is an actor's runtime's, when its kind's cooldown allows and the
   * target is within reach (docs/engine/actors.md). A bot has no blow, and stands.
   */
  | { readonly kind: "attack"; readonly target: PlayerId }
  | MoveTo;

/** Go to a point, over the graph and then straight to it. */
export interface MoveTo {
  readonly kind: "moveTo";
  readonly point: Vec3;
  /** False: walk the whole way. Otherwise the follower runs where it would (docs/engine/navigation.md). */
  readonly run?: boolean;
  /** Stop this close, m, horizontally. At least the follower's own 0.4 m. */
  readonly arrive?: number;
  /** Face this once there. The point itself when absent. */
  readonly look?: Vec3;
  /**
   * Keep `point` on this player's feet between thinks. A chase re-aims every
   * tick at where its quarry is now, rather than where it was at the last think.
   */
  readonly track?: PlayerId;
  /** The path, if the brain already asked for one: the motor takes it rather than planning again. */
  readonly route?: Route;
}

export const IDLE: Goal = { kind: "idle" };

/**
 * What the motor last did about the goal.
 *
 * `noPath` and `stuck` are verdicts on the goal the brain gave, and last until it
 * gives another: a brain reads them on its next think and chooses differently.
 * A link the follower got stuck on is shut for the rest of the match, and the
 * motor plans around it on its own; `stuck` is only what it could not blame on
 * a link.
 */
export type MotorStatus = "idle" | "moving" | "arrived" | "noPath" | "stuck";

/** The motor as a brain sees it. */
export interface MotorView {
  readonly status: MotorStatus;
  readonly goal: Goal;
}

/** What a brain may ask of the graph. */
export interface BrainNav {
  readonly ready: boolean;
  /** The usable node nearest a point, within a height limit; -1 for none. */
  nearestNode(point: Vec3, maxDy?: number): number;
  nodeFeet(node: number): Vec3;
  /** A path from the node at `from` to the node at `to`, or null. Hand it to the motor in `MoveTo.route`. */
  route(from: Vec3, to: Vec3): Route | null;
}

/**
 * What a brain may see: the game as a script sees it, where everyone is, and the
 * graph. Reads only — a brain changes nothing but its own goal and memory; a
 * script changes the game.
 */
export interface BrainContext extends GameView {
  /** Where a player is and whether they are alive. Server-only, like the brain. */
  state(id: PlayerId): PlayerStateView | undefined;
  readonly nav: BrainNav;
}

/**
 * The bot a brain is thinking for — or the actor: an actor's `id` is its key
 * (`actorKey`), its `team` undefined, and nothing else differs.
 */
export interface BotSelf {
  readonly id: PlayerId;
  /** Its place among the match's bots, from 1: what spreads their thinks over the ticks. */
  readonly index: number;
  readonly team: TeamId | undefined;
  readonly objective: Objective;
  /** Where it is, as of the end of the last tick. */
  readonly movement: Readonly<MovementState>;
  readonly motor: MotorView;
}

/** A brain: an id, a period, fresh memory for each bot, and a think. */
export interface Brain<M = unknown> {
  readonly id: BrainId;
  /**
   * Seconds between thinks, rounded to whole ticks; every tick when absent. Each
   * bot is offset by its index, so a match's bots do not all think on one tick.
   * A bot also thinks at once when it spawns and when its objective is changed.
   */
  readonly period?: number;
  /** Memory for one bot, on its first think. `rng` is this bot's own stream (random.ts), for the life of the match. */
  init(self: BotSelf, rng: () => number, params: BrainParams): M;
  /** What to do until the next think. May change `memory`; may not change the game. */
  think(ctx: BrainContext, self: BotSelf, memory: M): Goal;
}

/** A brain as the table holds it: its memory is its own business. */
export type AnyBrain = Brain<unknown>;

/** Declare a brain, keeping its memory type inside it. */
export function defineBrain<M>(brain: Brain<M>): AnyBrain {
  return brain as unknown as AnyBrain;
}
