// What kinds of thing a physics world holds, and how each is replicated.
//
// One table, and it is the entire answer — the shape `NODE_TYPES` has for a node,
// `API_ROUTES` for a route and `SCRIPTS` for a script. A second kind is an entry
// here plus a builder in `physics/`; it is not a new mechanism, and if it turns out
// to need one then the seam was drawn in the wrong place.
//
// Plain data, in `sim/`, because the kind id travels on the wire and both ends
// derive a lifetime from it — so a module that decodes a packet must be able to
// read this without importing a physics engine.
//
// -- The two policies ---------------------------------------------------------
//
// **Cosmetic** (`serverSimulates: false`, `correctEvery: 0`). Nothing in the game
// reads it, so the server spends nothing on it: it decides the spawn, says it once,
// and every client simulates from identical bytes. They agree because the inputs
// and the step count are identical, and there is nothing to correct *to*. A corpse
// is this.
//
// **Authoritative** (`serverSimulates: true`, `correctEvery` a few ticks). Gameplay
// reads the server's copy and only the server's copy. Clients simulate the same
// thing so that a throw looks immediate, and adopt a corrective transform when one
// arrives — which is exactly what `reconcile.ts` already does for the player, one
// layer up. A grenade, a rocket and a care package are this.

/**
 * The kinds, in the order the wire names them.
 *
 * The order **is** a format: a spawn carries an index into this array. Append,
 * never insert.
 */
export const ENTITY_KINDS = ["ragdoll"] as const;

export type EntityKindId = (typeof ENTITY_KINDS)[number];

export interface EntityPolicy {
  /**
   * Whether the server steps one at all.
   *
   * False is a pure optimisation and never a change of model: the server still
   * decides the spawn, and turning it true would change what it costs and nothing
   * about what anybody sees. It is false only where nothing in the game reads the
   * result.
   */
  readonly serverSimulates: boolean;
  /**
   * How often the server publishes a corrective transform, in ticks. 0 is never.
   *
   * The only thing that bounds a divergence. A cosmetic kind can do without one —
   * being a body's width out on one screen is a blemish; a grenade a body's width
   * out is somebody killed by an explosion that happened somewhere else.
   */
  readonly correctEvery: number;
  /** Seconds before both ends free it. Derived from the spawn tick, never sent. */
  readonly lifetimeSeconds: number;
  /**
   * How many may exist at once. The oldest goes when the next arrives.
   *
   * A bound on what a bad minute can cost: twelve players dying repeatedly is the
   * ordinary case, not the adversarial one.
   */
  readonly maxLive: number;
}

export const ENTITY_POLICY: Readonly<Record<EntityKindId, EntityPolicy>> = {
  // A corpse settles in a second or two and is still for the rest of its life, so
  // twenty seconds is mostly a sleeping island in a broad phase. Eight is a busy
  // choke point on a twelve-player map.
  ragdoll: { serverSimulates: false, correctEvery: 0, lifetimeSeconds: 20, maxLive: 8 },
};
