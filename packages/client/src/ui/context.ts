import { createContext } from "preact";
import { useContext } from "preact/hooks";
import type { UiCommands, UiState } from "../app/uiBridge.js";

export interface Ui {
  state: UiState;
  commands: UiCommands;
}

export const UiContext = createContext<Ui | null>(null);

export function useUi(): Ui {
  const ui = useContext(UiContext);

  if (!ui) {
    throw new Error("useUi() outside <UiContext.Provider>");
  }

  return ui;
}
