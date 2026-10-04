// A world as it travels: the menu list, a world's sources, and one file out of
// its folder.
//
// These three are the oldest contract in the repo and the reason the route layer
// exists. Before it, the client hardcoded the manifest path, built the payload
// path with a template, built the asset prefix a third way, and app/App.ts built
// a fourth copy of that prefix to key the AssetStore with.
//
// That fourth copy is the trap worth keeping in mind while editing this file. A
// hot reload invalidates exactly one asset by its URL (see "Assets belong to a
// world" in CLAUDE.md), so the key App.ts builds must be byte-identical to the
// one scene/ loaded with. Encode a slug in one and not the other and
// invalidation silently stops working — for nobody today, because every slug is
// [a-z0-9.-], which is precisely why it would go unnoticed. Both sides now spell
// these URLs with the builders at the bottom of this file, over one route
// declaration, so the question cannot come up.

import * as z from "zod/mini";
import { bytes, defineRoute, json, routePath } from "../route.js";

/** One entry in the manifest — what the main menu lists. */
export const worldManifestEntry = z.object({
  slug: z.string().check(z.minLength(1)),
  /** The world's declared `name:`, falling back to the folder slug. */
  name: z.string(),
  description: z.optional(z.string()),
  /** The world's declared `category:`, used to group the picker list. */
  category: z.optional(z.string()),
  /** URL of the menu thumbnail (an imported map's loading screen, else its minimap), if the world has one. */
  thumbnail: z.optional(z.string()),
});
export type WorldManifestEntry = z.infer<typeof worldManifestEntry>;

/** Everything needed to run the DSL pipeline over a world, wherever it is run. */
export interface WorldPayload {
  /** Entry file to hand to loadWorld, as a key into `sources`. */
  entryPath: string;
  /** Every `.world` file in the world's folder, keyed by POSIX-relative path. */
  sources: Record<string, string>;
}

/**
 * A shape check rather than a schema over the contents, and deliberately so:
 * `sources` is every `.world` file in the world, which for an imported Call of
 * Duty map is megabytes of strings. Validating them property-by-property on the
 * main thread, on every load and every hot reload, would cost more than parsing
 * them does. The DSL is the real validator; this only rejects a reply that is not
 * the right kind of object at all.
 */
function isWorldPayload(value: unknown): value is WorldPayload {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const { entryPath, sources } = value as Partial<WorldPayload>;
  return typeof entryPath === "string" && typeof sources === "object" && sources !== null;
}

export const worldPayload = z.custom<WorldPayload>(isWorldPayload, { error: "not a WorldPayload" });

// Both of these say what a name *is* rather than listing what it may not be.
// That direction is the point: a refusal list has to enumerate every escape —
// "..", "\\", a NUL, a percent-encoding that survives one decode, a unicode
// lookalike — and is wrong the first time one is missed. An allowlist is wrong
// only by being too strict, which shows up as a 404 on a file somebody can
// rename. Every slug and every asset path in the repo is already inside these.

/** One path segment of a world: no separator, no dot segment, no dotfile, nothing that is not a name. */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._ -]*$/;

/**
 * A world slug is one directory name: never a path, never a dot segment. The
 * authority splices it straight into a filesystem path, so the rule is part of
 * the contract rather than one server's private caution — @3d/api's
 * src/worlds/paths.ts enforces this same schema and then proves it again against
 * the resolved path.
 */
export const worldSlug = z.string().check(
  z.maxLength(64),
  z.refine((slug) => SEGMENT.test(slug), { error: "not a world slug" }),
);

/**
 * A path inside one world's folder. Relative, and with no way out of it: every
 * segment is a name by the rule above, so "..", a leading "/", a trailing one,
 * an empty segment and a dotfile are all simply not paths.
 */
export const worldAssetRelPath = z.string().check(
  z.maxLength(512),
  z.refine((rel) => rel.length > 0 && rel.split("/").every((seg) => SEGMENT.test(seg)), { error: "not a path inside a world" }),
);

export const worldManifestRoute = defineRoute({
  method: "GET",
  path: "/worlds-manifest.json",
  auth: "public",
  result: json(z.array(worldManifestEntry)),
  revalidate: true,
});

export const worldPayloadRoute = defineRoute({
  method: "GET",
  path: "/worlds/:slug.json",
  auth: "public",
  params: z.object({ slug: worldSlug }),
  result: json(worldPayload),
  revalidate: true,
});

/**
 * One file out of a world's folder, as bytes: a texture, a `.glb`, a lightmap
 * PNG. `revalidate` is not optional here — a re-exported asset must never come
 * from a stale cache, and the api answers 304 for one that has not changed so a
 * hot reload does not move ~100 MB of textures again.
 */
export const worldAssetRoute = defineRoute({
  method: "GET",
  path: "/worlds/:slug/*",
  auth: "public",
  params: z.object({ slug: worldSlug, rest: worldAssetRelPath }),
  result: bytes(),
  revalidate: true,
});

export const WORLD_ROUTES = {
  worldManifest: worldManifestRoute,
  worldPayload: worldPayloadRoute,
  worldAsset: worldAssetRoute,
} as const;

// The builders. One line each over the declarations above, because these three
// URLs are spelled all over the client and `routePath(worldAssetRoute, { slug,
// rest })` at every one of them would read worse than the name does.

/** `GET` here for `WorldManifestEntry[]`. */
export const WORLDS_MANIFEST_PATH = worldManifestRoute.path;

/** `GET` here for a world's `WorldPayload`. */
export const worldPayloadPath = (slug: string): string => routePath(worldPayloadRoute, { slug });

/** The prefix a world's asset paths are relative to. Keeps its trailing slash: callers concatenate onto it. */
export const worldBasePath = (slug: string): string => routePath(worldAssetRoute, { slug, rest: "" });

/** `GET` here for one file out of a world's `assets/`. */
export const worldAssetPath = (slug: string, relPath: string): string => routePath(worldAssetRoute, { slug, rest: relPath });
