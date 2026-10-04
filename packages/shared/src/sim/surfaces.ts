// What a surface is made of: the one list both ends, the exporter and the
// gameplay layer agree on. See docs/engine/collision.md#what-a-surface-is-made-of.
//
// It lives in sim/ rather than in collision/ because it is the *answer*, not the
// machinery: a footstep picks its alias from it and `sim/` may not import
// `collision/` at all (eslint.config.js). collision/ reads it from the mesh;
// sim/ reads it off `CapsuleWorld`.

/**
 * Call of Duty's own surface types, in the game's own order, because that order
 * is the wire value: a collision mesh stores an index into this list and the
 * name is what a sound alias is spelled with (`step_run_plr_metal`).
 *
 * The first 31 are IW3/IW4/IW5/IW6's `surfaceTypeNames[]`. **Black Ops' table
 * is not the same one**: its last two entries are `player` and `tallgrass`
 * where IW's are `riotshield` and `slush` (OpenAssetTools
 * `T5/Weapon/WeaponStrings.h`'s `bounceSoundSuffixes[]`). So those two are
 * appended here rather than aliased onto IW's, and the exporter maps each
 * game's own index into this list — a shared list with a per-game reading is
 * how a T5 lawn stops being a riot shield.
 */
export const SURFACE_TYPES = [
  "default",
  "bark",
  "brick",
  "carpet",
  "cloth",
  "concrete",
  "dirt",
  "flesh",
  "foliage",
  "glass",
  "grass",
  "gravel",
  "ice",
  "metal",
  "mud",
  "paper",
  "plaster",
  "rock",
  "sand",
  "snow",
  "water",
  "wood",
  "asphalt",
  "ceramic",
  "plastic",
  "rubber",
  "cushion",
  "fruit",
  "paintedmetal",
  "riotshield",
  "slush",
  "player",
  "tallgrass",
] as const;

export type SurfaceType = (typeof SURFACE_TYPES)[number];

/**
 * What a surface with nothing to say is. A hand-written world has no surface
 * data at all, and neither has any map exported before this existed — so this
 * is an answer rather than an error, and every caller gets it without a branch.
 */
export const DEFAULT_SURFACE: SurfaceType = "default";

/** The glTF vertex attribute a collision mesh carries its surface index in (`_SURFACE` as GLTFLoader spells it). */
export const SURFACE_ATTRIBUTE = "_surface";

/** The name for a stored index, or `default` for one this build does not know. */
export function surfaceType(index: number): SurfaceType {
  return SURFACE_TYPES[index] ?? DEFAULT_SURFACE;
}
