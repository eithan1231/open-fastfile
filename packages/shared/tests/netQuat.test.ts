// A rotation on the wire, and the one property the corpses depend on.
//
// A spawn carries sixteen of these, and every end simulates from the value it
// decoded rather than the value somebody meant — which is what makes "the same
// initial conditions" literally true across machines rather than nearly true.
// `round` is that rule as a function, and it has to be a *fixed point*: encoding an
// already-encoded rotation must not move it again, or the server's copy and the
// client's would drift apart by one step per hop.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { quat, type Quat } from "../src/net/codec/schema.js";
import { BitReader, BitWriter } from "../src/net/codec/bits.js";

function roundTrip(value: Quat): Quat {
  const w = new BitWriter();
  quat.write(w, value);
  return quat.read(new BitReader(w.finish()));
}

/** Rotations spread over the whole sphere, plus the awkward ones. */
function samples(): Quat[] {
  const out: Quat[] = [
    { x: 0, y: 0, z: 0, w: 1 },
    { x: 0, y: 0, z: 0, w: -1 },
    { x: 1, y: 0, z: 0, w: 0 },
    // All four components equal, which is where "the largest" is a tie.
    { x: 0.5, y: 0.5, z: 0.5, w: 0.5 },
    { x: -0.5, y: 0.5, z: -0.5, w: 0.5 },
  ];
  const axis = new THREE.Vector3();
  for (let i = 0; i < 200; i++) {
    axis.set(Math.sin(i * 1.7), Math.cos(i * 2.3), Math.sin(i * 0.9 + 1)).normalize();
    const q = new THREE.Quaternion().setFromAxisAngle(axis, (i / 200) * Math.PI * 2 - Math.PI);
    out.push({ x: q.x, y: q.y, z: q.z, w: q.w });
  }
  return out;
}

/** The angle between two rotations, radians. */
function between(a: Quat, b: Quat): number {
  const dot = Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w);
  return 2 * Math.acos(Math.min(1, dot));
}

describe("a quaternion on the wire", () => {
  it("costs 32 bits", () => {
    const w = new BitWriter();
    quat.write(w, { x: 0, y: 0, z: 0, w: 1 });
    expect(w.finish().byteLength).toBe(4);
  });

  it("comes back as a unit rotation", () => {
    for (const value of samples()) {
      const back = roundTrip(value);
      const length = Math.hypot(back.x, back.y, back.z, back.w);
      expect(length).toBeCloseTo(1, 6);
    }
  });

  it("is within a fifth of a degree everywhere on the sphere", () => {
    let worst = 0;
    for (const value of samples()) {
      worst = Math.max(worst, between(value, roundTrip(value)));
    }
    // Ten bits over ±1/sqrt(2) is a step of 0.0014 per component. A millimetre and
    // a half at the end of a forearm, and nothing a corpse's first frame needs
    // better than.
    expect((worst * 180) / Math.PI).toBeLessThan(0.2);
  });

  it("rounds to a fixed point", () => {
    // **The property the corpses rest on.** The server encodes its own spawn and
    // simulates the decoded value; a `round` that moved a second time would put the
    // two ends one step apart on every hop, which in a contact-rich sim is a
    // different pile of bodies a second later.
    for (const value of samples()) {
      const once = quat.round!(value);
      const twice = quat.round!(once);
      expect(twice).toEqual(once);
      // And it agrees with what actually crosses the wire, or `round` would be
      // describing a different codec from the one in use.
      expect(roundTrip(value)).toEqual(once);
    }
  });

  it("treats a rotation and its negation as the same", () => {
    // q and -q name one rotation, and smallest-three drops the sign of the largest
    // component — so both must decode to the same bytes, not merely to the same
    // rotation.
    for (const value of samples()) {
      const negated = { x: -value.x, y: -value.y, z: -value.z, w: -value.w };
      expect(roundTrip(negated)).toEqual(roundTrip(value));
    }
  });
});
