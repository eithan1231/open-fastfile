// Puts one third-person character into the pose `sim/pose.ts` decided.
//
// The decision is not here: which clips a body is playing and how much of each is
// `poseLayers(movement, weapon)` in `sim/`, a pure function. What is left here is
// putting a skeleton into that pose — a mixer, the weights, and the one joint the
// engine turns to aim.
//
// In `@3d/shared/rig/` rather than in the client because **both ends do it**. A
// client poses a body to draw it; a server poses the same body to trace a bullet
// against its bones, and a pose arrived at twice is a hit box somewhere other than
// the body on screen. One implementation is enough because the mixer, driven this
// way, is a pure function of the pose — `client/tests/character.test.ts` holds that
// to a nanometre across frame times and histories.
//
// Three things are layered, in the order the game layers them:
//
//  1. **Legs.** Idle, a four-way run blended by the direction of travel, a
//     sprint, a jump or a landing, or a climb (a mantle or a ladder). Weights, not
//     `crossFadeTo`: the target is recomputed every frame from a state that can
//     change every tick, and a fade started against one target is wrong by the
//     time it finishes.
//  2. **Torso.** A fire or reload clip, which *replaces* the spine and above over
//     whatever the legs are doing — a bone mask, not an offset. See `applyTorso`.
//  3. **Aim.** CoD ships no aim-up/down player clips; the engine turns one joint
//     (`torso_stabilizer`) and lets the spine above it follow. So does this.
//
// Weights are applied as given rather than walked towards over 0.18 s, which is
// what this used to do. See `poseLayers`: a weight that depended on the frames
// before it could not be reproduced from a snapshot, and "the hit box is where the
// body is drawn" is worth more than a tenth of a second of leg lerp.

import * as THREE from "three";
import { AIM_LIMIT, LEG_ROLES, type CharacterRole } from "../sim/characterDef.js";
import { bodyYaw, poseLayers, type PoseLayer } from "../sim/pose.js";
import type { MovementState } from "../sim/movement.js";
import type { WeaponData } from "../sim/weapon.js";
import type { CharacterRig } from "./character.js";

interface Layer {
  action: THREE.AnimationAction;
}

/** The most of a shared bone a torso overlay may take. See `applyTorso`: 1 is a weight of infinity. */
const FULL_TORSO = 0.999;

export class CharacterPoser {
  private readonly mixer: THREE.AnimationMixer;
  private readonly legs = new Map<CharacterRole, Layer>();
  private readonly torso = new Map<CharacterRole, Layer>();
  /**
   * The aim joint as the *mixer* last left it: the clips' own pose for it, before
   * the turn. Put back before every mixer pass.
   *
   * Two things have to hold at once, and only this value satisfies both.
   *
   *  - The turn must never land on top of a previous turn. `aim` premultiplies,
   *    and a clip that does not key this joint leaves it holding the last frame's
   *    aim rather than a pose, so the joint has to be wound back first.
   *  - The clips' pose for the joint must survive that winding back. three's
   *    `PropertyMixer` writes a bone **only when its accumulated value changes**
   *    (`// value has changed -> update scene graph`), so a held pose — an idle
   *    clip parked at one phase — is written once and skipped from then on.
   *
   * This used to be the rig's rest pose, which lost the second: a standing body's
   * `torso_stabilizer` was written on the first pose and never again, so it sat at
   * its bind rotation — around 20° off the aim on an IW5 body — until something
   * changing (a reload overlay, a stride) made the mixer write it again, and fell
   * straight back when that stopped. The value the mixer last produced is exactly
   * what it would have written had it not skipped, so restoring it is transparent.
   */
  private readonly aimBase = new THREE.Quaternion();
  private readonly axis = new THREE.Vector3();
  private readonly turn = new THREE.Quaternion();
  private readonly parent = new THREE.Quaternion();
  private readonly offset = new THREE.Quaternion();

  constructor(private readonly rig: CharacterRig) {
    this.mixer = new THREE.AnimationMixer(rig.root);
    for (const role of LEG_ROLES) {
      this.add(this.legs, role);
    }
    for (const role of rig.set.torsoRoles) {
      this.add(this.torso, role);
    }
    if (rig.aim) {
      this.aimBase.copy(rig.aim.quaternion);
    }
    this.mixer.update(0);
  }

  private add(into: Map<CharacterRole, Layer>, role: CharacterRole): void {
    // Keyed by the clip's own name: a role is what the game calls the *slot*, and
    // `set.roles` is the table from one to the other.
    const clip = this.rig.clips.get(this.rig.set.roles[role] ?? "");
    if (!clip) {
      return; // a world may ship fewer clips than this knows roles for
    }
    const action = this.mixer.clipAction(clip);
    action.enabled = true;
    action.weight = 0;
    action.play();
    // Every clip is placed by its phase rather than advanced by the mixer, so the
    // mixer never moves time on its own: a pose is a function of the state, and a
    // clock of its own is exactly what that cannot include. That also replaces
    // LoopOnce/clampWhenFinished — `poseLayers` clamps a one-shot's phase at 1.
    action.paused = true;
    into.set(role, { action });
  }

  /**
   * Pose the rig for one frame.
   *
   * `movement` is the *interpolated* state the body is being drawn at and `weapon`
   * the newest one received. `dt` is real time since the last frame and is spent
   * only on the mixer's own bookkeeping — nothing about the pose depends on it,
   * which is what lets a peer be drawn identically from the same state however the
   * frame rate wanders.
   */
  update(movement: MovementState, weapon: WeaponData | null, dt: number): void {
    const pose = poseLayers(movement, weapon);
    this.apply(this.legs, pose.legs);
    this.applyTorso(pose.torso);
    this.rig.aim?.quaternion.copy(this.aimBase);
    this.mixer.update(dt);
    // Whatever the mixer left, which is the clips' pose for the joint: taken back
    // before the turn is applied, because the turn is not part of what it holds.
    if (this.rig.aim) {
      this.aimBase.copy(this.rig.aim.quaternion);
    }
    this.aim(pose.yaw, pose.aim);
  }

  /** Give each layer the weight and phase the pose asks for, and zero to the rest. */
  private apply(layers: Map<CharacterRole, Layer>, wanted: readonly PoseLayer[], scale = 1): void {
    for (const { action } of layers.values()) {
      action.weight = 0;
    }
    for (const { role, weight, phase } of wanted) {
      const layer = layers.get(role);
      if (!layer) {
        continue;
      }
      layer.action.weight = weight * scale;
      layer.action.time = phase * layer.action.getClip().duration;
    }
  }

  /**
   * The torso overlay, as a bone mask three has no way to ask for directly.
   *
   * A `pt_` clip keys the spine and above and poses it *fully* — the bones it
   * touches are a subset of the ones a locomotion clip touches — so what the pose
   * wants is: these bones come from the overlay, the rest from the legs, crossfaded
   * by `share`. three gives every property one **normalized** blend across the
   * actions that key it, so an overlay at mixer weight `w` beside legs summing to 1
   * owns `w / (1 + w)` of a shared bone. Inverting that is this function: the share
   * `poseLayers` asked for becomes the weight that produces it.
   *
   * A share of 1 is the overlay alone, which is a weight of infinity — hence the
   * cap just short of it. At FULL_TORSO the legs keep a thousandth of a shared
   * bone, which is nothing anyone can see and keeps every weight finite.
   *
   * The share is measured over the roles this rig actually has a clip for, so a
   * body shipping no `fireAds` puts the whole overlay through `fire` rather than
   * quietly showing half of one.
   */
  private applyTorso(wanted: readonly PoseLayer[]): void {
    let share = 0;
    for (const { role, weight } of wanted) {
      if (this.torso.has(role)) {
        share += weight;
      }
    }
    share = Math.min(share, FULL_TORSO);
    this.apply(this.torso, wanted, share > 0 ? share / (1 - share) / share : 0);
  }

  /**
   * Turn the aim joint so the chest points where the player is looking. Run after
   * the mixer, which has just written that joint's clip pose, and applied in the
   * joint's parent space: the rig's own axes are the game's, not the engine's, so
   * the turn is built about the player's world right axis and carried into the
   * joint by its parent's inverse.
   */
  private aim(yaw: number, pitch: number): void {
    const joint = this.rig.aim;
    if (!joint?.parent) {
      return;
    }
    joint.parent.getWorldQuaternion(this.parent);
    this.axis.set(Math.cos(yaw), 0, -Math.sin(yaw)); // right, for a body facing -Z at yaw 0
    this.turn.setFromAxisAngle(this.axis, Math.max(-AIM_LIMIT, Math.min(AIM_LIMIT, pitch)));
    // q_local' = P⁻¹ · R · P · q_local, which turns the joint by R in world space.
    this.offset.copy(this.parent).invert().multiply(this.turn).multiply(this.parent);
    joint.quaternion.premultiply(this.offset);
  }

  dispose(): void {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.rig.root);
  }
}

export { bodyYaw };
