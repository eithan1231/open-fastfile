// The offscreen frame the world is drawn into: linear, high range, multisampled,
// and keeping its depth. The output pass tone-maps it onto the canvas; the
// effects read its depth instead of drawing the scene again
// (docs/engine/rendering.md#the-frame).

import * as THREE from "three";

/**
 * GLSL: the view-space distance (three's `vFogDepth`, along the view axis) for a
 * value read from the depth texture, given the camera's near and far planes.
 */
export const VIEW_DEPTH_GLSL = /* glsl */ `
float viewDepthOf(float stored, vec2 nearFar) {
  float d = stored * 2.0 - 1.0;
  return 2.0 * nearFar.x * nearFar.y / (nearFar.y + nearFar.x - d * (nearFar.y - nearFar.x));
}
`;

/** Samples per pixel: what the canvas's own `antialias` gives on desktop GPUs. */
const SAMPLES = 4;

export class FrameTarget {
  readonly target: THREE.WebGLRenderTarget;
  /** The drawing-buffer size in pixels, which gl_FragCoord is measured in. */
  readonly resolution = new THREE.Vector2(1, 1);
  /** The camera's near and far planes as of the last fit, to linearise the depth. */
  readonly nearFar = new THREE.Vector2(0.1, 200);
  private readonly size = new THREE.Vector2();

  constructor() {
    // Half float: lit colour before tone mapping runs well past 1.
    this.target = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      samples: SAMPLES,
      depthBuffer: true,
      depthTexture: new THREE.DepthTexture(1, 1, THREE.UnsignedIntType),
    });
    this.target.texture.name = "frame colour";
  }

  get colour(): THREE.Texture {
    return this.target.texture;
  }

  get depth(): THREE.DepthTexture {
    return this.target.depthTexture!;
  }

  /** Match the canvas's drawing buffer and `camera`, before drawing into this. */
  fit(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera): void {
    renderer.getDrawingBufferSize(this.size);
    const w = Math.max(1, this.size.x);
    const h = Math.max(1, this.size.y);
    if (this.target.width !== w || this.target.height !== h) {
      this.target.setSize(w, h);
    }
    this.resolution.set(w, h);
    this.nearFar.set(camera.near, camera.far);
  }

  dispose(): void {
    this.target.depthTexture?.dispose();
    this.target.dispose();
  }
}
