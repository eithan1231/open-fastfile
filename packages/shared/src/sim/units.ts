// The source games' own unit, and the one place it becomes a metre.
//
// A Call of Duty map is authored in inches: 39.37 to the metre, which is why a
// player is 64 units tall and a weapon's damage falls off between 800 and 1400.
// The exporter converts geometry as it writes a world, so almost nothing in the
// engine ever meets a game unit — but the numbers a weapon file carries are not
// geometry, and they arrive unconverted.
//
// Here rather than inline at each use because it had drifted into four spellings,
// one of which was a doc comment naming a module that did not exist. It is tier
// one: no DOM, no Node, no three.js.

/** Game units to the metre. A unit is an inch, and `dsl/units.ts` agrees at 0.0254. */
export const UNITS_PER_M = 39.37;

/** A length the games state in their own units, as metres. */
export function unitsToMetres(units: number): number {
  return units / UNITS_PER_M;
}

/**
 * One game unit, metres: what the movement numbers read from the games are
 * multiplied by. Not `1 / UNITS_PER_M` — that is 0.025400051, and a step both
 * ends replay is pinned to this spelling bit for bit.
 */
export const UNIT = 0.0254;
