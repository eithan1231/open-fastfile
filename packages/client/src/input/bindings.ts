// What each key does. Data rather than code, so a settings screen can rebind it.

export type Action =
  | "forward"
  | "back"
  | "left"
  | "right"
  | "run"
  | "jump"
  | "fire"
  | "ads"
  | "reload"
  | "swap"
  | "use"
  | "toggleView"
  | "menu"
  | "quality"
  | "inspector"
  | "colliders"
  | "mantles"
  | "hitboxes"
  | "surfaces"
  | "navigation"
  | "shotTraces" // SHOTTRACE (docs/engine/diagnostics-shottrace.md)
  | "sun"
  | "hideModels"
  | "pauseAnimation"
  | "viewmodel"
  | "capturePose";

/**
 * When an action is live:
 * - `walk`: in a world with the pointer locked (movement, look);
 * - `world`: whenever a world is up, locked or not (view and dev toggles);
 * - `always`: in menus too.
 */
export type ActionScope = "walk" | "world" | "always";

export interface Binding {
  /** KeyboardEvent.code values, or `Mouse<button>` (MouseEvent.button: 0 left, 2 right). */
  keys: readonly string[];
  scope: ActionScope;
  label: string;
  /** Shown only in development builds' controls help. */
  dev?: boolean;
}

export type Bindings = Record<Action, Binding>;

export const DEFAULT_BINDINGS: Bindings = {
  forward: { keys: ["KeyW", "ArrowUp"], scope: "walk", label: "Move forward" },
  back: { keys: ["KeyS", "ArrowDown"], scope: "walk", label: "Move back" },
  left: { keys: ["KeyA", "ArrowLeft"], scope: "walk", label: "Move left" },
  right: { keys: ["KeyD", "ArrowRight"], scope: "walk", label: "Move right" },
  run: { keys: ["ShiftLeft", "ShiftRight"], scope: "walk", label: "Run" },
  jump: { keys: ["Space"], scope: "walk", label: "Jump" },
  fire: { keys: ["Mouse0"], scope: "walk", label: "Fire" },
  ads: { keys: ["Mouse2"], scope: "walk", label: "Aim down sights" },
  reload: { keys: ["KeyR"], scope: "walk", label: "Reload" },
  // One action, not two: a class carries two weapons, so "the other one" is
  // unambiguous and either number key means it. Selecting a slot outright needs
  // a slot on the wire, which is a change to make when there is a third weapon.
  swap: { keys: ["Digit1", "Digit2"], scope: "walk", label: "Swap weapon" },
  // Held, like fire: the server acts on the press, and the prompt names this key.
  use: { keys: ["KeyF"], scope: "walk", label: "Use" },
  toggleView: { keys: ["Tab"], scope: "world", label: "Dollhouse view" },
  menu: { keys: ["Escape"], scope: "always", label: "Pause" },
  quality: { keys: ["KeyQ"], scope: "always", label: "Cycle quality" },
  inspector: { keys: ["Backquote"], scope: "world", label: "Inspector", dev: true },
  colliders: { keys: ["KeyC"], scope: "world", label: "Collider view", dev: true },
  mantles: { keys: ["KeyM"], scope: "world", label: "Mantle volumes and ladders", dev: true },
  hitboxes: { keys: ["KeyB"], scope: "world", label: "Hit boxes on other players", dev: true },
  surfaces: { keys: ["KeyN"], scope: "world", label: "Collision by surface type", dev: true },
  navigation: { keys: ["KeyK"], scope: "world", label: "Navigation graph (baked here)", dev: true },
  // SHOTTRACE: `G` was free. Removing this entry removes the binding.
  shotTraces: { keys: ["KeyG"], scope: "world", label: "Shot traces (client vs server)", dev: true },
  sun: { keys: ["KeyL"], scope: "world", label: "Sun marker", dev: true },
  hideModels: { keys: ["KeyH"], scope: "world", label: "Hide models", dev: true },
  pauseAnimation: { keys: ["KeyT"], scope: "world", label: "Pause animation", dev: true },
  viewmodel: { keys: ["KeyV"], scope: "world", label: "Show or hide the viewmodel", dev: true },
  capturePose: { keys: ["KeyP"], scope: "world", label: "Copy camera pose", dev: true },
};

/** Human-readable name for a KeyboardEvent.code or a `Mouse<button>`. */
export function keyLabel(code: string): string {
  if (code.startsWith("Mouse")) {
    return { Mouse0: "Left mouse", Mouse1: "Middle mouse", Mouse2: "Right mouse" }[code] ?? `Mouse ${code.slice(5)}`;
  }
  if (code.startsWith("Key")) {
    return code.slice(3);
  }
  if (code.startsWith("Arrow")) {
    return code.slice(5) + " arrow";
  }
  if (code.startsWith("Shift")) {
    return "Shift";
  }
  return { Backquote: "`", Escape: "Esc", Space: "Space", Tab: "Tab" }[code] ?? code;
}
