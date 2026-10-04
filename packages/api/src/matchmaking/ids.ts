// The three identifiers matchmaking mints, and why each is shaped as it is.

import { randomBytes } from "node:crypto";

/**
 * No O/0 or I/1: a private lobby's code is read out loud down a voice channel,
 * and the pair of characters people mishear is the pair worth not minting.
 */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;

/**
 * Lowercase too: this one is never typed, only carried. Never `#`, which starts
 * every bot id a game server mints (`@3d/shared/net/messages/fields.ts`).
 */
const PLAYER_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const PLAYER_ID_LENGTH = 8;

function pick(alphabet: string, length: number): string {
  // rejection-free because both alphabets divide 256 evenly enough that the bias
  // is irrelevant for an id nobody is guessing — the key below is the secret.
  const bytes = randomBytes(length);
  let out = "";
  for (const byte of bytes) {
    out += alphabet[byte % alphabet.length];
  }
  return out;
}

export const newLobbyCode = (): string => pick(CODE_ALPHABET, CODE_LENGTH);

/**
 * A player's id for one lobby and every game it plays — 8 ascii characters,
 * which is what the wire's `playerId` carries. Not the socket's id: this one
 * survives a reconnect, and it is what the game server checks a roster against.
 */
export const newPlayerId = (): string => pick(PLAYER_ALPHABET, PLAYER_ID_LENGTH);

/**
 * What a player presents to a game server to prove the api put them on that
 * roster. This one *is* a secret, so it comes from randomBytes whole rather than
 * from an alphabet.
 */
export const newAuthorizationKey = (): string => randomBytes(24).toString("base64url");
