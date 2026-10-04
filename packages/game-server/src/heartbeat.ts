// Telling the authority this instance is alive, and what it is hosting.
//
// The registry expires an entry that stops heartbeating rather than waiting to be
// told it is gone, because the failure worth surviving is the one where this
// process does not get to say goodbye. So this loop is what keeps the instance
// listed, and a few seconds of it is all a crashed server costs.
//
// What it reports, it asks the container for. There used to be a callback handed
// in at boot to describe this instance, which is the shape a passed-around
// context takes when the pieces it names are singletons anyway.

import { inject, singleton } from "tsyringe";
import type { GameServerInfo } from "@3d/shared/protocol/routes/servers.js";
import { Api } from "./api.js";
import { config } from "./config.js";
import { Games } from "./games.js";
import { Identity } from "./identity.js";
import { LoopBase } from "@3d/shared/lifecycle/loop.js";
import { WorldRegistry } from "./worlds.js";

/** Comfortably inside the registry's timeout, so one lost round-trip is not a delisting. */
const INTERVAL_MS = 10_000;

@singleton()
export class Heartbeat extends LoopBase {
  protected loopDuration = INTERVAL_MS;

  constructor(
    @inject(Api) private readonly api: Api,
    @inject(Identity) private readonly identity: Identity,
    @inject(Games) private readonly games: Games,
    @inject(WorldRegistry) private readonly worlds: WorldRegistry,
  ) {
    super();
  }

  /** This instance as the registry lists it, and as the matchmaker places games on it. */
  describe(): GameServerInfo {
    return {
      id: this.identity.id,
      url: config.publicUrl,

      // The maps already loaded here. A hint the matchmaker prefers, never a
      // filter: this instance will load anything it is ordered to host.
      worlds: this.worlds.loaded,
      players: this.games.players,
      maxPlayers: config.maxPlayers,
      maxGames: config.maxGames,
      games: this.games.count,
    };
  }

  protected async loopIteration(): Promise<void> {
    try {
      await this.api.client.heartbeat(this.describe());
    } catch (e) {
      // Not fatal: the api may be restarting, and the next beat re-registers. A
      // game server that stopped hosting because the menu could not list it
      // would be the worse failure. Swallowed here rather than thrown, so
      // LoopBase does not log a stack for something this ordinary.
      if (this.started) {
        console.warn(`heartbeat failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
}
