// Frame-time instrumentation: where does a frame actually go?
//
// Draw-call and triangle counts say how much work is being *asked for*, which
// turns out not to be the same question as what is slow. This splits a frame
// into the three buckets that actually distinguish the causes:
//
//   app    — our own per-frame callbacks (controls, collision, dev tools)
//   submit — CPU time inside renderer.render(): culling, sorting, GL calls
//   gpu    — real GPU time, via EXT_disjoint_timer_query_webgl2
//
// Read them against total frame time:
//   app + submit ≈ frame      → CPU-bound, in whichever of the two is larger
//   gpu ≈ frame               → GPU-bound; pixel/shader cost is the lever
//   all three ≪ frame         → neither. Waiting on vsync, the compositor, or
//                               a browser that is not using the real GPU —
//                               which is what `adapter` below is for.

import type * as THREE from "three";

/** Exponential smoothing factor: slow enough to read, fast enough to follow movement. */
const SMOOTHING = 0.1;

interface TimerExt {
  TIME_ELAPSED_EXT: number;
}

export class Profiler {
  /** Smoothed milliseconds. `gpu` stays -1 where the timer extension is unavailable. */
  app = 0;
  submit = 0;
  gpu = -1;
  frame = 0;

  /** What the browser says it is rendering with. The answer to "is this really the GPU?" */
  readonly adapter: string;
  readonly webgl2: boolean;

  private readonly gl: WebGLRenderingContext | WebGL2RenderingContext;
  private readonly ext: TimerExt | null;
  private query: WebGLQuery | null = null;
  /** A query's result is not ready the frame it is issued, so only one is ever in flight. */
  private pending: WebGLQuery | null = null;

  constructor(renderer: THREE.WebGLRenderer) {
    this.gl = renderer.getContext();
    this.webgl2 = typeof WebGL2RenderingContext !== "undefined" && this.gl instanceof WebGL2RenderingContext;

    // Unmasked strings need the debug extension; without it the plain RENDERER
    // string is a generic placeholder in most browsers and tells you nothing.
    const debug = this.gl.getExtension("WEBGL_debug_renderer_info");
    const unmasked = debug ? (this.gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) as string | null) : null;
    this.adapter = unmasked ?? (this.gl.getParameter(this.gl.RENDERER) as string) ?? "unknown";

    this.ext = this.webgl2 ? (this.gl.getExtension("EXT_disjoint_timer_query_webgl2") as TimerExt | null) : null;
  }

  /** One line for the console, so the environment is on the record rather than assumed. */
  describe(): string {
    return [
      `renderer: ${this.adapter}`,
      `webgl2: ${this.webgl2}`,
      `gpu timing: ${this.ext ? "available" : "unavailable"}`,
      `devicePixelRatio: ${window.devicePixelRatio}`,
    ].join("  ·  ");
  }

  beginGpu(): void {
    if (!this.ext) {
      return;
    }
    const gl = this.gl as WebGL2RenderingContext;
    // Collect the previous frame's result first; it needs at least a frame to land.
    if (this.pending) {
      const available = gl.getQueryParameter(this.pending, gl.QUERY_RESULT_AVAILABLE) as boolean;
      if (available) {
        // A "disjoint" GPU (clock change, context interruption) invalidates the
        // timing. Only read once a result exists — getParameter can sync.
        const disjoint = gl.getParameter(0x8fbb) as boolean; // GPU_DISJOINT_EXT
        if (!disjoint) {
          const ns = gl.getQueryParameter(this.pending, gl.QUERY_RESULT) as number;
          this.gpu = this.gpu < 0 ? ns / 1e6 : this.gpu + (ns / 1e6 - this.gpu) * SMOOTHING;
        }
        gl.deleteQuery(this.pending);
        this.pending = null;
      } else {
        return; // still in flight — do not start another
      }
    }

    this.query = gl.createQuery();
    if (this.query) {
      gl.beginQuery(this.ext.TIME_ELAPSED_EXT, this.query);
    }
  }

  endGpu(): void {
    if (!this.ext || !this.query) {
      return;
    }
    const gl = this.gl as WebGL2RenderingContext;
    gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending = this.query;
    this.query = null;
  }

  /** Record one frame's CPU split. All arguments in milliseconds. */
  sample(app: number, submit: number, frame: number): void {
    this.app += (app - this.app) * SMOOTHING;
    this.submit += (submit - this.submit) * SMOOTHING;
    this.frame += (frame - this.frame) * SMOOTHING;
  }

  /** One line, for the debug stats. */
  format(): string {
    const gpu = this.gpu < 0 ? "n/a" : `${this.gpu.toFixed(1)}`;
    return `app ${this.app.toFixed(1)}  submit ${this.submit.toFixed(1)}  gpu ${gpu}  frame ${this.frame.toFixed(1)} ms`;
  }
}
