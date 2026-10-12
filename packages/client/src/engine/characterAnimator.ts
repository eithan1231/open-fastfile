// Moved to `@3d/shared/rig/poser.ts`, and renamed: it poses rather than animates,
// and a server does it too — to trace a bullet against a body's bones rather than
// to draw them.
//
// Re-exported under the old name because `net/remotePlayers.ts` owns one per peer
// and reaches for it by this path.
export { CharacterPoser as CharacterAnimator, bodyYaw, placeBody } from "@3d/shared/rig/poser.js";
