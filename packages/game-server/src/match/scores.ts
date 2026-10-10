// What a match counts: each side's score, each player's purse and the
// gametype's counters. Scripts write them; the snapshot and `/healthz` read them.

import type { PlayerId } from "@3d/shared/net/messages/fields.js";
import type { GametypeDecl, TeamId } from "@3d/shared/game/gametypes/declaration.js";
import { counterIndex, isMatchValue, MATCH_VALUE_MAX, MATCH_VALUE_MIN, MAX_POINTS } from "@3d/shared/game/matchValues.js";
import type { Roster } from "./roster.js";

export class Scores {
  /** What each side has scored. A side with no entry has scored nothing. */
  private readonly teams = new Map<TeamId, number>();
  /** The gametype's counters, in its `counters` order: what `setCounter` sets and the snapshot carries. */
  private readonly counters: number[];

  constructor(
    private readonly gametype: GametypeDecl,
    private readonly roster: Roster,
  ) {
    this.counters = (gametype.counters ?? []).map(() => 0);
  }

  /** What each side has scored. Empty in a free-for-all: a score is keyed by side, and there are none. */
  get byTeam(): ReadonlyMap<TeamId, number> {
    return this.teams;
  }

  score(team: TeamId, delta: number): void {
    this.teams.set(team, (this.teams.get(team) ?? 0) + delta);
  }

  /** `ServerContext.addPoints`: the purse moves, never below nothing and never past what the wire carries. */
  addPoints(id: PlayerId, delta: number): void {
    if (!this.gametype.points) {
      throw new Error(`a script gave ${id} points, and gametype "${this.gametype.id}" keeps none`);
    }
    if (!Number.isInteger(delta)) {
      throw new Error(`points are whole: a script asked for ${delta}`);
    }
    const player = this.roster.get(id)?.player;
    if (!player) {
      return;
    }
    const next = player.points + delta;
    if (next < 0) {
      throw new Error(`a script took ${-delta} points from ${id}, who has ${player.points}`);
    }
    player.setPoints(Math.min(MAX_POINTS, next));
  }

  counter(name: string): number {
    return this.counters[counterIndex(this.gametype, name)]!;
  }

  /** `ServerContext.setCounter`: a declared name and a value the wire can carry, or a throw. */
  setCounter(name: string, value: number): void {
    const index = counterIndex(this.gametype, name);
    if (!isMatchValue(value)) {
      throw new Error(`counter "${name}" wants a whole number in ${MATCH_VALUE_MIN}..${MATCH_VALUE_MAX}, not ${value}`);
    }
    this.counters[index] = value;
  }

  /** The counters as a snapshot carries them: a copy, since the snapshot outlives the tick. */
  countersNow(): number[] {
    return [...this.counters];
  }
}
