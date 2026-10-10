// One bot: its brain, its memory, its motor, and when it thinks.
//
// What a game server holds for each bot and asks once a tick. Everything the
// match knows that a bot needs arrives in a `BotTurn`; everything the bot decides
// leaves as the `PlayerInput` it writes. So the server's side is a thin adapter
// (game-server/src/match/bots.ts, `MatchBots.think`) and all of a bot's behaviour is here,
// in tier one, where a test can drive it without a server.
//
// **When it thinks.** Every `period` seconds, offset by the bot's index so a
// match's bots spread over the ticks; and at once when it spawns or a script
// changes its objective. Between thinks the motor carries the last goal out
// every tick. Thinks are scheduled by tick and bots are asked in the order they
// were added, so two runs of one match think the same thoughts on the same ticks.

import type { PlayerId } from "../../net/messages/fields.js";
import type { PlayerInput } from "../../sim/input.js";
import type { MovementState } from "../../sim/movement.js";
import { hashString, seeded } from "../random.js";
import type { AnyBrain, BotSelf, BrainContext } from "./brain.js";
import { Motor, type FeetOf } from "./motor.js";
import type { BrainParams, Objective } from "./objective.js";
import type { NavPlanner } from "./planner.js";

/** What the match tells a bot each tick. */
export interface BotTurn {
  readonly id: PlayerId;
  /** Its place among the match's bots, from 1, never reused. */
  readonly index: number;
  /** The tick being stepped, and its length in seconds. */
  readonly tick: number;
  readonly dt: number;
  /** Where it is, as of the end of the last tick. */
  readonly movement: Readonly<MovementState>;
  readonly alive: boolean;
  /** The world's graph and this match's blocked links. A bot is not asked until there is one. */
  readonly nav: NavPlanner;
  /** Counts the times a script has ordered this bot: a change is what makes it think at once. */
  readonly ordered: number;
  /** Its objective now: the last order, or what a script's `botObjective` says instead. Asked only on a think. */
  objective(): Objective;
  /** What a brain sees. Built at most once a tick, for every bot that thinks on it. */
  context(): BrainContext;
  /** Where a player's feet are, for a goal that tracks one. Cheap: asked every tick. */
  feetOf: FeetOf;
}

export class BotDriver {
  readonly motor = new Motor();
  private memory: unknown;
  private started = false;
  private alive = false;
  private lastOrder = -1;
  private lastObjective: Objective | null = null;
  /** Thinks so far, for a test. */
  thinks = 0;

  constructor(
    readonly brain: AnyBrain,
    private readonly params: BrainParams = {},
  ) {}

  /** Write this tick's input into `out`, which arrives idle, facing where the bot faces. */
  think(turn: BotTurn, out: PlayerInput): void {
    if (!turn.alive) {
      if (this.alive) {
        this.motor.reset();
      }
      this.alive = false;
      return;
    }
    const spawned = !this.alive;
    this.alive = true;

    const period = Math.max(1, Math.round((this.brain.period ?? 0) / turn.dt));
    if (spawned || turn.ordered !== this.lastOrder || (turn.tick + turn.index) % period === 0) {
      this.lastOrder = turn.ordered;
      this.decide(turn);
    }
    this.motor.step(turn.movement, turn.dt, turn.nav, out, turn.feetOf);
  }

  private decide(turn: BotTurn): void {
    const ctx = turn.context();
    const objective = turn.objective();
    this.lastObjective = objective;
    const self: BotSelf = {
      id: turn.id,
      index: turn.index,
      team: ctx.player(turn.id)?.team,
      objective,
      movement: turn.movement,
      motor: this.motor,
    };
    if (!this.started) {
      // Its own stream, from the match's seed and its id: the same bot in the same
      // match draws the same numbers, and no two bots draw the same ones.
      this.memory = this.brain.init(self, seeded(hashString(`${ctx.seed}:${turn.id}`)), this.params);
      this.started = true;
    }
    this.thinks++;
    this.motor.setGoal(this.brain.think(ctx, self, this.memory), turn.nav);
  }

  /** The objective it last thought with, or null before its first think. */
  get objective(): Objective | null {
    return this.lastObjective;
  }
}
