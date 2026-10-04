// The weapon catalogue: the one place an id becomes a weapon.
//
// What these guard is agreement between two ends that never meet. A snapshot
// names a weapon by its *index* here, so an order that differs by one puts the
// wrong gun in a player's hands and nothing throws — which is why the order is
// derived rather than taken as given, and why the hash exists at all.

import { describe, expect, it } from "vitest";
import type { WeaponDef } from "../src/sim/weaponDef.js";
import { Player } from "../src/sim/player.js";
import type { CapsuleWorld } from "../src/sim/capsule.js";
import {
  MAX_ATTACHMENT_SLOTS,
  WeaponRegistry,
  fittedIds,
  fittedSlots,
  resolveWeapon,
  sameFitted,
  weaponKey,
  type WeaponEntry,
} from "../src/sim/weaponRegistry.js";

/** The catalogue address of a test entry: ids are qualified by game. */
const key = (id: string, game = "iw5") => weaponKey({ game, id });

function def(name: string, over: Partial<WeaponDef> = {}): WeaponDef {
  return {
    game: "iw5",
    weapon: name,
    gun: `${name}_gun`,
    roles: { idle: "idle_clip" },
    clips: { idle_clip: { duration: 1, looped: true, notes: [] } },
    times: {},
    clipSize: 30,
    fireType: "Full Auto",
    boltAction: false,
    roundsPerLoad: 0,
    adsZoomFov: 50,
    adsOverlay: null,
    motion: {},
    // The M4's own numbers, so a merge test has a real cone to lose part of.
    damage: { max: 42, min: 20, maxRange: 800, minRange: 1400 },
    spread: { ads: 0, hipStandMin: 3.5, hipStandMax: 7 },
    locationDamage: { head: 1.4, torsoUpper: 1, gun: 0 },
    shotCount: 1,
    weaponType: "bullet",
    weaponClass: "rifle",
    penetrateType: "medium",
    hideBones: ["tag_sight_off"],
    ...over,
  };
}

function entry(id: string, attachments: WeaponEntry["attachments"] = []): WeaponEntry {
  return { id, game: "iw5", def: def(id), attachments };
}

describe("catalogue order", () => {
  /** Two ends may read the catalogue from different sources; only the ids are shared. */
  it("is sorted by id, whatever order the entries arrive in", () => {
    const forwards = new WeaponRegistry([entry("a"), entry("b"), entry("c")]);
    const backwards = new WeaponRegistry([entry("c"), entry("a"), entry("b")]);
    expect(forwards.order).toEqual([key("a"), key("b"), key("c")]);
    expect(backwards.order).toEqual(forwards.order);
  });

  it("gives the same hash for the same weapons in a different order", () => {
    expect(new WeaponRegistry([entry("a"), entry("b")]).hash).toBe(new WeaponRegistry([entry("b"), entry("a")]).hash);
  });

  it("gives a different hash once a weapon is added", () => {
    expect(new WeaponRegistry([entry("a")]).hash).not.toBe(new WeaponRegistry([entry("a"), entry("b")]).hash);
  });

  /** Otherwise ["ab","c"] and ["a","bc"] would agree, and a rename would go unnoticed. */
  it("does not confuse two catalogues whose ids run together the same way", () => {
    expect(new WeaponRegistry([entry("ab"), entry("c")]).hash).not.toBe(new WeaponRegistry([entry("a"), entry("bc")]).hash);
  });

  /**
   * A snapshot names an attachment by its slot the way it names a weapon by its
   * index, so a catalogue built from a different attachment dump puts a silencer
   * where the far end draws a scope. The digest has to cover both orders.
   */
  it("changes when a weapon's attachments do, not only when a weapon is added", () => {
    const bare = new WeaponRegistry([entry("m4")]).hash;
    const scoped = new WeaponRegistry([entry("m4", [{ id: "acog" }])]).hash;
    const swapped = new WeaponRegistry([entry("m4", [{ id: "acog" }, { id: "grip" }])]).hash;
    const reordered = new WeaponRegistry([entry("m4", [{ id: "grip" }, { id: "acog" }])]).hash;
    expect(new Set([bare, scoped, swapped, reordered]).size).toBe(4);
  });

  it("hashes an empty catalogue to something both ends agree on", () => {
    expect(new WeaponRegistry([]).hash).toBe(new WeaponRegistry([]).hash);
  });

  it("refuses two weapons sharing an id rather than losing one", () => {
    expect(() => new WeaponRegistry([entry("a"), entry("a")])).toThrow(/share the id/);
  });

  it("refuses a weapon with more attachments than the wire can carry", () => {
    const tooMany = Array.from({ length: MAX_ATTACHMENT_SLOTS + 1 }, (_, i) => ({ id: `a${i}` }));
    expect(() => new WeaponRegistry([entry("a", tooMany)])).toThrow(/the wire carries/);
  });
});

describe("index and id", () => {
  const registry = new WeaponRegistry([entry("a"), entry("b")]);

  it("round-trips a weapon through its index", () => {
    expect(registry.idAt(registry.indexOf(key("b")))).toBe(key("b"));
  });

  it("has no index for a weapon it does not hold", () => {
    expect(registry.indexOf("missing")).toBeNull();
    expect(registry.idAt(99)).toBeNull();
  });

  it("carries null through in both directions: an empty-handed player", () => {
    expect(registry.indexOf(null)).toBeNull();
    expect(registry.idAt(null)).toBeNull();
  });

  it("builds a weapon by id, and nothing for one it does not hold", () => {
    expect(registry.build(key("a"))?.def.weapon).toBe("a");
    expect(registry.build("missing")).toBeUndefined();
    expect(registry.build(null)).toBeUndefined();
  });
});

describe("attachments", () => {
  const scope = { id: "acog", hideBones: ["tag_sight_on"], overrides: { adsZoomFov: 35 } };
  const grip = { id: "grip", overrides: { fireType: "Single Shot" } };
  const rifle = entry("m4", [scope, grip]);

  it("leaves a bare weapon exactly as the catalogue holds it", () => {
    expect(resolveWeapon(rifle, [])).toBe(rifle.def);
  });

  it("applies the fields a fitted attachment overrides", () => {
    expect(resolveWeapon(rifle, [0]).adsZoomFov).toBe(35);
    expect(resolveWeapon(rifle, [1]).fireType).toBe("Single Shot");
  });

  it("adds hidden joints rather than replacing the weapon's own", () => {
    expect(resolveWeapon(rifle, [0]).hideBones).toEqual(["tag_sight_off", "tag_sight_on"]);
  });

  it("never mutates the catalogue's own definition", () => {
    resolveWeapon(rifle, [0, 1]);
    expect(rifle.def.adsZoomFov).toBe(50);
    expect(rifle.def.hideBones).toEqual(["tag_sight_off"]);
  });

  /** Both ends derive their numbers from this, so it has to be a function of its arguments alone. */
  it("gives the same answer every time for the same fitted set", () => {
    expect(resolveWeapon(rifle, [0, 1])).toEqual(resolveWeapon(rifle, [0, 1]));
  });

  /**
   * The wire carries a list, and a list has an order a mask did not. Two ends
   * that disagreed about which attachment won a field would put different
   * numbers on the same gun, so the list's order must not be able to say.
   */
  it("applies attachments in catalogue order however the fitted list is written", () => {
    const both = entry("m4", [
      { id: "a", overrides: { fireType: "first" } },
      { id: "b", overrides: { fireType: "second" } },
    ]);
    expect(resolveWeapon(both, [0, 1]).fireType).toBe("second");
    expect(resolveWeapon(both, [1, 0]).fireType).toBe("second");
  });

  it("ignores a repeated slot and one the weapon does not offer", () => {
    expect(resolveWeapon(rifle, [0, 0, 9]).adsZoomFov).toBe(35);
    expect(fittedIds(rifle, [0, 0, 9])).toEqual(["acog"]);
  });

  it("round-trips ids through their slots", () => {
    expect(fittedIds(rifle, fittedSlots(rifle, ["grip", "acog"]))).toEqual(["acog", "grip"]);
  });

  it("ignores an attachment this weapon does not offer", () => {
    expect(fittedSlots(rifle, ["silencer"])).toEqual([]);
  });

  /** A scope owns the ADS times and a grip the reload times; fitting both has to keep each. */
  it("merges roles, times and motion key by key rather than replacing them", () => {
    const both = entry("m4", [
      { id: "acog", overrides: { times: { adsIn: 0.4 }, roles: { adsUp: "scoped_up" }, motion: { hipIdleAmount: 2 } } },
      { id: "grip", overrides: { times: { reload: 2.5 }, roles: { reload: "grip_reload" }, motion: { hipIdleSpeed: 9 } } },
    ]);
    const fitted = resolveWeapon(both, [0, 1]);
    expect(fitted.times).toEqual({ ...both.def.times, adsIn: 0.4, reload: 2.5 });
    expect(fitted.roles).toEqual({ ...both.def.roles, adsUp: "scoped_up", reload: "grip_reload" });
    expect(fitted.motion).toEqual({ ...both.def.motion, hipIdleAmount: 2, hipIdleSpeed: 9 });
  });

  /**
   * The view kick rides in `motion` and so merges with it, which is why it needed
   * no branch of its own. It is worth its own test anyway: it is ten keys a server
   * judges a shot by, and an attachment naming one of them outright — a grip that
   * only slows the recentring — must not take the other nine with it and leave
   * the weapon with no recoil at all.
   */
  it("keeps the rest of a weapon's view kick when an attachment names one number of it", () => {
    const rifleWith = entry("m4", [{ id: "grip", overrides: { motion: { adsViewKickCenterSpeed: 1900 } } }]);
    rifleWith.def.motion = {
      adsViewKickPitchMin: -20,
      adsViewKickPitchMax: 50,
      adsViewKickYawMin: 40,
      adsViewKickYawMax: -40,
      adsViewKickCenterSpeed: 1350,
    };
    const fitted = resolveWeapon(rifleWith, [0]);
    expect(fitted.motion.adsViewKickCenterSpeed).toBe(1900);
    expect(fitted.motion.adsViewKickPitchMax).toBe(50);
    expect(fitted.motion.adsViewKickYawMin).toBe(40);
    expect(Object.keys(fitted.motion).sort()).toEqual(Object.keys(rifleWith.def.motion).sort());
  });

  /**
   * And so do the numbers a server judges a shot by. An attachment names one
   * figure of a block — a silencer takes damage off, a grip tightens the hip
   * cone — and replacing the block instead leaves the rest of it absent: a
   * silenced M4 with no hip maximum and no falloff range at all, which reads as
   * a weapon whose game never said, not as a mistake.
   */
  it("merges damage, spread and locationDamage key by key rather than replacing them", () => {
    const both = entry("m4", [
      { id: "silencer", overrides: { damage: { min: 15 }, spread: { hipStandMin: 4 } } },
      { id: "fmj", overrides: { locationDamage: { head: 1.6 } } },
    ]);
    const fitted = resolveWeapon(both, [0, 1]);
    expect(fitted.damage).toEqual({ ...both.def.damage, min: 15 });
    expect(fitted.spread).toEqual({ ...both.def.spread, hipStandMin: 4 });
    expect(fitted.locationDamage).toEqual({ ...both.def.locationDamage, head: 1.6 });
  });

  /**
   * Slot order settles everything but this. Modern Warfare 2's own 806
   * two-attachment weapon files say a grip keeps its reload clip and a sight
   * keeps its ADS clips, whichever way round the two are fitted.
   */
  it("gives a fitted optic the aiming clips and the other attachment everything else", () => {
    // In the catalogue order the exporter writes: an optic before the grip, so
    // that the grip wins the slot order and the rule above hands the ADS back.
    const both = entry("mg4", [
      { id: "reflex", type: "scope", overrides: { roles: { reload: "optic_reload", adsUp: "optic_up" } } },
      { id: "grip", type: "underbarrel", overrides: { roles: { reload: "grip_reload", adsUp: "grip_up" } } },
    ]);
    expect(resolveWeapon(both, [0]).roles).toMatchObject({ reload: "optic_reload", adsUp: "optic_up" });
    expect(resolveWeapon(both, [1]).roles).toMatchObject({ reload: "grip_reload", adsUp: "grip_up" });
    expect(resolveWeapon(both, [0, 1]).roles).toMatchObject({ reload: "grip_reload", adsUp: "optic_up" });
  });

  /**
   * The scope picture goes the way the aiming clips do, and for the same reason
   * — but it is one field, so an underbarrel sitting later in the slot order
   * must not be able to take it. Modern Warfare 2 ships the answers:
   * `barrett_acog_mp` has no overlay and `barrett_thermal_mp` has the thermal
   * one, on a rifle whose own is `scope_overlay_m40a3`.
   */
  it("lets a fitted optic take the scope picture away or replace it, whatever else is on the gun", () => {
    const sniper = entry("barrett", [
      { id: "acog", type: "scope", overrides: { adsOverlay: null } },
      { id: "thermal", type: "scope", overrides: { adsOverlay: "scope_overlay_m14_night" } },
      { id: "grip", type: "underbarrel", overrides: { times: { reload: 3 } } },
    ]);
    sniper.def = { ...sniper.def, adsOverlay: "scope_overlay_m40a3" };
    expect(resolveWeapon(sniper, []).adsOverlay).toBe("scope_overlay_m40a3");
    expect(resolveWeapon(sniper, [0]).adsOverlay).toBeNull();
    expect(resolveWeapon(sniper, [1]).adsOverlay).toBe("scope_overlay_m14_night");
    // A grip changes the handling and never what the player looks through.
    expect(resolveWeapon(sniper, [2]).adsOverlay).toBe("scope_overlay_m40a3");
    expect(resolveWeapon(sniper, [0, 2]).adsOverlay).toBeNull();
  });

  /** Modern Warfare 2 carries every attachment's mesh on the one gun model and hides what is not fitted. */
  it("reveals the joints an attachment shows, and lets a second attachment hide one of its own", () => {
    const carried = entry("m4", [
      { id: "eotech", showBones: ["tag_sight_off"], hideBones: ["tag_sight_on"] },
      { id: "grip", showBones: ["tag_foregrip"] },
    ]);
    expect(resolveWeapon(carried, [0]).hideBones).toEqual(["tag_sight_on"]);
    expect(resolveWeapon(carried, [1]).hideBones).toEqual(["tag_sight_off"]);
    expect(resolveWeapon(carried, [0, 1]).hideBones).toEqual(["tag_sight_on"]);
  });

  it("compares two fitted sets by what they name, not by how they are written", () => {
    expect(sameFitted([0, 1], [1, 0])).toBe(true);
    expect(sameFitted([0], [0, 1])).toBe(false);
    expect(sameFitted([0], [1])).toBe(false);
  });

  it("builds a weapon with its attachments applied", () => {
    const registry = new WeaponRegistry([rifle]);
    expect(registry.build(key("m4"), fittedSlots(rifle, ["acog"]))?.def.adsZoomFov).toBe(35);
  });
});

describe("a player's weapon in their state", () => {
  const registry = new WeaponRegistry([entry("ak"), entry("m4")]);
  const nowhere = { ready: true, resolveCapsule: () => undefined } as unknown as CapsuleWorld;

  it("names the weapon it holds, by catalogue index", () => {
    const player = new Player(nowhere, registry);
    player.equipById(key("m4"));
    expect(player.snapshot().weaponIndex).toBe(registry.indexOf(key("m4")));
    expect(player.weaponId).toBe(key("m4"));
  });

  it("names none when empty-handed", () => {
    const player = new Player(nowhere, registry);
    expect(player.snapshot().weaponIndex).toBeNull();
  });

  /**
   * The whole point of the phase: before this, `restore` applied a weapon's
   * state to whatever was already in hand, so a peer who switched guns kept
   * firing the old one on everybody else's screen.
   */
  it("rebuilds a peer's weapon when the snapshot names a different one", () => {
    const them = new Player(nowhere, registry);
    them.equipById(key("ak"));

    const us = new Player(nowhere, registry);
    us.equipById(key("m4"));
    us.restore(them.snapshot());

    expect(us.weaponId).toBe(key("ak"));
  });

  it("keeps the weapon, and its running state, when the snapshot names the same one", () => {
    const them = new Player(nowhere, registry);
    them.equipById(key("m4"));
    them.weapon!.reload();

    const us = new Player(nowhere, registry);
    us.equipById(key("m4"));
    const before = us.weapon;
    us.restore(them.snapshot());

    expect(us.weapon).toBe(before);
    expect(us.weapon!.data.state).toBe(them.weapon!.data.state);
  });

  it("disarms a peer whose snapshot says they hold nothing", () => {
    const them = new Player(nowhere, registry);
    const us = new Player(nowhere, registry);
    us.equipById(key("m4"));
    us.restore(them.snapshot());
    expect(us.weaponId).toBeNull();
  });

  it("carries the fitted attachments too, so a peer's gun is built the same way", () => {
    const scoped = entry("m4", [{ id: "acog", overrides: { adsZoomFov: 35 } }]);
    const withScope = new WeaponRegistry([scoped]);

    const them = new Player(nowhere, withScope);
    them.equipById(key("m4"), [0]);

    const us = new Player(nowhere, withScope);
    us.restore(them.snapshot());

    expect(us.snapshot().attachments).toEqual([0]);
    expect(us.weapon!.def.adsZoomFov).toBe(35);
  });

  /** A server re-anchoring to a client's claim has no weapon half to restore. */
  it("is left alone by a re-anchor", () => {
    const player = new Player(nowhere, registry);
    player.equipById(key("m4"));
    player.reanchor(player.snapshot().movement);
    expect(player.weaponId).toBe(key("m4"));
  });

  /** Without a catalogue there is no index to send, and none to rebuild from. */
  it("names no weapon at all without a registry, rather than guessing one", () => {
    const player = new Player(nowhere);
    player.equip(registry.build(key("m4")), key("m4"));
    expect(player.weaponId).toBe(key("m4"));
    expect(player.snapshot().weaponIndex).toBeNull();
  });
});

describe("loadout slots", () => {
  const rifle = { ...entry("m4"), slot: "primary" as const, class: "rifle" };
  const pistol = { ...entry("usp"), slot: "secondary" as const, class: "pistol" };
  const launcher = { ...entry("rpg"), slot: "secondary" as const, class: "rocketlauncher" };
  const registry = new WeaponRegistry([rifle, pistol, launcher]);

  it("groups weapons by the slot they go in", () => {
    expect(registry.inSlot("primary").map((e) => e.id)).toEqual(["m4"]);
    expect(registry.inSlot("secondary").map((e) => e.id)).toEqual(["rpg", "usp"]);
  });

  /** A weapon catalogued from a world's GLB has no weapon file, so it has no slot. */
  it("leaves a weapon with no slot out of both", () => {
    const mixed = new WeaponRegistry([rifle, entry("unknown")]);
    expect(mixed.inSlot("primary").map((e) => e.id)).toEqual(["m4"]);
    expect(mixed.inSlot("secondary")).toHaveLength(0);
  });
});

describe("two games shipping one name", () => {
  /**
   * Not hypothetical: `at4_mp`, `javelin_mp`, `rpg_mp`, `stinger_mp` and
   * `riotshield_mp` are each in both Modern Warfare 2's and 3's catalogues, with
   * different numbers. Keyed by name alone, one would quietly replace the other.
   */
  const mw2 = { ...entry("at4_mp"), game: "iw4" };
  const mw3 = { ...entry("at4_mp"), game: "iw5" };
  const registry = new WeaponRegistry([mw2, mw3]);

  it("keeps both, addressed by game", () => {
    expect(registry.size).toBe(2);
    expect(registry.order).toEqual(["iw4/at4_mp", "iw5/at4_mp"]);
  });

  it("builds the one the id names, not the other", () => {
    expect(registry.entry("iw4/at4_mp")?.game).toBe("iw4");
    expect(registry.entry("iw5/at4_mp")?.game).toBe("iw5");
  });

  it("still refuses a genuine duplicate — the same weapon of the same game twice", () => {
    expect(() => new WeaponRegistry([mw3, { ...mw3 }])).toThrow(/share the id "iw5\/at4_mp"/);
  });

  /** A world's viewmodel filename says the name and not the game, so this must not guess. */
  it("will not resolve a bare name two games share", () => {
    expect(registry.resolveName("at4_mp")).toBeNull();
  });

  it("resolves a bare name only one game ships", () => {
    const mixed = new WeaponRegistry([mw2, { ...entry("acr_mp"), game: "iw5" }]);
    expect(mixed.resolveName("acr_mp")).toBe("iw5/acr_mp");
    expect(mixed.resolveName("nothing_mp")).toBeNull();
  });
});
