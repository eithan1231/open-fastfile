// Where a body's sixteen segments are, read off a skeleton.
//
// In `rig/` and not in `physics/`, and the split is the point: **describing a death
// is a fact about a skeleton, not about a physics engine.** A game server poses the
// body it has just traced the killing round against, reads this, and puts it on the
// wire — and it does all of that without loading Rapier, which is ~2.9 MB it would
// otherwise carry to say where somebody's elbow was.
//
// Simulating is the other half, and that one does need an engine:
// `physics/ragdoll.ts` turns one of these into sixteen rigid bodies, and
// `poseRagdoll` writes the result back onto the same kind of skeleton.

import * as THREE from "three";
import type { Vec3 } from "../sim/hit.js";
import { RAGDOLL_SEGMENTS, SEGMENT_BONES } from "../sim/ragdollBones.js";
import type { CharacterRig } from "./character.js";

/** A rotation on the wire and in a physics world alike: never Euler angles. */
export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

/** Where one segment is, in the world. */
export interface SegmentPose {
  position: Vec3;
  rotation: Quat;
}

/**
 * Where each segment is *now*, off a rig somebody has just posed.
 *
 * This is the server's half of a death: `Match` already poses a peer's skeleton to
 * trace the round that killed them, so the pose a corpse starts from is one
 * `updateMatrixWorld` that has already happened.
 *
 * **Undefined rather than thrown** where the rig is not a body — a skeleton without
 * all sixteen joints, which every exported one has and a stand-in may not. This runs
 * inside the tick that announces a death, and a death that failed to be announced
 * because the victim could not be described as a corpse would be a kill that never
 * happened. The cosmetic half is the half that gives way.
 *
 * `ragdollShape` throws in the same case, and that is not an inconsistency: it runs
 * once at load, where a body that cannot fall over is worth knowing about
 * immediately and costs nobody a kill.
 */
export function poseFromRig(rig: CharacterRig): SegmentPose[] | undefined {
  const position = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const out = RAGDOLL_SEGMENTS.map((segment): SegmentPose | undefined => {
    const bone = rig.root.getObjectByName(SEGMENT_BONES[segment]);
    if (!bone) {
      return undefined;
    }
    bone.matrixWorld.decompose(position, rotation, scale);
    return {
      position: { x: position.x, y: position.y, z: position.z },
      rotation: { x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w },
    };
  });
  return out.every((one) => one !== undefined) ? (out as SegmentPose[]) : undefined;
}
