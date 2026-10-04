// The numbers a match keeps that every client reads: each player's points and
// the gametype's counters. The server's to change
// (`ServerContext`), every end's to read (`GameView`, `PlayerView.points`), and
// carried in the snapshot as state — so a late joiner and a lost datagram
// converge on the next one, and a HUD needs no event to be told a round began.
//
// The bounds are the wire's (net/messages/player.ts, snapshot.ts), and here so a
// script is refused a value where it asks for it rather than halfway through
// encoding a snapshot the whole room was waiting for.

import type { GametypeDecl } from "./gametypes/declaration.js";

/** The most points one player can hold: twenty bits, a little over a million. */
export const MAX_POINTS = 2 ** 20 - 1;

/** The most counters a gametype may declare: the snapshot's four-bit count. */
export const MAX_COUNTERS = 15;

/** A counter, as the wire carries it: a signed 24-bit integer. */
export const MATCH_VALUE_MIN = -(2 ** 23);
export const MATCH_VALUE_MAX = 2 ** 23 - 1;

/**
 * Where a counter is in its gametype's `counters`, which is where the snapshot
 * carries it. A name the gametype does not declare throws, as `setTeam` does for
 * a side: a counter silently read as zero is a wrong answer nothing would report.
 */
export function counterIndex(decl: GametypeDecl, name: string): number {
  const index = decl.counters?.indexOf(name) ?? -1;
  if (index < 0) {
    throw new Error(`gametype "${decl.id}" declares no counter "${name}"`);
  }
  return index;
}

/** Whether `value` is a whole number the wire can carry as a counter. */
export function isMatchValue(value: number): boolean {
  return Number.isInteger(value) && value >= MATCH_VALUE_MIN && value <= MATCH_VALUE_MAX;
}
