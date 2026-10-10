// The stats readout: where the camera is, the frame rate and what the frame
// cost, then whatever the shown overlays have to say. Two lines, refreshed a few
// times a second, through `UiState.debug.stats`.

import type { AudioSystem } from "../../engine/audio/system.js";
import type { Viewmodel } from "../../engine/viewmodel.js";
import type { FrameUpdates } from "../frame.js";
import type { DevContext } from "./context.js";
import type { NavDebug } from "./navDebug.js";
import type { Overlays } from "./overlays.js";

/** Seconds between stats updates. Nobody reads a readout faster, and each one re-renders its panel. */
const STATS_INTERVAL = 0.1;

export class StatsReadout {
  private frames = 0;
  private fpsAccum = 0;
  private fps = 0;
  private accum = STATS_INTERVAL;

  constructor(
    private readonly ctx: DevContext,
    private readonly overlays: Overlays,
    private readonly nav: NavDebug,
    private readonly updates: FrameUpdates,
    private readonly viewmodel: Viewmodel,
    private readonly audio: AudioSystem,
  ) {}

  /** Redraw on the next frame rather than at the next interval: something it reports just changed. */
  refresh(): void {
    this.accum = STATS_INTERVAL;
  }

  clear(): void {
    this.ctx.ui.debug.stats.value = null;
  }

  update(dt: number): void {
    const { ui, viewer, firstPerson, current, view } = this.ctx;
    this.frames++;
    this.fpsAccum += dt;
    if (this.fpsAccum >= 0.5) {
      this.fps = Math.round(this.frames / this.fpsAccum);
      this.frames = 0;
      this.fpsAccum = 0;
    }
    this.accum += dt;
    const world = current.world;
    if (!ui.debug.enabled.value || !world || this.accum < STATS_INTERVAL) {
      return;
    }
    this.accum = 0;

    const mode = view.mode;
    const p = mode === "walk" ? firstPerson.player.movement.feet : viewer.camera.position;
    // The loop runs frame callbacks before rendering, so this is the previous frame's tally.
    const { calls, triangles } = viewer.renderer.info.render;
    const tris = triangles >= 1e6 ? `${(triangles / 1e6).toFixed(2)}M` : `${Math.round(triangles / 1000)}k`;
    const primary = [
      world.name,
      `(${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)})`,
      `${this.fps} fps`,
      `${calls} draws`,
      `${tris} tris`,
      mode,
      viewer.qualityLevel,
    ];
    const secondary = [viewer.profiler.format(), `passes ${viewer.pipeline.format()}`, `updates ${this.updates.format()}`];
    this.overlays.stats(primary, secondary);
    if (this.nav.visible) {
      primary.push(...this.nav.stats(p));
    }
    const weapon = this.viewmodel.describe();
    if (weapon) {
      secondary.push(weapon);
    }
    // Voices *and* placements: no voices with placements is a world whose loops
    // are all out of earshot (or whose context the browser has not started), and
    // no placements at all is a world with no ambience — different readings.
    const placements = this.audio.ambienceCount.placements;
    if (placements) {
      secondary.push(`${this.audio.voiceCount}/${placements} voices`);
    }
    ui.debug.stats.value = { primary, secondary };
  }
}
