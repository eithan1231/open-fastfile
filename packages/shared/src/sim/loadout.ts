// A class: the two weapons a player spawns carrying, and what is fitted to each.
//
// Plain data, like everything else in sim/. The api stores one of these per slot
// per user, the client edits them, and a game order carries the chosen one to
// whichever instance is hosting — so this is the one description of what a
// player brings to a match, and all three ends are built from it.
//
// **Attachments are named here, not numbered.** A snapshot carries a fitted
// attachment as its slot in the weapon's list, because it goes out sixty times a
// second (net/messages/player.ts); a stored class carries ids, because it
// outlives the catalogue that gave those slots their numbers. Rebuilding the
// catalogue renumbers the slots and must not silently refit anybody's gun.
// `fittedSlots` is the one place the two meet.

import type { AttachmentId, WeaponId } from "./weaponRegistry.js";

/**
 * The two weapons a class carries, in the order they are held.
 *
 * The order is the format: `PlayerState.swapping` says "the other one", which is
 * only unambiguous while there are two. A third would need a slot on the wire.
 */
export const LOADOUT_SLOTS = ["primary", "secondary"] as const;
export type LoadoutSlot = (typeof LOADOUT_SLOTS)[number];

/** One weapon in a class: which, and what is fitted to it. */
export interface LoadoutWeapon {
  /** A catalogue id, or null for a slot left empty. */
  weapon: WeaponId | null;
  /** Attachment ids, in no significant order — `resolveWeapon` applies them in the catalogue's. */
  attachments: AttachmentId[];
}

/**
 * The games a class may be built from, in the order the menu offers them. A class
 * belongs to one, and carries only that game's weapons (`mayCarry`), so a player
 * is built as a soldier of one game rather than from parts of five.
 */
export const LOADOUT_GAMES = [
  { id: "iw4", name: "MW2" },
  { id: "iw5", name: "MW3" },
  { id: "t5", name: "BO1" },
  { id: "s1", name: "AW" },
  { id: "iw6", name: "Ghosts" },
] as const;

/** One of a player's classes. */
export interface Loadout {
  /** What the player called it. Theirs to choose, so it is not an id and nothing keys by it. */
  name: string;
  /** The game it is built from, as a catalogue game (`iw4`); null until one is chosen, and then it carries nothing. */
  game: string | null;
  primary: LoadoutWeapon;
  secondary: LoadoutWeapon;
}

/** How many classes a player has. */
export const LOADOUT_COUNT = 5;

/**
 * How many attachments one weapon in a class may carry.
 *
 * Below the wire's own cap (MAX_FITTED_ATTACHMENTS) on purpose: the wire says
 * what can be represented and this says what the game allows, and the two are
 * different questions. Call of Duty's answer is two, with the perk; this is one
 * until there is a reason for the second.
 */
export const MAX_LOADOUT_ATTACHMENTS = 1;

/** The longest a class's name may be. Long enough for "Silenced Assault", short enough to draw. */
export const LOADOUT_NAME_MAX = 24;

export function emptyLoadoutWeapon(): LoadoutWeapon {
  return { weapon: null, attachments: [] };
}

/** The class a player has before they have made one: named by its place, carrying nothing. */
export function defaultLoadout(index: number): Loadout {
  return { name: `Class ${index + 1}`, game: null, primary: emptyLoadoutWeapon(), secondary: emptyLoadoutWeapon() };
}

/** A player's five, as they start out. */
export function defaultLoadouts(): Loadout[] {
  return Array.from({ length: LOADOUT_COUNT }, (_, i) => defaultLoadout(i));
}

/** The two weapons of a class in the order they are held. */
export function loadoutWeapons(loadout: Loadout): [LoadoutWeapon, LoadoutWeapon] {
  return [loadout.primary, loadout.secondary];
}
