// The weapon catalogue as the class menu needs it: a list of things to pick,
// with names a player can read.
//
// The catalogue holds the game's own localisation keys (`WEAPON_M4_CARBINE`,
// `WEAPON_ACOG_ATTACHMENT`) because the pipeline does not dump the localized
// strings — see scripts/cod/catalog.py. Turning one into words is a display
// decision, so it happens here, on the app's side of the bridge, and the UI is
// handed something it can print.
//
// Deliberately not a lookup table of real names. A table would have to carry
// every weapon of every game the importer supports and would be wrong the first
// time one was added; the key already says the name, in capitals, and this only
// has to stop it shouting.

import type { UiAttachment, UiWeapon } from "./uiBridge.js";
import type { WeaponEntry, WeaponRegistry } from "@3d/shared/sim/weaponRegistry.js";
import { weaponCategory } from "@3d/shared/sim/weaponCategory.js";

/** Up to this many letters, a word is taken for an abbreviation and left in capitals. */
const ABBREVIATION = 4;

/** Words the game's own keys wrap a name in. */
const PREFIX = "WEAPON_";
const SUFFIXES = ["_ATTACHMENT", "_SCOPE_ATTACHMENT"];

/**
 * A localisation key as a name: `WEAPON_M4_CARBINE` is "M4 Carbine".
 *
 * A short word or one with a digit in it stays in capitals, which is what keeps
 * ACOG, FMJ, SCAR, MP5 and L96A1 from becoming Acog, Fmj, Scar, Mp5 and L96a1.
 * It is a rule about abbreviations and it is wrong for a short word that is not
 * one — "GRIP" stays shouting — which costs nothing here, because every surface
 * that shows these uppercases them anyway.
 */
export function readableName(key: string, fallback: string): string {
  let text = key.trim();
  if (!text.startsWith(PREFIX)) {
    return prettyId(fallback);
  }
  text = text.slice(PREFIX.length);
  for (const suffix of SUFFIXES) {
    if (text.endsWith(suffix)) {
      text = text.slice(0, -suffix.length);
    }
  }
  const words = text.split("_").filter(Boolean);
  if (words.length === 0) {
    return prettyId(fallback);
  }
  return words.map((word) => (word.length <= ABBREVIATION || /\d/.test(word) ? word : word[0] + word.slice(1).toLowerCase())).join(" ");
}

/** A weapon's own name as a last resort: `iw5_m4_mp` is "m4". Better than nothing and obviously derived. */
function prettyId(id: string): string {
  const parts = id.split("_").filter((part) => part !== "mp" && !/^iw\d$/.test(part) && part !== "t5");
  return parts.join(" ") || id;
}

function weaponChoice(entry: WeaponEntry): UiWeapon {
  const id = `${entry.game}/${entry.id}`;
  return {
    id,
    name: readableName(entry.display ?? "", entry.id),
    game: entry.game,
    kind: entry.class ?? "",
    slot: entry.slot ?? null,
    category: weaponCategory(entry),
    attachments: entry.attachments.map((attachment): UiAttachment => ({ id: attachment.id, name: readableName(attachment.display ?? "", attachment.id) })),
  };
}

/** Primaries first, then secondaries, then anything the exporter could not place. */
const SLOT_RANK: Record<string, number> = { primary: 0, secondary: 1 };

/**
 * Every weapon a class may name, in the order the menu lists them: by the slot
 * they belong in, then by the source game's class, then by name.
 *
 * Not the catalogue's own order, which is by id and so groups by game — a player
 * picking a primary wants every rifle together, not every Modern Warfare 2
 * weapon together.
 */
export function weaponChoices(registry: WeaponRegistry): UiWeapon[] {
  const rank = (weapon: UiWeapon) => SLOT_RANK[weapon.slot ?? ""] ?? 2;
  return registry.order
    .map((id) => registry.entry(id))
    .filter((entry): entry is WeaponEntry => entry !== undefined)
    .map(weaponChoice)
    .sort((a, b) => rank(a) - rank(b) || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}
