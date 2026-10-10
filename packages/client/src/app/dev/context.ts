// What every development tool reads: live objects, never copies, since each one
// outlives the worlds it looks at.

import type { CollisionView, CollisionWorld } from "@3d/shared/collision/world.js";
import type { FirstPersonControls } from "../../engine/controls/firstPerson.js";
import type { Viewer } from "../../engine/viewer.js";
import type { CurrentWorld } from "../currentWorld.js";
import type { Toaster } from "../toaster.js";
import type { UiState } from "../uiBridge.js";

export type ViewMode = "walk" | "dollhouse";

export interface DevContext {
  readonly viewer: Viewer;
  readonly collision: CollisionWorld;
  /** The collision as the match has it: what a player steps and traces against. */
  readonly live: CollisionView;
  readonly firstPerson: FirstPersonControls;
  readonly ui: UiState;
  readonly toaster: Toaster;
  readonly current: CurrentWorld;
  /** Which way the world is being looked at. */
  readonly view: { readonly mode: ViewMode };
}
