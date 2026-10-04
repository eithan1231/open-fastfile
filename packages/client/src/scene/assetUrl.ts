// Where an asset's file is fetched from: the world's own folder, or the catalogue.
//
// The one place either becomes a URL. It used to be `baseUrl + source` inline at
// each use — two of them in models.ts, for the mesh and for its collision hull —
// which was fine while every asset came from one place. A prop shared between maps
// does not, and a second rule spelled out twice is how the two quietly disagree.
//
// Both spellings go through the route builders, so the key an AssetStore holds is
// byte-identical to the URL the route serves. That matters more than it looks:
// hot-reload invalidation is keyed by URL, so a second spelling of one file would
// silently stop invalidating it (see the note in protocol/routes/worlds.ts).

import type { ResolvedAsset } from "@3d/shared/dsl/resolved.js";
import type { CatalogRef } from "@3d/shared/game/cast.js";
import { castFilePath, catalogFilePath, catalogSoundClipPath, catalogSoundsPath } from "@3d/shared/protocol/routes/catalog.js";

/**
 * The URL for an asset's file.
 *
 * `worldBase` is the world's asset prefix, and is ignored for a catalogue asset —
 * a shared prop is not relative to whichever map is being walked, which is the
 * whole point of it being shared.
 */
export function assetUrl(asset: ResolvedAsset, worldBase: string): string {
  const { catalog, source } = asset;
  return catalog === undefined ? worldFileUrl(source, worldBase) : catalogFilePath(catalog.kind, catalog.game, catalog.id, source);
}

/** The URL of one file of a catalogue entry `@3d/shared/game/` named (`CatalogRef`): a cast's or an actor's. */
export function catalogRefUrl(ref: CatalogRef): string {
  return castFilePath(ref);
}

/**
 * Which alias table a sound came out of, and therefore where its clips are: a
 * world's own `assets/sounds/`, or the catalogue's bank for one game.
 *
 * The two travel together because they are one decision. A name is resolved
 * against both tables in order (`engine/audio/library.ts`), and the table that
 * held it is the one whose clips have to be fetched — so the home is carried
 * beside the row rather than chosen once per session.
 */
export type SoundHome = { readonly base: string; readonly source: string } | { readonly game: string };

/** Where an alias table is. */
export function soundLibraryUrl(home: SoundHome): string {
  return "game" in home ? catalogSoundsPath(home.game) : home.base + home.source;
}

/**
 * The URL for one clip of a sound alias.
 *
 * The table names a file **with no extension**, at the game's own path, and the
 * export writes Opus in WebM beside it — so the extension is added here and
 * nowhere else, on both branches.
 */
export function soundClipUrl(home: SoundHome, file: string): string {
  return "game" in home ? catalogSoundClipPath(home.game, file) : `${home.base}assets/sounds/clips/${file}.webm`;
}

/**
 * The URL of a file a world names by a path in its own folder, such as its
 * `navigation { source: }`. Never a catalogue file: a world's graph is its own.
 */
export function worldFileUrl(source: string, worldBase: string): string {
  return worldBase + source;
}
