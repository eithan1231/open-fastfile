// What a game server is told to do. The api decides that a game exists and who
// is in it; an instance is told, and reports back when it is over.
//
// `hello` carries the same GameOrder shape as `gameCreate` so that a reconnect
// reconciles against exactly what it would have been told one at a time. An
// instance holds nothing that survives it, so the authority's list wins.

import * as z from "zod/mini";
import { LOADOUT_COUNT } from "../../sim/loadout.js";
import { loadoutSchema } from "../routes/loadouts.js";

export const gameOrderPlayer = z.object({
  /** The id the api issued in the lobby. The player presents it on the wire. */
  id: z.string().check(z.minLength(1)),
  /** Proof that this player is the one the api put on this roster. */
  authorizationKey: z.string().check(z.minLength(1)),
  /**
   * All of this player's classes, as the authority stores them — weapons and
   * attachments by name, and nothing resolved.
   *
   * All of them, because a player chooses one in the match (`chooseClass` on the
   * wire names it by index), and a server that only knew the one chosen in the
   * menu could not honour that. By index rather than by content, so what a player
   * spawns with is always a class the api stored for them.
   *
   * Sent with the roster rather than fetched, because an instance reads nothing
   * off the api's disk and holds nothing that outlives a game; and left
   * unresolved because the instance has its own catalogue and reconciles against
   * that when it equips the player (`Player.equipLoadout`).
   */
  loadouts: z.array(loadoutSchema).check(z.maxLength(LOADOUT_COUNT)),
});
export type GameOrderPlayer = z.infer<typeof gameOrderPlayer>;

export const gameOrder = z.object({
  gameId: z.string().check(z.minLength(1)),
  /** The world. An instance hosts one, so this must match the one it loaded. */
  map: z.string().check(z.minLength(1)),
  /**
   * The rules: an id in `GAMETYPES`, which both the authority and the instance
   * compile in. A name rather than the declaration itself — the table is the one
   * definition, and sending a copy of it would let the two disagree about what a
   * gametype *is* while agreeing about its name.
   *
   * An instance that does not know the name refuses the game and keeps running,
   * the same way it refuses a map it cannot load.
   */
  gametype: z.string().check(z.minLength(1)),
  /** This game's cap, not the instance's: one process hosts several games. */
  maxPlayers: z.number().check(z.int(), z.positive()),
  durationSeconds: z.number().check(z.positive()),
  players: z.array(gameOrderPlayer),
});
export type GameOrder = z.infer<typeof gameOrder>;

/** Everything this instance should be running, sent first on every connection. */
export const helloEvent = z.object({
  type: z.literal("hello"),
  games: z.array(gameOrder),
});

export const gameCreateEvent = z.object({
  type: z.literal("gameCreate"),
  game: gameOrder,
});

/** The api has finished with a game. An instance ends its own too — see game-server's games.ts. */
export const gameEndEvent = z.object({
  type: z.literal("gameEnd"),
  gameId: z.string().check(z.minLength(1)),
});

export const serverEvent = z.discriminatedUnion("type", [helloEvent, gameCreateEvent, gameEndEvent]);
export type ServerEvent = z.infer<typeof serverEvent>;
