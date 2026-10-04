// Node-only filesystem primitives for a world's folder: what makes a directory a
// world, what counts as one of its sources, and how one of its files is read or
// streamed. The api's routes read through these (src/worlds/source.ts), and so
// does `pnpm check`.
//
// Everything here is async, because all of it sits on a request path: the api is
// one process serving every world's text and every one of an imported map's
// assets, and a synchronous read there is the whole event loop waiting on a
// disk. `createReadStream` is the exception that proves it — a stream is already
// the asynchronous form, and it is what keeps a 40 MB .glb off the heap.
//
// Kept out of @3d/shared, which must run in a browser too.

import { createReadStream } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { catalogIndexFile, isSafeSlug, worldDir, worldFile } from "./paths.js";

/** The only folder of a world that is served and shipped. Everything a world loads at runtime lives here. */
export const ASSETS_DIR = "assets";

/** The file a world starts at. Its presence is what makes a folder a world. */
export const ENTRY_FILE = "world.world";

/** `_`- and `.`-prefixed folders hold an author's notes or tool scratch space, never part of the world. */
function isPrivateDir(name: string): boolean {
  return name.startsWith("_") || name.startsWith(".");
}

/**
 * The worlds under a root, by slug.
 *
 * Filtered through the same slug rule the routes enforce, so the menu lists only
 * worlds whose URLs the contract can actually name — a folder this rule refuses
 * would otherwise be advertised and then 404.
 */
export async function listWorldFolders(worldsRoot: string): Promise<string[]> {
  // A worlds root that is not there yet is empty, not an error: a fresh volume
  // is the ordinary first state of a deployment.
  const entries = await fsp.readdir(worldsRoot, { withFileTypes: true }).catch(() => []);

  const candidates = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter(isSafeSlug);

  const worlds = await Promise.all(candidates.map(async (slug) => ((await worldEntry(worldsRoot, slug)) === undefined ? undefined : slug)));

  return worlds.filter((slug) => slug !== undefined).sort();
}

/** A world's entry file, if the folder is a world at all. The one answer to "is there a world here". */
export async function worldEntry(worldsRoot: string, slug: string): Promise<string | undefined> {
  const dir = await worldDir(worldsRoot, slug);
  return dir === undefined ? undefined : worldFile(dir, ENTRY_FILE);
}

/**
 * Every `.world` file under one world's folder, as `{ relativePath: contents }`
 * with POSIX separators.
 *
 * Symlinks are skipped rather than followed: a world is the files in its own
 * folder, and following one is how a walk of a directory ends up reading
 * something outside it.
 */
export async function readWorldSources(worldDirectory: string): Promise<Record<string, string>> {
  const sources: Record<string, string> = {};

  const walk = async (dir: string, rel: string): Promise<void> => {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    await Promise.all(
      entries.map(async (entry) => {
        const full = path.join(dir, entry.name);
        const relPath = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) {
          return;
        }
        if (entry.isDirectory()) {
          if (!isPrivateDir(entry.name)) {
            await walk(full, relPath);
          }
        } else if (entry.name.endsWith(".world")) {
          sources[relPath] = await fsp.readFile(full, "utf8");
        }
      }),
    );
  };

  await walk(worldDirectory, "");

  return sources;
}

/** One of a world's text files — its entry, for the manifest's header peek. */
export const readWorldText = (file: string): Promise<string> => fsp.readFile(file, "utf8");

/** One of a world's files, whole. For a caller that wants the bytes rather than a stream. */
export const readWorldBytes = async (file: string): Promise<Uint8Array> => new Uint8Array(await fsp.readFile(file));

/** An asset's mtime as an HTTP date, for the revalidation the asset route answers 304 from. */
export const assetLastModified = async (file: string): Promise<string> => (await fsp.stat(file)).mtime.toUTCString();

/**
 * An asset as a stream, not a buffer: a map's collision.glb and its textures run
 * to tens of megabytes each, which is also why hono's etag middleware (which
 * buffers) is the wrong tool on that route.
 */
export const assetStream = (file: string): ReadableStream => Readable.toWeb(createReadStream(file)) as ReadableStream;

/**
 * The catalogue as it sits on disk. The contents are each kind's registry's
 * business, not this file's.
 *
 * One array per kind, and every kind but `weapons` optional: a catalogue built
 * before a kind existed simply has no key for it, which a reader takes as "this
 * deployment has none" and degrades on — peers drawn as capsules rather than a
 * refused catalogue. `weapons` is required because every reader of this file
 * needs it, and because an absent one means the file is not a catalogue at all.
 */
export interface CatalogIndex {
  version: number;
  weapons: unknown[];
  characters?: unknown[];
  viewhands?: unknown[];
  animations?: unknown[];
  actors?: unknown[];
}

/** The optional kinds, so reading them is one loop rather than five near-identical lines. */
const OPTIONAL_KINDS = ["characters", "viewhands", "animations", "actors"] as const;

/**
 * The catalogue index, or undefined when none has been built.
 *
 * Read from disk on every request rather than cached: it changes only when the
 * exporter runs, it is one small file, and a stale catalogue is the one thing
 * `catalogHash` exists to make loud — caching it here would be caching the
 * mismatch too.
 */
export async function readCatalogIndex(worldsRoot: string): Promise<CatalogIndex | undefined> {
  const file = await catalogIndexFile(worldsRoot);
  if (file === undefined) {
    return undefined;
  }
  try {
    const body: unknown = JSON.parse(await fsp.readFile(file, "utf8"));
    if (typeof body !== "object" || body === null) {
      throw new Error("not an object");
    }
    const found = body as Partial<CatalogIndex>;
    const { version, weapons } = found;
    if (typeof version !== "number" || !Array.isArray(weapons)) {
      throw new Error("no version or weapons");
    }
    // Copied key by key rather than spread: a kind this build does not know
    // about has no reader, so carrying it would be carrying bytes nothing can
    // use. A kind it does know but the catalogue lacks stays undefined.
    const index: CatalogIndex = { version, weapons };
    for (const kind of OPTIONAL_KINDS) {
      const entries = found[kind];
      if (Array.isArray(entries)) {
        index[kind] = entries;
      }
    }
    return index;
  } catch (error) {
    // A catalogue that will not parse is a build problem, not a request problem:
    // answering with none lets the api keep serving worlds, and both ends then
    // agree on an empty catalogue rather than disagreeing about a broken one.
    console.warn(`the catalogue at ${file} is unreadable (${String(error)}); serving none`);
    return undefined;
  }
}
