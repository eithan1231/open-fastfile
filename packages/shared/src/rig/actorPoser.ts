// Puts an actor's body into the pose `poseActor` decided.
//
// The actor's `CharacterPoser`, and shared for its reason: a client poses the
// body to draw it and a game server poses the same body to trace a shot at it.
// Simpler, because a creature is one layer of whole-body clips — no torso overlay,
// no aim joint — and every action is placed by its phase rather than advanced by
// the mixer, so the pose is a function of the `ActorState` and the look alone.
//
// The look is handed in on every call rather than held, because a game server
// keeps one scratch rig per body and poses every actor wearing it in turn.

import * as THREE from "three";
import type { ActorLook } from "../game/actors/assets.js";
import { poseActor, type ActorPoseState } from "../game/actors/pose.js";
import type { CharacterRig } from "./character.js";

export class ActorPoser {
  private readonly mixer: THREE.AnimationMixer;
  /** One per clip this rig has been asked for, made on first use: a set holds 51 clips and an actor plays a handful. */
  private readonly actions = new Map<string, THREE.AnimationAction>();

  constructor(private readonly rig: CharacterRig) {
    this.mixer = new THREE.AnimationMixer(rig.root);
  }

  /**
   * Pose for one frame. `dt` is spent on the mixer's bookkeeping only; the pose is
   * the state's. A clip the rig does not hold is skipped, leaving the rest pose's
   * share to whatever else carries weight.
   */
  update(state: ActorPoseState, look: Pick<ActorLook, "clips" | "traversals">, dt: number): void {
    for (const action of this.actions.values()) {
      action.weight = 0;
    }
    for (const { clip, weight, phase } of poseActor(state, look.clips, look.traversals)) {
      const action = this.action(clip);
      if (action) {
        action.weight = weight;
        action.time = phase * action.getClip().duration;
      }
    }
    this.mixer.update(dt);
  }

  dispose(): void {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.rig.root);
  }

  private action(name: string): THREE.AnimationAction | undefined {
    let action = this.actions.get(name);
    if (!action) {
      const clip = this.rig.clips.get(name);
      if (!clip) {
        return undefined;
      }
      action = this.mixer.clipAction(clip);
      action.enabled = true;
      action.weight = 0;
      action.play();
      action.paused = true;
      this.actions.set(name, action);
    }
    return action;
  }
}
