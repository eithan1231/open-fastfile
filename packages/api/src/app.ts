// The api, as one Hono app assembled from its route groups.
//
// Separate from the process (server.ts) so a test can mount it with
// `app.request()` and no socket — which is also how @3d/game-server's
// integration test runs against the real routes.
//
// Every route is mounted from its declaration in @3d/shared/protocol/routes/. A
// handler answers the question and nothing else: no path spelling, no status
// codes for a malformed request, no auth check of its own. routes/mount.ts does
// all of that from the declaration.
//
// The order below is a real constraint in exactly one place, and it is the last
// line: the client bundle answers `/*`, so anything registered after it would
// never be reached. The rest are disjoint and listed in the order a reader wants
// them.

import { Hono } from "hono";
import { inject, singleton } from "tsyringe";
import { AuthRoutes } from "./routes/auth.js";
import { CatalogRoutes } from "./routes/catalog.js";
import { ClientRoutes } from "./routes/client.js";
import { GameRoutes } from "./routes/games.js";
import { HealthRoutes } from "./routes/health.js";
import { LoadoutRoutes } from "./routes/loadouts.js";
import { MatchmakingRoutes } from "./routes/matchmaking.js";
import { ServerRoutes } from "./routes/servers.js";
import { WorldRoutes } from "./routes/worlds.js";

@singleton()
export class App {
  readonly hono = new Hono();

  constructor(
    @inject(HealthRoutes) health: HealthRoutes,
    @inject(WorldRoutes) worlds: WorldRoutes,
    @inject(CatalogRoutes) catalog: CatalogRoutes,
    @inject(AuthRoutes) auth: AuthRoutes,
    @inject(ServerRoutes) servers: ServerRoutes,
    @inject(LoadoutRoutes) loadouts: LoadoutRoutes,
    @inject(MatchmakingRoutes) matchmaking: MatchmakingRoutes,
    @inject(GameRoutes) gamesRoutes: GameRoutes,
    @inject(ClientRoutes) client: ClientRoutes,
  ) {
    for (const group of [health, worlds, catalog, auth, loadouts, servers, matchmaking, gamesRoutes, client]) {
      group.register(this.hono);
    }
  }
}
