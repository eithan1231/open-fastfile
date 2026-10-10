// The gametypes as a lobby offers them: the registry's declarations, read once
// into the plain data the UI lists.

import { GAMETYPES } from "@3d/shared/game/gametypes/registry.js";
import { zombiesGametype } from "@3d/shared/game/gametypes/zombies.js";

/** Which picture is behind the menus. */
export type MenuBackdrop = "generic" | "zombies";

/** A gametype as a lobby offers it. */
export interface LobbyMode {
  id: string;
  name: string;
  description: string;
  /** The map slugs it is played on, or null for every map. */
  maps: readonly string[] | null;
  /** The menus' picture while a lobby is set to it. */
  backdrop: MenuBackdrop;
}

/** Every gametype, in the registry's order. */
export const LOBBY_MODES: readonly LobbyMode[] = Object.values(GAMETYPES).map((decl) => ({
  id: decl.id,
  name: decl.display,
  description: decl.description ?? "",
  maps: decl.maps?.length ? decl.maps : null,
  // By mode rather than id: every gametype played in the zombies' mode is Zombies to look at.
  backdrop: decl.mode === zombiesGametype.mode ? "zombies" : "generic",
}));
