// The shared asset catalogue: what belongs to no one world.
//
// A weapon used to live inside whichever world shipped it, which is why a world
// held exactly one and why a loadout could not name a gun the current map did
// not happen to carry. These two routes are the other half of that.
//
// `kind` and `game` are path segments rather than parts of an id so that the
// same id can exist in two games (`m4` in iw4 and iw5) without colliding, and so
// a whole branch is a prefix — which is what lets vehicles and characters move
// in here later without a route each.

import * as z from "zod/mini";
import { bytes, defineRoute, json, routePath } from "../route.js";

/**
 * A catalogue segment: the same allowlist a world slug uses, and for the same
 * reason. `kind`, `game` and `id` are each spliced into a filesystem path by
 * @3d/api's src/worlds/paths.ts, so what they may be is part of the contract
 * rather than one server's private caution. Saying what a name *is* beats
 * listing what it may not be: a refusal list is wrong the first time an escape
 * is missed, an allowlist only by being too strict.
 */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const catalogSegment = z.string().check(
  z.maxLength(64),
  z.refine((value) => SEGMENT.test(value), { error: "not a catalogue name" }),
);

/** A file inside one catalogue entry's folder. Relative, with no way out of it. */
const catalogRelPath = z.string().check(
  z.maxLength(256),
  z.refine((rel) => rel.length > 0 && rel.split("/").every((seg) => SEGMENT.test(seg)), { error: "not a path inside a catalogue entry" }),
);

/**
 * The whole catalogue in one reply, definitions included.
 *
 * A shape check rather than a schema over the contents, as `worldPayload` is and
 * for the same reason: a `WeaponDef` is a few hundred numbers and clip names per
 * weapon, and validating every one of them property-by-property on the main
 * thread at boot would cost more than reading them does. `WeaponRegistry`
 * refuses what it cannot use.
 *
 * One request rather than one per weapon: it is fetched once at boot by both
 * ends, and a round trip per weapon would cost far more than the bytes do.
 */
function isCatalog(value: unknown): value is { version: number; weapons: unknown[] } {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const { version, weapons } = value as { version?: unknown; weapons?: unknown };
  return typeof version === "number" && Array.isArray(weapons);
}

export const catalogBody = z.custom<{ version: number; weapons: unknown[] }>(isCatalog, { error: "not a catalogue" });

export const catalogIndexRoute = defineRoute({
  method: "GET",
  path: "/api/catalog",
  auth: "public",
  result: json(catalogBody),
  revalidate: true,
});

/**
 * One file out of a catalogue entry: a weapon's `.glb`, an attachment's model.
 * `revalidate` for the reason the world asset route has it — a re-exported file
 * must never come from a stale cache, and 304 keeps a reload cheap.
 */
export const catalogFileRoute = defineRoute({
  method: "GET",
  path: "/api/catalog/:kind/:game/:id/*",
  auth: "public",
  params: z.object({ kind: catalogSegment, game: catalogSegment, id: catalogSegment, rest: catalogRelPath }),
  result: bytes(),
  revalidate: true,
});

export const CATALOG_ROUTES = {
  catalogIndex: catalogIndexRoute,
  catalogFile: catalogFileRoute,
} as const;

/** `GET` here for the whole catalogue. */
export const CATALOG_INDEX_PATH = catalogIndexRoute.path;

/** `GET` here for one file of a catalogue entry. */
export const catalogFilePath = (kind: string, game: string, id: string, rel: string): string => routePath(catalogFileRoute, { kind, game, id, rest: rel });

/** Where a weapon's model lives, which is the only file a client needs by name. */
export const weaponModelPath = (game: string, id: string): string => catalogFilePath("weapons", game, id, `${id}.glb`);

/**
 * The catalogue's sound: one alias table per game, and the clips it names.
 *
 * Not in `index.json`, for the reason props and attachments are not — nothing
 * enumerates them. But unlike a prop, which a world addresses by id, an alias
 * table has to be fetchable **whole**, because what a caller holds is a *name*
 * and a name resolves to a row. So the table is one file fetched on demand and
 * the clips are addressed one at a time, which is the same shape a world's own
 * `assets/sounds/` has.
 *
 * `mp` is which bank: a game keeps more than one and they do not hold the same
 * thing. This is IW5's `localized_common_mp.ff`; a campaign bank would be `sp`
 * beside it rather than merged into this one.
 */
const SOUND_KIND = "sounds";
const SOUND_BANK = "mp";

/** Where a game's catalogue alias table is. */
export const catalogSoundsPath = (game: string): string => catalogFilePath(SOUND_KIND, game, SOUND_BANK, "sounds.json");

/** Where one clip of it is. The table names a file with **no extension**; the export writes WebM. */
export const catalogSoundClipPath = (game: string, file: string): string => catalogFilePath(SOUND_KIND, game, SOUND_BANK, `clips/${file}.webm`);

/**
 * Where one file of a cast entry lives.
 *
 * A cast carries `{ kind, game, id, file }` rather than a URL, because
 * `@3d/shared/game/` decides *who* a player is and must not know how a client
 * fetches anything — it is tier one, with no DOM and no fetch. This is the one
 * place that pairing becomes a path, so the key an AssetStore holds and the URL
 * the route serves cannot be spelled two ways.
 */
export const castFilePath = (ref: { kind: string; game: string; id: string; file: string }): string => catalogFilePath(ref.kind, ref.game, ref.id, ref.file);
