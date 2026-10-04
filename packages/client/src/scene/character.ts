// Moved to `@3d/shared/rig/character.ts`.
//
// A server poses a body now — a player is moved as a capsule and shot as a
// skeleton — so building one could not stay in a package the two servers may not
// import. Re-exported from here because every caller in `scene/` and `engine/`
// reaches for it by this path, and because this is still the layer that hands it
// the files an `AssetStore` loaded.
export {
  CHARACTER_FORMAT_VERSION,
  CHARACTER_ROLES,
  MODEL_FACING,
  CharacterKit,
  buildCharacterRig,
  readCharacterSet,
  type CharacterClipInfo,
  type CharacterRig,
  type CharacterRole,
  type CharacterSet,
  type CharacterSource,
  type GltfAsset,
} from "@3d/shared/rig/character.js";
