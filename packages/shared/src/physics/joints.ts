// Joint limits, and the one cast that reaching them costs.
//
// A ragdoll needs two kinds of stop: a hinge for an elbow or a knee, and a bounded
// ball for a shoulder, a hip or a neck. Rapier gives both, but only one of them
// through its typed API, and the difference is worth writing down once here rather
// than discovering twice:
//
//  - A **revolute** joint is `RevoluteImpulseJoint.setLimits(min, max)`. Nothing to
//    see.
//  - A **spherical** joint reports its type as `Generic`, and its typed wrapper
//    exposes motors and no limits at all. The limits are on the raw joint set, set
//    per angular axis — which is also the only place `JointAxis` has to be laundered
//    into `RawJointAxis`, two enums with identical members and no assignability
//    between them.
//
// **A per-axis limit is a box in angle space, not a cone.** ±θ on all three axes
// admits a rotation of θ·√3 about a diagonal, so a table written as "a 45° cone"
// and applied here would be half again as loose as it reads. The table is written
// in these terms instead, and tests/physicsDeterminism.test.ts measures it.

import RAPIER from "@dimforge/rapier3d-deterministic-compat";

/** The three angular axes of a spherical joint, in the order a limit triple names them. */
export const ANGULAR_AXES = [RAPIER.JointAxis.AngX, RAPIER.JointAxis.AngY, RAPIER.JointAxis.AngZ] as const;

/** How far a joint may turn about each of its angular axes, radians, `[min, max]`. */
export interface AngularLimits {
  x: readonly [number, number];
  y: readonly [number, number];
  z: readonly [number, number];
}

/**
 * The raw set's own spelling of an axis. Taken off the signature rather than
 * imported: `RawJointAxis` lives in a module the package's `exports` map does not
 * publish, so there is no honest way to name it directly.
 */
type RawAxis = Parameters<RAPIER.World["impulseJoints"]["raw"]["jointSetLimits"]>[1];

/**
 * Limit all three angular axes of a joint.
 *
 * Works on a spherical joint, which has no other way to be limited, and would work
 * on any other — but a revolute joint should use its own `setLimits`, which says
 * what it means and does not need the cast below.
 */
export function setAngularLimits(world: RAPIER.World, joint: RAPIER.ImpulseJoint, limits: AngularLimits): void {
  const ranges = [limits.x, limits.y, limits.z];
  for (let i = 0; i < ANGULAR_AXES.length; i++) {
    const axis = ANGULAR_AXES[i]! as unknown as RawAxis;
    const [min, max] = ranges[i]!;
    world.impulseJoints.raw.jointSetLimits(joint.handle, axis, min, max);
  }
}

/** The same limit either way about every axis — what a symmetric ball joint wants. */
export function evenLimits(limit: number): AngularLimits {
  const range = [-limit, limit] as const;
  return { x: range, y: range, z: range };
}
