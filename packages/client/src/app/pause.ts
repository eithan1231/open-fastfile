// Whether the world is being played: the view mode, pause and the prompt over
// it, pointer lock, and waiting to be spawned into a match. Gameplay input is on
// exactly while this says the world is unpaused.

import { contentBounds } from "../scene/scene.js";
import type { CurrentWorld } from "./currentWorld.js";
import type { ViewMode } from "./dev/context.js";
import type { ScreenRouter } from "./screens.js";
import type { Systems } from "./systems.js";
import type { Toaster } from "./toaster.js";
import type { UiState } from "./uiBridge.js";

/** An Esc this soon after pausing is the one that paused, if the browser delivers it after freeing the pointer. */
const ESC_ECHO_MS = 250;

export class PauseController {
  private viewMode: ViewMode = "walk";
  private pausedAt = 0;
  /**
   * In a match and not in the world yet: from the moment the map starts loading
   * until a class is chosen, or the server says they are in, or the match is
   * given up on. Nothing may start play meanwhile — `resume` puts the joining
   * prompt back instead — because nobody plays before choosing a class.
   */
  private waiting = false;
  /** Told of every view mode change. */
  onModeChange: ((mode: ViewMode) => void) | undefined;
  /** Esc on the error screen: back to the menu. */
  onLeave: (() => void) | undefined;

  constructor(
    private readonly systems: Systems,
    private readonly ui: UiState,
    private readonly screens: ScreenRouter,
    private readonly current: CurrentWorld,
    private readonly toaster: Toaster,
  ) {}

  get mode(): ViewMode {
    return this.viewMode;
  }

  get awaitingSpawn(): boolean {
    return this.waiting;
  }

  bind(): void {
    const { input, firstPerson, animator } = this.systems;
    input.on("toggleView", () => this.setMode(this.viewMode === "walk" ? "dollhouse" : "walk"));
    input.on("menu", () => this.onMenuKey());
    // A pointer that unlocks (Esc, alt-tab) pauses a walk; one that locks resumes it.
    input.onLockChange((locked) => {
      if (this.screens.current !== "world" || this.viewMode !== "walk") {
        return;
      }
      if (locked && this.waiting) {
        input.exitPointerLock(); // not in the world yet: see `waiting`
        return;
      }
      if (locked) {
        this.ui.prompt.value = null;
      }
      this.setPaused(!locked);
    });
    firstPerson.onUnfreeze = () => {
      animator.paused = false;
      this.toaster.show("released");
    };
  }

  /** A match's map is about to load: nobody plays it until they are spawned. */
  awaitSpawn(): void {
    this.waiting = true;
  }

  /** In the match's world now — spawned, or the match gone — so it can be played. */
  spawned(): void {
    this.waiting = false;
    if (this.ui.prompt.value === "joining") {
      this.ui.prompt.value = "play";
    }
  }

  /** Seated, not spawned: the class menu goes up over a paused world. */
  holdForClass(): void {
    this.ui.prompt.value = null;
    this.systems.input.exitPointerLock();
    this.setPaused(true);
  }

  /** A world just came up: the prompt over it, unless a hot reload kept whatever was there. */
  arrived(reload: boolean): void {
    if (!reload) {
      this.ui.prompt.value = this.waiting ? "joining" : "play";
    } // over the world, which runs behind it
  }

  /** The world went away: nothing is played or waited for. */
  stop(): void {
    const { input, firstPerson, dollhouse } = this.systems;
    this.waiting = false;
    input.context = "menu";
    firstPerson.setActive(false);
    firstPerson.setFrozen(false);
    dollhouse.enabled = false;
    this.ui.prompt.value = null;
    this.ui.paused.value = false;
  }

  setMode(next: ViewMode): void {
    const { input, firstPerson, dollhouse } = this.systems;
    this.viewMode = next;
    this.onModeChange?.(next);
    firstPerson.setActive(next === "walk");
    if (next !== "walk") {
      input.exitPointerLock();
    }
    dollhouse.enabled = next === "dollhouse";
    const root = this.current.root;
    if (next === "dollhouse" && root) {
      dollhouse.frame(contentBounds(root));
    }
    this.setPaused(next === "walk" && !input.locked);
  }

  /**
   * Play, from a click or key press (Click to play, Resume Game). In walk mode
   * the lock change then unpauses and clears the prompt.
   */
  resume(): void {
    // The click that takes the pointer is also the gesture a browser wants
    // before it will start an AudioContext, and this is the one place both are
    // known to be inside one. `engine/audio/context.ts` is the backstop for the
    // gestures that never reach here — signing in, and the menus.
    this.systems.audio.unlock();
    // Not in the world yet: back to waiting for the server, over which the class
    // menu comes up by itself.
    if (this.waiting) {
      if (this.ui.classChoice.value === null) {
        this.ui.prompt.value = "joining";
      }
      return;
    }
    if (this.viewMode !== "walk") {
      this.ui.prompt.value = null;
      this.setPaused(false);
      return;
    }
    void this.systems.input.requestPointerLock();
  }

  /**
   * Paused means gameplay input is off and the pause menu is up. Walking is
   * paused exactly while the pointer is unlocked; the dollhouse by choice.
   */
  private setPaused(paused: boolean): void {
    this.ui.paused.value = paused;
    if (paused) {
      this.pausedAt = performance.now();
    }
    this.systems.input.context = paused ? "menu" : "world";
  }

  /**
   * Esc in the pause menu. The browser freed the pointer before the page saw
   * the key, and will not re-lock from it, so this usually asks for a click.
   */
  private resumeFromKey(): void {
    if (this.waiting) {
      return this.resume(); // which puts the joining prompt back
    }
    if (this.viewMode !== "walk") {
      return this.setPaused(false);
    }
    void this.systems.input.requestPointerLock().then((locked) => {
      if (!locked && this.screens.current === "world" && this.ui.paused.value) {
        this.ui.prompt.value = "resume";
      }
    });
  }

  /** Esc toggles the pause menu. Walking, the lock change does the pausing. */
  private onMenuKey(): void {
    const screen = this.screens.current;
    if (screen === "error") {
      return this.onLeave?.();
    }
    if (screen !== "world") {
      return;
    }
    // Over the class menu, Esc is that menu's: Back when changing class (its own
    // handler), and nothing at all on joining, where there is no game to go back to.
    if (this.ui.classChoice.value !== null) {
      return;
    }
    if (this.ui.prompt.value) {
      this.ui.prompt.value = null; // to the pause menu: the game is paused under a prompt
      return;
    }
    if (!this.ui.paused.value) {
      if (this.viewMode === "walk") {
        this.systems.input.exitPointerLock();
      } else {
        this.setPaused(true);
      }
    } else if (performance.now() - this.pausedAt > ESC_ECHO_MS) {
      this.resumeFromKey();
    }
  }
}
