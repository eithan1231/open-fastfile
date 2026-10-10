// The scene's depth, for soft particles: zfeather's fade where a sheet meets the world.
//
// The world draws straight to the canvas, whose depth WebGL cannot read back, so
// this renders the scene's depth again into a texture of its own before the
// frame: real materials with colour writes masked off, so an alpha-tested fence
// or leaf has the shape the frame does. Half resolution; the fade is soft anyway.

import * as THREE from "three";

/** Fraction of the drawing buffer the depth pass renders at. */
const SCALE = 0.5;

export class SceneDepth {
  readonly target: THREE.WebGLRenderTarget;
  /** The canvas's drawing-buffer size in pixels: what gl_FragCoord is measured in. */
  readonly resolution = new THREE.Vector2(1, 1);
  /** The camera's near and far planes, to linearise the stored depth. */
  readonly nearFar = new THREE.Vector2(0.1, 200);
  private readonly size = new THREE.Vector2();

  constructor() {
    this.target = new THREE.WebGLRenderTarget(1, 1, {
      depthBuffer: true,
      depthTexture: new THREE.DepthTexture(1, 1, THREE.UnsignedIntType),
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
    });
    this.target.texture.name = "fx scene depth (unused colour)";
  }

  get texture(): THREE.DepthTexture {
    return this.target.depthTexture!;
  }

  /** Draw `scene`'s depth from `camera`, with `hide` (the effects themselves) left out. */
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, hide: THREE.Object3D): void {
    renderer.getDrawingBufferSize(this.size);
    this.resolution.copy(this.size);
    const w = Math.max(1, Math.floor(this.size.x * SCALE));
    const h = Math.max(1, Math.floor(this.size.y * SCALE));
    if (this.target.width !== w || this.target.height !== h) {
      this.target.setSize(w, h);
    }
    this.nearFar.set(camera.near, camera.far);

    // Shadow maps update only when asked (engine/shadows.ts); a request pending
    // now belongs to the frame, not to this pass, which would answer it with
    // colour writes locked off and leave the sun's map empty.
    const shadows = renderer.shadowMap;
    const autoUpdate = shadows.autoUpdate;
    const needsUpdate = shadows.needsUpdate;
    shadows.autoUpdate = false;
    shadows.needsUpdate = false;
    const visible = hide.visible;
    const background = scene.background;
    const previous = renderer.getRenderTarget();
    const colour = renderer.state.buffers.color;
    hide.visible = false;
    scene.background = null;
    renderer.setRenderTarget(this.target);
    // Depth only: lock the colour mask so no material can turn it back on.
    colour.setMask(false);
    colour.setLocked(true);
    renderer.clear(false, true, false);
    renderer.render(scene, camera);
    colour.setLocked(false);
    colour.setMask(true);
    renderer.setRenderTarget(previous);
    scene.background = background;
    hide.visible = visible;
    shadows.autoUpdate = autoUpdate;
    shadows.needsUpdate = needsUpdate;
  }

  /**
   * Compile the programs `render` uses (its target's variant of every scene
   * material), then draw once: a driver finishes a program on its first draw
   * with a given target, which cost a quarter of a second on the first frame
   * with a feathered sheet.
   */
  async prewarm(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, hide: THREE.Object3D): Promise<void> {
    // compileAsync picks every program synchronously and only then waits for the
    // driver, so the target is put back before the wait: a hot reload loads with
    // the loop running, and its frames must not draw into this.
    const previous = renderer.getRenderTarget();
    renderer.setRenderTarget(this.target);
    const ready = renderer.compileAsync(scene, camera);
    renderer.setRenderTarget(previous);
    await ready;
    this.render(renderer, scene, camera, hide);
  }

  dispose(): void {
    this.target.depthTexture?.dispose();
    this.target.dispose();
  }
}
