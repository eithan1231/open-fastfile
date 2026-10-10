// What a player tunes and the browser remembers: render quality, aim
// sensitivity and the volume. Each works from the menu as well as in a world,
// and the UI's copy is written here and nowhere else.

import { contentBounds } from "../scene/scene.js";
import { QUALITY } from "../engine/quality.js";
import type { QualityLevel } from "../engine/qualityLevel.js";
import { clampSensitivity, loadSensitivity, saveSensitivity } from "../input/sensitivity.js";
import type { CurrentWorld } from "./currentWorld.js";
import type { Systems } from "./systems.js";
import type { AudioChannel, UiState } from "./uiBridge.js";

export class Settings {
  constructor(
    private readonly systems: Systems,
    private readonly current: CurrentWorld,
    private readonly ui: UiState,
  ) {}

  /** Put every remembered setting into effect and into the UI. */
  restore(): void {
    this.ui.quality.value = this.systems.viewer.qualityLevel;
    this.ui.audio.value = this.systems.audio.settings;
    this.setSensitivity(loadSensitivity());
  }

  /** Works in the menu too; the level is remembered per browser. */
  setQuality(level: QualityLevel): void {
    const { viewer, shadowFit } = this.systems;
    const root = this.current.root;
    let texelSize: number | undefined;
    if (root) {
      // Focus radius and map size are per level, so the frustum is refitted first.
      texelSize = shadowFit.build(root, contentBounds(root), {
        focusRadius: QUALITY[level].shadowFocusRadius,
        mapSize: QUALITY[level].shadowMapSize,
      }).texelSize;
      shadowFit.update(viewer.camera);
    }
    viewer.setQuality(level, root, texelSize);
    this.ui.quality.value = level;
  }

  /** The aim's scale, and the UI's copy of it. Remembered per browser once a player has chosen one. */
  setSensitivity(value: number, options: { save?: boolean } = {}): void {
    const clamped = clampSensitivity(value);
    this.systems.firstPerson.setSensitivity(clamped);
    this.ui.sensitivity.value = clamped;
    if (options.save) {
      saveSensitivity(clamped);
    }
  }

  setVolume(channel: AudioChannel | "master", value: number): void {
    this.systems.audio.setVolume(channel, value);
    this.ui.audio.value = this.systems.audio.settings;
  }

  setMuted(muted: boolean): void {
    this.systems.audio.setMuted(muted);
    this.ui.audio.value = this.systems.audio.settings;
  }
}
