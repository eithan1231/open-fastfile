// One actor's body, ready to pose: a catalogue body with its head rebound onto it,
// playing its kind's clip set.
//
// A player's rig with nothing held (`buildCharacterRig`): the exporter grafts the
// union of every head's joints into each body, so any head hangs on any body by
// joint name, and the clip set's table arrives as JSON (`ActorAssets`) rather than
// in the clip GLB's extras, so the `CharacterSet` the builder wants is made here.
// Both ends build one: the client to draw each actor, the server one per body to
// trace shots against.

import type * as THREE from "three";
import type { ActorAssets } from "../game/actors/assets.js";
import { buildCharacterRig, type CharacterRig, type CharacterSet, type FittedClips, type GltfAsset } from "./character.js";

/**
 * Build an actor's rig: `body` cloned, `head` (if any) rebound onto it, the clips
 * its skeleton can play — or an earlier rig's on the same body (`FittedClips`).
 */
export function buildActorRig(
  name: string,
  assets: ActorAssets,
  clips: readonly THREE.AnimationClip[] | FittedClips,
  body: GltfAsset,
  head?: GltfAsset,
): CharacterRig {
  return buildCharacterRig(name, actorCharacterSet(assets), clips, body, head);
}

/**
 * The `CharacterSet` a creature's rig carries. Only `clips` is read by the
 * builder (a one-frame clip's duration); a creature has no aim joint and no
 * torso layer, and is posed by look rather than by `roles`.
 */
function actorCharacterSet(assets: ActorAssets): CharacterSet {
  const clips: CharacterSet["clips"] = {};
  for (const variants of Object.values(assets.roles)) {
    for (const clip of variants) {
      clips[clip.name] = { duration: clip.duration, looped: false, notes: [] };
    }
  }
  return { game: assets.entry.game, weapon: "", animType: assets.clips.id, roles: {}, torsoRoles: [], aimJoint: "", clips };
}
