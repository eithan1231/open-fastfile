// A marker in the sky along each directional light's direction (`L`), since a
// frame otherwise shows where the light comes from only through its shadows.
// Built from the scene's DirectionalLights, not `ResolvedWorld.lights`: the
// default rig is not in that list, and shadow fitting re-aims every light.

import * as THREE from "three";

/** Fraction of the camera's far plane to sit at. Inside the frustum, but far enough to read as sky. */
const DISTANCE_FACTOR = 0.9;

/** Where the camera is, reused: the markers are re-placed every frame the view is on. */
const SUN_ORIGIN = new THREE.Vector3();

/** Marker radius as a fraction of its distance, so its apparent size does not change with the far plane. */
const ANGULAR_RADIUS = 0.012;

/** One directional light's marker, and the direction it stands for. */
interface Marker {
  mesh: THREE.Mesh;
  /** Unit vector pointing from the scene toward the light — i.e. where the light comes from. */
  direction: THREE.Vector3;
}

export class SunView {
  readonly object = new THREE.Group();
  private markers: Marker[] = [];
  private geometry = new THREE.SphereGeometry(1, 24, 16);

  constructor() {
    this.object.name = "sun-view";
    this.object.visible = false;
    // One object that deliberately sits at the edge of the far plane and moves
    // with the camera; culling it against a stale bounding sphere would pop it.
    this.object.frustumCulled = false;
    this.object.renderOrder = 997;
  }

  get visible(): boolean {
    return this.object.visible;
  }

  setVisible(visible: boolean): void {
    this.object.visible = visible;
  }

  /** How many directional lights are being shown. */
  get count(): number {
    return this.markers.length;
  }

  /** Rebuild from every DirectionalLight under `root`. Safe to call on every world swap. */
  build(root: THREE.Object3D): void {
    this.clear();

    root.updateMatrixWorld(true);
    const from = new THREE.Vector3();
    const to = new THREE.Vector3();

    root.traverse((obj) => {
      if (!(obj instanceof THREE.DirectionalLight)) {
        return;
      }

      // A directional light points from its own position at its target, and
      // both may be parented anywhere, so take them in world space.
      obj.getWorldPosition(from);
      obj.target.getWorldPosition(to);
      const direction = from.sub(to);
      if (direction.lengthSq() < 1e-12) {
        return;
      } // degenerate: no direction to draw
      direction.normalize();

      const material = new THREE.MeshBasicMaterial({
        color: obj.color.clone(),
        // Unlit, unfogged and untonemapped on purpose. This is an instrument,
        // not scenery: it has to stay legible at whatever `exposure:` and
        // `grade` the world sets, and at the far plane any fog would erase it.
        fog: false,
        toneMapped: false,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(this.geometry, material);
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false; // positioned by `update`, which composes the matrix itself
      this.object.add(mesh);
      this.markers.push({ mesh, direction });
    });
  }

  /**
   * Re-place the markers for this frame.
   *
   * They follow the camera rather than sitting at fixed world positions,
   * because a directional light *is* at infinity: walking across a 2.8km map
   * must not slide the sun across the sky. Depth-tested all the same, so it
   * goes behind a building when the building is between you and it — which is
   * the honest answer to "can I see the sun from here?".
   */
  update(camera: THREE.Camera): void {
    if (!this.object.visible || this.markers.length === 0) {
      return;
    }

    const far = camera instanceof THREE.PerspectiveCamera ? camera.far : 1000;
    const distance = far * DISTANCE_FACTOR;
    const scale = distance * ANGULAR_RADIUS;
    const origin = camera.getWorldPosition(SUN_ORIGIN);

    for (const { mesh, direction } of this.markers) {
      mesh.position.copy(origin).addScaledVector(direction, distance);
      mesh.scale.setScalar(scale);
      mesh.updateMatrix();
    }
    // The scene has `matrixWorldAutoUpdate = false` (see engine/viewer.ts), so
    // anything added to it outside a world build has to do this itself.
    this.object.updateMatrixWorld(true);
  }

  /** Drop the markers and free their materials. The shared sphere geometry outlives them. */
  clear(): void {
    for (const { mesh } of this.markers) {
      mesh.removeFromParent();
      (mesh.material as THREE.Material).dispose();
    }
    this.markers = [];
  }

  dispose(): void {
    this.clear();
    this.geometry.dispose();
  }
}
