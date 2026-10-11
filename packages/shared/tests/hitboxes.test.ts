// A body's hit volumes (rig/hitboxes.ts): reading them, binding them to bones, and
// tracing a line through them once the skeleton has moved.
//
// The test that matters is the last one. A box is stored in its bone's own space and
// posed by that bone's world matrix, which is what lets one box per bone follow every
// clip — so the thing to prove is that turning a joint moves the volume with it, and
// by the right amount.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { BoundHitboxes, couldHit, readHitboxes, HITBOX_FORMAT_VERSION } from "../src/rig/hitboxes.js";
import { bindPoseOf, type CharacterRig } from "../src/rig/character.js";
import { RADIUS, STAND_HEIGHT as HEIGHT } from "../src/sim/movement.js";

const at = (x: number, y: number, z: number) => ({ x, y, z });

function sidecar(bones: unknown[] = [{ bone: "j_head", location: "head", min: [-1, -1, -1], max: [1, 1, 1] }]) {
  return { version: HITBOX_FORMAT_VERSION, bones };
}

describe("reading a hitbox sidecar", () => {
  it("takes one it understands", () => {
    const boxes = readHitboxes(sidecar());
    expect(boxes).toHaveLength(1);
    expect(boxes[0]!.bone).toBe("j_head");
    expect(boxes[0]!.location).toBe("head");
    expect(boxes[0]!.min).toEqual(at(-1, -1, -1));
  });

  it("refuses one from a different exporter, rather than guessing at it", () => {
    // A body whose boxes will not load is one nobody can be shot on, which is worth
    // a failure at load rather than a silent immunity in a match.
    expect(() => readHitboxes({ ...sidecar(), version: 99 })).toThrow(/this build reads/);
  });

  it("refuses one with nothing in it, or a location it does not know", () => {
    expect(() => readHitboxes({ ...sidecar(), bones: [] })).toThrow(/no boxes/);
    expect(() => readHitboxes(sidecar([{ bone: "j_head", location: "elbow", min: [0, 0, 0], max: [1, 1, 1] }]))).toThrow(/bad entry/);
    expect(() => readHitboxes(null)).toThrow(/not an object/);
  });

  it("refuses a corner that is not three finite numbers", () => {
    expect(() => readHitboxes(sidecar([{ bone: "j_head", location: "head", min: [0, 0], max: [1, 1, 1] }]))).toThrow(/three numbers/);
    expect(() => readHitboxes(sidecar([{ bone: "j_head", location: "head", min: [0, 0, NaN], max: [1, 1, 1] }]))).toThrow(/three numbers/);
  });
});

/** A two-bone skeleton: a root, and a head a metre above it. */
function rigOf(): { rig: CharacterRig; root: THREE.Object3D; head: THREE.Object3D } {
  const root = new THREE.Bone();
  root.name = "j_mainroot";
  const head = new THREE.Bone();
  head.name = "j_head";
  head.position.set(0, 1, 0);
  root.add(head);
  const holder = new THREE.Group();
  holder.add(root);
  return { rig: { name: "test", root: holder, aim: undefined, clips: new Map(), bind: bindPoseOf(holder), set: {} as never }, root, head };
}

describe("boxes bound to a body's bones", () => {
  it("drops a box naming a bone this body has not got", () => {
    // Bodies differ in their cloth and head joints; the hit bones are common to all
    // of them, so this is a belt to the braces.
    const { rig } = rigOf();
    const bound = new BoundHitboxes(
      rig,
      readHitboxes(
        sidecar([
          { bone: "j_head", location: "head", min: [-1, -1, -1], max: [1, 1, 1] },
          { bone: "j_ponytail", location: "head", min: [-1, -1, -1], max: [1, 1, 1] },
        ]),
      ),
    );
    expect(bound.size).toBe(1);
  });

  it("finds the box where the bone is, not where it was authored", () => {
    const { rig, head } = rigOf();
    const bound = new BoundHitboxes(rig, readHitboxes(sidecar([{ bone: "j_head", location: "head", min: [-0.2, -0.2, -0.2], max: [0.2, 0.2, 0.2] }])));
    rig.root.updateMatrixWorld(true);

    // The head is a metre up, so a shot at head height hits and one at the root misses.
    expect(bound.trace(at(-10, 1, 0), at(10, 1, 0))).not.toBeNull();
    expect(bound.trace(at(-10, 0, 0), at(10, 0, 0))).toBeNull();

    const hit = bound.trace(at(-10, 1, 0), at(10, 1, 0))!;
    expect(hit.location).toBe("head");
    expect(hit.bone).toBe("j_head");
    // The near face is at x = -0.2 along a 20 m segment.
    expect(hit.fraction).toBeCloseTo(9.8 / 20, 4);
    void head;
  });

  it("carries the box with the bone when the skeleton moves", () => {
    // The whole reason a box lives in bone space. Move the head and the volume goes
    // with it, without anything re-deriving a box.
    const { rig, root, head } = rigOf();
    const bound = new BoundHitboxes(rig, readHitboxes(sidecar([{ bone: "j_head", location: "head", min: [-0.2, -0.2, -0.2], max: [0.2, 0.2, 0.2] }])));

    rig.root.updateMatrixWorld(true);
    expect(bound.trace(at(-10, 1, 0), at(10, 1, 0))).not.toBeNull();

    // Duck: the root drops half a metre, so the head is at 0.5 and the old shot misses.
    root.position.set(0, -0.5, 0);
    rig.root.updateMatrixWorld(true);
    expect(bound.trace(at(-10, 1, 0), at(10, 1, 0))).toBeNull();
    expect(bound.trace(at(-10, 0.5, 0), at(10, 0.5, 0))).not.toBeNull();

    // Lean: turning the root about z swings the head sideways, and the box follows.
    root.position.set(0, 0, 0);
    root.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
    rig.root.updateMatrixWorld(true);
    expect(bound.trace(at(-10, 1, 0), at(10, 1, 0))).toBeNull();
    // Now a metre along -x instead, so a shot down z at that place finds it.
    expect(bound.trace(at(-1, 0, -10), at(-1, 0, 10))).not.toBeNull();
    void head;
  });

  it("returns the nearest box when a shot passes through two", () => {
    const { rig, head } = rigOf();
    head.position.set(0, 0, 0); // both boxes at the origin, one bigger than the other
    const bound = new BoundHitboxes(
      rig,
      readHitboxes(
        sidecar([
          { bone: "j_mainroot", location: "torsoLower", min: [-1, -1, -1], max: [1, 1, 1] },
          { bone: "j_head", location: "head", min: [-0.3, -0.3, -0.3], max: [0.3, 0.3, 0.3] },
        ]),
      ),
    );
    rig.root.updateMatrixWorld(true);
    // The big box is entered first, at x = -1 rather than -0.3.
    expect(bound.trace(at(-10, 0, 0), at(10, 0, 0))!.location).toBe("torsoLower");
  });
});

describe("the broad phase", () => {
  const feet = at(0, 0, 0);

  it("lets through a shot that could reach the body", () => {
    expect(couldHit(at(-10, 1, 0), at(10, 1, 0), feet, RADIUS, HEIGHT, 0.4)).not.toBeNull();
  });

  it("rejects one that passes wide, above or short", () => {
    expect(couldHit(at(-10, 1, 3), at(10, 1, 3), feet, RADIUS, HEIGHT, 0.4)).toBeNull();
    expect(couldHit(at(-10, 5, 0), at(10, 5, 0), feet, RADIUS, HEIGHT, 0.4)).toBeNull();
    expect(couldHit(at(-10, 1, 0), at(-5, 1, 0), feet, RADIUS, HEIGHT, 0.4)).toBeNull();
  });

  it("is widened by the margin, so an outstretched limb is not rejected before it is posed", () => {
    // The capsule is what the simulation *moves*; an arm or a mantling leg reaches
    // outside it, and rejecting on the bare capsule would miss those before anything
    // had a chance to pose them.
    const justOutside = RADIUS + 0.3;
    expect(couldHit(at(-10, 1, justOutside), at(10, 1, justOutside), feet, RADIUS, HEIGHT, 0)).toBeNull();
    expect(couldHit(at(-10, 1, justOutside), at(10, 1, justOutside), feet, RADIUS, HEIGHT, 0.4)).not.toBeNull();
  });
});
