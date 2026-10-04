// The world list the menu shows, built by reading each world's header with the
// real parser so the menu cannot disagree with the world.
//
// Shared by the Vite dev plugin and the server's HTTP routes: the two transports
// of the same data. Building it parses 52 entry files, so both callers cache it
// and drop the cache when something under worlds/ changes.

import type { WorldManifestEntry } from "@3d/shared/protocol/routes/worlds.js";
import { parseWorldFile } from "@3d/shared/dsl/parser.js";
import { isObjectNode, isPropertyNode, type ObjectNode } from "@3d/shared/dsl/ast.js";
import { ENTRY_FILE, listWorldFolders, readWorldText } from "./fs.js";
import { worldDir, worldFile } from "./paths.js";

const WORLD_URL_PREFIX = "/worlds/";

/**
 * The `world { name, description, category }` header, read with the real
 * parser so the menu cannot disagree with the world. Diagnostics are ignored:
 * a broken world is still listed, so it can be picked and its errors seen.
 */
export function peekWorldHeader(source: string, path: string): { name?: string; description?: string; category?: string } {
  const { ast } = parseWorldFile(source, path);
  const worldNode = ast.statements.find((s): s is ObjectNode => isObjectNode(s) && s.type === "world");
  if (!worldNode) {
    return {};
  }

  const stringProp = (key: string): string | undefined => {
    let found: string | undefined;

    for (const stmt of worldNode.body) {
      if (!isPropertyNode(stmt) || stmt.key !== key) {
        continue;
      }

      const value = stmt.values[0];
      if (value?.kind === "string") {
        found = value.value;
      } // last one wins, matching resolve.ts's findProp
    }

    return found;
  };

  return {
    name: stringProp("name"),
    description: stringProp("description"),
    category: stringProp("category"),
  };
}

/** Thumbnail candidates, best first: the game's loading-screen photo reads far better than a top-down minimap. */
const THUMBNAILS = ["assets/loadscreen.jpg", "assets/minimap.png"];

export async function buildManifest(worldsDir: string): Promise<WorldManifestEntry[]> {
  const slugs = await listWorldFolders(worldsDir);

  // In parallel: 52 worlds, each an entry file to read and two thumbnails to
  // look for. One at a time this is 52 round trips to the disk on a cold cache,
  // and the whole point of the TTL below it is that nobody waits for that.
  const entries = await Promise.all(
    slugs.map(async (slug): Promise<WorldManifestEntry | undefined> => {
      // Through the same gate a request goes through, even though these slugs
      // came off disk rather than out of a URL: one way to turn a slug into a
      // directory in this package rather than two.
      const dir = await worldDir(worldsDir, slug);
      const entry = dir === undefined ? undefined : await worldFile(dir, ENTRY_FILE);
      if (dir === undefined || entry === undefined) {
        return undefined;
      }

      const { name, description, category } = peekWorldHeader(await readWorldText(entry), `${slug}/${ENTRY_FILE}`);

      const found = await Promise.all(THUMBNAILS.map((rel) => worldFile(dir, rel)));
      const thumb = THUMBNAILS[found.findIndex((file) => file !== undefined)];

      return {
        slug,
        name: name ?? slug,
        description,
        category,
        thumbnail: thumb && `${WORLD_URL_PREFIX}${encodeURIComponent(slug)}/${thumb}`,
      };
    }),
  );

  return entries.filter((entry) => entry !== undefined);
}
