// Which instance a lobby's game goes on.
//
// A heartbeat is up to ten seconds old and knows nothing of what the matchmaker
// has promised since, so placing by it alone hands every lobby armed in one tick
// the same server. What this process has promised it knows exactly: every lobby
// with a `serverId` is a game on that server, counting down, ordered, or running.
// A server's load is the larger of the two accounts for games already ordered —
// the heartbeat sees games this api never ordered (it restarted), the lobbies see
// games the heartbeat has not caught up with — plus the countdowns, which only
// the lobbies know of.
//
// Players are reserved the same way against `maxPlayers`. It is a soft cap the
// instance does not enforce, but it is the one an operator sets to stop a loaded
// box being handed work, and a lobby's players all arrive at once.

import { inject, singleton } from "tsyringe";
import type { GameServerInfo } from "@3d/shared/protocol/routes/servers.js";
import { Clock } from "../clock.js";
import { Registry } from "../registry.js";
import { Lobbies, type Lobby } from "./lobbies.js";

/** How long a server that refused a lobby's game is passed over for that lobby. */
export const REFUSAL_AVOID_MS = 30_000;

@singleton()
export class Placement {
  /** lobby code → server id → until when that lobby avoids it. */
  private readonly avoided = new Map<string, Map<string, number>>();

  constructor(
    @inject(Registry) private readonly registry: Registry,
    @inject(Lobbies) private readonly lobbies: Lobbies,
    @inject(Clock) private readonly clock: Clock,
  ) {}

  /**
   * A live instance with room for this lobby's game, preferring one that already
   * has the map loaded. A preference and not a filter: an instance loads whatever
   * it is ordered to host, so filtering would mean a fleet that cannot host a map
   * until it is already hosting it.
   */
  pick(lobby: Lobby, map: string): GameServerInfo | undefined {
    const free = this.registry.live().filter((server) => !this.avoids(lobby, server.id) && this.fits(server, lobby));
    return free.find((server) => server.worlds.includes(map)) ?? free[0];
  }

  /** Whether the server this lobby reserved is still live and still has its room. Asked at commit. */
  holds(lobby: Lobby): boolean {
    const server = this.registry.live().find((candidate) => candidate.id === lobby.serverId);
    return server !== undefined && this.fits(server, lobby);
  }

  /** This server would not host this lobby's game: place its next one elsewhere, for a while. */
  refused(lobby: Lobby, serverId: string): void {
    // Swept here, so a lobby that was dropped does not keep its entry for ever.
    for (const [code, servers] of this.avoided) {
      for (const [id, until] of servers) {
        if (until <= this.clock.now()) {
          servers.delete(id);
        }
      }
      if (servers.size === 0) {
        this.avoided.delete(code);
      }
    }
    const avoided = this.avoided.get(lobby.code) ?? new Map<string, number>();
    avoided.set(serverId, this.clock.now() + REFUSAL_AVOID_MS);
    this.avoided.set(lobby.code, avoided);
  }

  private avoids(lobby: Lobby, serverId: string): boolean {
    const until = this.avoided.get(lobby.code)?.get(serverId);
    return until !== undefined && until > this.clock.now();
  }

  /** Room for `lobby` on `server`, counting every other lobby already promised to it. */
  private fits(server: GameServerInfo, lobby: Lobby): boolean {
    let ordered = 0;
    let orderedPlayers = 0;
    let counting = 0;
    let countingPlayers = 0;
    for (const other of this.lobbies.all()) {
      if (other === lobby || other.serverId !== server.id) {
        continue;
      }
      if (other.status === "closed") {
        ordered++;
        orderedPlayers += other.users.length;
      } else {
        counting++;
        countingPlayers += other.users.length;
      }
    }
    const games = Math.max(server.games, ordered) + counting;
    const players = Math.max(server.players, orderedPlayers) + countingPlayers;
    return games < server.maxGames && players + lobby.users.length <= server.maxPlayers;
  }
}
