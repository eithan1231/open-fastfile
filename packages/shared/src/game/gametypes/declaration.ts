// What a gametype is, as data.
//
// Declaration and behaviour are split the way a route already is: `protocol/
// routes/` says what a route is and `api/src/routes/` implements it. So a
// gametype is declared here as plain data and its behaviour lives in a script
// beside it, which is what lets @3d/api validate a lobby's gametype and put it in
// a game order without importing a line of gameplay logic.
//
// No behaviour in this file, and nothing derived: a declaration is read by the
// api, by a game server and by a browser, and the three must agree about what a
// gametype *is* before any of them runs one.

import type { GameKey } from "../../dsl/resolved.js";

/** A gametype's name on the wire and in a lobby. */
export type GametypeId = string;

/**
 * A side.
 *
 * A free string rather than a union, and deliberately the same vocabulary the
 * maps already use: 9,463 `spawn` nodes across 42 worlds carry `team: "allies"`,
 * `"axis"`, `"attacker"` and `"defender"`, and a gametype's teams feed straight
 * into `spawnPoints(world, { mode, team })`. Inventing a second spelling here
 * would mean a table mapping one to the other.
 */
export type TeamId = string;

export interface GametypeDecl {
  readonly id: GametypeId;
  /** What a player sees in a lobby. */
  readonly display: string;
  /** What a lobby says it is, in a sentence, under its name. */
  readonly description?: string;
  /**
   * The sides, in the order a player is assigned to them.
   *
   * Empty means free-for-all: every player is their own side, and nothing asks
   * the map for a team's spawns.
   */
  readonly teams: readonly TeamId[];
  /**
   * The source game's own mode key (`tdm`, `dom`, `sd`, …), passed to
   * `spawnPoints`. Undefined takes any spawn the map offers.
   *
   * This is the largest piece of already-exported data nothing reads yet: every
   * imported map declares its spawns per mode and per side, and `Spawns.place`
   * asks for neither.
   */
  readonly spawnMode?: string;
  /**
   * The mode whose tagged world objects exist in this gametype: a `solid` or a
   * `model` carrying `mode:` is present only where it names this one
   * (`presentIn`). Undefined, as in Free Roam, has none of them.
   */
  readonly mode?: string;
  /**
   * The match-wide numbers a script keeps (`ServerContext.setCounter`) and every
   * client reads (`GameView.counter`) and the HUD shows: a round, a wave, a
   * number of flags left. Named here so both ends agree on their order, which is
   * how the snapshot carries them — values only, in this order. At most
   * `MAX_COUNTERS`; absent costs the snapshot four bits.
   */
  readonly counters?: readonly string[];
  /**
   * Whether each player keeps a purse of points (`ServerContext.addPoints`),
   * which the HUD shows. Off, a script asking for points throws: a number the
   * HUD never draws is a number nobody would notice going wrong.
   */
  readonly points?: boolean;
  /** Map slugs this gametype admits. Empty or absent means every map. */
  readonly maps?: readonly string[];
  /** Source games it admits. Empty or absent means every game. */
  readonly games?: readonly GameKey[];
}
