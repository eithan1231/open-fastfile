// Which game servers are live.
//
// In memory, and so only true of this process: one authority is the assumption
// for now, and a fleet of them would need a store both could see. Say so here
// rather than discovering it when the second one is deployed.
//
// Entries expire rather than being removed on shutdown, because the failure that
// matters is the one where a game server does not get to say goodbye. Expiry is
// lazy — checked on read — so that nothing in this file owns a timer, and the
// one loop this process does run is the matchmaker's.

import { inject, singleton } from "tsyringe";
import type { GameServerInfo } from "@3d/shared/protocol/routes/servers.js";
import { Clock } from "./clock.js";

/** Missing this many heartbeats drops a server. Three is enough to ride out one slow round-trip. */
export const HEARTBEAT_TIMEOUT_MS = 30_000;

interface Entry {
  info: GameServerInfo;
  seenAt: number;
}

@singleton()
export class Registry {
  private readonly entries = new Map<string, Entry>();

  constructor(@inject(Clock) private readonly clock: Clock) {}

  /** Record a heartbeat. Returns how long the entry now lives for, which is what the sender is told. */
  heartbeat(info: GameServerInfo): number {
    this.entries.set(info.id, { info, seenAt: this.clock.now() });
    return HEARTBEAT_TIMEOUT_MS / 1000;
  }

  /** Every server that has heartbeated recently enough, oldest expiry last. */
  live(): GameServerInfo[] {
    const cutoff = this.clock.now() - HEARTBEAT_TIMEOUT_MS;
    const live: GameServerInfo[] = [];
    for (const [id, entry] of this.entries) {
      if (entry.seenAt < cutoff) {
        this.entries.delete(id);
      } else {
        live.push(entry.info);
      }
    }
    return live;
  }
}
