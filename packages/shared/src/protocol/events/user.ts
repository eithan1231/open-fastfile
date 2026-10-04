// What a signed-in player hears between games: the lobby they are standing in,
// and the one event that takes them into a match.
//
// One shape serves both ends, as routes/servers.ts does — the api publishes
// through this schema and the browser parses through it, so a field added at one
// end and not the other fails at the boundary naming the field, rather than three
// layers deeper as an `undefined`.

import * as z from "zod/mini";

export const lobbyVisibility = z.enum(["public", "private"]);
export type LobbyVisibility = z.infer<typeof lobbyVisibility>;

/** `open` is waiting or counting down; `closed` means its game is running. */
export const lobbyStatus = z.enum(["open", "closed"]);
export type LobbyStatus = z.infer<typeof lobbyStatus>;

export const lobbyPlayer = z.object({
  /** The player's id in this lobby, and the id they will carry on the wire. */
  id: z.string().check(z.minLength(1)),
  username: z.string().check(z.minLength(1)),
  host: z.boolean(),
});
export type LobbyPlayer = z.infer<typeof lobbyPlayer>;

/**
 * The whole lobby, every time, never a delta. EventSource reconnects on its own
 * and nothing here replays what was missed, so a snapshot is what makes a
 * reconnect self-healing instead of a permanently wrong roster.
 */
export const lobbyEvent = z.object({
  type: z.literal("lobby"),
  code: z.string().check(z.minLength(1)),
  visibility: lobbyVisibility,
  /** Settled when the countdown arms, so players see the map for the whole window. */
  map: z.nullable(z.string()),
  /**
   * The rules, as an id in `GAMETYPES`. Never null: a lobby opens with a default,
   * because there is no such thing as a game with no rules.
   */
  gametype: z.string().check(z.minLength(1)),
  status: lobbyStatus,
  /**
   * When the round starts, as an absolute unix-ms instant — not a remaining
   * count. The client ticks its own countdown off one event, instead of the api
   * pushing one a second to everyone in every lobby.
   */
  startsAt: z.nullable(z.number()),
  players: z.array(lobbyPlayer),
});

/** Queued, but not in a lobby yet. */
export const searchingEvent = z.object({
  type: z.literal("searching"),
  since: z.number(),
});

/** Everything needed to reach the match: where to connect, and who to say you are. */
export const matchReadyEvent = z.object({
  type: z.literal("matchReady"),
  gameId: z.string().check(z.minLength(1)),
  playerId: z.string().check(z.minLength(1)),
  authorizationKey: z.string().check(z.minLength(1)),
  /** A whole URL, for the reason GameServerInfo.url is one. */
  serverUrl: z.string().check(z.minLength(1)),
  map: z.string().check(z.minLength(1)),
  /**
   * The lobby's gametype, as `joined` will name it: the world is built for its
   * mode (which `mode:` models and solids exist) before the channel is open.
   */
  gametype: z.string().check(z.minLength(1)),
});

/** Out of the queue and out of any lobby. */
export const leftEvent = z.object({ type: z.literal("left") });

/**
 * No session on the stream. Sent in-band rather than answered 401 because
 * EventSource cannot tell a 401 from a dropped connection and would reconnect
 * forever; the reader closes the stream on this instead.
 */
export const unauthenticatedEvent = z.object({ type: z.literal("unauthenticated") });

/**
 * This player opened another stream — another tab, another browser — and that
 * one is theirs now. The api closes this stream after it; the reader must not
 * reconnect, or the two tabs would take the player from each other forever.
 */
export const displacedEvent = z.object({ type: z.literal("displaced") });

export const userEvent = z.discriminatedUnion("type", [lobbyEvent, searchingEvent, matchReadyEvent, leftEvent, unauthenticatedEvent, displacedEvent]);
export type UserEvent = z.infer<typeof userEvent>;
