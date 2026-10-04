// Turning a URL's parts into a path inside worlds/, or refusing to.
//
// This is the only module in @3d/api that joins a piece of a request to a path
// on disk, and that is the whole of the directory-traversal surface. It is one
// module rather than a guard at each handler because a guard at each handler is
// a guard somebody adds a fourth route without: ESLint keeps the rest of the
// package away from `node:fs` and `node:path` entirely (eslint.config.js), so
// there is nowhere else a path can be built.
//
// Two checks, because neither catches what the other does:
//
//   1. the contract's own schemas (@3d/shared/protocol/routes/worlds.ts), which
//      say what a slug and an asset path *are* rather than what they may not be;
//   2. the *real* path — symlinks resolved — must still be inside the directory
//      it was built from. That is what a future clever rewrite of (1) would
//      otherwise break, and the only thing that catches a symlink planted inside
//      a world pointing at /etc.
//
// Extracted so the refusals can be tested directly, which is the only way they
// can be: a request for "/worlds/x/../../../etc/passwd" never reaches a route,
// because WHATWG URL parsing collapses the dot segments before any router sees
// it, and what arrives is a plain "/etc/passwd" that simply 404s. A route test
// therefore passes whether the guard works or not. The encoded form (%2e%2e) is
// the one that does reach the handler, and it has its own test.

import fsp from "node:fs/promises";
import path from "node:path";
import { worldAssetRelPath, worldSlug } from "@3d/shared/protocol/routes/worlds.js";

/**
 * A world slug is one directory name — never a path, never a dot segment. The
 * rule itself is the contract's (`worldSlug`), because the client builds these
 * URLs and the route refuses them; this is the filesystem's own reading of it,
 * for the callers below that splice a slug straight into a path.
 */
export function isSafeSlug(slug: string): boolean {
  return worldSlug.safeParse(slug).success;
}

/** The same, for the remainder of an asset URL. Also the contract's rule (`worldAssetRelPath`). */
export function isSafeAssetPath(relPath: string): boolean {
  return worldAssetRelPath.safeParse(relPath).success;
}

/**
 * `<worldsRoot>/<slug>`, as a directory that exists, or undefined.
 *
 * The slug is checked because it is spliced into a path — without that,
 * "/worlds/../src/main.ts" resolves outside worlds/ entirely.
 */
export async function worldDir(worldsRoot: string, slug: string): Promise<string | undefined> {
  if (!isSafeSlug(slug)) {
    return undefined;
  }

  const root = path.resolve(worldsRoot);
  const dir = path.join(root, slug);
  if (!within(root, dir)) {
    return undefined;
  }

  // Resolved through symlinks *after* the containment check on the spelled path.
  // A world folder that is a symlink to storage elsewhere is the operator's own
  // layout and stays allowed — no request can create one — and its real path is
  // what every file inside the world is then measured against.
  const real = await realpath(dir);
  return real !== undefined && (await kindOf(real)) === "dir" ? real : undefined;
}

/**
 * One file inside a world, or undefined — for a path that is not one, for one
 * that leaves the world, or for a file that is not there.
 *
 * `dir` is a directory the caller already vouches for: a `worldDir` result for a
 * request, or a path typed at a shell for `pnpm check`. What this proves is the
 * other half — that `relPath` names something inside it.
 */
export async function worldFile(dir: string, relPath: string): Promise<string | undefined> {
  if (!isSafeAssetPath(relPath)) {
    return undefined;
  }

  const base = path.resolve(dir);
  const file = path.join(base, relPath);
  if (!within(base, file)) {
    return undefined;
  }

  const real = await realWithin(base, file);
  return real !== undefined && (await kindOf(real)) === "file" ? real : undefined;
}

/**
 * The catalogue's root, `<worldsRoot>/catalog`. It sits beside the worlds rather
 * than inside one because it belongs to none of them; `listWorldFolders` calls a
 * folder a world only if it holds a `world.world`, so it never appears in the
 * menu.
 */
export const CATALOG_DIR = "catalog";

/**
 * `<worldsRoot>/catalog/<kind>/<game>/<id>/<relPath>`, or undefined.
 *
 * Four pieces of a URL become a path here, so all four go through the contract's
 * own allowlist first and the whole result is then proved to be inside the
 * catalogue — the same two independent checks `worldFile` makes, for the same
 * reason: a clever rewrite of one must not silently disable the other.
 */
export async function resolveCatalogFile(worldsRoot: string, kind: string, game: string, id: string, relPath: string): Promise<string | undefined> {
  const root = path.resolve(worldsRoot, CATALOG_DIR);
  // Joined as one relative path so a single guard covers every segment: each is
  // checked by the route's schema, and `worldFile` checks them again here.
  return worldFile(root, [kind, game, id, relPath].join("/"));
}

/** `<worldsRoot>/catalog/index.json`, or undefined when no catalogue has been built. */
export async function catalogIndexFile(worldsRoot: string): Promise<string | undefined> {
  return worldFile(path.resolve(worldsRoot, CATALOG_DIR), "index.json");
}

/** `<worldsRoot>/<slug>/<relPath>`: both halves through their own guard, in one call. */
export async function resolveWorldAsset(worldsRoot: string, slug: string, relPath: string): Promise<string | undefined> {
  const dir = await worldDir(worldsRoot, slug);
  return dir === undefined ? undefined : worldFile(dir, relPath);
}

/** Check 1's filesystem half: `candidate` resolves to `base` itself or to something under it. */
function within(base: string, candidate: string): boolean {
  const resolved = path.resolve(candidate);
  return resolved === base || resolved.startsWith(base + path.sep);
}

/**
 * Check 2, and the value that is finally opened. Both sides are resolved through
 * their symlinks before being compared, so what is served is the same path that
 * was proved — not a path that merely spells one.
 *
 * Undefined when either side does not exist, which is why callers get their
 * "not there" answer from here rather than stat'ing again afterwards.
 */
async function realWithin(base: string, candidate: string): Promise<string | undefined> {
  const [realBase, real] = await Promise.all([realpath(base), realpath(candidate)]);
  if (realBase === undefined || real === undefined) {
    return undefined;
  }
  return real === realBase || real.startsWith(realBase + path.sep) ? real : undefined;
}

/** Undefined rather than a throw: a path that is not there is an ordinary answer here, not an exception. */
async function realpath(file: string): Promise<string | undefined> {
  try {
    return await fsp.realpath(file);
  } catch {
    return undefined;
  }
}

async function kindOf(file: string): Promise<"dir" | "file" | undefined> {
  try {
    const stat = await fsp.stat(file);
    return stat.isDirectory() ? "dir" : stat.isFile() ? "file" : undefined;
  } catch {
    return undefined;
  }
}

/** Content types for world assets. */
export const ASSET_MIME: Record<string, string> = {
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".bin": "application/octet-stream",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".json": "application/json",
  // The only WebM either a world or the catalogue holds is a sound clip: mono
  // Opus, written by scripts/cod/sound.py and decoded by `AssetStore.audio`.
  ".webm": "audio/webm",
};

export const assetMime = (file: string): string => ASSET_MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
