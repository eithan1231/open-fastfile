// The one line of transient text over the world.

import type { UiState } from "./uiBridge.js";

/** Seconds a toast stays up: long enough to read, and to retype a pose link the clipboard refused. */
const TOAST_SECONDS = 6;

export class Toaster {
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly ui: UiState) {}

  show(text: string): void {
    this.ui.toast.value = text;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.clear(), TOAST_SECONDS * 1000);
  }

  clear(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.ui.toast.value = null;
  }
}
