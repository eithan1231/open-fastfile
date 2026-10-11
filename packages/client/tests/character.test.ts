// Third-person characters: that a head and a weapon find the body's joints, that
// a rig only takes the clips its own skeleton can play, and that the animator
// picks the pose the wire state asks for.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { createMovement, RUN_SPEED, type MovementState } from "@3d/shared/sim/movement.js";
import { IDLE_SPEED } from "@3d/shared/sim/gait.js";
import type { WeaponData } from "@3d/shared/sim/weapon.js";
import { restingKick, restingViewKick } from "@3d/shared/sim/recoil.js";
import { buildCharacterRig, CharacterKit, readCharacterSet, type CharacterSet } from "../src/scene/character.js";
import { CharacterAnimator } from "../src/engine/characterAnimator.js";
import type { GltfAsset } from "../src/scene/assets.js";

const SET: CharacterSet = {
  game: "iw5",
  weapon: "iw5_m4_mp",
  animType: "autorifle",
  roles: {
    idle: "pb_stand_alert",
    idleAds: "pb_stand_ads",
    runForward: "pb_combatrun_forward_loop",
    runBack: "pb_combatrun_back_loop",
    runLeft: "pb_combatrun_left_loop",
    runRight: "pb_combatrun_right_loop",
    sprint: "pb_sprint",
    fire: "pt_stand_shoot_auto",
    reload: "pt_reload_stand_rifle",
  },
  torsoRoles: ["fire", "reload"],
  aimJoint: "torso_stabilizer",
  clips: {},
};

/** The body: the joints the exporter leaves in it, the head's and the weapon's already grafted on. */
function body(): GltfAsset {
  const scene = new THREE.Group();
  const bones = new Map<string, THREE.Bone>();
  let parent: THREE.Object3D = scene;
  for (const name of ["tag_origin", "torso_stabilizer", "j_spine4", "j_neck", "j_head", "j_jaw", "j_gun", "tag_weapon"]) {
    const bone = new THREE.Bone();
    bone.name = name;
    parent.add(bone);
    bones.set(name, bone);
    parent = name === "j_head" ? bone : (bones.get("j_spine4") ?? bone);
  }
  const mesh = new THREE.SkinnedMesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
  mesh.bind(new THREE.Skeleton([...bones.values()]));
  scene.add(mesh);
  return { scene, clips: [] };
}

/** A worn piece: skinned meshes bound to bones named after the body's. */
function worn(joints: string[]): GltfAsset {
  const scene = new THREE.Group();
  const bones = joints.map((name) => {
    const bone = new THREE.Bone();
    bone.name = name;
    scene.add(bone);
    return bone;
  });
  const mesh = new THREE.SkinnedMesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
  mesh.bind(new THREE.Skeleton(bones));
  scene.add(mesh);
  return { scene, clips: [] };
}

function clip(name: string, joints: string[], duration = 1): THREE.AnimationClip {
  const tracks = joints.map((j) => new THREE.QuaternionKeyframeTrack(`${j}.quaternion`, [0, duration], [0, 0, 0, 1, 0, 0, 0, 1]));
  return new THREE.AnimationClip(name, duration, tracks);
}

function allClips(): THREE.AnimationClip[] {
  return [
    clip("pb_stand_alert", ["tag_origin", "j_head"], 17.6),
    clip("pb_stand_ads", ["tag_origin"], 3),
    clip("pb_combatrun_forward_loop", ["tag_origin"], 1.87),
    clip("pb_combatrun_back_loop", ["tag_origin"], 1.87),
    clip("pb_combatrun_left_loop", ["tag_origin"], 1.43),
    clip("pb_combatrun_right_loop", ["tag_origin"], 1.57),
    clip("pb_sprint", ["tag_origin"], 1.5),
    clip("pt_stand_shoot_auto", ["j_spine4"], 0.6),
    clip("pt_reload_stand_rifle", ["j_spine4"], 2.97),
    // Only a body with a coat has these, and this one has not.
    clip("pb_coat_only", ["j_coatfront_le"], 1),
  ];
}

function rig() {
  return buildCharacterRig("allies", SET, allClips(), body(), worn(["j_neck", "j_head", "j_jaw"]), worn(["tag_weapon"]));
}

function state(over: Partial<MovementState> = {}): MovementState {
  return settled({ ...createMovement({ x: 0, y: 0, z: 0 }, 0, 0), grounded: true, ...over });
}

/**
 * The heading `advanceBlends` would have settled on for this state's velocity.
 *
 * A fixture that says "running backwards" has to say it twice now: the velocity the
 * player has, and the heading the *pose* has blended to (`MovementState.travelForward`).
 * Two facts for the same reason `velocity` and `gait` are two — a reversal walks the
 * heading through the middle over TRAVEL_BLEND, so a test of the settled pose has to
 * ask for the settled heading. Standing still has no heading and is left at zero.
 */
function settled(s: MovementState): MovementState {
  const speed = Math.hypot(s.velocity.x, s.velocity.z);
  if (speed <= IDLE_SPEED) {
    return s;
  }
  const sin = Math.sin(s.yaw);
  const cos = Math.cos(s.yaw);
  s.travelForward = (-s.velocity.x * sin - s.velocity.z * cos) / speed;
  s.travelRight = (s.velocity.x * cos - s.velocity.z * sin) / speed;
  return s;
}

/**
 * Moving, with the gait blend already up.
 *
 * `velocity` is how fast the player is going and `gait` is how much of the run clip
 * is showing; they differ for 0.18 s after starting or stopping, which is the blend.
 * A fixture that wants the settled pose has to say so.
 */
function moving(over: Partial<MovementState> = {}): MovementState {
  return state({ velocity: { x: 0, y: 0, z: -RUN_SPEED }, gait: 1, ...over });
}

function weapon(over: Partial<WeaponData> = {}): WeaponData {
  return {
    state: "idle",
    input: { trigger: false, ads: false, sprint: false },
    timer: 0,
    span: 0,
    ammo: 30,
    cooldown: 0,
    pressed: false,
    burstLeft: 0,
    ads: 0,
    reloadQueued: false,
    refillAt: null,
    fired: 0,
    spread: 0,
    kick: restingKick(),
    viewKick: restingViewKick(),
    clip: null,
    ...over,
  };
}

/** The weight each clip is actually drawn at, by role. */
function weights(animator: CharacterAnimator, character = rigOf(animator)): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [role, name] of Object.entries(SET.roles)) {
    const found = character.clips.get(name!);
    out[role] = found ? ((animator as unknown as { mixer: THREE.AnimationMixer }).mixer.existingAction(found)?.weight ?? 0) : 0;
  }
  return out;
}

/**
 * How much of a shared bone a torso overlay is taking, from the raw mixer weight.
 *
 * `applyTorso` inverts three's normalized blend to get a mask out of it, so an
 * action's weight is no longer its share — a full overlay is a weight of ~999. This
 * is that inversion read back, which is the number `poseLayers` asked for.
 */
function torsoShare(animator: CharacterAnimator, role: "fire" | "reload"): number {
  const w = weights(animator)[role] ?? 0;
  return w / (1 + w);
}

function rigOf(animator: CharacterAnimator) {
  return (animator as unknown as { rig: ReturnType<typeof rig> }).rig;
}

/** Run `animator` at 60 Hz for `seconds` on one state, so its blends settle. */
function settle(animator: CharacterAnimator, movement: MovementState, held: WeaponData | null, seconds = 1): void {
  for (let i = 0; i < Math.round(seconds * 60); i++) {
    animator.update(movement, held, 1 / 60);
  }
}

describe("building a character", () => {
  it("moves the head's and the weapon's meshes onto the body's own bones", () => {
    const character = rig();
    const bones = new Map<string, THREE.Bone>();
    character.root.traverse((o) => {
      if (o instanceof THREE.Bone) {
        bones.set(o.name, o);
      }
    });
    const meshes: THREE.SkinnedMesh[] = [];
    character.root.traverse((o) => {
      if (o instanceof THREE.SkinnedMesh) {
        meshes.push(o);
      }
    });
    expect(meshes).toHaveLength(3); // the body, the head, the gun
    for (const mesh of meshes) {
      for (const bone of mesh.skeleton.bones) {
        expect(bone).toBe(bones.get(bone.name));
      }
    }
  });

  it("refuses a head the body has no joints for, rather than drawing it at the origin", () => {
    expect(() => buildCharacterRig("allies", SET, [], body(), worn(["j_nvg"]))).toThrow(/no joint j_nvg/);
  });

  it("takes only the clips its own skeleton can play", () => {
    const character = rig();
    // Every role's clip is there...
    for (const name of Object.values(SET.roles)) {
      expect(character.clips.has(name!)).toBe(true);
    }
    // ...but a clip that drives only joints this body lacks is dropped, rather
    // than left for three to warn about once per track per action.
    expect(character.clips.has("pb_coat_only")).toBe(false);
  });

  it("leaves the torso clips exactly as they were authored, rather than making them additive", () => {
    const character = rig();
    // A `pt_` clip poses the spine and above *fully* — a reload is where the arms
    // are, not an offset from where they were. Made additive against its own first
    // frame, as this used to do, it composed the reload's arm motion on top of the
    // run's arm swing and drew neither. `rig/poser.ts` masks them instead.
    expect(character.clips.get("pt_stand_shoot_auto")!.blendMode).toBe(THREE.NormalAnimationBlendMode);
    expect(character.clips.get("pt_reload_stand_rifle")!.blendMode).toBe(THREE.NormalAnimationBlendMode);
    expect(character.clips.get("pb_stand_alert")!.blendMode).toBe(THREE.NormalAnimationBlendMode);
  });

  it("finds the joint aim pitch turns", () => {
    expect(rig().aim?.name).toBe("torso_stabilizer");
  });
});

describe("reading the clip table", () => {
  it("rejects a GLB from a different exporter version", () => {
    expect(() => readCharacterSet({ characters: { version: 99, roles: { idle: "x" } } })).toThrow(/re-export/);
  });

  it("rejects a GLB that is not a character animations file", () => {
    expect(() => readCharacterSet({})).toThrow(/no `characters` extras/);
  });
});

describe("a kit", () => {
  it("gives every player their own skeleton, and the same id the same character", () => {
    const kit = new CharacterKit(SET, allClips(), [
      { name: "allies", body: body() },
      { name: "axis", body: body() },
    ]);
    expect(kit.names).toEqual(["allies", "axis"]);
    expect(kit.build(4).name).toBe("allies");
    expect(kit.build(5).name).toBe("axis");
    expect(kit.build(4).root).not.toBe(kit.build(4).root);
  });
});

describe("posing a character from the wire state", () => {
  it("stands still when the state is still", () => {
    const animator = new CharacterAnimator(rig());
    settle(animator, state(), weapon());
    expect(weights(animator).idle).toBeCloseTo(1, 2);
    expect(weights(animator).runForward).toBe(0);
    animator.dispose();
  });

  it("uses the aiming idle once the weapon is in the sights", () => {
    const animator = new CharacterAnimator(rig());
    settle(animator, state(), weapon({ ads: 1 }));
    expect(weights(animator).idleAds).toBeCloseTo(1, 2);
    expect(weights(animator).idle).toBeCloseTo(0, 2);
    animator.dispose();
  });

  it("blends the two run clips that bracket the direction of travel", () => {
    const animator = new CharacterAnimator(rig());
    // Yaw 0 faces -Z; moving forward-and-right at 45° should be half forward, half right.
    const speed = RUN_SPEED / Math.SQRT2;
    settle(animator, moving({ velocity: { x: speed, y: 0, z: -speed } }), weapon());
    const w = weights(animator);
    expect(w.runForward).toBeCloseTo(0.5, 1);
    expect(w.runRight).toBeCloseTo(0.5, 1);
    expect(w.runBack).toBe(0); // the two behind hold none of it
    expect(w.runLeft).toBe(0);
    animator.dispose();
  });

  it("runs backwards rather than turning round", () => {
    const animator = new CharacterAnimator(rig());
    settle(animator, moving({ velocity: { x: 0, y: 0, z: RUN_SPEED } }), weapon());
    expect(weights(animator).runBack).toBeCloseTo(1, 1);
    expect(weights(animator).runForward).toBe(0);
    animator.dispose();
  });

  it("keeps every run clip at the same point in the stride, so the blend does not slide", () => {
    const character = rig();
    const animator = new CharacterAnimator(character);
    const speed = RUN_SPEED / Math.SQRT2;
    settle(animator, moving({ velocity: { x: speed, y: 0, z: -speed } }), weapon(), 0.5);
    const mixer = (animator as unknown as { mixer: THREE.AnimationMixer }).mixer;
    const phase = (role: "runForward" | "runRight") => {
      const action = mixer.existingAction(character.clips.get(SET.roles[role]!)!)!;
      return action.time / action.getClip().duration;
    };
    // The clips are 1.87 s and 1.57 s long, so equal times would be different strides.
    expect(phase("runForward")).toBeCloseTo(phase("runRight"), 3);
    animator.dispose();
  });

  it("sprints on the weapon's own state, not on speed alone", () => {
    const animator = new CharacterAnimator(rig());
    const sprinting = moving();
    settle(animator, sprinting, weapon({ state: "sprinting" }));
    expect(weights(animator).sprint).toBeCloseTo(1, 2);
    expect(weights(animator).runForward).toBeCloseTo(0, 2);
    animator.dispose();
  });

  it("layers a fire or a reload over the legs without stopping them", () => {
    const animator = new CharacterAnimator(rig());
    const runner = moving();
    // Halfway through each state, so the overlay has faded fully in: it ramps over
    // the first and last of its own state rather than appearing.
    settle(animator, runner, weapon({ state: "firing", span: 0.1, timer: 0.05 }));
    expect(torsoShare(animator, "fire")).toBeCloseTo(1, 2);
    expect(weights(animator).runForward).toBeCloseTo(1, 2); // the legs keep all of their weight

    settle(animator, runner, weapon({ state: "reloading", span: 2, timer: 1 }));
    expect(torsoShare(animator, "reload")).toBeCloseTo(1, 2);
    expect(torsoShare(animator, "fire")).toBeCloseTo(0, 2);
    animator.dispose();
  });

  it("places a reload clip by how far through the reload the weapon is", () => {
    // It used to stretch the clip with `timeScale` and let the mixer advance it.
    // Now every clip is paused and placed by its phase, because a pose has to be a
    // function of the state rather than of the frames before it — so the same
    // stretch falls out of `(span - timer) / span` instead, and a 2.97 s animation
    // fits a 1.5 s reload by being sampled a third of the way in at a third gone.
    const character = rig();
    const animator = new CharacterAnimator(character);
    const clip = character.clips.get("pt_reload_stand_rifle")!;
    const mixer = (animator as unknown as { mixer: THREE.AnimationMixer }).mixer;

    // Read where the overlay actually carries weight: at the very start and very end
    // of a state it has faded to nothing, and an action at weight zero is not placed
    // at all — so its time then says nothing about anything.
    animator.update(state(), weapon({ state: "reloading", span: 1.5, timer: 1.4 }), 1 / 60);
    expect(mixer.existingAction(clip)!.time).toBeCloseTo((clip.duration * 0.1) / 1.5, 2);

    animator.update(state(), weapon({ state: "reloading", span: 1.5, timer: 1 }), 1 / 60);
    expect(mixer.existingAction(clip)!.time).toBeCloseTo(clip.duration / 3, 3);

    animator.update(state(), weapon({ state: "reloading", span: 1.5, timer: 0.1 }), 1 / 60);
    expect(mixer.existingAction(clip)!.time).toBeCloseTo((clip.duration * 1.4) / 1.5, 2);
    animator.dispose();
  });

  it("turns the aim joint with the player's pitch, and no further than a spine bends", () => {
    const character = rig();
    const animator = new CharacterAnimator(character);
    const rest = character.aim!.quaternion.clone();

    animator.update(state({ pitch: 0 }), null, 1 / 60);
    expect(character.aim!.quaternion.angleTo(rest)).toBeCloseTo(0, 4);

    animator.update(state({ pitch: 0.4 }), null, 1 / 60);
    expect(character.aim!.quaternion.angleTo(rest)).toBeCloseTo(0.4, 2);

    // A player can look very nearly straight up; a chest cannot follow it there.
    animator.update(state({ pitch: 1.5 }), null, 1 / 60);
    expect(character.aim!.quaternion.angleTo(rest)).toBeCloseTo((55 * Math.PI) / 180, 2);
    animator.dispose();
  });
});

// -- The mixer as a pure function ----------------------------------------------
//
// This is the linchpin of tracing bullets against a posed body, and it is worth its
// own tests because it is a property of *how* the animator drives three.js rather
// than of anything three.js promises.
//
// Every action is `paused` and placed by its phase, so the mixer never advances a
// clip's time on its own; the only things that decide the output are the weights and
// times `poseLayers` handed it. That makes `mixer.update(0)` a pure function of the
// state — which means a server can pose the same rig from the same snapshot with the
// same three.js and get the same bones, and there is no second blender to disagree
// with.
describe("the mixer, driven by phases rather than by time", () => {
  /** The stance every clip below keys the aim joint to, well away from the bind pose. */
  const STANCE = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.42);

  /**
   * Clips that actually turn a joint, unlike `allClips()`.
   *
   * The fixtures elsewhere in this file key identity quaternions — they exist to
   * have names and durations, and the tests around them check weights and times. A
   * pose test needs motion, or "the bones are the same" is true because nothing ever
   * moves and the purity below would mean nothing.
   *
   * Each clip turns `j_spine4` a different way over its own length, about a
   * different axis per role so two roles cannot cancel out.
   */
  function movingClips(): THREE.AnimationClip[] {
    const turning = (name: string, duration: number, axis: THREE.Vector3, angle: number) => {
      const end = new THREE.Quaternion().setFromAxisAngle(axis, angle);
      return new THREE.AnimationClip(name, duration, [
        new THREE.QuaternionKeyframeTrack("j_spine4.quaternion", [0, duration], [0, 0, 0, 1, ...end.toArray()]),
        // The aim joint, keyed to one value from end to end. A real body's clips all
        // key it — it is the stance the engine then turns for pitch — and keying it
        // *flat* is what a held pose looks like to the mixer, which is the case
        // `keeps the clips' own aim joint` exists for.
        new THREE.QuaternionKeyframeTrack("torso_stabilizer.quaternion", [0, duration], [...STANCE.toArray(), ...STANCE.toArray()]),
      ]);
    };
    const x = new THREE.Vector3(1, 0, 0);
    const y = new THREE.Vector3(0, 1, 0);
    const z = new THREE.Vector3(0, 0, 1);
    return [
      turning("pb_stand_alert", 17.6, x, 0.05),
      turning("pb_stand_ads", 3, x, 0.1),
      turning("pb_combatrun_forward_loop", 1.87, x, 1.2),
      turning("pb_combatrun_back_loop", 1.87, y, 1.2),
      turning("pb_combatrun_left_loop", 1.43, z, 1.2),
      turning("pb_combatrun_right_loop", 1.57, z, -1.2),
      turning("pb_sprint", 1.5, x, 1.4),
      turning("pt_stand_shoot_auto", 0.6, y, 0.3),
      turning("pt_reload_stand_rifle", 2.97, y, 0.8),
    ];
  }

  /**
   * A body whose bones are *apart*, unlike `body()`.
   *
   * The shared fixture puts every bone at the origin, which is fine for the tests
   * that read weights — but a rotation only moves a bone that is at some offset from
   * the joint being turned, so on a coincident skeleton no clip can ever move
   * anything and every pose comparison is trivially equal.
   */
  function spacedBody(): GltfAsset {
    const scene = new THREE.Group();
    const bones = new Map<string, THREE.Bone>();
    const make = (name: string, parent: THREE.Object3D, y: number) => {
      const bone = new THREE.Bone();
      bone.name = name;
      bone.position.set(0, y, 0);
      parent.add(bone);
      bones.set(name, bone);
      return bone;
    };
    const origin = make("tag_origin", scene, 0);
    const stabilizer = make("torso_stabilizer", origin, 1);
    const spine = make("j_spine4", stabilizer, 0.2);
    const neck = make("j_neck", spine, 0.25);
    const head = make("j_head", neck, 0.1);
    make("j_jaw", head, 0.05);
    const gun = make("j_gun", spine, 0.3);
    make("tag_weapon", gun, 0.1);
    const mesh = new THREE.SkinnedMesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
    mesh.bind(new THREE.Skeleton([...bones.values()]));
    scene.add(mesh);
    return { scene, clips: [] };
  }

  /** A rig whose clips move and whose bones are apart, so a pose is observable. */
  const moving = () => buildCharacterRig("allies", SET, movingClips(), spacedBody(), worn(["j_neck", "j_head", "j_jaw"]), worn(["tag_weapon"]));

  /** Every bone's world position, as the one thing a hitbox actually depends on. */
  function bones(character: ReturnType<typeof moving>): Map<string, THREE.Vector3> {
    character.root.updateMatrixWorld(true);
    const out = new Map<string, THREE.Vector3>();
    character.root.traverse((o) => {
      if (o instanceof THREE.Bone) {
        out.set(o.name, o.getWorldPosition(new THREE.Vector3()));
      }
    });
    return out;
  }

  function apart(a: Map<string, THREE.Vector3>, b: Map<string, THREE.Vector3>): number {
    let worst = 0;
    for (const [name, position] of a) {
      const other = b.get(name);
      if (other) {
        worst = Math.max(worst, position.distanceTo(other));
      }
    }
    return worst;
  }

  const running: MovementState = settled({
    ...createMovement({ x: 0, y: 0, z: 0 }, 0.4, 0.2),
    grounded: true,
    velocity: { x: 1, y: 0, z: -4 },
    gait: 1,
    stride: 0.37,
  });

  it("keeps the clips' own aim joint while a pose is held, rather than falling back to the bind", () => {
    // three's `PropertyMixer` writes a bone only when its accumulated value
    // *changes*, so a pose that is held — an idle clip parked at one phase, which is
    // every standing player — is written once and skipped from then on. Anything
    // that put the joint back to the rig's rest pose in between therefore kept that
    // rest pose: on an IW5 body the stabilizer sat 24° from its stance, so a
    // standing peer's chest, head and gun all pointed a fifth of a right angle away
    // from where that player was actually looking, and snapped back into place for
    // as long as a reload overlay kept the value moving.
    const character = moving();
    const animator = new CharacterAnimator(character);
    const still = { ...createMovement({ x: 0, y: 0, z: 0 }, 0, 0), grounded: true };
    for (let frame = 0; frame < 4; frame++) {
      animator.update(still, weapon(), 1 / 60);
      // Exactly the clip's key, since a pitch of zero turns the joint not at all.
      expect(character.aim!.quaternion.angleTo(STANCE)).toBeCloseTo(0, 9);
    }
    animator.dispose();
  });

  it("gives a torso overlay the bones it keys, whatever the legs are doing", () => {
    // The mask, read off the pose rather than off a weight. `pt_reload_stand_rifle`
    // turns `j_spine4` 0.8 rad about Y over its length, so at a phase of a half the
    // spine belongs to the overlay and stands at 0.4 — whether the legs underneath
    // are running (1.2 rad about X, a long way from it) or standing still.
    //
    // Made additive, as this used to be, the spine came out at the *sum* of the two,
    // which is a pose neither clip contains and is what a peer reloading mid-run was
    // drawn in.
    const expected = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.4);
    const still = { ...createMovement({ x: 0, y: 0, z: 0 }, 0, 0), grounded: true };
    for (const movement of [running, still]) {
      const character = moving();
      const animator = new CharacterAnimator(character);
      animator.update(movement, weapon({ state: "reloading", span: 2, timer: 1 }), 1 / 60);
      const spine = character.root.getObjectByName("j_spine4")!;
      // Not exactly: the legs keep a thousandth of the bone (FULL_TORSO), because a
      // share of one is a mixer weight of infinity.
      expect(spine.quaternion.angleTo(expected)).toBeLessThan(0.01);
      animator.dispose();
    }
  });

  it("gives the same bones for the same state, twice over", () => {
    const character = moving();
    const animator = new CharacterAnimator(character);
    animator.update(running, weapon(), 1 / 60);
    const first = bones(character);
    animator.update(running, weapon(), 1 / 60);
    expect(apart(first, bones(character))).toBeLessThan(1e-9);
    animator.dispose();
  });

  it("does not depend on `dt`, which a server does not have", () => {
    // The pose is a function of the state; `dt` reaches only the mixer's own
    // bookkeeping. A server stepping a tick and a client drawing at 144 Hz have to
    // agree, and they cannot if the frame time moves a clip.
    const fast = moving();
    const slow = moving();
    const a = new CharacterAnimator(fast);
    const b = new CharacterAnimator(slow);
    a.update(running, weapon(), 1 / 240);
    b.update(running, weapon(), 1 / 30);
    expect(apart(bones(fast), bones(slow))).toBeLessThan(1e-9);
    // And zero, which is what a server would pass having no frame at all.
    const none = moving();
    const c = new CharacterAnimator(none);
    c.update(running, weapon(), 0);
    expect(apart(bones(fast), bones(none))).toBeLessThan(1e-9);
    a.dispose();
    b.dispose();
    c.dispose();
  });

  it("does not depend on what it was asked before", () => {
    // What a blended mixer could not promise. One rig walks, sprints, then walks
    // again; the other only ever walks. The walk has to be the same pose.
    const history = moving();
    const fresh = moving();
    const a = new CharacterAnimator(history);
    const b = new CharacterAnimator(fresh);
    a.update({ ...running, velocity: { x: 0, y: 0, z: -RUN_SPEED } }, weapon({ state: "sprinting" }), 1 / 60);
    a.update({ ...running, mantle: { target: { x: 0, y: 1, z: 0 }, left: 0.2, rise: 1, over: false } }, weapon(), 1 / 60);
    a.update(running, weapon(), 1 / 60);
    b.update(running, weapon(), 1 / 60);
    expect(apart(bones(history), bones(fresh))).toBeLessThan(1e-9);
    a.dispose();
    b.dispose();
  });

  it("really does move the bones, so the tests above are not comparing bind poses", () => {
    const standing = moving();
    const runner = moving();
    const a = new CharacterAnimator(standing);
    const b = new CharacterAnimator(runner);
    a.update({ ...createMovement({ x: 0, y: 0, z: 0 }, 0, 0), grounded: true }, weapon(), 1 / 60);
    b.update(running, weapon(), 1 / 60);
    // Centimetres at least: if this were zero the purity above would be vacuous.
    expect(apart(bones(standing), bones(runner))).toBeGreaterThan(0.01);
    a.dispose();
    b.dispose();
  });

  it("moves a bone when only the stride changes, so a phase really places a clip", () => {
    const early = moving();
    const late = moving();
    const a = new CharacterAnimator(early);
    const b = new CharacterAnimator(late);
    a.update({ ...running, stride: 0.1 }, weapon(), 1 / 60);
    b.update({ ...running, stride: 0.6 }, weapon(), 1 / 60);
    expect(apart(bones(early), bones(late))).toBeGreaterThan(0.01);
    a.dispose();
    b.dispose();
  });
});
