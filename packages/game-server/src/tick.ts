// The fixed tick: every game steps, every player in each is sent the verdict.
//
// A FixedRateLoop rather than a plain one, because the rate is a contract. Every
// client is told it in its `joined` and accumulates against it, so 60 Hz has to
// mean 60 steps a second — a loop that slept its period *after* the work would
// run slower than realtime and every client would drift against a server that
// thought it was keeping up. See @3d/shared/lifecycle/loop.ts.

import { inject, singleton } from "tsyringe";
import { config } from "./config.js";
import { FixedRateLoop } from "@3d/shared/lifecycle/loop.js";
import { NetServer } from "./net/server.js";

@singleton()
export class TickLoop extends FixedRateLoop {
  protected loopDuration = 1000 / config.tickRate;

  constructor(@inject(NetServer) private readonly net: NetServer) {
    super();
  }

  protected async loopIteration(): Promise<void> {
    this.net.tick();
  }
}
