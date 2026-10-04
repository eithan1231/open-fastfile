// Every route the api serves, in one table, and the one client over it.
//
// This file is the index: the declarations live in routes/, the mechanism that
// turns them into a client or a set of handlers is ./route.ts, and what is left
// here is which routes exist and what each is called. A method name in the table
// is the name both the client's callers and the api's own mounting use, so
// `api.health()` and the handler behind it cannot come apart.
//
// Adding a route is a declaration under routes/ and a line below. Nothing else
// has to be told: the client method appears with it, typed, and @3d/api fails to
// compile until something mounts it.

import { createRouteClient, type RouteClient, type RouteClientOptions } from "./route.js";
import { AUTH_ROUTES } from "./routes/auth.js";
import { CATALOG_ROUTES } from "./routes/catalog.js";
import { GAME_ROUTES } from "./routes/games.js";
import { healthRoute } from "./routes/health.js";
import { LOADOUT_ROUTES } from "./routes/loadouts.js";
import { MATCHMAKING_ROUTES } from "./routes/matchmaking.js";
import { heartbeatRoute, serverListRoute } from "./routes/servers.js";
import { WORLD_ROUTES } from "./routes/worlds.js";

export const API_ROUTES = {
  health: healthRoute,
  servers: serverListRoute,
  heartbeat: heartbeatRoute,
  ...AUTH_ROUTES,
  ...MATCHMAKING_ROUTES,
  ...LOADOUT_ROUTES,
  ...GAME_ROUTES,
  ...WORLD_ROUTES,
  ...CATALOG_ROUTES,
} as const;

export type ApiRoutes = typeof API_ROUTES;

/** One method per route, each parsing what comes back — bar the event streams, which have none. See ./route.ts. */
export type ApiClient = RouteClient<ApiRoutes>;

export type ApiClientOptions = RouteClientOptions;

export function createApiClient(options: ApiClientOptions): ApiClient {
  return createRouteClient(API_ROUTES, options);
}
