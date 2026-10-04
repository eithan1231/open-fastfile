// Installs the hook that re-renders a component when a signal it read changes.
// The bridge creates its signals with signals-core; this is the same instance.
import "@preact/signals";
import type { UiCommands, UiState } from "../app/uiBridge.js";
import { UiContext, useUi } from "./context.js";
import { DebugOverlay } from "./debug/DebugOverlay.js";
import { HudLayer } from "./hud/HudLayer.js";
import { ChooseClass } from "./screens/ChooseClass.js";
import { CreateClass } from "./screens/CreateClass.js";
import { Elsewhere } from "./screens/Elsewhere.js";
import { ErrorScreen } from "./screens/ErrorScreen.js";
import { Loading } from "./screens/Loading.js";
import { Lobby } from "./screens/Lobby.js";
import { MainMenu } from "./screens/MainMenu.js";
import { PauseMenu } from "./screens/PauseMenu.js";
import { PlayPrompt } from "./screens/PlayPrompt.js";
import { SignIn } from "./screens/SignIn.js";

export function Root(props: { state: UiState; commands: UiCommands }) {
  return (
    <UiContext.Provider value={props}>
      <Screen />
    </UiContext.Provider>
  );
}

function Screen() {
  const { state } = useUi();
  switch (state.screen.value) {
    case "auth":
      return <SignIn />;
    case "menu":
      return <MainMenu />;
    case "lobby":
      return <Lobby />;
    case "classes":
      return <CreateClass />;
    case "loading":
      return <Loading />;
    case "error":
      return <ErrorScreen />;
    case "elsewhere":
      return <Elsewhere />;
    case "world":
      return (
        <>
          <HudLayer />
          {state.debug.enabled.value && <DebugOverlay />}
          <WorldOverlay />
        </>
      );
  }
}

/**
 * Over a world: the class menu while one is being chosen, else a prompt waiting
 * for the click that captures the mouse, else the pause menu while paused.
 */
function WorldOverlay() {
  const { state } = useUi();

  if (state.classChoice.value !== null) {
    return <ChooseClass />;
  }

  const prompt = state.prompt.value;
  if (prompt) {
    return <PlayPrompt prompt={prompt} />;
  }

  return state.paused.value ? <PauseMenu /> : null;
}
