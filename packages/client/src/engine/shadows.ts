// Shadow-frustum fitting, at runtime: it needs the finished scene (models load
// asynchronously) and it follows the player. Why, and the texel-based biases:
// docs/engine/rendering.md, "Shadows".

import * as THREE from "three";

/**
 * When the shadow map is re-rendered. `static`: only when the player leaves the
 * fitted region, since nothing else moves. `dynamic`: every frame, for a scene
 * with something animated in it (nothing selects it yet).
 */
export type ShadowPolicy = "static" | "dynamic";

export interface ShadowFitOptions {
  /**
   * Half-width of the region kept in shadow around the player, in metres, or
   * `undefined` to cover the whole world. A world smaller than this is covered
   * whole, and then never needs re-fitting.
   */
  focusRadius?: number;
  /** Shadow map resolution, from the quality level. Sets the texel size the focus centre is snapped to. */
  mapSize: number;
}

export interface ShadowFitStats {
  /** Shadow-casting directional lights being driven. */
  lights: number;
  /** False when the world fits inside `focusRadius` and is covered whole. */
  focused: boolean;
  /** Half-width of the fitted frustum, in metres. */
  radius: number;
  /** World-space size of one shadow texel, in metres — the real resolution limit. */
  texelSize: number;
}

/**
 * How far behind the focus region the light sits, so casters outside the region
 * still shadow into it. Approximate: 200 m covers a 120 m tower at the lowest
 * sun any imported map uses (36° up). Overshooting costs depth precision only.
 */
const CASTER_REACH = 200;

/**
 * Depth bias, in shadow texels rather than metres: acne scales with the texel's
 * world size, and texel sizes here span 0.7 to 11.7 cm. One texel, because the
 * normal bias does the real work. `biasFor` converts to three's units, which
 * are a fraction of the shadow camera's depth range.
 */
const DEPTH_BIAS_TEXELS = 1;

/**
 * Normal-offset bias, in shadow texels. It moves the sample point off the
 * surface rather than moving the shadow, so it suppresses acne without
 * detaching shadows from casters. Two texels: one clears a surface at 45° to
 * the light, and every imported map's sun is lower than that.
 */
const NORMAL_BIAS_TEXELS = 2;

/** One driven light: the three.js object plus the authored direction we must not lose. */
interface Tracked {
  light: THREE.DirectionalLight;
  /**
   * Unit vector from the scene toward the light. Captured once at build: fitting
   * moves `light.position`, so re-deriving the direction would drift the sun.
   */
  direction: THREE.Vector3;
  /** Light-space basis perpendicular to `direction`, for texel snapping. */
  right: THREE.Vector3;
  up: THREE.Vector3;
}

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const FALLBACK_UP = new THREE.Vector3(0, 0, 1);

/**
 * Drives every shadow-casting directional light's orthographic frustum. `build`
 * once per load, after every model has arrived; `update` every frame, and
 * invalidate the shadow map when it returns true.
 */
export class ShadowFit {
  private tracked: Tracked[] = [];
  private policy: ShadowPolicy = "static";
  private contentCenter = new THREE.Vector3();
  private contentRadius = 0;
  private radius = 0;
  private texelSize = 0;
  private focused = false;
  /** Centre the current fit was built around; null before the first fit. */
  private committed: THREE.Vector3 | null = null;

  /** How far the camera may drift from the fitted centre before re-fitting; `radius - slack` is always covered. */
  private get slack(): number {
    return this.radius * 0.25;
  }

  setPolicy(policy: ShadowPolicy): void {
    this.policy = policy;
    // A tightened policy must take effect now, not at the next region crossing.
    if (policy === "dynamic") {
      this.committed = null;
    }
  }

  /**
   * Collect the lights to drive and decide how much world each covers. `root`
   * must be the finished scene.
   */
  build(root: THREE.Object3D, bounds: THREE.Box3, opts: ShadowFitOptions): ShadowFitStats {
    this.tracked = [];
    this.committed = null;

    if (!bounds.isEmpty()) {
      const sphere = bounds.getBoundingSphere(new THREE.Sphere());
      this.contentCenter.copy(sphere.center);
      this.contentRadius = Math.max(1, sphere.radius) * 1.1; // margin, so nothing sits exactly on the frustum edge
    } else {
      this.contentCenter.set(0, 0, 0);
      this.contentRadius = 1;
    }

    this.focused = opts.focusRadius !== undefined && opts.focusRadius < this.contentRadius;
    this.radius = this.focused ? opts.focusRadius! : this.contentRadius;
    this.texelSize = (2 * this.radius) / opts.mapSize;

    root.traverse((obj) => {
      if (!(obj instanceof THREE.DirectionalLight) || !obj.castShadow) {
        return;
      }

      const direction = obj.position.clone().sub(obj.target.position);
      // A light declared at the origin, or exactly on its target, has no
      // direction to preserve; straight down is the least surprising default.
      if (direction.lengthSq() < 1e-12) {
        direction.set(0, 1, 0);
      }
      direction.normalize();

      // Any pair of axes perpendicular to the light direction will do — they
      // only have to be *stable*, since the snapping grid is defined in them.
      const seed = Math.abs(direction.dot(WORLD_UP)) > 0.999 ? FALLBACK_UP : WORLD_UP;
      const right = new THREE.Vector3().crossVectors(seed, direction).normalize();
      const up = new THREE.Vector3().crossVectors(direction, right).normalize();

      obj.shadow.normalBias = this.texelSize * NORMAL_BIAS_TEXELS;
      this.tracked.push({ light: obj, direction, right, up });
    });

    return { lights: this.tracked.length, focused: this.focused, radius: this.radius, texelSize: this.texelSize };
  }

  /**
   * Re-aim the lights at the camera if needed. Returns true when the shadow map
   * must be re-rendered — hand that straight to `Viewer.invalidateShadows`.
   */
  update(camera: THREE.Camera): boolean {
    if (this.tracked.length === 0) {
      return false;
    }

    // An unfocused world is covered whole, so one fit holds forever — unless
    // something in it moves, which is exactly what `dynamic` means.
    if (!this.focused && this.committed !== null && this.policy === "static") {
      return false;
    }

    const target = this.focused ? camera.position : this.contentCenter;

    if (this.policy === "static" && this.committed !== null) {
      if (this.committed.distanceTo(target) < this.slack) {
        return false;
      }
    }

    for (const t of this.tracked) {
      this.fit(t, target);
    }

    this.committed = (this.committed ?? new THREE.Vector3()).copy(target);
    return true;
  }

  /** Where the current fit is centred. Null before the first fit. */
  get center(): THREE.Vector3 | null {
    return this.committed;
  }

  /** Point one light's shadow camera at `target`, snapped to whole texels across the light so shadow edges do not crawl. */
  private fit(t: Tracked, target: THREE.Vector3): void {
    const { light, direction, right, up } = t;

    const snapped = new THREE.Vector3();
    if (this.focused) {
      const texel = this.texelSize;
      const a = Math.round(target.dot(right) / texel) * texel;
      const b = Math.round(target.dot(up) / texel) * texel;
      // Only the two axes across the light matter: depth along `direction`
      // does not move the texel grid, so it is carried through unrounded.
      snapped.addScaledVector(right, a).addScaledVector(up, b).addScaledVector(direction, target.dot(direction));
    } else {
      snapped.copy(target);
    }

    // Pull the light back so everything that can cast into the region is in front of the near plane.
    const reach = this.focused ? CASTER_REACH : this.contentRadius;
    const distance = this.radius + reach;

    light.position.copy(snapped).addScaledVector(direction, distance);
    light.target.position.copy(snapped);

    const cam = light.shadow.camera as THREE.OrthographicCamera;
    cam.left = -this.radius;
    cam.right = this.radius;
    cam.top = this.radius;
    cam.bottom = -this.radius;
    cam.near = 0.1;
    cam.far = distance + this.radius;
    cam.updateProjectionMatrix();

    light.shadow.bias = biasFor(cam, this.texelSize);

    // Nothing updates matrices per frame, and matrixAutoUpdate is off on every
    // node of a built world, so without `updateMatrix` the new position never
    // reaches `matrixWorld` and the shadow camera stays where the light was
    // built. The light is the one thing in a built world that moves.
    light.updateMatrix();
    light.target.updateMatrix();
    light.updateMatrixWorld(true);
    light.target.updateMatrixWorld(true);
  }
}

/** `LightShadow.bias` in three's normalised depth units for `DEPTH_BIAS_TEXELS` of world distance. */
export function biasFor(cam: THREE.OrthographicCamera, texelSize: number): number {
  const range = cam.far - cam.near;
  return range > 0 ? -(texelSize * DEPTH_BIAS_TEXELS) / range : 0;
}
