// Which category of Create a Class a weapon is listed under, and which slot of a
// class that category belongs to.
//
// Ours rather than the games': the categories are the ones this menu offers, the
// same for every game, and a weapon's slot follows from its category rather than
// from what its source game did (Modern Warfare 2 carried shotguns as
// secondaries; here a shotgun is a primary in every game).
//
// Derived from what the catalogue does hold — the weapon file's `weaponClass`,
// plus a scope overlay — because the games' own create-a-class categories live
// in their menu files and stats tables, which the pipeline does not dump. Where
// that is not enough (a machine pistol is filed as an SMG, a sniper rifle as a
// rifle, a riot shield as a rifle) the weapon is named in OVERRIDES below.
//
// Shared, because three ends ask it and must agree: the menu lists by it, the
// api refuses a class that breaks it, and a game server equips by it.

import type { WeaponEntry } from "./weaponRegistry.js";

export const WEAPON_CATEGORIES = ["smg", "assault", "shotgun", "lmg", "sniper", "handgun", "machinePistol", "special"] as const;
export type WeaponCategory = (typeof WEAPON_CATEGORIES)[number];

export const CATEGORY_LABEL: Record<WeaponCategory, string> = {
  smg: "SMG",
  assault: "Assault Rifle",
  shotgun: "Shotgun",
  lmg: "LMG",
  sniper: "Sniper Rifle",
  handgun: "Handgun",
  machinePistol: "Machine Pistol",
  special: "Special",
};

/** The slot each category is carried in. */
export const CATEGORY_SLOT: Record<WeaponCategory, "primary" | "secondary"> = {
  smg: "primary",
  assault: "primary",
  shotgun: "primary",
  lmg: "primary",
  sniper: "primary",
  handgun: "secondary",
  machinePistol: "secondary",
  special: "secondary",
};

/** The source game's `weaponClass`, as a category, where that is the whole answer. */
const BY_CLASS: Record<string, WeaponCategory> = {
  rifle: "assault",
  smg: "smg",
  spread: "shotgun",
  mg: "lmg",
  sniper: "sniper",
  pistol: "handgun",
  rocketlauncher: "special",
};

/**
 * The weapons `weaponClass` files wrongly for this menu, by catalogue key. `null`
 * keeps one out of Create a Class altogether.
 *
 * - Machine pistols: filed as SMGs (and MW2's Raffica as a pistol), carried here
 *   as secondaries, as Modern Warfare 2 and 3 carried them.
 * - Riot shields, knives and the explosive crossbow: filed as rifles, SMGs and
 *   pistols, and none of them is one — Special.
 * - MW3's Dragunov is a rifle with no scope overlay of its own, and a sniper in
 *   MW3's menu.
 * - Ghosts' minigun is the Juggernaut's, a killstreak and never a class weapon.
 */
const OVERRIDES: Record<string, WeaponCategory | null> = {
  "iw4/glock_mp": "machinePistol",
  "iw4/tmp_mp": "machinePistol",
  "iw4/pp2000_mp": "machinePistol",
  "iw4/beretta393_mp": "machinePistol",
  "iw4/riotshield_mp": "special",
  "iw5/iw5_g18_mp": "machinePistol",
  "iw5/iw5_skorpion_mp": "machinePistol",
  "iw5/iw5_fmg9_mp": "machinePistol",
  "iw5/iw5_mp9_mp": "machinePistol",
  "iw5/iw5_riotshield_mp": "special",
  "iw5/riotshield_mp": "special",
  "iw5/iw5_dragunov_mp": "sniper",
  "iw6/iw6_riotshield_mp": "special",
  "iw6/iw6_knifeonly_mp": "special",
  "iw6/iw6_minigun_mp": null,
  "s1/iw5_combatknife_mp": "special",
  "t5/crossbow_explosive_mp": "special",
  // Black Ops II's menu (`mp/statstable.csv`) files the crossbow as special, the
  // Peacekeeper (a `rifle`) as an SMG, and the Executioner (`pistol spread`) as a pistol.
  "t6/crossbow_mp": "special",
  "t6/peacekeeper_mp": "smg",
  "t6/judge_mp": "handgun",
};

/**
 * Which category a weapon is listed under, or null for one Create a Class does
 * not offer — an override says so, or its `weaponClass` is one this menu has no
 * category for.
 *
 * A rifle with a scope overlay is a sniper: Black Ops files every sniper rifle as
 * `rifle`, and the overlay is the thing that makes one.
 */
export function weaponCategory(entry: Pick<WeaponEntry, "game" | "id" | "class" | "def">): WeaponCategory | null {
  const key = `${entry.game}/${entry.id}`;
  if (key in OVERRIDES) {
    return OVERRIDES[key]!;
  }
  if (entry.class === "rifle" && entry.def.adsOverlay) {
    return "sniper";
  }
  return BY_CLASS[entry.class ?? ""] ?? null;
}

/**
 * Whether a class of `game` may carry this weapon in `slot`: it is offered, its
 * category belongs in that slot, and it comes from that game.
 *
 * The one rule, asked by the menu, the api and a game server alike. A class with
 * no game carries nothing: the game is chosen first.
 */
export function mayCarry(entry: Pick<WeaponEntry, "game" | "id" | "class" | "def">, slot: "primary" | "secondary", game: string | null): boolean {
  const category = weaponCategory(entry);
  return game !== null && entry.game === game && category !== null && CATEGORY_SLOT[category] === slot;
}
