// The actors' place in a match's tick: stepped against the players as this
// tick's inputs left them, and what each snapshot then says about them.
// `Actors` (../actors.ts) is the creatures themselves.

import type { ActorState } from "@3d/shared/game/actors/actor.js";
import type { BrainContext } from "@3d/shared/game/bots/brain.js";
import type { NavPlanner } from "@3d/shared/game/bots/planner.js";
import { MAX_SNAPSHOT_ACTORS } from "@3d/shared/net/messages/actors.js";
import type { PlayerId } from "@3d/shared/net/messages/fields.js";
import type { Actors } from "../actors.js";
import type { MatchClock } from "./clock.js";
import type { Damage } from "./damage.js";
import type { MatchNav } from "./nav.js";
import type { Roster } from "./roster.js";

export class ActorTick {
  /** Every actor as the last tick left it. */
  private states: ActorState[] = [];

  constructor(
    private readonly clock: MatchClock,
    private readonly actors: Actors,
    private readonly roster: Roster,
    private readonly nav: MatchNav,
    private readonly damage: Damage,
    private readonly brains: (planner: NavPlanner) => BrainContext,
  ) {}

  /** The actors' tick (`Actors.step`): brains, movement and blows, with damage through the match's one queue. */
  step(): void {
    if (this.actors.size === 0) {
      return;
    }
    const nav = this.nav.actorPlanner;
    const roster = this.roster;
    this.actors.step({
      tick: this.clock.tick,
      dt: this.clock.dt,
      nav,
      context: () => this.brains(nav!),
      feetOf: (id) => roster.get(id)?.player.movement.feet,
      target: (id) => {
        const player = roster.get(id)?.player;
        return player && { feet: player.movement.feet, alive: !player.dead };
      },
      blow: (target, amount, actor) => this.damage.hurt({ id: target, amount, by: null, cause: "melee", actor }),
      fell: (actor, health) => this.damage.hurt({ kind: "actor", actor, amount: health, by: null, cause: "outOfWorld", certain: true }),
    });
  }

  /** Keep what this tick's snapshots carry. */
  capture(): void {
    this.states = this.actors.snapshot(this.clock.tick);
  }

  /** How many actors the last tick left: none means there is nothing to tell anyone about them. */
  get count(): number {
    return this.states.length;
  }

  /**
   * The actors one player is told about: all of them, or past the cap the nearest
   * to them, nearest first and spawn order on a tie. Somebody not in the match —
   * seated, choosing a class — has no feet to measure from and gets the oldest.
   */
  for(id: PlayerId): ActorState[] {
    const all = this.states;
    if (all.length <= MAX_SNAPSHOT_ACTORS) {
      return all;
    }
    const feet = this.roster.get(id)?.player.movement.feet;
    if (!feet) {
      return all.slice(0, MAX_SNAPSHOT_ACTORS);
    }
    const away = (a: ActorState) => (a.feet.x - feet.x) ** 2 + (a.feet.y - feet.y) ** 2 + (a.feet.z - feet.z) ** 2;
    return all
      .map((actor) => ({ actor, d: away(actor) }))
      .sort((a, b) => a.d - b.d || a.actor.id - b.actor.id)
      .slice(0, MAX_SNAPSHOT_ACTORS)
      .map(({ actor }) => actor);
  }
}
