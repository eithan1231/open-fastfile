// The pass that notices: enough people to start, a countdown that has run out, a
// player whose tab has been shut.
//
// A LoopBase and not a setInterval, for the reason that base class exists: the
// api's shutdown is then the same operation as a game server's, and a pass that
// took longer than its period cannot queue another behind it. The matchmaker
// itself owns no timer, which is what lets a test step it by hand.

import { inject, singleton } from "tsyringe";
import { LoopBase } from "@3d/shared/lifecycle/loop.js";
import { Config } from "../config.js";
import { Matchmaker } from "./matchmaker.js";

@singleton()
export class MatchmakingLoop extends LoopBase {
  protected loopDuration: number;

  constructor(
    @inject(Matchmaker) private readonly matchmaker: Matchmaker,
    @inject(Config) config: Config,
  ) {
    super();
    this.loopDuration = config.matchmakingIntervalMs;
  }

  protected async loopIteration(): Promise<void> {
    this.matchmaker.tick();
  }
}
