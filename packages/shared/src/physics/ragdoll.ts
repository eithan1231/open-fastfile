// A corpse, as sixteen boxes on fifteen joints.
//
// Split in two, because the two halves have completely different lifetimes:
//
//  - **`ragdollShape(rig, boxes)`** is what a *body* is — how big each segment is,
//    where each joint hangs, what each weighs. It depends only on the GLB and its
//    hit boxes, so it is computed once per character id and reused by every player
//    wearing it, the way `Bodies` already shares one rig per id.
//  - **`buildRagdoll(world, shape, pose)`** is what a *death* is: that shape,
//    placed. It is the only half that touches a physics world, and the only half
//    whose inputs come off the wire.
//
// -- Where the numbers come from ----------------------------------------------
//
// Every collider is the body's own hit box, so **a corpse is made of the volumes it
// was being shot at**. That is worth more than one mesh's worth of tidiness: it
// means the shape a round met a moment ago is the shape that falls over, and it
// means a new export gets a ragdoll with no work at all — the boxes are already
// derived from its skin weights (`scripts/cod/hitboxes.py`).
//
// A hit box is **in its bone's own space, in inches**: a CoD rig hangs from a
// `unit-scale` root of 0.0254, and `rig/hitboxes.ts` calls converting them early
// the mistake that looks like tidying up. Nothing here converts them either.
// `BindPose.worldOf` already carries that scale, so a box's corners come out of it
// in metres and the only thing left to undo is the segment bone's rotation. The
// number 0.0254 does not appear in this file, which is the point: a rig exported at
// a different scale still works.

import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-deterministic-compat";
import type { Vec3 } from "../sim/hit.js";
import type { Hitbox } from "../rig/hitboxes.js";
import type { CharacterRig } from "../rig/character.js";
import type { Quat, SegmentPose } from "../rig/ragdollPose.js";
import {
  KNOCK_AT_FEET,
  KNOCK_AT_HEAD,
  MAX_SEGMENT_HALF_EXTENT,
  RAGDOLL_CCD_PREDICTION,
  RAGDOLL_LINEAR_DAMPING,
  RAGDOLL_SEGMENTS,
  RAGDOLL_SOLVER_ITERATIONS,
  SEGMENT_ANGULAR_DAMPING,
  SEGMENT_BONES,
  SEGMENT_JOINTS,
  SEGMENT_MASS,
  segmentOf,
  type RagdollSegment,
} from "../sim/ragdollBones.js";
import { setAngularLimits } from "./joints.js";

export type { Quat, SegmentPose } from "../rig/ragdollPose.js";

/** One segment's box, in its own rigid body's frame, metres. */
export interface SegmentShape {
  segment: RagdollSegment;
  /** Half the box, each axis. Never zero: a flat collider has no contact normal. */
  halfExtents: Vec3;
  /** Where the box sits relative to the bone the body is rooted at. */
  centre: Vec3;
  mass: number;
  /**
   * Where this segment's joint sits, in this body's frame and in its parent's.
   * Absent on `pelvis`, which hangs off nothing.
   */
  anchor?: { own: Vec3; parent: Vec3 };
}

/** What a body is, before anybody dies in it. Computed once per character id. */
export interface RagdollShape {
  /** In `RAGDOLL_SEGMENTS` order, always all sixteen. The order is a format. */
  segments: readonly SegmentShape[];
  /**
   * Each segment's rest transform relative to the rig root, for placing a pose.
   *
   * `scale` is the one piece that looks like clutter and is not: a CoD rig hangs
   * from a `unit-scale` root of 0.0254 and every bone's world matrix carries it,
   * while a rigid body has no scale at all. Putting a simulated transform back onto
   * a bone means putting that scale back with it, and the right-hand side of a body
   * is mirrored, so it is per bone rather than one number.
   */
  rest: readonly { position: Vec3; rotation: Quat; scale: Vec3 }[];
}

/** A corpse in a physics world. Its bodies are in `RAGDOLL_SEGMENTS` order. */
export interface Ragdoll {
  bodies: readonly RAPIER.RigidBody[];
  joints: readonly RAPIER.ImpulseJoint[];
}

const SMALLEST_HALF_EXTENT = 0.01;

/**
 * Measure a body once: sixteen boxes and fifteen joint anchors.
 *
 * Throws where a segment has no bone or no volume, rather than quietly building a
 * fifteen-segment corpse — a body that cannot be a ragdoll is worth a failure at
 * load, for the same reason `readHitboxes` refuses a body that cannot be shot.
 * `game-server/tests/ragdollTable.test.ts` is what proves no shipped body does.
 */
export function ragdollShape(rig: CharacterRig, boxes: readonly Hitbox[]): RagdollShape {
  const bind = rig.bind;

  // Each segment's rest frame, rotation separated from position: a collider is
  // expressed in an *unscaled* body frame, so the bone's scale must not come with
  // it — it is already spent putting the box's corners into metres.
  const frames = new Map<RagdollSegment, { position: THREE.Vector3; rotation: THREE.Quaternion; scale: THREE.Vector3; inverse: THREE.Matrix4 }>();
  for (const segment of RAGDOLL_SEGMENTS) {
    const bone = SEGMENT_BONES[segment];
    const world = bind.worldOf(bone);
    if (!world) {
      throw new Error(`ragdoll: ${rig.name} has no bone ${bone} for its ${segment}`);
    }
    const position = new THREE.Vector3();
    const rotation = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    world.decompose(position, rotation, scale);
    const inverse = new THREE.Matrix4().compose(position, rotation, new THREE.Vector3(1, 1, 1)).invert();
    frames.set(segment, { position, rotation, scale, inverse });
  }

  // Fold every box onto the segment it belongs to, as an AABB in that segment's
  // own frame. A box reaches its segment by walking the real skeleton upwards,
  // which is what puts `j_hiptwist_le` on a thigh and `j_clavicle_ri` on a chest
  // without anybody having to know that it should be.
  const bounds = new Map<RagdollSegment, THREE.Box3>();
  const corner = new THREE.Vector3();
  for (const box of boxes) {
    const segment = segmentOf(box.bone, (bone) => bind.parentOf(bone));
    const world = bind.worldOf(box.bone);
    const frame = segment === undefined ? undefined : frames.get(segment);
    if (segment === undefined || !world || !frame) {
      continue; // a box on a bone above the pelvis: no segment owns it, and none should
    }
    const into = frame.inverse.clone().multiply(world);
    const found = bounds.get(segment) ?? new THREE.Box3().makeEmpty();
    for (let i = 0; i < 8; i++) {
      corner.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
      found.expandByPoint(corner.applyMatrix4(into));
    }
    bounds.set(segment, found);
  }

  const segments: SegmentShape[] = [];
  const rest: { position: Vec3; rotation: Quat; scale: Vec3 }[] = [];
  for (const segment of RAGDOLL_SEGMENTS) {
    const frame = frames.get(segment)!;
    const found = bounds.get(segment);
    if (!found || found.isEmpty()) {
      throw new Error(`ragdoll: ${rig.name} has no hit box anywhere on its ${segment} (${SEGMENT_BONES[segment]})`);
    }
    const size = found.getSize(new THREE.Vector3()).multiplyScalar(0.5);
    const centre = found.getCenter(new THREE.Vector3());
    const joint = SEGMENT_JOINTS[segment];
    segments.push({
      segment,
      halfExtents: {
        x: clampExtent(segment, size.x),
        y: clampExtent(segment, size.y),
        z: clampExtent(segment, size.z),
      },
      centre: { x: centre.x, y: centre.y, z: centre.z },
      mass: SEGMENT_MASS[segment],
      ...(joint === null
        ? {}
        : {
            // The joint sits where this segment's bone does. Said in both frames,
            // because Rapier anchors a joint in each body's own space and the two
            // are only the same point while the corpse is still in its bind pose.
            anchor: {
              own: { x: 0, y: 0, z: 0 },
              parent: local(frames.get(joint.parent)!.inverse, frame.position),
            },
          }),
    });
    rest.push({
      position: { x: frame.position.x, y: frame.position.y, z: frame.position.z },
      rotation: { x: frame.rotation.x, y: frame.rotation.y, z: frame.rotation.z, w: frame.rotation.w },
      scale: { x: frame.scale.x, y: frame.scale.y, z: frame.scale.z },
    });
  }
  return { segments, rest };
}

/** A world point in some frame, given that frame's inverse. */
function local(inverse: THREE.Matrix4, point: THREE.Vector3): Vec3 {
  const out = point.clone().applyMatrix4(inverse);
  return { x: out.x, y: out.y, z: out.z };
}

/**
 * A collider of zero thickness has no contact normal and a solver will push it
 * through a floor, so a segment thinner than a centimetre is padded rather than
 * refused.
 *
 * The upper bound applies to the head and nothing else — see
 * `MAX_SEGMENT_HALF_EXTENT`, which is also where the note lives about what capping
 * every segment did instead.
 */
function clampExtent(segment: RagdollSegment, half: number): number {
  return Math.min(Math.max(half, SMALLEST_HALF_EXTENT), MAX_SEGMENT_HALF_EXTENT[segment] ?? Infinity);
}

/**
 * Put a shape into a world at a pose: sixteen bodies, then fifteen joints.
 *
 * **The order of everything here is a format.** Rapier's promise of the same answer
 * on every machine is conditional on the same order of construction, so bodies go
 * in in `RAGDOLL_SEGMENTS` order and joints in the order that array implies, and
 * neither may become a `Map` iteration or a sort.
 */
export function buildRagdoll(world: RAPIER.World, shape: RagdollShape, pose: readonly SegmentPose[]): Ragdoll {
  if (pose.length !== shape.segments.length) {
    throw new Error(`ragdoll: ${pose.length} poses for ${shape.segments.length} segments`);
  }

  const bodies: RAPIER.RigidBody[] = [];
  for (let i = 0; i < shape.segments.length; i++) {
    const part = shape.segments[i]!;
    const at = pose[i]!;
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(at.position.x, at.position.y, at.position.z)
        .setRotation(at.rotation)
        // Damping is what stops a ragdoll flailing, and it is per segment because
        // legs and arms want opposite things — see `SEGMENT_ANGULAR_DAMPING`.
        .setAngularDamping(SEGMENT_ANGULAR_DAMPING[part.segment])
        .setLinearDamping(RAGDOLL_LINEAR_DAMPING)
        // Fifteen joints need more than the world's four passes to hold together
        // under a hard impulse. Per body, so no other kind inherits the cost.
        .setAdditionalSolverIterations(RAGDOLL_SOLVER_ITERATIONS)
        // A corpse made of somebody who was already falling arrives faster than a
        // floor is thick. See `RAGDOLL_CCD_PREDICTION`.
        .setSoftCcdPrediction(RAGDOLL_CCD_PREDICTION),
    );
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(part.halfExtents.x, part.halfExtents.y, part.halfExtents.z)
        .setTranslation(part.centre.x, part.centre.y, part.centre.z)
        .setMass(part.mass),
      body,
    );
    bodies.push(body);
  }

  const joints: RAPIER.ImpulseJoint[] = [];
  for (let i = 0; i < shape.segments.length; i++) {
    const part = shape.segments[i]!;
    const spec = SEGMENT_JOINTS[part.segment];
    if (spec === null || !part.anchor) {
      continue;
    }
    const parent = bodies[RAGDOLL_SEGMENTS.indexOf(spec.parent)]!;
    const joint = world.createImpulseJoint(RAPIER.JointData.spherical(part.anchor.parent, part.anchor.own), parent, bodies[i]!, true);
    setAngularLimits(world, joint, spec.limits);
    // Not tuning: every adjacent pair of segments touches by construction — a
    // forearm's box begins where the upper arm's ends — and contact resolution
    // between two bodies a joint already holds together fights the joint and locks
    // the corpse in its death pose. Measured at 0.020 rad of movement against
    // 3.137 without, in shared/tests/physicsDeterminism.test.ts.
    joint.setContactsEnabled(false);
    joints.push(joint);
  }
  return { bodies, joints };
}

/**
 * Put a simulated corpse back onto the skeleton that is drawn.
 *
 * The opposite of `poseFromRig`, and the last step of every frame a corpse is in:
 * sixteen rigid bodies have moved, and sixteen bones have to follow them.
 *
 * **Everything is in world space**, with the rig's own root left at the identity —
 * the trick `engine/fx/` plays for the same reason. A corpse is not standing
 * anywhere; it is lying where the physics put it, and giving the root a transform
 * would mean maintaining a second answer to where it is.
 *
 * Only the sixteen are driven. Every other joint — a clavicle, a neck, a coat, a
 * hundred facial bones — keeps the local transform its GLB gave it and is carried
 * along by whichever segment it hangs under, which is what makes a chain like
 * `back_mid → j_spine4 → j_neck → j_head` come out right with two of its four bones
 * simulated. That is also why the segments are written **in `RAGDOLL_SEGMENTS`
 * order**: a parent is placed before the child that measures itself against it.
 */
export function poseRagdoll(rig: CharacterRig, shape: RagdollShape, ragdoll: Ragdoll): void {
  const root = rig.root;
  root.position.set(0, 0, 0);
  root.quaternion.identity();
  root.scale.set(1, 1, 1);
  root.updateMatrixWorld(true);

  for (let i = 0; i < RAGDOLL_SEGMENTS.length; i++) {
    const bone = root.getObjectByName(SEGMENT_BONES[RAGDOLL_SEGMENTS[i]!]);
    const body = ragdoll.bodies[i];
    if (!bone?.parent || !body) {
      continue;
    }
    const at = body.translation();
    const turn = body.rotation();
    const scale = shape.rest[i]!.scale;

    wanted.compose(scratchPosition.set(at.x, at.y, at.z), scratchRotation.set(turn.x, turn.y, turn.z, turn.w), scratchScale.set(scale.x, scale.y, scale.z));
    // The parent's world matrix is already current: its own segment was written
    // earlier in this loop, or it is an undriven bone carried by one that was.
    bone.matrix.copy(intoParent.copy(bone.parent.matrixWorld).invert().multiply(wanted));
    bone.matrix.decompose(bone.position, bone.quaternion, bone.scale);
    // This bone's subtree, so the undriven joints under it — and the next segment's
    // parent chain — are current before the next iteration reads them.
    bone.updateWorldMatrix(false, true);
  }
}

const wanted = new THREE.Matrix4();
const intoParent = new THREE.Matrix4();
const scratchPosition = new THREE.Vector3();
const scratchRotation = new THREE.Quaternion();
const scratchScale = new THREE.Vector3();

/**
 * How the body knock is shared out: one factor per segment, by height.
 *
 * Derived from the shape's own rest pose, so both ends compute it from the same
 * GLB and get the same numbers — a divide and a multiply, nothing transcendental.
 * See `KNOCK_AT_FEET`.
 */
export function knockWeights(shape: RagdollShape): number[] {
  let low = Infinity;
  let high = -Infinity;
  for (const at of shape.rest) {
    low = Math.min(low, at.position.y);
    high = Math.max(high, at.position.y);
  }
  const span = high - low;
  return shape.rest.map((at) => {
    const up = span > 0 ? (at.position.y - low) / span : 0;
    return KNOCK_AT_FEET + (KNOCK_AT_HEAD - KNOCK_AT_FEET) * up;
  });
}

/**
 * Set a freshly-built corpse moving, exactly as the round that made it did.
 *
 * Three things, and the order of the first two is the whole of a bug that made the
 * impulse do nothing at all: **`setLinvel` assigns rather than adds**, so the
 * velocities go on first and the round's push second, or the push is wiped off the
 * only segment it was meant for.
 *
 *  1. `velocity` — what the player was already doing. Every segment, unweighted: a
 *     sprinting body carries its own momentum whole.
 *  2. `knock` — what the round did to the body, weighted by height so that it
 *     topples about the feet rather than sliding (`knockWeights`).
 *  3. `impulse` — the snap at the bone that was hit, which is the only part that
 *     is about one limb.
 *
 * Here rather than at each caller because a client and a test that started a corpse
 * differently would be two answers to the one question this whole subtree exists to
 * have one answer to.
 */
export function startRagdoll(ragdoll: Ragdoll, shape: RagdollShape, spawn: { velocity: Vec3; knock: Vec3; segment: number; impulse: Vec3 }): void {
  const weights = knockWeights(shape);
  for (let i = 0; i < ragdoll.bodies.length; i++) {
    const weight = weights[i] ?? 1;
    ragdoll.bodies[i]!.setLinvel(
      {
        x: spawn.velocity.x + spawn.knock.x * weight,
        y: spawn.velocity.y + spawn.knock.y * weight,
        z: spawn.velocity.z + spawn.knock.z * weight,
      },
      true,
    );
  }
  const hit = ragdoll.bodies[spawn.segment];
  if (hit && (spawn.impulse.x !== 0 || spawn.impulse.y !== 0 || spawn.impulse.z !== 0)) {
    // At the segment's own centre rather than at the impact point: a hit box is not
    // a surface, and a push at a corner of one spins a limb in a way a round would
    // not.
    hit.applyImpulse(spawn.impulse, true);
  }
}

/**
 * How far a corpse is lifted as it is created, metres.
 *
 * A body's hit boxes are derived from its mesh, and they reach a shade below the
 * sole it is standing on — measured at 1.4 cm on an ordinary body in an idle pose.
 * A hit box may do that harmlessly; a *collider* may not. Rapier finds sixteen boxes
 * one of which is inside the floor, ejects it, and the whole corpse pops: the hips
 * were measured rising 10 cm in the first third of a second, on every death, before
 * anything had even been shot.
 *
 * Two centimetres is under the smallest gap anybody will see and takes most of it
 * away. It is a constant rather than a computed clearance because the far end does
 * not know where the ground was — the wire carries the pelvis, not the floor — and
 * a corpse that spawns two centimetres high in mid-air is nothing at all.
 */
export const SPAWN_LIFT = 0.02;

/**
 * The pose a spawn describes, as sixteen world transforms.
 *
 * Only the rotations travel. A segment's *position* is its parent's, plus the offset
 * between the two bones in the rest pose, turned into the parent's new orientation —
 * a rotation of a fixed vector and an addition, and nothing else. That matters more
 * than the bytes it saves: every operation here is one IEEE-754 pins down exactly,
 * so two machines given the same rotations derive the same positions bit for bit,
 * where anything trigonometric would not.
 *
 * Walked in `RAGDOLL_SEGMENTS` order, which is parent-before-child by construction.
 *
 * Here rather than in the client because every end has to derive the *same* pose
 * from the same spawn, and two implementations of that is the one thing this whole
 * subtree exists to avoid.
 */
export function poseFromSpawn(shape: RagdollShape, spawn: { origin: Vec3; rotations: readonly Quat[] }): SegmentPose[] {
  const out: SegmentPose[] = [];
  const offset = new THREE.Vector3();
  const turn = new THREE.Quaternion();
  const origin = { x: spawn.origin.x, y: spawn.origin.y + SPAWN_LIFT, z: spawn.origin.z };

  for (let i = 0; i < RAGDOLL_SEGMENTS.length; i++) {
    const rotation = spawn.rotations[i] ?? { x: 0, y: 0, z: 0, w: 1 };
    const joint = SEGMENT_JOINTS[RAGDOLL_SEGMENTS[i]!];
    if (joint === null) {
      out.push({ position: origin, rotation });
      continue;
    }
    const parentIndex = RAGDOLL_SEGMENTS.indexOf(joint.parent);
    const parent = out[parentIndex]!;
    const parentRest = shape.rest[parentIndex]!;
    const rest = shape.rest[i]!;

    // Where this bone sits relative to its parent at rest, said in the parent's own
    // frame, then re-said in the frame the parent is in now.
    offset.set(rest.position.x - parentRest.position.x, rest.position.y - parentRest.position.y, rest.position.z - parentRest.position.z);
    turn.set(parentRest.rotation.x, parentRest.rotation.y, parentRest.rotation.z, parentRest.rotation.w).invert();
    offset.applyQuaternion(turn);
    offset.applyQuaternion(turn.set(parent.rotation.x, parent.rotation.y, parent.rotation.z, parent.rotation.w));

    out.push({
      position: { x: parent.position.x + offset.x, y: parent.position.y + offset.y, z: parent.position.z + offset.z },
      rotation,
    });
  }
  return out;
}
