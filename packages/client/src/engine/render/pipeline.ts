// A frame, as named passes in a fixed order.
//
// A feature that draws joins by filling one of the slots in PASSES, never by
// hooking the viewer's loop: so what a frame draws, and in what order, is this
// list, and each pass is timed under its name. A pass also says how to compile
// what it draws, for its own target, which is what lets the prewarm cover every
// pass rather than the world's alone (docs/engine/rendering.md#the-frame).

import type * as THREE from "three";
import type { FrameTarget } from "./target.js";
import type { SceneRoots } from "./roots.js";

/** Every pass a frame can run, in order. A new pass is a new name here. */
export const PASSES = [
  // The built world and everything kept beside it, into the frame target (render/target.ts),
  // linear and with its depth kept; the shadow map renders here when invalidated.
  "world",
  // The frame, tone-mapped and graded, onto the canvas (render/output.ts).
  "output",
  // Particles, onto the canvas in display space, tested against the frame's depth (engine/fx/).
  "effects",
  // Hands and weapon over everything, or the scope picture instead (engine/viewmodel.ts).
  "viewmodel",
] as const;

export type PassName = (typeof PASSES)[number];

export interface PassContext {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  /** The world pass's output: colour for the output pass, depth for whatever reads it. */
  readonly target: FrameTarget;
  /** What the scene holds, and the world's fog. */
  readonly roots: SceneRoots;
}

export interface RenderPass {
  /**
   * What the pass draws from besides the world scene, so what reaches every
   * material — a quality level's filtering and shadow filter — reaches it too.
   */
  readonly scene?: THREE.Object3D;
  /** Draw this frame's share, or nothing. */
  render(ctx: PassContext): void;
  /**
   * Compile the programs `render` would use, with the render target and scene
   * it would use them for: three keys a program by its target too. Absent, the
   * pass compiles nothing ahead and the prewarm's one real frame covers it.
   */
  prewarm?(ctx: PassContext): Promise<void>;
}

/**
 * Resolve once the GPU has done everything submitted so far, without blocking
 * the thread. What a prewarm frame queues (texture uploads, program links) is
 * otherwise waited for by the first frames of play.
 */
function gpuIdle(renderer: THREE.WebGLRenderer): Promise<void> {
  const gl = typeof renderer.getContext === "function" ? renderer.getContext() : undefined;
  if (!(typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext)) {
    return Promise.resolve();
  }
  const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
  if (!sync) {
    return Promise.resolve();
  }
  gl.flush();
  return new Promise((resolve) => {
    const poll = (): void => {
      if (gl.getSyncParameter(sync, gl.SYNC_STATUS) === gl.SIGNALED) {
        gl.deleteSync(sync);
        resolve();
      } else {
        setTimeout(poll, 5);
      }
    };
    poll();
  });
}

/** Exponential smoothing for the per-pass timings, as engine/profiler.ts smooths the rest. */
const SMOOTHING = 0.1;

export class FramePipeline {
  private readonly passes = new Map<PassName, RenderPass>();
  /** Smoothed CPU milliseconds per pass: submission work, not GPU time. */
  readonly timings = new Map<PassName, number>();

  /** Fill the slot `name` with `pass`, replacing what was there. */
  use(name: PassName, pass: RenderPass): void {
    this.passes.set(name, pass);
  }

  /** Every pass's own scene, in pass order. */
  scenes(): THREE.Object3D[] {
    return PASSES.flatMap((name) => this.passes.get(name)?.scene ?? []);
  }

  render(ctx: PassContext): void {
    for (const name of PASSES) {
      const pass = this.passes.get(name);
      if (!pass) {
        continue;
      }
      const start = performance.now();
      pass.render(ctx);
      const ms = performance.now() - start;
      const was = this.timings.get(name);
      this.timings.set(name, was === undefined ? ms : was + (ms - was) * SMOOTHING);
    }
  }

  /**
   * Do the work a first frame would before it: each pass's programs,
   * asynchronously; then a frame as play draws it, which computes the bounds
   * three measures lazily on an object's first frustum test; then one with the
   * shadow map invalidated and culling off, which draws every object once into
   * the view and every shadow map, so it compiles what nothing can ask for ahead
   * (a caster's shadow-map depth program) and uploads every texture rather than
   * leaving them to the moment the player turns.
   */
  async prewarm(ctx: PassContext): Promise<void> {
    for (const name of PASSES) {
      await this.passes.get(name)?.prewarm?.(ctx);
    }
    this.render(ctx);
    const culled: THREE.Object3D[] = [];
    ctx.scene.traverse((object) => {
      if (object.frustumCulled) {
        object.frustumCulled = false;
        culled.push(object);
      }
    });
    try {
      ctx.renderer.shadowMap.needsUpdate = true;
      this.render(ctx);
    } finally {
      for (const object of culled) {
        object.frustumCulled = true;
      }
      // The view drawn above is not the one play starts on.
      ctx.renderer.shadowMap.needsUpdate = true;
    }
    await gpuIdle(ctx.renderer);
  }

  /** One line for the debug stats. */
  format(): string {
    return PASSES.filter((name) => this.timings.has(name))
      .map((name) => `${name} ${this.timings.get(name)!.toFixed(1)}`)
      .join("  ");
  }
}
