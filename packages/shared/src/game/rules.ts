// What combat costs: the numbers a script sets, and the arithmetic the engine
// does with them.
//
// The split is Call of Duty's own rather than an analogy of it. The engine owns
// the health field, the trace and this arithmetic; a script owns the numbers and
// hears about the outcome through `playerDamage` and `playerDeath` —
// `Callback_PlayerDamage` and `Callback_PlayerKilled` over `_health.gsc`. So a
// gametype changes what a round costs without touching the thing that decides a
// round landed, and a match with no script at all still plays by the defaults
// below, exactly as `spawnFor` and `castFor` degrade to theirs.

import type { HitLocation } from "../sim/hitLocations.js";
import { unitsToMetres } from "../sim/units.js";
import { DEFAULT_HEALTH } from "../sim/player.js";
import type { WeaponDef } from "../sim/weaponDef.js";

/** The numbers a gametype plays by. Asked of the scripts once, at match start. */
export interface CombatRules {
  /** Full health, and what a spawn gives back. Capped by the wire at 1023 (net/messages/player.ts). */
  maxHealth: number;
  /** Seconds after the last hit before health starts coming back. */
  regenDelay: number;
  /** Health a second once it does. */
  regenRate: number;
  /** Whether a round from a teammate costs anything. Never gates self-damage: see `Match.mayHurt`. */
  friendlyFire: boolean;
  /**
   * Seconds a body waits before it is put back on a spawn. Clamped to
   * `COMBAT_TIMER_MAX`, which is what the wire can carry a countdown over.
   *
   * Null: the engine never puts anybody back. A dead player stays dead until a
   * script's `ServerContext.respawn` — a round-based mode's "wait for the next
   * round" — and the countdown a client shows is not a number at all.
   */
  respawnDelay: number | null;
  /**
   * What every bullet's damage is multiplied by. A gametype's dial for hardcore
   * or for a one-shot mode, applied to the arithmetic below and **not** to a
   * number a script names itself through `ServerContext.damage` — a script
   * asking for 30 gets 30, since it already knows its own scale.
   */
  damageScale: number;
}

/**
 * What combat costs where nobody has said otherwise.
 *
 * The games' own core figures: a hundred health, regeneration about five seconds
 * after the last hit and filling in a couple, no friendly fire, and a few seconds
 * on the floor before a respawn.
 */
export const DEFAULT_COMBAT_RULES: CombatRules = {
  maxHealth: DEFAULT_HEALTH,
  regenDelay: 5,
  regenRate: 50,
  friendlyFire: false,
  respawnDelay: 3,
  damageScale: 1,
};

/** CoD units to the metre — inches (scripts/cod/units.py). Every range in a weapon file is in these. */

/**
 * What a round takes off where its weapon file said nothing at all.
 *
 * Every field of `WeaponDef.damage` is optional: the block arrived at format 4,
 * so a weapon read out of an older GLB — or built by hand in a test — carries
 * none of it. Treating that as zero would leave a weapon that fires, reloads,
 * runs dry and never hurts anybody, which is the kind of wrong answer nothing
 * complains about. So absent means "this file did not say" and the fallback is an
 * ordinary rifle's body shot, which kills in four. It is the same reading
 * `WeaponLocationDamage` already documents for a missing location.
 */
export const UNSPECIFIED_DAMAGE = 30;

/**
 * What one round on `location` from `distance` metres away costs.
 *
 * The falloff is the weapon's own: `damage.max` out to `maxRange`, `damage.min`
 * past `minRange`, and a straight interpolation between the two. **`max` is
 * spelled `damage`** in a weapon file and there is no `maxDamage`, so a reader
 * looking for that name finds nothing and disarms the gun. The two ranges are in
 * CoD units — an M4's 800 to 1400 is 20.3 m to 35.6 m, not 800 m to 1400 m.
 *
 * Then the location multiplier (1.4 on an M4's head, 0 on `gun`, and 1 where the
 * game did not say), and then the gametype's scale. Never negative.
 */
export function shotDamage(def: WeaponDef | undefined, location: HitLocation, distance: number, rules: CombatRules): number {
  const damage = def?.damage;
  const max = damage?.max ?? UNSPECIFIED_DAMAGE;
  const min = damage?.min ?? max;
  const near = unitsToMetres(damage?.maxRange ?? 0);
  const far = unitsToMetres(damage?.minRange ?? 0);

  // A weapon that declared no window, or an inverted one, has no falloff to
  // apply rather than a division by zero to propagate.
  let base = max;
  if (far > near) {
    const t = Math.min(1, Math.max(0, (distance - near) / (far - near)));
    base = max + (min - max) * t;
  }

  const multiplier = def?.locationDamage?.[location] ?? 1;
  return Math.max(0, base * multiplier * rules.damageScale);
}
