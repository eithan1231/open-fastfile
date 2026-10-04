// The sky marker for directional lights (engine/sunView.ts).
//
// The behaviour worth pinning is that the marker follows the camera. A
// directional light is at infinity, so walking across a 2.8km map must not
// slide the sun across the sky — a fixed world position would, and would look
// convincing enough at the spawn point to be missed.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { SunView } from "../src/engine/sunView.js";

/** A directional light aimed from `at` toward the origin, as scene/lights.ts makes them. */
function sun(at: [number, number, number], color = 0xffffff): THREE.DirectionalLight {
  const l = new THREE.DirectionalLight(color, 1);
  l.position.set(...at);
  l.target.position.set(0, 0, 0);
  return l;
}

function world(...objects: THREE.Object3D[]): THREE.Group {
  const root = new THREE.Group();
  for (const o of objects) {
    root.add(o, ...(o instanceof THREE.DirectionalLight ? [o.target] : []));
  }
  return root;
}

const camera = (far: number): THREE.PerspectiveCamera => new THREE.PerspectiveCamera(70, 1, 0.1, far);

describe("SunView — building", () => {
  it("makes one marker per directional light", () => {
    const view = new SunView();
    view.build(world(sun([30, 70.5, -92.3]), sun([-10, 40, 20])));
    expect(view.count).toBe(2);
    expect(view.object.children).toHaveLength(2);
  });

  it("ignores lights that have no direction to show", () => {
    const view = new SunView();
    view.build(world(new THREE.AmbientLight(), new THREE.PointLight(), new THREE.SpotLight(), sun([1, 2, 3])));
    expect(view.count).toBe(1);
  });

  it("picks up the engine's default rig, which never reaches ResolvedWorld.lights", () => {
    // scene/scene.ts's defaultLighting() is used when a world declares no
    // lights of its own; reading the graph is what makes it visible here.
    const view = new SunView();
    const hemi = new THREE.HemisphereLight();
    view.build(world(hemi, sun([8, 12, 6])));
    expect(view.count).toBe(1);
  });

  it("skips a degenerate light whose target sits on top of it", () => {
    const view = new SunView();
    const l = sun([0, 0, 0]);
    view.build(world(l));
    expect(view.count).toBe(0);
  });

  it("takes the light's colour", () => {
    const view = new SunView();
    view.build(world(sun([0, 1, 0], 0xff8800)));
    const mat = (view.object.children[0] as THREE.Mesh).material as THREE.MeshBasicMaterial;
    expect(mat.color.getHex()).toBe(0xff8800);
  });

  it("is an instrument, not scenery — unlit, unfogged, untonemapped", () => {
    const view = new SunView();
    view.build(world(sun([0, 1, 0])));
    const mat = (view.object.children[0] as THREE.Mesh).material as THREE.MeshBasicMaterial;
    // Must stay legible at whatever exposure/grade the world sets, and at the
    // far plane fog would otherwise erase it entirely.
    expect(mat.fog).toBe(false);
    expect(mat.toneMapped).toBe(false);
  });

  it("replaces its markers on rebuild rather than accumulating them", () => {
    const view = new SunView();
    view.build(world(sun([1, 1, 1]), sun([2, 2, 2])));
    view.build(world(sun([3, 3, 3])));
    expect(view.count).toBe(1);
    expect(view.object.children).toHaveLength(1);
  });
});

describe("SunView — placement", () => {
  it("puts the marker along the light's own direction", () => {
    const view = new SunView();
    view.build(world(sun([0, 100, 0]))); // straight overhead
    view.setVisible(true);
    view.update(camera(1000));

    const pos = (view.object.children[0] as THREE.Mesh).position;
    expect(pos.x).toBeCloseTo(0, 6);
    expect(pos.z).toBeCloseTo(0, 6);
    expect(pos.y).toBeGreaterThan(0); // above, not below
  });

  it("follows the camera, so the sun does not slide across a large map", () => {
    const view = new SunView();
    view.build(world(sun([30, 70.5, -92.3])));
    view.setVisible(true);
    const cam = camera(2800);

    cam.position.set(0, 0, 0);
    cam.updateMatrixWorld(true);
    view.update(cam);
    const a = (view.object.children[0] as THREE.Mesh).position.clone();

    cam.position.set(900, 0, -400); // walk most of the way across dome
    cam.updateMatrixWorld(true);
    view.update(cam);
    const b = (view.object.children[0] as THREE.Mesh).position.clone();

    // The marker moved with the camera, so its *direction* from the viewer is
    // unchanged — which is what "at infinity" means.
    const dirA = a.clone().normalize();
    const dirB = b.clone().sub(cam.position).normalize();
    expect(dirA.distanceTo(dirB)).toBeLessThan(1e-6);
  });

  it("keeps a constant apparent size as the far plane changes", () => {
    const view = new SunView();
    view.build(world(sun([0, 1, 0])));
    view.setVisible(true);

    const ratio = (far: number): number => {
      const cam = camera(far);
      cam.updateMatrixWorld(true);
      view.update(cam);
      const m = view.object.children[0] as THREE.Mesh;
      return m.scale.x / m.position.length(); // radius over distance
    };
    expect(ratio(200)).toBeCloseTo(ratio(2800), 9);
  });

  it("does no work while hidden", () => {
    const view = new SunView();
    view.build(world(sun([0, 1, 0])));
    const before = (view.object.children[0] as THREE.Mesh).position.clone();
    view.update(camera(1000)); // still hidden
    expect((view.object.children[0] as THREE.Mesh).position).toEqual(before);
  });
});

describe("SunView — lifecycle", () => {
  it("starts hidden and toggles", () => {
    const view = new SunView();
    expect(view.visible).toBe(false);
    view.setVisible(true);
    expect(view.visible).toBe(true);
  });

  it("clears its markers", () => {
    const view = new SunView();
    view.build(world(sun([1, 1, 1])));
    view.clear();
    expect(view.count).toBe(0);
    expect(view.object.children).toHaveLength(0);
  });
});
