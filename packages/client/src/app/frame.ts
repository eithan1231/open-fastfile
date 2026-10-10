// What runs every frame before the frame is drawn, as named steps in a fixed
// order: the update half of a frame, as engine/render/pipeline.ts is the draw
// half. A system that needs a per-frame call fills a slot here rather than a
// line in App, so the order is this list and each step is timed under its name.

/** Every step a frame can run, in order. Where one needs another first, its comment says so. */
export const UPDATES = [
  // Animated props: their matrices, written by the animator (nothing else in the world moves).
  "animation",
  // The player steps and the camera moves: walk or dollhouse.
  "controls",
  // After the step: the watchers compare the state they last saw with this one,
  // so a frame that ran several ticks still hears every footfall between them.
  "local sound",
  // Peers and actors, interpolated to the moment they are drawn at.
  "others",
  // After the controls: a swap that finished this step attaches its rig before
  // anything poses the old one; then the hands follow the camera, and the
  // sights set the camera's zoom.
  "viewmodel",
  // After the camera has moved and zoomed: spawn culling, distance fades and
  // facing are all judged from this frame's camera.
  "effects",
  // The HUD, the minimap and the use prompt, from the predicted player and the camera's zoom.
  "presenters",
  // After the controls: the listener is where the player is now, so a loop comes
  // into earshot on the frame they reach it.
  "listener",
  // After the controls: the shadow fit follows where the player is now.
  "shadows",
  // Last: the hit box view reads bone matrices the "others" step posed this frame.
  "dev",
] as const;

export type UpdateName = (typeof UPDATES)[number];

export type FrameUpdate = (dt: number) => void;

/** Exponential smoothing for the timings, as the pipeline smooths its own. */
const SMOOTHING = 0.1;

export class FrameUpdates {
  private readonly steps = new Map<UpdateName, FrameUpdate>();
  /** Smoothed milliseconds per step. */
  readonly timings = new Map<UpdateName, number>();

  /** Fill the slot `name` with `step`, replacing what was there. */
  use(name: UpdateName, step: FrameUpdate): void {
    this.steps.set(name, step);
  }

  run(dt: number): void {
    for (const name of UPDATES) {
      const step = this.steps.get(name);
      if (!step) {
        continue;
      }
      const start = performance.now();
      step(dt);
      const ms = performance.now() - start;
      const was = this.timings.get(name);
      this.timings.set(name, was === undefined ? ms : was + (ms - was) * SMOOTHING);
    }
  }

  /** One line for the debug stats: the steps worth naming, slowest first. */
  format(): string {
    return [...this.timings]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([name, ms]) => `${name} ${ms.toFixed(1)}`)
      .join("  ");
  }
}
