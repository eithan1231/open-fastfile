// Where a light points: three aims one with a target, so `rotate:` has to be
// converted. The defaults matter as much — every imported map's sun relies on them.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { buildLight } from "../src/scene/lights.js";
import type { ResolvedLight } from "@3d/shared/dsl/resolved.js";

function light(over: Partial<ResolvedLight> = {}): ResolvedLight {
  return {
    type: "spot",
    position: { x: 0, y: 3, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    aimed: false,
    intensity: 1,
    shadows: false,
    ...over,
  };
}

/** The unit vector from a built light toward its target. */
function direction(built: THREE.Object3D): THREE.Vector3 {
  const l = (built instanceof THREE.Group ? built.children[0] : built) as THREE.SpotLight | THREE.DirectionalLight;
  return l.target.position.clone().sub(l.position).normalize();
}

describe("buildLight — aiming", () => {
  it("points a spot light straight down when it has no rotation", () => {
    expect(direction(buildLight(light()))).toEqual(new THREE.Vector3(0, -1, 0));
  });

  it("points a spot light below ground straight down too, not back up at the ceiling", () => {
    // Targeting y = 0 sent every light under the ground plane pointing upward.
    const below = buildLight(light({ position: { x: 2, y: -4, z: 1 } }));
    expect(direction(below)).toEqual(new THREE.Vector3(0, -1, 0));
  });

  it("aims a spot light along `rotate`", () => {
    const aimed = buildLight(light({ aimed: true, rotation: { x: -Math.PI / 2, y: 0, z: 0 } }));
    const d = direction(aimed);
    expect(d.x).toBeCloseTo(0, 9);
    expect(d.y).toBeCloseTo(-1, 9);
    expect(d.z).toBeCloseTo(0, 9);
  });

  it("turns a spot light's aim with its yaw", () => {
    // A bare `rotate: 90` is yaw, and -Z yawed by +90° faces west.
    const d = direction(buildLight(light({ aimed: true, rotation: { x: 0, y: Math.PI / 2, z: 0 } })));
    expect(d.x).toBeCloseTo(-1, 9);
    expect(d.y).toBeCloseTo(0, 9);
    expect(d.z).toBeCloseTo(0, 9);
  });

  it("keeps a directional light aimed at the world origin without `rotate`", () => {
    const sun = buildLight(light({ type: "directional", position: { x: 30, y: 100, z: -60 } }));
    const d = direction(sun);
    expect(d).toEqual(new THREE.Vector3(-30, -100, 60).normalize());
  });

  it("aims a directional light along `rotate` when it has one", () => {
    const sun = buildLight(light({ type: "directional", position: { x: 30, y: 100, z: -60 }, aimed: true, rotation: { x: -Math.PI / 2, y: 0, z: 0 } }));
    const d = direction(sun);
    expect(d.y).toBeCloseTo(-1, 9);
  });
});

describe("buildLight — cone and range", () => {
  it("turns a cone's full width and core into three's half angle and penumbra", () => {
    const spot = (buildLight(light({ cone: { outer: Math.PI / 2, inner: Math.PI / 4 } })) as THREE.Group).children[0] as THREE.SpotLight;
    expect(spot.angle).toBeCloseTo(Math.PI / 4);
    expect(spot.penumbra).toBeCloseTo(0.5);
  });

  it("keeps a ranged light's strength out to its range instead of the inverse square", () => {
    const spot = (buildLight(light({ range: 10 })) as THREE.Group).children[0] as THREE.SpotLight;
    expect([spot.distance, spot.decay]).toEqual([10, 0]);
    const point = buildLight(light({ type: "point" })) as THREE.PointLight;
    expect([point.distance, point.decay]).toEqual([0, 2]);
    // ... and three's own window, which fades from the start, is replaced for it.
    expect(THREE.ShaderChunk.lights_pars_begin).toContain("1.0 - smoothstep( cutoffDistance * 0.75, cutoffDistance, lightDistance )");
  });
});
