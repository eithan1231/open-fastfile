// What a round costs, as arithmetic: the weapon's falloff, the location it
// landed on, and the gametype's scale.
//
// Every fixture here is deliberately away from 1. A location multiplier of 1.0
// and a `damageScale` of 1.0 would make a reader that dropped either of them
// agree with one that did not, so the numbers below are 0.8, 1.5 and 0.5 — and a
// wrong answer is a different number rather than the same one.

import { describe, expect, it } from "vitest";
import { DEFAULT_COMBAT_RULES, shotDamage, UNSPECIFIED_DAMAGE, type CombatRules } from "../src/game/rules.js";
import type { WeaponDef } from "../src/sim/weaponDef.js";
import { weaponDef } from "../testing/weaponDef.js";

/** CoD units to the metre. The ranges below are written as metres times this, so the metre figure is the readable one. */
const UNITS_PER_M = 39.37;

/** Full damage to 10 m, minimum past 30 m. An M4's own window is 20 m to 36 m. */
const NEAR = 10;
const FAR = 30;

const armed = (over: Partial<WeaponDef> = {}): WeaponDef =>
  weaponDef({
    damage: { max: 40, min: 20, maxRange: NEAR * UNITS_PER_M, minRange: FAR * UNITS_PER_M },
    locationDamage: { head: 1.5, torsoUpper: 0.8, gun: 0 },
    ...over,
  });

/** Half damage, so a reader that ignored the gametype's scale gets a different number everywhere. */
const rules: CombatRules = { ...DEFAULT_COMBAT_RULES, damageScale: 0.5 };

describe("what a round costs", () => {
  it("is the weapon's damage, times the location, times the gametype's scale", () => {
    // 40 × 0.8 × 0.5. Each factor is visible in the answer: drop the location and
    // it is 20, drop the scale and it is 32.
    expect(shotDamage(armed(), "torsoUpper", 5, rules)).toBeCloseTo(16, 6);
    expect(shotDamage(armed(), "head", 5, rules)).toBeCloseTo(30, 6);

    // `gun` is 0 in the games and means it: a round stopped by somebody's rifle
    // costs nothing. That is a real multiplier and not a missing one.
    expect(shotDamage(armed(), "gun", 5, rules)).toBe(0);

    // A location the weapon file did not mention is 1 rather than 0 — absent means
    // "this game did not say", and IW6 says nothing about any of them.
    expect(shotDamage(armed(), "neck", 5, rules)).toBeCloseTo(20, 6);
  });

  it("falls off between the two ranges, and the ranges are in CoD units", () => {
    const def = armed();
    // Inside `maxRange`: the maximum, all the way in to the muzzle.
    expect(shotDamage(def, "torsoUpper", 0, rules)).toBeCloseTo(16, 6);
    expect(shotDamage(def, "torsoUpper", NEAR, rules)).toBeCloseTo(16, 6);

    // Past `minRange`: the minimum, 20 × 0.8 × 0.5. This is also the assertion
    // that the ranges are inches and not metres — read as metres, 30 m would sit
    // well inside a 394 m window and this would still be 16.
    expect(shotDamage(def, "torsoUpper", FAR, rules)).toBeCloseTo(8, 6);
    expect(shotDamage(def, "torsoUpper", 200, rules)).toBeCloseTo(8, 6);

    // And in between it interpolates. Halfway is 30 × 0.8 × 0.5, which a step
    // function would answer with either 16 or 8 — the whole reason this line is
    // here rather than only the two ends.
    expect(shotDamage(def, "torsoUpper", (NEAR + FAR) / 2, rules)).toBeCloseTo(12, 6);
    expect(shotDamage(def, "torsoUpper", NEAR + (FAR - NEAR) / 4, rules)).toBeCloseTo(14, 6);
  });

  it("gives a weapon that declared no ballistics an ordinary rifle's damage rather than none", () => {
    // `weaponDef()` carries no `damage` block at all, which is what a format-3
    // GLB and every hand-built definition look like. Zero would be a weapon that
    // fires, reloads, runs dry and never hurts anybody.
    const silent = weaponDef();
    expect(silent.damage).toBeUndefined();
    expect(shotDamage(silent, "torsoUpper", 5, rules)).toBeCloseTo(UNSPECIFIED_DAMAGE * 0.5, 6);
    expect(shotDamage(silent, "torsoUpper", 5, rules)).toBeGreaterThan(0);

    // Far away too: with no ranges there is no falloff to apply, rather than a
    // division by zero to propagate.
    expect(shotDamage(silent, "torsoUpper", 500, rules)).toBeCloseTo(UNSPECIFIED_DAMAGE * 0.5, 6);
    expect(shotDamage(undefined, "torsoUpper", 5, rules)).toBeCloseTo(UNSPECIFIED_DAMAGE * 0.5, 6);
  });

  it("treats a weapon that named a maximum and nothing else as having no falloff", () => {
    // `damage` is spelled `damage` in a weapon file and `max` here; a file that
    // carries only that must not lose its damage past an unstated range.
    const flat = weaponDef({ damage: { max: 55 } });
    expect(shotDamage(flat, "torsoUpper", 0, rules)).toBeCloseTo(27.5, 6);
    expect(shotDamage(flat, "torsoUpper", 500, rules)).toBeCloseTo(27.5, 6);

    // A window with its ends the wrong way round is the same case, not a NaN.
    const inverted = weaponDef({ damage: { max: 40, min: 20, maxRange: 1000, minRange: 400 } });
    expect(shotDamage(inverted, "torsoUpper", 50, rules)).toBeCloseTo(20, 6);
  });
});
