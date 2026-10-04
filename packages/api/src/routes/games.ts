// The fleet's side of a game: the orders an instance is given, and what it
// reports back.
//
// All three carry the service token, so none of them is reachable from a
// browser. What a *player* is told about the same game arrives on their own
// stream (routes/matchmaking.ts), because the authority publishes its decisions
// rather than answering with them.

import type { Hono } from "hono";
import { inject, singleton } from "tsyringe";
import type { ServerEvent } from "@3d/shared/protocol/events/server.js";
import { gameReadyRoute, gameReportRoute, gameServerEventsRoute } from "@3d/shared/protocol/routes/games.js";
import { eventStream } from "../events.js";
import { Matchmaker } from "../matchmaking/matchmaker.js";
import { Mount, type RouteGroup } from "./mount.js";

const ok = { ok: true as const };

@singleton()
export class GameRoutes implements RouteGroup {
  constructor(
    @inject(Mount) private readonly mount: Mount,
    @inject(Matchmaker) private readonly matchmaker: Matchmaker,
  ) {}

  register(app: Hono): void {
    /**
     * `serverId` is a routing label, not a permission: the service token is what
     * authenticates the caller. An instance that heartbeats and subscribes in the
     * same breath must not be able to race itself into a 404.
     */
    this.mount.route(app, gameServerEventsRoute, ({ params: { serverId }, c }) =>
      eventStream<ServerEvent>(c, (sink) => {
        sink.send(this.matchmaker.helloFor(serverId));
        return this.matchmaker.serverEvents.subscribe(serverId, sink);
      }),
    );

    // Neither of these 404s a game this process has never heard of. Lobbies live
    // in memory, so an api that restarted mid-match legitimately knows nothing
    // about a game an instance is still reporting, and that is not its fault.
    this.mount.route(app, gameReadyRoute, ({ params: { gameId } }) => {
      this.matchmaker.gameReady(gameId);
      return ok;
    });

    this.mount.route(app, gameReportRoute, ({ params: { gameId }, body }) => {
      if (body.status === "refused") {
        this.matchmaker.gameRefused(gameId, body.reason);
      } else {
        this.matchmaker.gameEnded(gameId);
      }
      return ok;
    });
  }
}
