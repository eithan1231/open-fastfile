// Which game servers are live: the list a player picks a match from, and the
// heartbeat that puts an instance on it.
//
// One shape serves both directions. What an instance says about itself is exactly
// what a client is told about it, which is why there is no separate request type
// to keep in step.

import * as z from "zod/mini";
import { defineRoute, json } from "../route.js";

export const gameServerInfo = z.object({
  id: z.string().check(z.minLength(1)),
  /**
   * Where a browser should connect, as a whole URL. Not a host and a port: a
   * fleet behind one reverse proxy is reached by path, and one with a
   * certificate each is reached by name, and this field has to survive either.
   * See docs/server/README.md.
   */
  url: z.string().check(z.minLength(1)),
  /**
   * The maps this instance already has loaded. A placement *hint*, not a filter:
   * an instance loads whatever it is ordered to host (game-server/src/worlds.ts),
   * so the matchmaker prefers a server that has the map but is free to use any
   * server with room. An empty list is an idle instance, not an unusable one.
   */
  worlds: z.array(z.string()),
  players: z.number().check(z.int(), z.nonnegative()),
  maxPlayers: z.number().check(z.int(), z.positive()),
  /**
   * Games this instance will host at once, and how many it holds now — standing
   * or still loading. The cap it refuses an order by, so the matchmaker places by
   * the same rule rather than discovering it from a refusal.
   */
  maxGames: z.number().check(z.int(), z.positive()),
  games: z.number().check(z.int(), z.nonnegative()),
});
export type GameServerInfo = z.infer<typeof gameServerInfo>;

export const serverListResponse = z.object({ servers: z.array(gameServerInfo) });
export type ServerListResponse = z.infer<typeof serverListResponse>;

/** What a game server sends to say it is alive and what it is hosting. */
export const heartbeatRequest = gameServerInfo;
export type HeartbeatRequest = z.infer<typeof heartbeatRequest>;

export const heartbeatResponse = z.object({
  ok: z.literal(true),
  /** How long the authority will keep this entry without another heartbeat. */
  expiresInSeconds: z.number().check(z.positive()),
});
export type HeartbeatResponse = z.infer<typeof heartbeatResponse>;

/**
 * The fleet, as the matchmaker sees it. `service` rather than public: a player is
 * handed the one server their match is on, in their `matchReady` event, so the
 * browser has no reason to enumerate every instance — and every reason not to be
 * able to.
 */
export const serverListRoute = defineRoute({
  method: "GET",
  path: "/api/servers",
  auth: "service",
  result: json(serverListResponse),
});

/** `/internal/*` is the fleet's own surface, and `auth: "service"` is what says so. A browser never calls this. */
export const heartbeatRoute = defineRoute({
  method: "POST",
  path: "/internal/game-servers/heartbeat",
  auth: "service",
  input: heartbeatRequest,
  result: json(heartbeatResponse),
});
