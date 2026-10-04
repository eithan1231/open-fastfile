// Which clips an actor's body is playing, and how much of each — decided once,
// for both ends, from what the wire carries.
//
// The actor's half of `sim/pose.ts`, and pure for the same reason: a server poses
// the body to trace a shot at it and a client poses it to draw it, so the answer
// has to be a function of the `ActorState` and the actor's look (`actorLook`,
// which both ends draw from the same seed). A creature has no torso overlay and
// no aim, so this is one layer of whole-body clips that sum to 1.

import type { CreatureRole } from "../../sim/characterDef.js";
import type { ActorState } from "./actor.js";
import { climbRole, gaitRole, type ActorClip, type ActorTraversalClip } from "./assets.js";

/** One clip, how much of it, and where in it (a fraction of its own duration). */
export interface ActorPoseLayer {
  /** `traversal` for a link's own clip (`ActorLook.traversals`), which is no role. */
  role: CreatureRole | "traversal";
  /** The clip itself: the actor's variant of `role`. */
  clip: string;
  weight: number;
  phase: number;
}

/** What a pose is decided from: the wire's fields, no more. */
export type ActorPoseState = Pick<ActorState, "speed" | "gait" | "action" | "phase" | "traversal">;

/**
 * Below this share of its gait clip's own speed, a moving actor's idle shows
 * through: starting and stopping fade rather than snap.
 */
const MOVE_FADE = 0.5;

/**
 * The clips an actor is posed from. `clips` is its look's variant per role: a
 * role with none falls back to one it has, so a set shipping only a walk still
 * walks when it sprints and stands when it swings. Empty only for a look with no
 * idle, which `readActorAssets` refuses. `traversals` is the look's: a traverse
 * naming one plays it, and one naming none (or one this end does not hold) climbs.
 */
export function poseActor(
  state: ActorPoseState,
  clips: Partial<Record<CreatureRole, Pick<ActorClip, "name" | "speed">>>,
  traversals: readonly Pick<ActorTraversalClip, "name">[] = [],
): ActorPoseLayer[] {
  const layer = (role: CreatureRole, weight: number, phase: number): ActorPoseLayer => ({ role, clip: clips[role]!.name, weight, phase });
  const has = (role: CreatureRole) => clips[role] !== undefined;
  const one = (role: CreatureRole): ActorPoseLayer[] => (has(role) ? [layer(role, 1, state.phase)] : has("idle") ? [layer("idle", 1, 0)] : []);
  switch (state.action) {
    case "die":
      return one("die");
    case "attack":
      return one("attack");
    case "idle":
      return one("idle");
    case "traverse": {
      // The link's own clip, or the gait's climb: placed by the phase as the server moves the body along the link.
      const own = state.traversal > 0 ? traversals[state.traversal - 1] : undefined;
      if (own) {
        return [{ role: "traversal", clip: own.name, weight: 1, phase: state.phase }];
      }
      const role = climbRole(state.gait, has);
      return role === undefined ? one("idle") : [layer(role, 1, state.phase)];
    }
    case "move": {
      const role = gaitRole(state.gait, has);
      if (role === undefined) {
        return one("idle");
      }
      const own = clips[role]!.speed;
      const moving = has("idle") && own > 0 ? clamp01(state.speed / (own * MOVE_FADE)) : 1;
      const layers = [layer(role, moving, state.phase)];
      if (moving < 1) {
        layers.unshift(layer("idle", 1 - moving, 0));
      }
      return layers.filter((l) => l.weight > 0);
    }
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
