import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { ShadowFit, biasFor } from "../src/engine/shadows.js";
import { QUALITY, QUALITY_LEVELS } from "../src/engine/quality.js";

/** A shadow-casting sun at `at`, aimed at the origin, plus a caster box to give the scene bounds. */
function scene(opts: { at: THREE.Vector3; contentHalfExtent: number }): {
  root: THREE.Group;
  light: THREE.DirectionalLight;
  bounds: THREE.Box3;
} {
  const root = new THREE.Group();
  const light = new THREE.DirectionalLight(0xffffff, 1);
  light.position.copy(opts.at);
  light.target.position.set(0, 0, 0);
  light.castShadow = true;
  root.add(light, light.target);

  const e = opts.contentHalfExtent;
  const bounds = new THREE.Box3(new THREE.Vector3(-e, -e, -e), new THREE.Vector3(e, e, e));
  return { root, light, bounds };
}

function cameraAt(x: number, y: number, z: number): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera();
  cam.position.set(x, y, z);
  return cam;
}

const shadowCam = (light: THREE.DirectionalLight) => light.shadow.camera as THREE.OrthographicCamera;

describe("ShadowFit", () => {
  it("finds shadow-casting directional lights and leaves others alone", () => {
    const { root, bounds } = scene({ at: new THREE.Vector3(30, 70, -92), contentHalfExtent: 1000 });
    const ignored = new THREE.DirectionalLight(0xffffff, 1); // castShadow defaults to false
    root.add(ignored, new THREE.AmbientLight(0xffffff, 1), new THREE.PointLight(0xffffff, 1));

    const stats = new ShadowFit().build(root, bounds, { focusRadius: 120, mapSize: 2048 });
    expect(stats.lights).toBe(1);
  });

  it("focuses on the player when the world is larger than the focus radius", () => {
    const { root, bounds } = scene({ at: new THREE.Vector3(30, 70, -92), contentHalfExtent: 1000 });
    const fit = new ShadowFit();

    const stats = fit.build(root, bounds, { focusRadius: 120, mapSize: 2048 });

    expect(stats.focused).toBe(true);
    expect(stats.radius).toBe(120);
    // The measurement this whole change exists for: 2048 texels across 240m
    // rather than across the content sphere's ~3.8km.
    expect(stats.texelSize).toBeCloseTo(0.117, 3);
  });

  it("covers a small world whole rather than focusing on part of it", () => {
    // A 10m house has no boundary problem worth having: one fit covers it and
    // never needs re-rendering.
    const { root, bounds } = scene({ at: new THREE.Vector3(6, 9, 4), contentHalfExtent: 5 });
    const fit = new ShadowFit();

    const stats = fit.build(root, bounds, { focusRadius: 120, mapSize: 2048 });

    expect(stats.focused).toBe(false);
    expect(stats.radius).toBeLessThan(120);
  });

  it("re-renders once for a whole-world fit and never again while nothing moves", () => {
    const { root, bounds } = scene({ at: new THREE.Vector3(6, 9, 4), contentHalfExtent: 5 });
    const fit = new ShadowFit();
    fit.build(root, bounds, { focusRadius: 120, mapSize: 2048 });

    expect(fit.update(cameraAt(0, 2, 0))).toBe(true);
    expect(fit.update(cameraAt(3, 2, 3))).toBe(false);
    expect(fit.update(cameraAt(-4, 2, 1))).toBe(false);
  });

  it("re-renders on region crossings only, not on every step", () => {
    const { root, bounds } = scene({ at: new THREE.Vector3(30, 70, -92), contentHalfExtent: 1000 });
    const fit = new ShadowFit();
    fit.build(root, bounds, { focusRadius: 120, mapSize: 2048 });

    expect(fit.update(cameraAt(0, 2, 0))).toBe(true); // first fit
    expect(fit.update(cameraAt(0, 2, 10))).toBe(false); // inside the slack
    expect(fit.update(cameraAt(0, 2, 29))).toBe(false);
    expect(fit.update(cameraAt(0, 2, 31))).toBe(true); // past radius * 0.25
    expect(fit.update(cameraAt(0, 2, 40))).toBe(false); // re-committed, quiet again
  });

  it("re-renders every frame under the dynamic policy", () => {
    // The seam animated models will need: the scene is no longer static, so a
    // fitted map is stale the moment anything in it moves.
    const { root, bounds } = scene({ at: new THREE.Vector3(30, 70, -92), contentHalfExtent: 1000 });
    const fit = new ShadowFit();
    fit.build(root, bounds, { focusRadius: 120, mapSize: 2048 });
    fit.setPolicy("dynamic");

    expect(fit.update(cameraAt(0, 2, 0))).toBe(true);
    expect(fit.update(cameraAt(0, 2, 0))).toBe(true);
    expect(fit.update(cameraAt(0, 2, 0.01))).toBe(true);
  });

  it("snaps the focus centre to whole shadow texels", () => {
    // Without this the texel grid slides continuously as the player walks and
    // every shadow edge crawls along with it.
    const { root, light, bounds } = scene({ at: new THREE.Vector3(0, 100, 0), contentHalfExtent: 1000 });
    const fit = new ShadowFit();
    const stats = fit.build(root, bounds, { focusRadius: 120, mapSize: 2048 });

    fit.setPolicy("dynamic"); // refit on demand, so each camera position is actually applied
    fit.update(cameraAt(0, 2, 0));
    const origin = light.target.position.clone();

    // A sun straight overhead snaps in the XZ plane; step a whole number of
    // texels and the target must move by exactly that.
    fit.update(cameraAt(4 * stats.texelSize, 2, 0));
    const stepped = light.target.position.clone();
    expect(stepped.distanceTo(origin)).toBeCloseTo(4 * stats.texelSize, 6);

    // Step a fraction of one and it must not move at all.
    fit.update(cameraAt(4 * stats.texelSize + stats.texelSize * 0.2, 2, 0));
    expect(light.target.position.distanceTo(stepped)).toBeCloseTo(0, 9);
  });

  it("preserves the authored light direction across repeated fits", () => {
    // Fitting repositions the light, so a fit that derived the next direction
    // from the moved position would drift the sun across the sky as you walk.
    const { root, light, bounds } = scene({ at: new THREE.Vector3(30, 70.5, -92.3), contentHalfExtent: 1000 });
    const authored = light.position.clone().sub(light.target.position).normalize();

    const fit = new ShadowFit();
    fit.build(root, bounds, { focusRadius: 120, mapSize: 2048 });
    fit.setPolicy("dynamic");
    for (let i = 0; i < 50; i++) {
      fit.update(cameraAt(i * 7, 2, i * -3));
    }

    const after = light.position.clone().sub(light.target.position).normalize();
    expect(after.angleTo(authored)).toBeLessThan(1e-6);
  });

  it("puts the light outside the content so nothing is clipped behind the near plane", () => {
    // The old build-time fit left the light where the world file put it and
    // clamped near to 0.1. Every imported CoD world places the sun ~120m out
    // around content hundreds of metres across, so everything behind the light
    // plane fell out of the shadow map entirely.
    const { root, light, bounds } = scene({ at: new THREE.Vector3(30, 70.5, -92.3), contentHalfExtent: 1000 });
    const fit = new ShadowFit();
    fit.build(root, bounds, { focusRadius: undefined, mapSize: 2048 });
    fit.update(cameraAt(0, 2, 0));

    const cam = shadowCam(light);
    const toContent = light.position.distanceTo(light.target.position);
    expect(toContent).toBeGreaterThan(bounds.getBoundingSphere(new THREE.Sphere()).radius);
    // Every corner of the content box must land between near and far.
    const dir = light.target.position.clone().sub(light.position).normalize();
    for (const corner of boxCorners(bounds)) {
      const depth = corner.clone().sub(light.position).dot(dir);
      expect(depth).toBeGreaterThanOrEqual(cam.near);
      expect(depth).toBeLessThanOrEqual(cam.far);
    }
  });

  it("keeps the light's world matrix in step with the fit", () => {
    // The scene's per-frame matrix walk is off (engine/viewer.ts), and three.js
    // reads matrixWorld to place the shadow camera — so a fit that moved the
    // light without updating it would render from the old position.
    const { root, light, bounds } = scene({ at: new THREE.Vector3(30, 70, -92), contentHalfExtent: 1000 });
    const fit = new ShadowFit();
    fit.build(root, bounds, { focusRadius: 120, mapSize: 2048 });
    fit.update(cameraAt(500, 2, -300));

    expect(new THREE.Vector3().setFromMatrixPosition(light.matrixWorld).distanceTo(light.position)).toBeCloseTo(0, 6);
    expect(new THREE.Vector3().setFromMatrixPosition(light.target.matrixWorld).distanceTo(light.target.position)).toBeCloseTo(0, 6);
  });

  it("keeps it in step even with matrixAutoUpdate frozen, as a built world's is", () => {
    // The same property as the test above, under the condition the app actually
    // runs in — and the gap between the two is a bug that shipped. WorldSession
    // clears `matrixAutoUpdate` on every node once a world is built (nothing in
    // one moves), and that flag is exactly what gates the position -> matrix
    // recomposition inside `updateMatrixWorld`. With it left at three.js's
    // default, as the test above leaves it, a fit that only assigns `position`
    // still passes; with it off, `matrixWorld` is rebuilt from a `matrix` that
    // still holds the authored placement and the assignment reaches nothing
    // three.js reads.
    //
    // The symptom was not a misplaced shadow but no shadow at all: the frustum
    // stayed pinned to the sun's authored position looking at the origin, so a
    // map whose play space sits somewhere else (mp_radar's is 220m out) had its
    // shadow pass render a patch of world nobody was standing in, and turning
    // the shadow map off was a pixel-identical no-op.
    const { root, light, bounds } = scene({ at: new THREE.Vector3(30, 70, -92), contentHalfExtent: 1000 });
    root.updateMatrixWorld(true);
    root.traverse((obj) => {
      obj.matrixAutoUpdate = false;
    });

    const fit = new ShadowFit();
    fit.build(root, bounds, { focusRadius: 120, mapSize: 2048 });
    fit.update(cameraAt(500, 2, -300));

    expect(new THREE.Vector3().setFromMatrixPosition(light.matrixWorld).distanceTo(light.position)).toBeCloseTo(0, 6);
    expect(new THREE.Vector3().setFromMatrixPosition(light.target.matrixWorld).distanceTo(light.target.position)).toBeCloseTo(0, 6);

    // What the stale matrix cost: the shadow camera has to look at the player,
    // not at wherever the world file put the light's target.
    light.shadow.updateMatrices(light);
    const aim = new THREE.Vector3(0, 0, -1).applyQuaternion(shadowCam(light).quaternion);
    const toPlayer = new THREE.Vector3(500, 2, -300).sub(new THREE.Vector3().setFromMatrixPosition(shadowCam(light).matrixWorld)).normalize();
    expect(aim.dot(toPlayer)).toBeGreaterThan(0.999);
  });

  it("expresses depth bias as a fraction of the frustum's own depth range", () => {
    // bias is added to a normalised [0,1] depth, so the same world distance is
    // a different number against a different frustum: -0.0005 is 3cm against
    // the old far:60 placeholder and over two metres against a 2km map.
    const shallow = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 60.1);
    const deep = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 4000.1);

    expect(biasFor(shallow, 0.02) * 60).toBeCloseTo(-0.02, 6);
    expect(biasFor(deep, 0.02) * 4000).toBeCloseTo(-0.02, 6);
    expect(Math.abs(biasFor(deep, 0.02))).toBeLessThan(Math.abs(biasFor(shallow, 0.02)));
  });

  it("scales both biases with the shadow texel, not with metres", () => {
    // The acne regression. Depth drifts by `texel * tan(light-to-normal)` across
    // one texel, so a bias fixed in metres is only correct at one resolution: a
    // 2cm constant is fine at the 0.7cm texel of a small room and eight times
    // too small at the 11.7cm texel of a focused CoD map, where it showed up as
    // parallel creases across every large flat surface.
    const coarse = scene({ at: new THREE.Vector3(30, 70, -92), contentHalfExtent: 1000 });
    const fine = scene({ at: new THREE.Vector3(6, 9, 4), contentHalfExtent: 5 });

    const coarseStats = new ShadowFit().build(coarse.root, coarse.bounds, { focusRadius: 120, mapSize: 2048 });
    const fineStats = new ShadowFit().build(fine.root, fine.bounds, { focusRadius: 120, mapSize: 2048 });

    // Normal bias must clear a full texel even on a surface steeply raked to
    // the light. mp_dome's sun is 36 degrees up: 54 off a floor's normal,
    // tan(54) = 1.38.
    const rake = Math.tan(THREE.MathUtils.degToRad(54));
    expect(coarse.light.shadow.normalBias).toBeGreaterThan(coarseStats.texelSize * rake);
    expect(fine.light.shadow.normalBias).toBeGreaterThan(fineStats.texelSize * rake);

    // And it must track the texel rather than being a constant.
    const ratio = coarseStats.texelSize / fineStats.texelSize;
    expect(coarse.light.shadow.normalBias / fine.light.shadow.normalBias).toBeCloseTo(ratio, 6);

    // The small-world case must land near the 0.02 that was tuned for it, so
    // this is a fix for the large maps and not a change to the small ones.
    expect(fine.light.shadow.normalBias).toBeCloseTo(0.02, 2);
  });

  it("keeps the shipped quality levels fine enough for contact shadows", () => {
    // The other side of the acne trade. Normal bias is two texels, and it moves
    // the sample point off the surface — so once a texel is coarse enough, the
    // offset overshoots the contact shadow it is meant to preserve and leaves a
    // bright rim at the foot of every wall and around the base of every prop
    // standing on a floor. A 120m focus at 2048 was 11.7cm per texel and 23cm of
    // offset, which did exactly that indoors.
    const worst = { high: 0.05, medium: 0.07, low: 0.11 };

    for (const level of QUALITY_LEVELS) {
      const { shadowFocusRadius, shadowMapSize } = QUALITY[level];
      const texel = (2 * shadowFocusRadius) / shadowMapSize;
      expect(texel, `${level} texel size`).toBeLessThanOrEqual(worst[level]);
    }
  });

  it("survives a light with no usable direction", () => {
    const root = new THREE.Group();
    const light = new THREE.DirectionalLight(0xffffff, 1);
    light.position.set(0, 0, 0); // exactly on its own target
    light.castShadow = true;
    root.add(light, light.target);

    const fit = new ShadowFit();
    expect(fit.build(root, new THREE.Box3(new THREE.Vector3(-5, -5, -5), new THREE.Vector3(5, 5, 5)), { mapSize: 1024 }).lights).toBe(1);
    expect(() => fit.update(cameraAt(0, 2, 0))).not.toThrow();
    expect(Number.isFinite(shadowCam(light).far)).toBe(true);
  });

  it("does nothing when a world declares no shadow-casting light", () => {
    const root = new THREE.Group();
    root.add(new THREE.AmbientLight(0xffffff, 1));
    const fit = new ShadowFit();

    expect(fit.build(root, new THREE.Box3(), { mapSize: 2048 }).lights).toBe(0);
    expect(fit.update(cameraAt(0, 2, 0))).toBe(false);
  });
});

function boxCorners(box: THREE.Box3): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (const x of [box.min.x, box.max.x]) {
    for (const y of [box.min.y, box.max.y]) {
      for (const z of [box.min.z, box.max.z]) {
        out.push(new THREE.Vector3(x, y, z));
      }
    }
  }
  return out;
}
