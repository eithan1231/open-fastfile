// A match's bots: adding them, ordering them, and writing their input once a
// tick, before the drain, shaped as a client's so nothing downstream has to know.

import { botId, type PlayerId } from "@3d/shared/net/messages/fields.js";
import { roundInput } from "@3d/shared/net/messages/input.js";
import { BotDriver, type BotTurn } from "@3d/shared/game/bots/driver.js";
import type { BrainContext } from "@3d/shared/game/bots/brain.js";
import { NO_OBJECTIVE, type BotSpec, type Objective } from "@3d/shared/game/bots/objective.js";
import { brainFor } from "@3d/shared/game/bots/registry.js";
import type { NavPlanner } from "@3d/shared/game/bots/planner.js";
import { idleInput } from "@3d/shared/sim/input.js";
import type { Loadout } from "@3d/shared/sim/loadout.js";
import type { MovementState } from "@3d/shared/sim/movement.js";
import { thinkOrStand, type BotController, type BotOptions } from "../bots.js";
import type { MatchClock } from "./clock.js";
import type { MatchNav } from "./nav.js";
import type { Roster } from "./roster.js";
import type { ScriptHost } from "./scripts.js";

/** A bot's side of a member. */
export interface BotState {
  readonly controller: BotController;
  /** Its place among the match's bots, from 1: what spreads their thinks over the ticks. */
  readonly index: number;
  /** The last input's `seq`, counting as a client's does. */
  seq: number;
  /** Its controller threw once: said then, and not asked again. It stands still. */
  failed: boolean;
  /** What a script last said it is for (`bots.order`, `botObjective`), kept here so a script need not. */
  objective: Objective;
  /** Counts `bots.order` calls, so the bot thinks again at once. */
  ordered: number;
}

/** How a bot joins the match: as a player does, on `side` where one is given. */
export type AdmitBot = (id: PlayerId, loadout: Loadout | undefined, side: number | undefined, bot: BotState) => void;

export class MatchBots {
  /** Bots this match has ever added, which is what the next one's id counts from: an id is never reused. */
  private minted = 0;

  constructor(
    private readonly clock: MatchClock,
    private readonly roster: Roster,
    private readonly nav: MatchNav,
    private readonly scripts: ScriptHost,
    private readonly brains: (nav: NavPlanner) => BrainContext,
    private readonly admit: AdmitBot,
    private readonly leave: (id: PlayerId) => void,
  ) {}

  /**
   * Add a bot, and return the id it was given: `#b` and a count (`botId`), which
   * the api can never issue. It joins as a player does — a side, a spawn, a class
   * or the gametype's weapon — and from the next tick its controller moves it.
   * A side the gametype does not have throws, as `setTeam` does.
   */
  add(spec: BotOptions): PlayerId {
    const side = spec.team === undefined ? undefined : this.roster.side(spec.team, "a bot was put on");
    const index = ++this.minted;
    const id = botId(index);
    this.admit(id, spec.loadout, side, {
      controller: spec.controller,
      index,
      seq: 0,
      failed: false,
      objective: spec.objective ?? NO_OBJECTIVE,
      ordered: 0,
    });
    return id;
  }

  /** `ServerContext.bots.add`: a bot driven by a brain from `BRAINS`, which is how a real game gets one. */
  addScripted(spec: BotSpec): PlayerId {
    const brain = brainFor(spec.brain);
    if (!brain) {
      throw new Error(`a script added a bot with brain "${spec.brain}", which nothing declares`);
    }
    return this.add({ controller: new BotDriver(brain, spec.params), team: spec.team, objective: spec.objective });
  }

  /** `ServerContext.bots.order`. */
  order(id: PlayerId, objective: Objective | null): void {
    const member = this.roster.get(id);
    if (!member) {
      return;
    }
    if (!member.bot) {
      throw new Error(`a script gave ${id} an objective, and ${id} is not a bot`);
    }
    member.bot.objective = objective ?? NO_OBJECTIVE;
    member.bot.ordered++;
  }

  /** Take a bot out of the match. False for an id that is not a bot here. */
  remove(id: PlayerId): boolean {
    if (this.roster.get(id)?.bot === undefined) {
      return false;
    }
    this.leave(id);
    return true;
  }

  /**
   * One input per bot, queued for this tick's drain as a client's would be.
   *
   * Shaped as a client's so that nothing downstream has to know: `dt` is one
   * tick, the input is rounded as the wire would round it, and `renderTick` names
   * the last tick stepped — what a bot "sees" is the world as the previous tick
   * left it, and a shot it fires is judged there. A client's is a tick or more
   * older, and a bot's zero would be clamped to the rewind floor, a quarter of a
   * second back. `claim` is its own state, which nothing reads: drift is not
   * measured for a bot.
   *
   * Idle, without asking the controller, until the world's graph is baked: a bot
   * stands still until it has somewhere to plan. Queued even then, because a
   * member is only stepped by its inputs, and a bot with none would hang in the
   * air where it spawned.
   */
  think(): void {
    if (this.roster.bots === 0) {
      return;
    }
    const nav = this.nav.planner;
    const tick = this.clock.tick;
    // Built at most once this tick, and only if some bot thinks on it: most ticks
    // none does, and a view walks the roster.
    let brains: BrainContext | undefined;
    const context = (): BrainContext => (brains ??= this.brains(nav!));
    const feetOf = (id: PlayerId) => this.roster.get(id)?.player.movement.feet;
    for (const member of this.roster.values()) {
      const bot = member.bot;
      if (!bot) {
        continue;
      }
      const id = member.id;
      const movement = member.player.movement as MovementState;
      const input = idleInput(movement.yaw, movement.pitch);
      if (nav && !bot.failed) {
        const turn: BotTurn = {
          id,
          index: bot.index,
          tick,
          dt: this.clock.dt,
          movement,
          alive: !member.player.dead,
          nav,
          ordered: bot.ordered,
          objective: () => {
            const said = this.scripts.first((hooks, ctx) => hooks.botObjective?.(ctx, id));
            if (said) {
              bot.objective = said;
            }
            return bot.objective;
          },
          context,
          feetOf,
        };
        bot.failed = !thinkOrStand(bot.controller, turn, input, `bot ${id}'s controller`);
      }
      bot.seq = (bot.seq + 1) & 0xffff;
      member.inputs.push({
        seq: bot.seq,
        dt: this.clock.dt,
        input: roundInput(input),
        claim: movement,
        renderTick: (tick - 1) & 0xffff,
        renderFrac: 0,
      });
    }
  }
}
