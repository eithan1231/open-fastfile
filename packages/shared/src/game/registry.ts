// Every script, by name — and the gametype table re-exported beside it.
//
// A table, as `NODE_TYPES` is for a node type and `API_ROUTES` for a route: the
// entries are compiled in and reached by name, and **nothing is ever read off
// disk**. A game server holds nothing that survives a game and reads nothing from
// `WORLDS_ROOT`, so a per-world `script.ts` evaluated at run time would turn the
// worlds volume into an execution surface across the whole fleet. A world names a
// behaviour; it never ships one.
//
// The gametype half lives in `gametypes/registry.ts` and is only re-exported
// here. That is not tidiness: importing this module pulls in every script, so
// `@3d/api` — which validates a lobby's gametype and runs nothing — must import
// the other one. Enforced by `apiImports` in eslint.config.js.

import { admits, admitsMap, gametype, GAMETYPES, DEFAULT_GAMETYPE } from "./gametypes/registry.js";
import type { GametypeId } from "./gametypes/declaration.js";
import type { Script } from "./hooks.js";
import { castScript } from "./scripts/cast.js";
import { chaseScript } from "./scripts/chase.js";
import { countdownScript } from "./scripts/countdown.js";
import { zombiesScript } from "./scripts/zombies.js";

export { DEFAULT_GAMETYPE, GAMETYPES, gametype, admits, admitsMap };

/**
 * Every script, in the order they are asked.
 *
 * Declaration order is delivery order, so two scripts that talk to each other do
 * so in an order that is written down rather than discovered. It is also who
 * answers a question first: a gametype's own script goes before `cast`, whose
 * `playerSpawn` answers for every gametype and would otherwise always win.
 */
export const SCRIPTS: readonly Script[] = [chaseScript, zombiesScript, castScript, countdownScript];

/** The scripts a (gametype, map) pair runs, in `SCRIPTS` order. */
export function scriptsFor(id: GametypeId, map: string): readonly Script[] {
  return SCRIPTS.filter((script) => !script.gametypes?.length || script.gametypes.includes(id)).filter(
    (script) => !script.maps?.length || script.maps.includes(map),
  );
}
