// The catalogue, narrowed to the questions a gametype asks of it.
//
// `api/src/loadouts.ts` already does this for a stored class: it declares the
// one method it needs rather than importing `WeaponRegistry`, so reconciling a
// class is testable against an object literal. This is the same trick for the
// kinds a cast is built from, and for the same reason — `castFor` has to run
// identically in a browser, on a game server and in a test, so what it reads has
// to be an interface rather than a file on disk.
//
// Plain data, tier one: no three.js, no DOM, no Node. A body is a name here; the
// GLB behind it is the client's business.

import type { GameKey } from "../dsl/resolved.js";
import type { WeaponId } from "../sim/weaponRegistry.js";
import type { ActorEntry } from "./actors/assets.js";

/**
 * One body a player can be drawn as, as
 * `catalog/characters/<game>/<id>/<id>.json` holds it.
 *
 * `side` is the faction the source game put it on, which is what lets a gametype
 * ask for "this game's allies" rather than naming a body per map. It comes from
 * the exporter's own table (`scripts/cod/characters.py`), so that table stays the
 * one place a faction is decided.
 */
export interface CharacterEntry {
  id: string;
  game: GameKey;
  side?: string;
  /** The body GLB, relative to the entry's folder: the skeleton every clip plays on. */
  body: string;
  /** A head GLB, rebound to the body's joints by name. Absent for a body that needs none. */
  head?: string;
  /**
   * The third-person weapon whose joints are baked into this body
   * (`characters.py` grafts them at `j_gun`).
   *
   * Recorded rather than used: a peer holds this gun and not the one their class
   * names, because rebinding a different weapon's joints at run time is not built.
   * When it is, this is what says which gun a body came with.
   */
  bakedWeapon?: string | null;
  /** Which clip set this body's skeleton expects, keying `animationsFor`. */
  animType?: string;
}

/** One pair of first-person hands, as `catalog/viewhands/<game>/<id>/` holds it. */
export interface ViewhandsEntry {
  id: string;
  game: GameKey;
  /** The hands GLB, relative to the entry's folder. */
  hands: string;
}

/**
 * One set of third-person player clips, shared by every body whose joints carry
 * those names.
 *
 * Keyed by `(game, animType)` rather than by map: the clips are a game's, not a
 * map's — every world of one game ships the same sixteen under the same names.
 */
export interface AnimationsEntry {
  id: string;
  game: GameKey;
  animType: string;
  /** The clip GLB, relative to the entry's folder: a skeleton with no meshes. */
  clips: string;
}

/**
 * What a gametype may ask the catalogue.
 *
 * Every accessor answers with what this deployment actually holds, so an empty
 * result means "none built" and never "ask again later". A caller that gets
 * nothing degrades — capsules, or an unarmed player — rather than failing.
 */
export interface CatalogueView {
  /** Whether this id names a weapon the catalogue still holds. */
  weapon(id: WeaponId): { game: string; id: string } | undefined;
  /** Every body for a game, in catalogue order. */
  charactersFor(game: GameKey): readonly CharacterEntry[];
  /** Every pair of hands for a game, in catalogue order. */
  viewhandsFor(game: GameKey): readonly ViewhandsEntry[];
  /** The clips a body of this game and anim type plays. */
  animationsFor(game: GameKey, animType: string): AnimationsEntry | undefined;
  /** A creature an actor kind is drawn as (`catalog/actors/<game>/<id>/`), unchecked: `actorAssetsFor` reads it. */
  actorFor(game: GameKey, id: string): ActorEntry | undefined;
}

/** The catalogue index as it arrives, which is `api/src/worlds/fs.ts`'s `CatalogIndex` over the wire. */
export interface CatalogIndexBody {
  version: number;
  weapons?: unknown[];
  characters?: unknown[];
  viewhands?: unknown[];
  animations?: unknown[];
  actors?: unknown[];
}

/** Whether a weapon id is one this catalogue still holds. The one thing a cast asks about weapons. */
export interface WeaponLookup {
  entry(id: string | null | undefined): unknown;
}

/**
 * A `CatalogueView` over a fetched index.
 *
 * Grouped by game once rather than filtered per call: a cast is chosen on every
 * spawn, and `charactersFor` walking 26 entries each time is work with an obvious
 * shape. An entry whose `game` is missing is dropped rather than guessed at.
 *
 * `weapons` is the registry that already read the `weapons` array, so this does
 * not parse it a second time — and the two can never be a rebuild apart.
 */
export function catalogueViewOf(index: CatalogIndexBody, weapons: WeaponLookup): CatalogueView {
  const byGame = <T extends { game?: unknown }>(entries: unknown[] | undefined): Map<string, T[]> => {
    const out = new Map<string, T[]>();
    for (const entry of entries ?? []) {
      const game = (entry as { game?: unknown }).game;
      if (typeof game === "string") {
        const list = out.get(game);
        if (list) {
          list.push(entry as T);
        } else {
          out.set(game, [entry as T]);
        }
      }
    }
    return out;
  };

  const characters = byGame<CharacterEntry>(index.characters);
  const viewhands = byGame<ViewhandsEntry>(index.viewhands);
  const animations = byGame<AnimationsEntry>(index.animations);
  const actors = byGame<ActorEntry>(index.actors);

  return {
    weapon: (id) => {
      const entry = weapons.entry(id);
      return entry ? (entry as { game: string; id: string }) : undefined;
    },
    charactersFor: (game) => characters.get(game) ?? [],
    viewhandsFor: (game) => viewhands.get(game) ?? [],
    animationsFor: (game, animType) => (animations.get(game) ?? []).find((a) => a.animType === animType),
    actorFor: (game, id) => (actors.get(game) ?? []).find((a) => a.id === id),
  };
}
