// Renderer, camera, scene container and the render loop. World content is
// added by the caller (app/WorldSession.ts); input lives in engine/controls/.

import * as THREE from "three";
import { applyQuality, loadQualityLevel, saveQualityLevel, QUALITY, type QualityLevel, type QualitySettings, type QualityState } from "./quality.js";
import { Profiler } from "./profiler.js";
import { applyGrade } from "./grade.js";
import type { ResolvedGrade } from "@3d/shared/dsl/resolved.js";

/** Vertical field of view, degrees. */
const FOV = 70;

/** `fov` (degrees) with the tangent of its half-angle scaled by `factor`: how a zoom, or a change of axis, scales it. */
export function scaleFov(fov: number, factor: number): number {
  return 2 * THREE.MathUtils.radToDeg(Math.atan(Math.tan(THREE.MathUtils.degToRad(fov / 2)) * factor));
}

export class Viewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  /** Frame-time breakdown. Always on: a handful of timestamps per frame. */
  readonly profiler: Profiler;

  private frameCallbacks: Array<(dt: number, elapsed: number) => void> = [];
  /** Drawn after the world, into the same framebuffer (engine/viewmodel.ts). */
  private overlay: ((renderer: THREE.WebGLRenderer) => void) | undefined;
  private lastTime = performance.now();
  private rafId = 0;
  private quality: QualityLevel = loadQualityLevel();
  private readonly qualityState: QualityState = {};
  /** Watches the container itself, not just the window; disconnected on dispose. */
  private readonly containerObserver: ResizeObserver;
  /** What the last resize set, so an observer callback that changes nothing does nothing. */
  private sized = { width: 0, height: 0, ratio: 0 };

  constructor(private readonly container: HTMLElement) {
    // Not logarithmicDepthBuffer: it writes gl_FragDepth per fragment, which
    // outlines every MSAA silhouette, and cannot separate coplanar surfaces
    // anyway. The near plane below keeps depth precision instead.
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.shadowMap.enabled = true;
    // A built world never moves, so neither per-frame walk of the scene graph
    // is needed: shadows re-render only when invalidated, and matrices are
    // computed once per build. See docs/engine/rendering.md#a-static-world.
    this.renderer.shadowMap.autoUpdate = false;
    this.scene.matrixWorldAutoUpdate = false;
    applyQuality(this.quality, this.renderer, this.scene, this.qualityState);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Two render calls a frame (the world, then the overlay); counted together, reset in the loop.
    this.renderer.info.autoReset = false;
    container.appendChild(this.renderer.domElement);
    this.profiler = new Profiler(this.renderer);

    // Near 0.1 keeps the ratio to the farthest far plane (~600 m) inside a 24-bit depth buffer.
    this.camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 200);
    this.camera.position.set(0, 1.7, 3);

    this.resize();
    window.addEventListener("resize", this.resize);
    // A window resize is not the only way the canvas changes size: anything
    // that relayouts the container (a panel opening, a CSS change) does too,
    // and leaves the canvas stretched until the next window resize.
    this.containerObserver = new ResizeObserver(() => this.resize());
    this.containerObserver.observe(container);
  }

  /** Register a per-frame callback; returns an unsubscribe. */
  onFrame(cb: (dt: number, elapsed: number) => void): () => void {
    this.frameCallbacks.push(cb);
    return () => {
      this.frameCallbacks = this.frameCallbacks.filter((c) => c !== cb);
    };
  }

  /** Start the render loop. Idempotent: a second call replaces the running loop rather than adding one. */
  start(): void {
    this.stop();
    this.lastTime = performance.now();
    const loop = (now: number) => {
      const dt = Math.min((now - this.lastTime) / 1000, 1 / 20); // no huge step after a tab switch
      const frameMs = now - this.lastTime;
      this.lastTime = now;

      const tStart = performance.now();
      for (let i = 0; i < this.frameCallbacks.length && this.frameCallbacks[i]; i++) {
        this.frameCallbacks[i]!(dt, now / 1000);
      }
      const tCallbacks = performance.now();

      this.profiler.beginGpu(); // asynchronous: never stalls waiting for the result
      this.renderer.info.reset();
      this.renderer.render(this.scene, this.camera);
      this.overlay?.(this.renderer);
      this.profiler.endGpu();
      this.profiler.sample(tCallbacks - tStart, performance.now() - tCallbacks, frameMs);

      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  stop(): void {
    cancelAnimationFrame(this.rafId);
  }

  setOverlay(render: ((renderer: THREE.WebGLRenderer) => void) | undefined): void {
    this.overlay = render;
  }

  /** Narrow the view by `zoom` on tan(fov / 2), 1 for none: aiming down the sights. */
  setZoom(zoom: number): void {
    const fov = scaleFov(FOV, zoom);
    if (this.camera.fov === fov) {
      return;
    }
    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();
  }

  setFar(distance: number): void {
    if (this.camera.far === distance) {
      return;
    }
    this.camera.far = distance;
    this.camera.updateProjectionMatrix();
  }

  /** Re-render the shadow map on the next frame (it does not auto-update). A one-shot request. */
  invalidateShadows(): void {
    this.renderer.shadowMap.needsUpdate = true;
  }

  get qualitySettings(): QualitySettings {
    return QUALITY[this.quality];
  }

  get qualityLevel(): QualityLevel {
    return this.quality;
  }

  /** Switch level, remember it, and apply it to the current world. */
  setQuality(level: QualityLevel, root?: THREE.Object3D, texelSize?: number): void {
    this.quality = level;
    saveQualityLevel(level);
    this.applyQuality(root, texelSize);
  }

  /** Apply the current level, e.g. to a newly built world. `texelSize` comes from ShadowFit.build. */
  applyQuality(root?: THREE.Object3D, texelSize?: number): void {
    applyQuality(this.quality, this.renderer, this.scene, this.qualityState, root, texelSize);
    this.invalidateShadows();
  }

  /** Install a world's colour grading, or clear it. Must precede building its materials: the grade is compiled into every shader. */
  setGrade(grade: ResolvedGrade | undefined): void {
    applyGrade(this.renderer, grade);
  }

  setExposure(value: number): void {
    this.renderer.toneMappingExposure = value;
  }

  private resize = (): void => {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    // Also guards against a feedback loop: `setSize` writes the canvas's style,
    // which the observer sees. The device pixel ratio counts, since a move to
    // another monitor changes the buffer without changing the layout.
    const ratio = window.devicePixelRatio;
    if (width === this.sized.width && height === this.sized.height && ratio === this.sized.ratio) {
      return;
    }
    this.sized = { width, height, ratio };
    this.camera.aspect = width / Math.max(height, 1);
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  };

  dispose(): void {
    window.removeEventListener("resize", this.resize);
    this.containerObserver.disconnect();
    this.stop();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
