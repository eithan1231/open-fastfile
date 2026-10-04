// Source text to a ResolvedWorld: the whole of it, once.
//
// This is the only caller of loadWorld() + resolveWorld(). It used to be written
// out in the browser (app/worldLoader.ts) and again on the server
// (worlds/load.ts), identical but for where the bytes came from; a game server
// that fetches its world would have been a third copy. Everything that differs
// is behind WorldSource, so a client's view of a world and a server's cannot
// disagree — which is the property the whole re-simulation model rests on.
//
// Collision is deliberately not part of this. It needs the world's .glb files,
// which are orders of magnitude larger and which only some callers want.

import { loadWorld } from "../dsl/loader.js";
import { resolveWorld } from "../dsl/resolve.js";
import type { Diagnostic } from "../dsl/diagnostics.js";
import type { ResolvedWorld } from "../dsl/resolved.js";
import type { WorldSource } from "./source.js";

export interface LoadedWorld {
  /**
   * What the resolver produced, which it can do *alongside* errors. Whether
   * errors are fatal is the caller's policy, not this function's: the browser
   * refuses to mount such a world, while `pnpm check` still reports on it.
   * Undefined only when the resolver gave up entirely.
   */
  world?: ResolvedWorld;
  diagnostics: Diagnostic[];
  /** Every `.world` source read, so diagnostics can be shown with their context. */
  sources: Record<string, string>;
  /** Set only when there was nothing to load at all. Not a diagnostic: a diagnostic points at a span in a file, and here there is no file. */
  error?: string;
}

/** Read and resolve one world. Never throws; a broken or absent world comes back in `error` or `diagnostics`. */
export async function loadResolvedWorld(source: WorldSource): Promise<LoadedWorld> {
  let entryPath: string;
  let sources: Record<string, string>;
  try {
    ({ entryPath, sources } = await source.payload());
  } catch (e) {
    return { sources: {}, diagnostics: [], error: e instanceof Error ? e.message : String(e) };
  }

  if (sources[entryPath] === undefined) {
    return { sources, diagnostics: [], error: `no ${entryPath} in ${source.describe}` };
  }

  const { statements, diagnostics: loadDiags } = loadWorld(entryPath, sources);

  const result = resolveWorld(statements);
  return { world: result.world, diagnostics: [...loadDiags, ...result.diagnostics], sources };
}
