// The UI: menus, the HUD, overlays and dev panels, rendered with Preact over
// the canvas. Everything it shows comes from UiState signals, and everything it
// does goes through UiCommands (app/uiBridge.ts). Gameplay input is not here:
// see input/.

import { render } from "preact";
import type { UiCommands, UiState } from "../app/uiBridge.js";
import { Root } from "./Root.js";
import "./styles/tokens.css";

export function mountUi(container: HTMLElement, state: UiState, commands: UiCommands): void {
  const root = document.createElement("div");

  root.dataset.uiRoot = "";

  container.appendChild(root);

  render(<Root state={state} commands={commands} />, root);
}
