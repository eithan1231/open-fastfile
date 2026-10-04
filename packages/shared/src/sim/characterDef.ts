// What a player's body *is*, as the exporter describes it in its GLB's scene
// extras (scripts/cod/characters.py). Plain data: the clip names and the joint a
// body is aimed by, with no three.js and no glTF.
//
// The parallel to `weaponDef.ts` is exact and deliberate. That file is what a
// weapon is; this is what a body is; and both live in `sim/` rather than in the
// client because **both ends need them now**. A weapon moved here when a server
// had to validate a shot. A body moves here because a bullet is traced against a
// posed skeleton, so a server has to decide which clip a peer is playing — and
// two ends deciding that separately is a hit box in a different place from the
// body on screen.

/**
 * Bumped whenever the `characters` extras change shape; scripts/cod/characters.py
 * writes it.
 */
export const CHARACTER_FORMAT_VERSION = 1;

/**
 * Every clip a body can play.
 *
 * A list rather than a bare union for the reason `CLIP_ROLES` is one: the order is
 * referred to by index in places that outlive a build, so append rather than
 * insert.
 */
export const CHARACTER_ROLES = [
  "idle",
  "idleAds",
  "runForward",
  "runBack",
  "runLeft",
  "runRight",
  "sprint",
  "jump",
  "land",
  "fire",
  "fireAds",
  "reload",
  "mantle",
  "mantleOver",
  "climbUp",
  "climbDown",
] as const;

export type CharacterRole = (typeof CHARACTER_ROLES)[number];

/**
 * The clips that pose the legs and the body under the overlay.
 *
 * Listed rather than derived as "everything that is not a torso role", because a
 * body's `torsoRoles` comes out of its own GLB: deriving it would make which map a
 * clip belongs to depend on what a particular body happened to ship, and register
 * the same clip on two layers where it shipped both.
 */
export const LEG_ROLES: readonly CharacterRole[] = [
  "idle",
  "idleAds",
  "runForward",
  "runBack",
  "runLeft",
  "runRight",
  "sprint",
  "jump",
  "land",
  "mantle",
  "mantleOver",
  "climbUp",
  "climbDown",
];

/** The roles that play once and hold their last frame rather than looping. */
export const ONCE_ROLES: readonly CharacterRole[] = ["reload", "jump", "land", "mantle", "mantleOver"];

/**
 * The four run clips and where each points in the player's own frame:
 * `(right, forward)`, both in [-1, 1].
 *
 * Here rather than in the animator because the *blend* is part of deciding the
 * pose, not part of drawing it: which clips carry weight, and how much, has to be
 * the same answer on both ends.
 */
export const RUN_DIRECTIONS: readonly (readonly [CharacterRole, number, number])[] = [
  ["runForward", 0, 1],
  ["runBack", 0, -1],
  ["runRight", 1, 0],
  ["runLeft", -1, 0],
];

/**
 * The roles a clip set names, which of them pose the whole body, and which play
 * once and hold. A soldier's is one table; a creature's is another, because a
 * zombie has no reload and a player has no death clip (a player dies as a ragdoll).
 */
export interface RoleTable<R extends string = string> {
  readonly roles: readonly R[];
  readonly legs: readonly R[];
  readonly once: readonly R[];
}

export const SOLDIER_TABLE: RoleTable<CharacterRole> = { roles: CHARACTER_ROLES, legs: LEG_ROLES, once: ONCE_ROLES };

/**
 * Every clip an actor's body can play (game/actors/). Each poses the whole body:
 * an actor has no torso overlay and no aim. Append only, like `CHARACTER_ROLES`.
 * `climb` is a traversal played along its link (a window climbed in), one per gait.
 */
export const CREATURE_ROLES = ["idle", "walk", "run", "attack", "die", "sprint", "climb", "climbRun", "climbSprint"] as const;
export type CreatureRole = (typeof CREATURE_ROLES)[number];

export const CREATURE_TABLE: RoleTable<CreatureRole> = {
  roles: CREATURE_ROLES,
  legs: CREATURE_ROLES,
  once: ["attack", "die", "climb", "climbRun", "climbSprint"],
};

/** Every role table, by the name a clip set's extras give it (`roleTable`). A set that names none is a soldier's. */
export const ROLE_TABLES = { soldier: SOLDIER_TABLE, creature: CREATURE_TABLE } as const;
export type RoleTableId = keyof typeof ROLE_TABLES;

/**
 * How far the aim joint turns, radians either way.
 *
 * A player's pitch runs to very nearly ±90°, which no spine reaches: past this the
 * body would fold in half rather than lean, so the head is left looking further
 * than the chest does.
 */
export const AIM_LIMIT = (55 * Math.PI) / 180;
