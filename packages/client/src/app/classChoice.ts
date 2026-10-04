// Which class this player is playing in a match, and which one waits for their
// next spawn: this end keeping up with what the game server holds them to.
//
// The server is the authority — it looks a choice up by number in its own copy of
// the player's classes, decides when it takes effect (`ClassTiming`), and hands
// the weapons over itself (`PlayerState.armed`, which `WorldSession` follows).
// None of that is decided or predicted here. What is here is the menu's marks:
// which class is in hand, which is waiting, and what to say about an answer.

import type { ClassTiming } from "@3d/shared/game/classes.js";
import type { UiState } from "./uiBridge.js";

export class ClassChoice {
  /** Whether the server last had this player down; undefined before a snapshot has said. A respawn is true → false. */
  private dead: boolean | undefined;
  /** The choice that is spawning them, until its answer arrives. */
  private spawning: number | null = null;

  constructor(private readonly ui: UiState) {}

  /**
   * A class was clicked in the class menu, which closes. Returns whether this is
   * the choice that spawns them — the menu that came up on joining — which the
   * caller answers by getting them into the world.
   */
  chose(index: number): boolean {
    const spawning = this.ui.classChoice.value === "spawn";
    this.ui.classChoice.value = null;
    if (spawning) {
      this.spawning = index;
      this.ui.playingClass.value = index;
      this.ui.pendingClass.value = null;
    }
    return spawning;
  }

  /**
   * The server's answer about `index`. Returns what to tell the player about it,
   * or null where nothing needs saying: a class that spawned them, or the class
   * already in hand chosen again.
   */
  answered(index: number, timing: ClassTiming, name: string): string | null {
    const spawned = this.spawning === index;
    this.spawning = null;
    if (spawned) {
      if (timing === "refuse") {
        this.ui.playingClass.value = null;
        return "Your class was refused for this match";
      }
      return null;
    }
    switch (timing) {
      case "now": {
        const changed = this.ui.playingClass.value !== index;
        this.ui.playingClass.value = index;
        this.ui.pendingClass.value = null;
        return changed ? `Now playing ${name}` : null;
      }
      case "nextSpawn":
        this.ui.pendingClass.value = index;
        return `${name} from your next spawn`;
      case "refuse":
        return "You can't change class now";
    }
  }

  /**
   * This player's `dead` from one snapshot, or undefined while they are not in
   * the match. Getting up again is when a waiting class became the one in hand —
   * the server re-armed them with it, and this moves the menu's marks to match.
   */
  snapshot(dead: boolean | undefined): void {
    const was = this.dead;
    this.dead = dead;
    if (was !== true || dead !== false) {
      return;
    }
    const pending = this.ui.pendingClass.value;
    if (pending !== null) {
      this.ui.playingClass.value = pending;
      this.ui.pendingClass.value = null;
    }
  }

  /** Out of the match: nothing is being played, and nothing waits. */
  clear(): void {
    this.ui.classChoice.value = null;
    this.ui.playingClass.value = null;
    this.ui.pendingClass.value = null;
    this.ui.canChooseClass.value = false;
    this.dead = undefined;
    this.spawning = null;
  }
}
