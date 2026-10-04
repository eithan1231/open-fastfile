// Pins the Quake-angles -> `rotate:` conversion scripts/cod/props.py writes into
// every imported world's props.world. The generator is Python, so nothing else in
// the build would notice if its idea of an euler stopped matching the engine's.
//
// Two independent things are asserted:
//   1. the euler the generator emits reproduces the orientation the entity
//      actually describes, once carried into the engine's frame; and
//   2. three.js reads that euler back the way the generator assumed
//      (order "XYZ", i.e. R = Rx . Ry . Rz), which is what buildModelMesh's
//      `group.rotation.set()` will do with it.

import { describe, expect, it } from "vitest";
import * as THREE from "three";

const DEG = Math.PI / 180;

/** [[pitch, yaw, roll], [x, y, z]] — right-hand side straight from scripts/cod/props.py. */
// prettier-ignore
const GOLDEN: [[number, number, number], [number, number, number]][] = [
  [[0, 0, 0], [0, 0, 0]],
  [[0, 90, 0], [0, 90, 0]],
  [[0, 180, 0], [-180, 0, -180]],
  [[0, 270, 0], [0, -90, 0]],
  [[-90, 0, 0], [0, 0, 90]],
  [[90, 0, 0], [0, 0, -90]],
  [[0, 0, 180], [180, 0, 0]],
  [[0, 0, -90], [-90, 0, 0]],
  [[-90, 45, 0], [0, 45, 90]],
  [[-63.7, 120, 6.1], [175.356459, 54.438306, -112.390728]],
  [[4.7, -30, -4.8], [-5.498038, -29.492431, -7.429508]],
  [[1, 2, 3], [3.001273, 1.944926, -1.103325]],
  [[0, 98, 90], [90, 0, -98]], // the `dome` entity itself
];

/**
 * The orientation an entity describes, expressed in the engine's frame.
 *
 * Built here from first principles rather than from the generator's output:
 * idTech composes "angles" as Rz(yaw).Ry(pitch).Rx(roll) in Call of Duty's
 * +X-forward/+Y-left/+Z-up frame, and the engine's frame is that one turned by
 * Rx(-90). A rotation moves between frames by conjugation.
 */
function expectedEngineRotation(pitch: number, yaw: number, roll: number): THREE.Matrix4 {
  const cod = new THREE.Matrix4()
    .makeRotationZ(yaw * DEG)
    .multiply(new THREE.Matrix4().makeRotationY(pitch * DEG))
    .multiply(new THREE.Matrix4().makeRotationX(roll * DEG));
  const toEngine = new THREE.Matrix4().makeRotationX(-90 * DEG);
  return new THREE.Matrix4().multiplyMatrices(toEngine, cod).multiply(toEngine.clone().invert());
}

function maxElementDelta(a: THREE.Matrix4, b: THREE.Matrix4): number {
  return Math.max(...a.elements.map((v, i) => Math.abs(v - b.elements[i]!)));
}

describe("mp_dome prop orientation", () => {
  it("emits an euler that reproduces the entity's true orientation", () => {
    for (const [[pitch, yaw, roll], euler] of GOLDEN) {
      // Exactly what scene/models.ts does with a resolved model's rotation.
      const applied = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(euler[0] * DEG, euler[1] * DEG, euler[2] * DEG, "XYZ"));
      // 1e-7 is set by GOLDEN being rounded to six decimal places of a degree
      // (~1.7e-8 rad), not by the conversion. Any real convention error — a
      // flipped sign, a swapped axis — moves matrix elements by O(1).
      expect(maxElementDelta(applied, expectedEngineRotation(pitch, yaw, roll))).toBeLessThan(1e-7);
    }
  });

  it("keeps a pure yaw on the engine's vertical axis", () => {
    // The generator leans on this to emit a one-value `rotate:` for the ~975
    // props that only need a yaw, so it has to stay true.
    for (const yaw of [0, 30, 90, 145, 270]) {
      const expected = new THREE.Matrix4().makeRotationY(yaw * DEG);
      expect(maxElementDelta(expectedEngineRotation(0, yaw, 0), expected)).toBeLessThan(1e-12);
    }
  });

  it("stands the dome up rather than laying it flat", () => {
    // The regression in human terms. The dome model is authored lying down, and
    // the map's roll of 90 is the only thing that raises it. The model's own up
    // is its local -Z: its geometry runs from z -24.6 to z +4.1 around a pivot
    // near the top, which is why dropping the roll left the dome both flat AND
    // offset from where it belongs.
    const modelUp = new THREE.Vector3(0, 0, -1).applyMatrix4(expectedEngineRotation(0, 98, 90));
    expect(modelUp.y).toBeCloseTo(1, 9);

    // ...whereas keeping the yaw alone leaves that axis in the ground plane.
    const yawOnly = new THREE.Vector3(0, 0, -1).applyMatrix4(expectedEngineRotation(0, 98, 0));
    expect(Math.abs(yawOnly.y)).toBeLessThan(1e-9);
  });
});
