// What a class is, in one line: shared by Create a Class and the in-match class
// menu, which both describe a class under the list they pick it from.

import { LOADOUT_GAMES, type Loadout, type UiWeapon } from "../../app/uiBridge.js";

/** The name a game is shown by (`MW3`), or the catalogue's own id for one the menu does not list. */
export function gameName(game: string | null): string | null {
  return game === null ? null : (LOADOUT_GAMES.find((one) => one.id === game)?.name ?? game);
}

/** "MW3 — ACR / USP .45": the game, then the primary and the secondary, or what is missing. */
export function classSummary(loadout: Loadout, weapons: readonly UiWeapon[]): string {
  const game = gameName(loadout.game);
  if (game === null) {
    return "No game chosen yet.";
  }
  const name = (id: string | null) => (id === null ? "Nothing" : (weapons.find((w) => w.id === id)?.name ?? "Nothing"));
  return `${game} — ${name(loadout.primary.weapon)} / ${name(loadout.secondary.weapon)}`;
}
