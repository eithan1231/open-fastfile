// Worlds off disk, as the same WorldSource the browser gets over HTTP.
//
// This is the side of @3d/shared/worlds/source.js that needs a filesystem, which
// is why it lives here rather than there. It is the authority's own reader: the
// three HTTP routes serve through it, and `pnpm check` validates through it, so
// what the validator sees and what a client is sent come from one place.
//
// `asset()` is worth a second look. Its argument is a path out of the world's
// *own text* — an `asset`'s `source:`, say — which is neither a URL nor
// something a user typed, and is exactly the kind of input that gets trusted by
// accident. It goes through the same gate a request does, so a world file
// naming "../../etc/passwd" reads as a missing asset and is reported as one.

import type { WorldPayload } from "@3d/shared/protocol/routes/worlds.js";
import type { WorldSource } from "@3d/shared/worlds/source.js";
import { ENTRY_FILE, readWorldBytes, readWorldSources } from "./fs.js";
import { worldFile } from "./paths.js";

/**
 * One world, read from a directory the caller vouches for: a `worldDir(root,
 * slug)` result for a request, or a path typed at a shell for `pnpm check`,
 * which names a directory rather than a slug and need not sit under a worlds
 * root at all — which is also why a WorldSource is one world and not a
 * slug-keyed collection. Everything read *inside* it goes through `worldFile`.
 */
export function fsWorldDirSource(dir: string): WorldSource {
  return {
    describe: dir,

    async payload(): Promise<WorldPayload> {
      // worldFile answers undefined for a directory that is not there as well as
      // for one that is not a world. A caller naming a world that does not exist
      // is ordinary, not exceptional, so it comes back as a rejected promise the
      // loader turns into `error`.
      if ((await worldFile(dir, ENTRY_FILE)) === undefined) {
        throw new Error(`no world at ${dir}`);
      }
      return { entryPath: ENTRY_FILE, sources: await readWorldSources(dir) };
    },

    async asset(relPath: string): Promise<Uint8Array | undefined> {
      const file = await worldFile(dir, relPath);
      return file === undefined ? undefined : readWorldBytes(file);
    },
  };
}
