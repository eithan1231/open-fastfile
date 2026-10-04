// Every gametype, by name — and nothing else.
//
// Split out of `game/registry.ts` so that **`@3d/api` can validate a lobby's
// gametype having imported no behaviour at all.** `game/registry.ts` imports
// `scripts/cast.js` for its `SCRIPTS` table, and that is a *value* import: an api
// reaching for `gametype()` there would pull the whole script table — and every
// script's transitive imports — into the authority's bundle. The api decides that
// a game exists, who is in it and where it runs; it never runs one.
//
// A table, as `NODE_TYPES` is for a node type and `API_ROUTES` for a route: the
// entries are compiled in and reached by name, and **nothing is ever read off
// disk**. See docs/engine/scripting.md.

import type { GameKey } from "../../dsl/resolved.js";
import { chaseGametype } from "./chase.js";
import { defaultGametype, DEFAULT_GAMETYPE } from "./default.js";
import type { GametypeDecl, GametypeId } from "./declaration.js";
import { zombiesBo2HordeGametype, zombiesGametype } from "./zombies.js";

export { DEFAULT_GAMETYPE };

/** Every gametype, by id. */
export const GAMETYPES: Readonly<Record<GametypeId, GametypeDecl>> = {
  [defaultGametype.id]: defaultGametype,
  [chaseGametype.id]: chaseGametype,
  [zombiesGametype.id]: zombiesGametype,
  [zombiesBo2HordeGametype.id]: zombiesBo2HordeGametype,
};

/** The gametype with this id, or undefined — which is what a lobby is refused on. */
export function gametype(id: string): GametypeDecl | undefined {
  return Object.hasOwn(GAMETYPES, id) ? GAMETYPES[id] : undefined;
}

/**
 * Whether a gametype will run on this map, of this game.
 *
 * An absent or empty restriction means "no restriction" rather than "nothing",
 * because that is the answer a declaration that does not care should give.
 */
export function admits(decl: GametypeDecl, map: string, game: GameKey | undefined): boolean {
  return admitsMap(decl, map) && (!decl.games?.length || (game !== undefined && decl.games.includes(game)));
}

/**
 * The half of `admits` that needs only a slug.
 *
 * Separate because **the api cannot answer the other half.** Which game a world
 * was imported from lives in its `world { game: }`, and the worlds manifest does
 * not carry it — so the authority validating a lobby's choice would have to
 * resolve the world text to check a `games` restriction. Rather than pass
 * `undefined` and have `admits` refuse every game-restricted gametype on every
 * map, a caller that only knows the slug checks what it can and says so. The game
 * server, which has the resolved world, calls `admits`.
 */
export function admitsMap(decl: GametypeDecl, map: string): boolean {
  return !decl.maps?.length || decl.maps.includes(map);
}
