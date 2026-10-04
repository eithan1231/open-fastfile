// The claim the whole of @3d/shared/physics rests on.
//
// Everything dynamic is simulated on both ends rather than streamed, so a corpse,
// a grenade and a care package are only ever in one place because **Rapier gives
// the same answer everywhere**. That is a promise about one build, given the same
// initial conditions and the same order of construction, and it is the kind of
// promise that is either true or quietly false — a divergence shows up as a body
// lying somewhere else on somebody else's screen, with nothing logged.
//
// So it is pinned here rather than believed:
//
//  - **Two worlds built the same way agree**, byte for byte, which catches a
//    construction order that depends on iteration order or on a hash map.
//  - **The bytes hash to a committed constant**, which is the only cross-machine
//    claim this repo can make from one machine. If CI and a laptop disagree, this
//    is the test that says so, and a Rapier bump is *defined* as the act of
//    re-recording it (`pnpm-workspace.yaml` pins the version exact for this).
//  - **A different number of steps hashes differently**, or the two above prove
//    nothing at all.
//
// It also pins the two pieces of Rapier behaviour the ragdoll is built on, because
// both were surprises and neither is in the JS documentation: angular limits on a
// spherical joint, and what happens to a joint whose two colliders touch.
//
// The one place in the repo that imports Rapier outside `src/physics/` — this is a
// test *of* the engine, so it holds the engine directly rather than through the
// wrapper it is validating.

import { describe, expect, it, beforeAll } from "vitest";
import { createHash } from "node:crypto";
import RAPIER from "@dimforge/rapier3d-deterministic-compat";
import { createPhysicsWorld, initPhysics } from "../src/physics/engine.js";
import { evenLimits, setAngularLimits } from "../src/physics/joints.js";
import { TICK_DT } from "../src/net/messages/fields.js";

/**
 * The build these numbers came from. Exact, and `pnpm-workspace.yaml` says why:
 * determinism is a property of one build, so two machines on two versions is how
 * corpses quietly stop agreeing.
 */
const PINNED_VERSION = "0.20.0";

/**
 * `sha256(world.takeSnapshot())` after `STEPS` steps of `build()`.
 *
 * Recorded on x86-64 Linux, Node 24. **This constant is the cross-machine claim.**
 * Changing the fixture or the engine changes it; changing it for any other reason
 * is the bug this test exists to find.
 */
const REFERENCE = "61aebe1e4fae5a8e38ef0d1e4a8ae841a06613082af07131f2e93f76c64a1c5e";
const STEPS = 600;

beforeAll(async () => {
  await initPhysics();
});

/**
 * A chain of four boxes on a spherical joint and two hinges, dropped onto a floor
 * and kicked — the shape a ragdoll has, in miniature.
 *
 * Every number here is a literal or a `Math.sqrt`, and that is the discipline
 * rather than an accident: IEEE-754 requires `sqrt` to be correctly rounded, while
 * Rapier's own documentation names `Math.sin`/`Math.cos` as not cross-platform
 * deterministic. Nothing computed with one may reach a physics world — in the game
 * that is what the quantised wire is for, and in here it is what keeps this test
 * from measuring V8's trigonometry instead of Rapier.
 */
function build(): RAPIER.World {
  const world = createPhysicsWorld(TICK_DT);

  // The floor first. Construction order is part of what is being asserted, so it
  // is written down rather than left to whatever the caller happens to do.
  world.createCollider(RAPIER.ColliderDesc.cuboid(50, 0.5, 50));

  const segments: RAPIER.RigidBody[] = [];
  for (let i = 0; i < 4; i++) {
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(0.05 * i, 3 - 0.4 * i, 0)
        .setRotation({ x: 0.1, y: 0, z: 0, w: Math.sqrt(0.99) }),
    );
    world.createCollider(RAPIER.ColliderDesc.cuboid(0.12, 0.18, 0.12).setMass(4 + i), body);
    segments.push(body);
  }

  const joints = [spherical(world, segments[0]!, segments[1]!, 0.45), hinge(world, segments[1]!, segments[2]!), hinge(world, segments[2]!, segments[3]!)];
  expect(joints).toHaveLength(3);

  segments[3]!.applyImpulse({ x: 9, y: 3, z: 4 }, true);
  return world;
}

/** Where a segment hangs off its parent: the parent's foot, the child's head. */
const ANCHOR_PARENT = { x: 0, y: -0.18, z: 0 };
const ANCHOR_CHILD = { x: 0, y: 0.18, z: 0 };

/**
 * A spherical joint with its three angular axes limited to ±`limit`.
 *
 * `JointData.spherical` reports its type as `Generic`, and the typed
 * `SphericalImpulseJoint` wrapper exposes motors but **no `setLimits`** — the limit
 * lives on the raw set, per axis, and that is the only way to reach it.
 */
function spherical(world: RAPIER.World, parent: RAPIER.RigidBody, child: RAPIER.RigidBody, limit: number): RAPIER.ImpulseJoint {
  const joint = world.createImpulseJoint(RAPIER.JointData.spherical(ANCHOR_PARENT, ANCHOR_CHILD), parent, child, true);
  setAngularLimits(world, joint, evenLimits(limit));
  joint.setContactsEnabled(false);
  return joint;
}

/** An elbow: one axis, stopping short of straight and short of folded. */
function hinge(world: RAPIER.World, parent: RAPIER.RigidBody, child: RAPIER.RigidBody): RAPIER.ImpulseJoint {
  const joint = world.createImpulseJoint(
    RAPIER.JointData.revolute(ANCHOR_PARENT, ANCHOR_CHILD, { x: 0, y: 0, z: 1 }),
    parent,
    child,
    true,
  ) as RAPIER.RevoluteImpulseJoint;
  joint.setLimits(0, 2.6);
  joint.setContactsEnabled(false);
  return joint;
}

function snapshotAfter(steps: number): Uint8Array {
  const world = build();
  for (let i = 0; i < steps; i++) {
    world.step();
  }
  const snapshot = world.takeSnapshot();
  world.free();
  return snapshot;
}

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe("Rapier is deterministic", () => {
  it("is the pinned build", () => {
    // A caret range here would be the mechanism by which two machines quietly get
    // different engines, so the pin is asserted rather than trusted to a lockfile.
    expect(RAPIER.version()).toBe(PINNED_VERSION);
  });

  it("gives two identically-built worlds identical bytes", () => {
    expect(snapshotAfter(STEPS)).toEqual(snapshotAfter(STEPS));
  });

  it("gives the same bytes on every machine", () => {
    expect(digest(snapshotAfter(STEPS))).toBe(REFERENCE);
  });

  it("gives different bytes for a different number of steps", () => {
    // Without this the two above would pass on a fixture that never moved.
    expect(digest(snapshotAfter(STEPS - 1))).not.toBe(digest(snapshotAfter(STEPS)));
  });
});

describe("what the ragdoll is built on", () => {
  /** Peak rotation of a child swung off a pinned parent, in radians. */
  function swing(limit: number | null, contacts: boolean): number {
    const world = createPhysicsWorld(TICK_DT);
    const parent = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, 3, 0));
    world.createCollider(RAPIER.ColliderDesc.cuboid(0.12, 0.18, 0.12), parent);
    const child = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 2.64, 0));
    world.createCollider(RAPIER.ColliderDesc.cuboid(0.12, 0.18, 0.12).setMass(5), child);

    const joint = world.createImpulseJoint(RAPIER.JointData.spherical(ANCHOR_PARENT, ANCHOR_CHILD), parent, child, true);
    if (limit !== null) {
      setAngularLimits(world, joint, evenLimits(limit));
    }
    joint.setContactsEnabled(contacts);

    child.applyImpulse({ x: 40, y: 0, z: 12 }, true);
    let peak = 0;
    for (let i = 0; i < 240; i++) {
      world.step();
      const q = child.rotation();
      peak = Math.max(peak, 2 * Math.acos(Math.min(1, Math.abs(q.w))));
    }
    world.free();
    return peak;
  }

  it("lets a spherical joint be limited per angular axis", () => {
    // Unlimited, the child swings all the way round.
    expect(swing(null, false)).toBeGreaterThan(3);

    // Limited, it does not — but note *what* the limit is. Rapier limits each
    // angular axis separately, so ±0.3 on all three is a box in angle space and
    // not a cone: a rotation about a diagonal reaches 0.3 * sqrt(3) ≈ 0.52. The
    // joint table is written in those terms rather than as a cone and a twist,
    // because pretending otherwise would put the numbers a third out.
    expect(swing(0.3, false)).toBeLessThan(0.3 * Math.sqrt(3) + 0.05);
    expect(swing(0.3, false)).toBeGreaterThan(0.3);
  });

  it("jams a joint whose two colliders touch", () => {
    // Every adjacent pair of a ragdoll's segments touches by construction — a
    // forearm's box begins where the upper arm's ends. Left enabled, contact
    // resolution fights the joint and the corpse locks up in its death pose,
    // which looks exactly like a joint limit set to zero and is not one. So
    // `setContactsEnabled(false)` is not tuning; it is a requirement, and this is
    // the measurement that says so.
    expect(swing(null, true)).toBeLessThan(0.05);
    expect(swing(null, false)).toBeGreaterThan(3);
  });
});
