// The fleet's own surface: how a game server is told to host a game, and how it
// says one is over.
//
// `/internal/*` and `auth: "service"`, like the heartbeat beside it. The
// heartbeat says an instance is alive and how loaded it is; this stream says
// what it should be doing. Both are needed, and in that order — an instance the
// api has never heard of cannot be given work.

import * as z from "zod/mini";
import { serverEvent } from "../events/server.js";
import { defineRoute, events, json } from "../route.js";

const ok = z.object({ ok: z.literal(true) });

/**
 * The commands for one instance. `serverId` is a routing label, not a
 * permission: the service token is what authenticates the caller, so an id the
 * registry has not seen yet still opens — an instance that heartbeats and
 * subscribes in the same breath must not race itself into a 404.
 */
export const gameServerEventsRoute = defineRoute({
  method: "GET",
  path: "/internal/game-servers/:serverId/events",
  auth: "service",
  params: z.object({ serverId: z.string().check(z.minLength(1)) }),
  result: events(serverEvent),
});

/** The instance has the game standing and is ready for its players to arrive. */
export const gameReadyRoute = defineRoute({
  method: "POST",
  path: "/internal/games/:gameId/ready",
  auth: "service",
  params: z.object({ gameId: z.string().check(z.minLength(1)) }),
  result: json(ok),
});

/**
 * A game is over. `ended` is a game that ran its course; `refused` is one this
 * instance would not or could not host (full, a map that would not load, a
 * gametype it does not know, a game that threw) — the lobby reopens at once and
 * is placed elsewhere next. A real result (scores, a winner) lands in this body.
 */
export const gameReportRequest = z.object({
  status: z.enum(["ended", "refused"]),
  /** Why, in a sentence, for the api's log. */
  reason: z.optional(z.string()),
});
export type GameReportRequest = z.infer<typeof gameReportRequest>;

export const gameReportRoute = defineRoute({
  method: "POST",
  path: "/internal/games/:gameId/report",
  auth: "service",
  params: z.object({ gameId: z.string().check(z.minLength(1)) }),
  input: gameReportRequest,
  result: json(ok),
});

export const GAME_ROUTES = {
  gameServerEvents: gameServerEventsRoute,
  gameReady: gameReadyRoute,
  gameReport: gameReportRoute,
} as const;
