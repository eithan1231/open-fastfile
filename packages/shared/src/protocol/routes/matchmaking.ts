// Looking for a game, and the stream that says what came of it.
//
// These routes only ever say "I asked". What actually happened — which lobby,
// who else is in it, when it starts, where to connect — arrives on the event
// stream, so there is one description of a lobby rather than a response body and
// an event that have to agree.

import * as z from "zod/mini";
import { userEvent } from "../events/user.js";
import { defineRoute, events, json } from "../route.js";
import { worldSlug } from "./worlds.js";

/** A private lobby's code is read out loud, so it is short and unambiguous. */
export const lobbyCode = z.string().check(z.minLength(4), z.maxLength(12), z.regex(/^[A-Z0-9]+$/, { error: "not a lobby code" }));

const ok = z.object({ ok: z.literal(true) });

export const lobbyRef = z.object({ code: lobbyCode });
export type LobbyRef = z.infer<typeof lobbyRef>;

/**
 * Public, not `user`, on purpose. EventSource reports a 401 as an `error` event
 * with no status — indistinguishable from a dropped connection — and then
 * reconnects on its own, forever, so an expired session would become a 401
 * flood nobody can see. The handler resolves the session itself and answers an
 * in-band `unauthenticated` event instead, which the reader can act on.
 */
export const userEventsRoute = defineRoute({
  method: "GET",
  path: "/api/events",
  auth: "public",
  result: events(userEvent),
});

export const queueJoinRoute = defineRoute({
  method: "POST",
  path: "/api/matchmaking/queue",
  auth: "user",
  result: json(ok),
});

export const queueLeaveRoute = defineRoute({
  method: "POST",
  path: "/api/matchmaking/queue/leave",
  auth: "user",
  result: json(ok),
});

/**
 * A private lobby: never filled by the queue, and started by whoever made it.
 *
 * The map is optional, and the client does not send one — a private match picks
 * its map *in* the lobby, so that everyone already there watches the host choose
 * rather than arriving at whatever was decided before they were invited.
 */
export const lobbyCreateRoute = defineRoute({
  method: "POST",
  path: "/api/lobbies",
  auth: "user",
  input: z.object({ map: z.optional(worldSlug) }),
  result: json(lobbyRef),
});

/** Choose the map. The host's, and refused once the countdown is running. */
export const lobbyMapRoute = defineRoute({
  method: "POST",
  path: "/api/lobbies/:code/map",
  auth: "user",
  params: z.object({ code: lobbyCode }),
  input: z.object({ map: worldSlug }),
  result: json(ok),
});

/**
 * Choose the rules. The host's, and refused once the countdown is running.
 *
 * A separate route from the map rather than one "settings" body, because the two
 * are refused for different reasons and a partial failure of a combined write has
 * no good answer: a host who picked a valid gametype and an invalid map should not
 * lose the gametype.
 */
export const lobbyGametypeRoute = defineRoute({
  method: "POST",
  path: "/api/lobbies/:code/gametype",
  auth: "user",
  params: z.object({ code: lobbyCode }),
  input: z.object({ gametype: z.string().check(z.minLength(1)) }),
  result: json(ok),
});

export const lobbyJoinRoute = defineRoute({
  method: "POST",
  path: "/api/lobbies/:code/join",
  auth: "user",
  params: z.object({ code: lobbyCode }),
  result: json(lobbyRef),
});

export const lobbyStartRoute = defineRoute({
  method: "POST",
  path: "/api/lobbies/:code/start",
  auth: "user",
  params: z.object({ code: lobbyCode }),
  result: json(ok),
});

/**
 * Stop what a private lobby is doing: a countdown goes back to waiting, and a
 * running game ends for everyone in it, who land back in the lobby. The host's,
 * so that a private match can change its map without everyone having to leave.
 */
export const lobbyEndRoute = defineRoute({
  method: "POST",
  path: "/api/lobbies/:code/end",
  auth: "user",
  params: z.object({ code: lobbyCode }),
  result: json(ok),
});

/** No code: a player is in at most one lobby, and the provider knows which. */
export const lobbyLeaveRoute = defineRoute({
  method: "POST",
  path: "/api/lobbies/leave",
  auth: "user",
  result: json(ok),
});

export const MATCHMAKING_ROUTES = {
  userEvents: userEventsRoute,
  queueJoin: queueJoinRoute,
  queueLeave: queueLeaveRoute,
  lobbyCreate: lobbyCreateRoute,
  lobbyJoin: lobbyJoinRoute,
  lobbyMap: lobbyMapRoute,
  lobbyGametype: lobbyGametypeRoute,
  lobbyStart: lobbyStartRoute,
  lobbyEnd: lobbyEndRoute,
  lobbyLeave: lobbyLeaveRoute,
} as const;
