// The catalogue as the class menu lists it.
//
// One thing here is a judgement rather than a reading, and it is the reason
// these exist: the catalogue holds the game's own localisation keys, and turning
// `WEAPON_M4_CARBINE` into "M4 Carbine" is a guess about capitalisation that is
// right for every weapon in two games and would be wrong for a three-letter word
// that is not an abbreviation.

import { describe, expect, it } from "vitest";
import { WeaponRegistry, type WeaponEntry } from "@3d/shared/sim/weaponRegistry.js";
import { readableName, weaponChoices } from "../src/app/weaponChoices.js";

const def = (weapon: string) =>
  ({
    game: "iw5",
    weapon,
    gun: weapon,
    roles: {},
    clips: {},
    times: {},
    clipSize: 30,
    fireType: "Full Auto",
    boltAction: false,
    roundsPerLoad: 0,
    adsZoomFov: 50,
    adsOverlay: null,
    motion: {},
    hideBones: [],
  }) as WeaponEntry["def"];

function entry(id: string, over: Partial<WeaponEntry> = {}): WeaponEntry {
  return { id, game: "iw5", def: def(id), attachments: [], ...over };
}

describe("naming a weapon", () => {
  it("reads a localisation key as words", () => {
    expect(readableName("WEAPON_M4_CARBINE", "iw5_m4_mp")).toBe("M4 Carbine");
    expect(readableName("WEAPON_DESERT_EAGLE", "deserteagle_mp")).toBe("Desert Eagle");
  });

  /** ACOG, FMJ, SMG and MP5 are abbreviations; a rule about length is what keeps them shouting. */
  it("leaves a short word in capitals", () => {
    expect(readableName("WEAPON_ACOG_ATTACHMENT", "acog")).toBe("ACOG");
    expect(readableName("WEAPON_FMJ", "fmj")).toBe("FMJ");
    expect(readableName("WEAPON_MP5", "mp5")).toBe("MP5");
  });

  it("falls back to the weapon's own name when there is no key", () => {
    expect(readableName("", "iw5_m4_mp")).toBe("m4");
    expect(readableName("Already A Name", "iw5_scar_mp")).toBe("scar");
  });
});

describe("listing what a class may name", () => {
  const registry = new WeaponRegistry([
    entry("iw5_usp45_mp", { display: "WEAPON_USP_45", slot: "secondary", class: "pistol" }),
    entry("iw5_m4_mp", { display: "WEAPON_M4_CARBINE", slot: "primary", class: "rifle", attachments: [{ id: "acog", display: "WEAPON_ACOG_ATTACHMENT" }] }),
    entry("iw5_ak47_mp", { display: "WEAPON_AK47", slot: "primary", class: "rifle" }),
  ]);

  /** The catalogue's own order is by id, which groups by game; a player picking a primary wants the rifles together. */
  it("groups by the source game's class rather than by id", () => {
    expect(weaponChoices(registry).map((w) => w.name)).toEqual(["AK47", "M4 Carbine", "USP 45"]);
    expect(weaponChoices(registry).map((w) => w.kind)).toEqual(["rifle", "rifle", "pistol"]);
  });

  it("carries the catalogue id, because that is what a class stores", () => {
    expect(weaponChoices(registry)[1]!.id).toBe("iw5/iw5_m4_mp");
  });

  it("names each weapon's attachments too", () => {
    expect(weaponChoices(registry)[1]!.attachments).toEqual([{ id: "acog", name: "ACOG" }]);
  });
});
