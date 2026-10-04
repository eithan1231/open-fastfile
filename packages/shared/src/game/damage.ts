// What hurt somebody: a hit's cause, which is also a death's.
//
// Call of Duty's `sMeansOfDeath` (MOD_RIFLE_BULLET, MOD_FALLING, MOD_SUICIDE, …),
// cut down to the causes that change what a script or a kill feed does. The cause
// says *how*; who is responsible is a separate field (`by`, `killer`), because the
// two vary independently — a grenade is an explosion whoever threw it, and a fall
// is nobody's.

import type { PlayerId } from "../net/messages/fields.js";

/**
 * Every cause, in wire order: **append only**, since a death event carries one as
 * an index into this list (net/messages/events.ts).
 *
 * - `bullet`: a round from a player's weapon, traced by the server.
 * - `outOfWorld`: past the world's kill plane (`sim/worldRules.ts`). Nobody's.
 * - `fall`: landing too hard. Declared: nothing deals fall damage yet.
 * - `explosion`: a blast — a grenade, a car. Declared: nothing explodes yet, but a
 *   script can already say so through `ServerContext.damage`.
 * - `script`: a script's damage that named no cause of its own.
 * - `melee`: a blow from something within reach. An actor's (game/actors/) is
 *   nobody's: `by` is null, and the actor rides beside it (`DamageEvent.actor`).
 */
export const DAMAGE_CAUSES = ["bullet", "outOfWorld", "fall", "explosion", "script", "melee"] as const;
export type DamageCause = (typeof DAMAGE_CAUSES)[number];

/**
 * A death nobody else earned: the world's doing (`killer` null) or their own.
 *
 * The one definition, so a kill feed, a score and a script agree: falling out of
 * the world, a neutral car and a player's own grenade are all suicides, and none
 * of them is anybody's kill.
 */
export function isSuicide(victim: PlayerId, killer: PlayerId | null): boolean {
  return killer === null || killer === victim;
}
