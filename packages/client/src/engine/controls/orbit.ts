// Dollhouse view: orbit/pan/zoom around the whole world, for reviewing a
// layout from above rather than walking it. Thin wrapper around three.js's
// own OrbitControls, framed to the world's bounding box on entry.

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

export class DollhouseControls {
  readonly controls: OrbitControls;

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    domElement: HTMLElement,
  ) {
    this.controls = new OrbitControls(camera, domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.02; // don't let the camera dip below the floor
    this.controls.minDistance = 1;
    this.controls.maxDistance = 200;
    this.controls.enabled = false;
  }

  set enabled(value: boolean) {
    this.controls.enabled = value;
  }
  get enabled(): boolean {
    return this.controls.enabled;
  }

  /** Frame the camera on a world-space bounding box, looking down at an angle. */
  frame(box: THREE.Box3): void {
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);

    const radius = Math.max(size.x, size.z, 2) * 0.75;
    this.camera.position.set(center.x + radius, radius * 1.1 + 2, center.z + radius);
    this.controls.target.copy(center);
    this.controls.update();
  }

  update(): void {
    if (this.controls.enabled) {
      this.controls.update();
    }
  }

  /** Teardown for OrbitControls' own listeners. Unexercised today — one controller lives for the app's lifetime — but kept correct so it stays that way. */
  dispose(): void {
    this.controls.dispose();
  }
}
