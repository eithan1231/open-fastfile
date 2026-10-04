// Where a line meets a body (sim/hit.ts).
//
// Plain numbers, so every case here is written as literals and checked against
// arithmetic done by hand. The one that earns its keep is the scaled box: a bone's
// matrix carries the rig's unit-scale root, so a length measured inside a bone's
// frame is not a length in the world — and a version that returns box-space
// distances is right for every unscaled thing and wrong for every real one.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { nearCapsule, rayBox, type Mat4 } from "../src/sim/hit.js";

const at = (x: number, y: number, z: number) => ({ x, y, z });

/** A column-major 4x4 from position/rotation/scale, as three.js composes one. */
function inverseOf(position: THREE.Vector3, quaternion: THREE.Quaternion, scale: THREE.Vector3): Mat4 {
  return new THREE.Matrix4().compose(position, quaternion, scale).invert().elements;
}

const IDENTITY: Mat4 = new THREE.Matrix4().elements;

describe("a ray passing near a capsule", () => {
  // A standing player: the capsule's segment from 0.3 up to 1.4, radius 0.3.
  const a = at(0, 0.3, 0);
  const b = at(0, 1.4, 0);

  it("finds a body in the way, at its closest approach rather than its surface", () => {
    // Fired from 10 m out at chest height, straight through: closest approach is the
    // axis at x = 0, which is halfway along a 20 m segment. Not 9.7/20, which is
    // where the *surface* is — this is a broad phase and the box tests behind it are
    // what decide a distance.
    const s = nearCapsule(at(-10, 1, 0), at(10, 1, 0), a, b, 0.3);
    expect(s).not.toBeNull();
    expect(s!).toBeCloseTo(0.5, 6);
  });

  it("orders two bodies by which is nearer, which is all it is used for", () => {
    const near = nearCapsule(at(-10, 1, 0), at(10, 1, 0), at(-5, 0.3, 0), at(-5, 1.4, 0), 0.3);
    const far = nearCapsule(at(-10, 1, 0), at(10, 1, 0), at(5, 0.3, 0), at(5, 1.4, 0), 0.3);
    expect(near).not.toBeNull();
    expect(far).not.toBeNull();
    expect(near!).toBeLessThan(far!);
  });

  it("misses one that is beside it", () => {
    expect(nearCapsule(at(-10, 1, 0.31), at(10, 1, 0.31), a, b, 0.3)).toBeNull();
    // And just barely does not, which is where an off-by-a-radius would show.
    expect(nearCapsule(at(-10, 1, 0.29), at(10, 1, 0.29), a, b, 0.3)).not.toBeNull();
  });

  it("misses over the head and under the feet", () => {
    expect(nearCapsule(at(-10, 1.75, 0), at(10, 1.75, 0), a, b, 0.3)).toBeNull();
    expect(nearCapsule(at(-10, -0.05, 0), at(10, -0.05, 0), a, b, 0.3)).toBeNull();
    // The caps are part of the capsule: just inside the top is a hit.
    expect(nearCapsule(at(-10, 1.65, 0), at(10, 1.65, 0), a, b, 0.3)).not.toBeNull();
  });

  it("stops at the end of the segment, so a shot cannot reach past its range", () => {
    // The body is 10 m away and the shot travels 5.
    expect(nearCapsule(at(-10, 1, 0), at(-5, 1, 0), a, b, 0.3)).toBeNull();
  });

  it("is zero when it starts inside", () => {
    expect(nearCapsule(at(0, 1, 0), at(10, 1, 0), a, b, 0.3)).toBeCloseTo(0, 6);
  });

  it("answers for a zero-length ray without dividing by it", () => {
    expect(nearCapsule(at(0, 1, 0), at(0, 1, 0), a, b, 0.3)).toBeNull();
  });
});

describe("a ray against a bone's box", () => {
  const min = at(-1, -1, -1);
  const max = at(1, 1, 1);

  it("enters an unmoved box where the arithmetic says", () => {
    // From x = -10 to x = 10; the face is at -1, so 9 of 20.
    expect(rayBox(at(-10, 0, 0), at(10, 0, 0), IDENTITY, min, max)!).toBeCloseTo(9 / 20, 6);
  });

  it("misses one it passes beside, above or behind", () => {
    expect(rayBox(at(-10, 1.01, 0), at(10, 1.01, 0), IDENTITY, min, max)).toBeNull();
    expect(rayBox(at(-10, 0, 1.01), at(10, 0, 1.01), IDENTITY, min, max)).toBeNull();
    // Behind: the segment ends before it arrives.
    expect(rayBox(at(-10, 0, 0), at(-5, 0, 0), IDENTITY, min, max)).toBeNull();
  });

  it("is zero when the segment starts inside", () => {
    // A shot fired from within someone has already hit them.
    expect(rayBox(at(0, 0, 0), at(10, 0, 0), IDENTITY, min, max)).toBe(0);
  });

  it("follows the box when the bone moves and turns", () => {
    const inverse = inverseOf(new THREE.Vector3(5, 0, 0), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 4), new THREE.Vector3(1, 1, 1));
    const hit = rayBox(at(-10, 0, 0), at(10, 0, 0), inverse, min, max);
    expect(hit).not.toBeNull();
    // Turned 45° about Y, so the box presents a corner: its nearest point along x is
    // 5 - sqrt(2), and the segment spans 20 from x = -10.
    expect(hit!).toBeCloseTo((5 - Math.SQRT2 + 10) / 20, 4);
  });

  it("gives a fraction that survives the bone's scale, which is the whole point", () => {
    // A rig hangs from a unit-scale root, so a bone's matrix scales its own frame.
    // The same box at the same place in the world must answer the same whatever
    // units it is stored in — the version that returns box-space distances passes
    // every unscaled case above and fails this one.
    const plain = rayBox(at(-10, 0, 0), at(10, 0, 0), IDENTITY, at(-1, -1, -1), at(1, 1, 1));

    const scale = 0.0254;
    const scaled = rayBox(
      at(-10, 0, 0),
      at(10, 0, 0),
      inverseOf(new THREE.Vector3(), new THREE.Quaternion(), new THREE.Vector3(scale, scale, scale)),
      at(-1 / scale, -1 / scale, -1 / scale),
      at(1 / scale, 1 / scale, 1 / scale),
    );
    expect(scaled).not.toBeNull();
    expect(scaled!).toBeCloseTo(plain!, 6);
  });

  it("handles a ray parallel to a face without dividing by zero", () => {
    // Exactly along the slab: inside it for the whole segment, so the other two
    // axes decide.
    expect(rayBox(at(-10, 1, 0), at(10, 1, 0), IDENTITY, min, max)).not.toBeNull();
    expect(rayBox(at(-10, 1.5, 0), at(10, 1.5, 0), IDENTITY, min, max)).toBeNull();
  });

  it("agrees with three.js's own ray for the same box", () => {
    // A cross-check against an implementation nobody here wrote.
    const box = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
    for (const [oy, oz] of [
      [0, 0],
      [0.5, -0.25],
      [-0.9, 0.9],
    ] as const) {
      const from = at(-10, oy, oz);
      const to = at(10, oy, oz);
      const mine = rayBox(from, to, IDENTITY, min, max);
      const ray = new THREE.Ray(new THREE.Vector3(from.x, from.y, from.z), new THREE.Vector3(1, 0, 0));
      const point = ray.intersectBox(box, new THREE.Vector3());
      expect(mine === null).toBe(point === null);
      if (mine !== null && point !== null) {
        expect(mine * 20).toBeCloseTo(point.x - from.x, 6);
      }
    }
  });
});
