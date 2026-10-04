// Fetching a world from @3d/api and running the DSL pipeline over it.
//
// The pipeline itself is @3d/shared/worlds/load.js, shared with the server. What
// is left here is the browser's policy on top of it: refuse to mount a world
// that resolved with errors (the error screen shows the diagnostics), and tell a
// failed fetch apart from a world that loaded and is broken.

import { hasErrors, type Diagnostic } from "@3d/shared/dsl/diagnostics.js";
import type { ResolvedWorld } from "@3d/shared/dsl/resolved.js";
import type { WorldManifestEntry } from "@3d/shared/protocol/routes/worlds.js";
import { worldBasePath } from "@3d/shared/protocol/routes/worlds.js";
import { httpWorldSource } from "@3d/shared/worlds/source.js";
import { loadResolvedWorld } from "@3d/shared/worlds/load.js";

export type LoadResult =
  | { ok: true; world: ResolvedWorld; sources: Record<string, string>; diagnostics: Diagnostic[] }
  | { ok: false; sources: Record<string, string>; diagnostics: Diagnostic[] }
  | { ok: false; fetchError: string };

/** The URL prefix a world's asset paths are relative to. */
export const worldBaseUrl = worldBasePath;

// Same-origin: in dev Vite proxies these to @3d/api, and in production the api
// serves this page itself.
const worlds = httpWorldSource({ fetch: (url, init) => fetch(url, init) });

export function fetchManifest(): Promise<WorldManifestEntry[]> {
  return worlds.manifest();
}

export async function loadWorldFromServer(slug: string): Promise<LoadResult> {
  const { world, sources, diagnostics, error } = await loadResolvedWorld(worlds.world(slug));

  if (error !== undefined) {
    return { ok: false, fetchError: error };
  }
  if (!world || hasErrors(diagnostics)) {
    return { ok: false, sources, diagnostics };
  }
  return { ok: true, world, sources, diagnostics };
}
