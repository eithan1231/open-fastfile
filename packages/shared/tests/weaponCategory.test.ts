// Which category of Create a Class a weapon is listed under, and what a class may
// carry. The rule the menu lists by, the api stores by and a game server equips by.

import { describe, expect, it } from "vitest";
import { CATEGORY_SLOT, mayCarry, weaponCategory } from "../src/sim/weaponCategory.js";
import { weaponDef } from "../testing/weaponDef.js";

const weapon = (game: string, id: string, klass: string | undefined, overlay: string | null = null) => ({
  game,
  id,
  class: klass,
  def: { ...weaponDef({ weapon: id }), adsOverlay: overlay },
});

describe("a weapon's category", () => {
  it("follows the source game's class where that is the whole answer", () => {
    expect(weaponCategory(weapon("iw4", "m4_mp", "rifle"))).toBe("assault");
    expect(weaponCategory(weapon("iw4", "ump45_mp", "smg"))).toBe("smg");
    expect(weaponCategory(weapon("iw4", "spas12_mp", "spread"))).toBe("shotgun");
    expect(weaponCategory(weapon("iw4", "rpd_mp", "mg"))).toBe("lmg");
    expect(weaponCategory(weapon("iw4", "cheytac_mp", "sniper", "overlay"))).toBe("sniper");
    expect(weaponCategory(weapon("iw4", "usp_mp", "pistol"))).toBe("handgun");
    expect(weaponCategory(weapon("iw4", "rpg_mp", "rocketlauncher"))).toBe("special");
  });

  it("makes a scoped rifle a sniper, which is how Black Ops files every one", () => {
    expect(weaponCategory(weapon("t5", "psg1_mp", "rifle", "scope_overlay_psg1"))).toBe("sniper");
    expect(weaponCategory(weapon("t5", "ak47_mp", "rifle"))).toBe("assault");
  });

  it("takes the named exceptions over the class", () => {
    expect(weaponCategory(weapon("iw4", "glock_mp", "smg"))).toBe("machinePistol");
    expect(weaponCategory(weapon("iw4", "beretta393_mp", "pistol"))).toBe("machinePistol");
    expect(weaponCategory(weapon("iw6", "iw6_riotshield_mp", "rifle"))).toBe("special");
    expect(weaponCategory(weapon("iw5", "iw5_dragunov_mp", "rifle"))).toBe("sniper");
    expect(weaponCategory(weapon("t6", "crossbow_mp", "rifle"))).toBe("special");
    expect(weaponCategory(weapon("t6", "peacekeeper_mp", "rifle"))).toBe("smg");
    expect(weaponCategory(weapon("t6", "judge_mp", "pistol spread"))).toBe("handgun");
    // The Juggernaut's, and never a class weapon.
    expect(weaponCategory(weapon("iw6", "iw6_minigun_mp", "mg"))).toBeNull();
  });

  it("offers nothing for a class it has no category for, or none at all", () => {
    expect(weaponCategory(weapon("iw4", "c4_mp", "item"))).toBeNull();
    expect(weaponCategory(weapon("iw4", "world_gun", undefined))).toBeNull();
  });

  it("puts machine pistols and special beside handguns, as secondaries", () => {
    expect(CATEGORY_SLOT.machinePistol).toBe("secondary");
    expect(CATEGORY_SLOT.special).toBe("secondary");
    expect(CATEGORY_SLOT.shotgun).toBe("primary");
  });
});

describe("what a class may carry", () => {
  const m4 = weapon("iw5", "iw5_m4_mp", "rifle");
  const usp = weapon("iw5", "iw5_usp45_mp", "pistol");

  it("is its own game's weapons, each in its category's slot", () => {
    expect(mayCarry(m4, "primary", "iw5")).toBe(true);
    expect(mayCarry(usp, "secondary", "iw5")).toBe(true);
    expect(mayCarry(m4, "secondary", "iw5")).toBe(false);
    expect(mayCarry(usp, "primary", "iw5")).toBe(false);
  });

  it("is nothing from another game, and nothing at all before a game is chosen", () => {
    expect(mayCarry(m4, "primary", "iw4")).toBe(false);
    expect(mayCarry(m4, "primary", null)).toBe(false);
  });
});
