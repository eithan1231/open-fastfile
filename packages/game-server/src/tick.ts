// The fixed tick: every game steps, every player in each is sent the verdict.
//
// A FixedRateLoop rather than a plain one, because the rate is a contract. Every
// client is told it in its `joined` and accumulates against it, so 60 Hz has to
// mean 60 steps a second — a loop that slept its period *after* the work would
// run slower than realtime and every client would drift against a server that
// thought it was keeping up. See @3d/shared/lifecycle/loop.ts.

import { inject, singleton } from "tsyringe";
import { encodePacket, MessageType } from "@3d/shared/net/packet.js";
import { config } from "./config.js";
import { FixedRateLoop } from "@3d/shared/lifecycle/loop.js";
import { Games, type GameInstance } from "./games.js";
import { NetServer } from "./net/server.js";
import { sendShotTraces } from "./shotTrace.js";

/** One tick of every game this instance hosts. Apart from the loop, so a test runs one without a timer. */
@singleton()
export class GameTick {
  constructor(
    @inject(Games) private readonly games: Games,
    @inject(NetServer) private readonly net: NetServer,
  ) {}

  /**
   * Advance every game one tick and send each player in each the verdict.
   *
   * Each game in its own try: a script that throws, or the damage queue's loop
   * guard, would otherwise throw every tick and starve every game after it in
   * the loop. The one that threw ends (`Match.fail`), and Housekeeping drops and
   * reports it.
   */
  run(): void {
    for (const game of this.games.all()) {
      if (game.match.failed !== undefined) {
        continue;
      }
      try {
        this.step(game);
      } catch (err) {
        game.match.fail(err);
        console.error(`  ! game ${game.id} threw on its tick, so it is ended:`, err);
      }
    }
  }

  private step(game: GameInstance): void {
    // Still step an empty game: the tick counter is the clock, and a player
    // joining mid-game should not see it restart.
    const { players, actors } = game.match.step();
    if (players.length === 0 && actors.length === 0) {
      return;
    }
    this.net.sendEach(game.id, (id) => encodePacket(MessageType.snapshot, game.match.snapshotFor(id, players)));
    // SHOTTRACE: off unless SHOT_TRACE is set, and then only to whoever fired.
    if (config.shotTrace) {
      sendShotTraces(this.net, game);
    }
  }
}

@singleton()
export class TickLoop extends FixedRateLoop {
  protected loopDuration = 1000 / config.tickRate;

  constructor(@inject(GameTick) private readonly tick: GameTick) {
    super();
  }

  protected async loopIteration(): Promise<void> {
    this.tick.run();
  }
}
