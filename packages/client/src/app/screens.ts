// Which screen is up. The only writer of `ui.screen` (a test holds it to that),
// so every rule about where a player belongs is here rather than at each place
// that sends them somewhere.

import type { InputManager } from "../input/InputManager.js";
import type { ErrorInfo, Screen, UiState } from "./uiBridge.js";

export class ScreenRouter {
  constructor(
    private readonly ui: UiState,
    private readonly input: InputManager,
    private readonly inLobby: () => boolean,
  ) {}

  get current(): Screen {
    return this.ui.screen.value;
  }

  show(screen: Screen): void {
    this.ui.screen.value = screen;
  }

  /**
   * The menu, or the lobby for a player in one: the menu's buttons would all be
   * refused to them by the api.
   */
  home(): void {
    this.show(this.inLobby() ? "lobby" : "menu");
  }

  /** Something went wrong loading a world: say what, over nothing. */
  error(error: ErrorInfo): void {
    this.ui.error.value = error;
    this.ui.loading.value = null;
    this.ui.prompt.value = null;
    this.input.context = "menu";
    this.show("error");
  }
}
