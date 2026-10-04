// The things worth doing once a second rather than sixty times.
//
// Its own loop and not the tick's, because `Match.report()` allocates and none
// of this is worth that at 60 Hz.

import { inject, singleton } from "tsyringe";
import { Api } from "./api.js";
import { config } from "./config.js";
import { endingReason, Games } from "./games.js";
import { LoopBase } from "@3d/shared/lifecycle/loop.js";
import type { GameReportRequest } from "@3d/shared/protocol/routes/games.js";

const HOUSEKEEPING_MS = 1000;

/** At most one drift line per player per this, so one bad client cannot crowd out the rest. */
const WARN_INTERVAL_MS = 5000;

@singleton()
export class Housekeeping extends LoopBase {
  protected loopDuration = HOUSEKEEPING_MS;

  private readonly warnedAt = new Map<string, number>();

  /**
   * Games that are over and that the api has not yet acknowledged. The report is
   * the only thing that reopens a lobby, so one lost to a blip would leave its
   * players standing in a match that has ended.
   */
  private readonly unreported = new Map<string, { report: GameReportRequest; sending: boolean; failed: boolean }>();

  constructor(
    @inject(Games) private readonly games: Games,
    @inject(Api) private readonly api: Api,
  ) {
    super();
  }

  protected async loopIteration(): Promise<void> {
    this.reportDrift();
    this.endFinishedGames();
    this.reportRefusals();
  }

  /**
   * Report every order `Games` refused, now rather than on the next pass: the api
   * reopens the lobby on hearing it, and its players are waiting.
   */
  reportRefusals(): void {
    for (const [gameId, reason] of this.games.takeRefusals()) {
      this.unreported.set(gameId, { report: { status: "refused", reason }, sending: false, failed: false });
    }
    this.report();
  }

  /** A game that is over is reported once and dropped; the api reopens its lobby. */
  private endFinishedGames(): void {
    for (const { game, ending } of this.games.finished()) {
      const why = ending === "over" ? `: ${game.match.ended}` : ending === "errored" ? `: ${game.match.failed}` : "";
      console.log(`  * game ${game.id} ended: ${endingReason(ending)}${why}`);

      // Dropped first: this is what gives its world back, and the report is a
      // round-trip that must not decide whether the map stays loaded.
      this.games.drop(game.id);
      // A game that threw is refused rather than ended, so the api places its
      // lobby's next round on another instance.
      const report: GameReportRequest = ending === "errored" ? { status: "refused", reason: `${endingReason(ending)}${why}` } : { status: "ended" };
      this.unreported.set(game.id, { report, sending: false, failed: false });
    }
  }

  /**
   * Tell the api about every game that is over, until it has heard. Once a
   * second, which is backoff enough: the api answers a report for a game it has
   * forgotten with ok, so the only thing that keeps one here is an api that
   * cannot be reached at all.
   */
  private report(): void {
    for (const [gameId, state] of this.unreported) {
      if (state.sending) {
        continue;
      }
      state.sending = true;
      void this.api.client.gameReport({ gameId }, state.report).then(
        () => this.unreported.delete(gameId),
        (err: unknown) => {
          // Said once per game, not once a second for as long as the api is down.
          if (!state.failed) {
            console.warn(`  ! could not report game ${gameId}; retrying until the api hears: ${err instanceof Error ? err.message : String(err)}`);
          }
          state.failed = true;
          state.sending = false;
        },
      );
    }
  }

  /**
   * A drift line per player, throttled per player rather than globally — the
   * thing worth seeing is which player's number is growing.
   */
  private reportDrift(): void {
    const now = Date.now();
    const present = new Set<string>();
    for (const game of this.games.all()) {
      for (const { id, drift } of game.match.report()) {
        // Across every game, not per game: a `present` set built inside this
        // loop would delete every other game's throttle on each pass.
        present.add(id);

        if (drift.current < config.driftWarnMetres || now - (this.warnedAt.get(id) ?? 0) < WARN_INTERVAL_MS) {
          continue;
        }

        this.warnedAt.set(id, now);

        console.warn(
          `  ~ player ${id} drifted ${drift.current.toFixed(3)}m from our simulation on one step ` +
            `(worst ${drift.max.toFixed(3)}m, mean ${drift.mean.toFixed(4)}m over ${drift.samples} steps)`,
        );
      }
    }

    // A game outlives many players; the throttle must not outlive them too.
    for (const id of this.warnedAt.keys()) {
      if (!present.has(id)) {
        this.warnedAt.delete(id);
      }
    }
  }
}
