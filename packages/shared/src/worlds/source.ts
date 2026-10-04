// Where a world's bytes come from, as the one thing the loader needs to know.
//
// There are three places a world gets read: the browser fetches it from the api,
// a game server fetches it from the api, and the api (and `pnpm check`) read it
// off disk. Before this interface existed the pipeline around those reads was
// written out twice and about to be written a third time. Now there is one
// loader (./load.ts) over this interface, and the only thing that differs
// between the three is which implementation it is handed.
//
// A WorldSource is *one world*, not a slug-keyed collection, because
// `pnpm check worlds/whatever` names an arbitrary directory that need not live
// under a worlds root at all.

import type { WorldManifestEntry, WorldPayload } from "../protocol/routes/worlds.js";
import { WORLD_ROUTES, worldPayloadPath } from "../protocol/routes/worlds.js";
import { createRouteClient, type RouteClientOptions } from "../protocol/route.js";
import { HttpError } from "../protocol/http.js";

export interface WorldSource {
  /** Where this world is, for a diagnostic a human has to act on: a URL or a directory. */
  readonly describe: string;
  payload(): Promise<WorldPayload>;
  /** One file from the world's folder. Undefined when it is not there, which is not always an error. */
  asset(relPath: string): Promise<Uint8Array | undefined>;
}

export type HttpWorldSourceOptions = RouteClientOptions;

export interface HttpWorldSource {
  manifest(): Promise<WorldManifestEntry[]>;
  world(slug: string): WorldSource;
}

/**
 * Worlds over the three world routes. Isomorphic: the browser and a game server
 * both use this, and neither spells a URL or a header — the declarations
 * (protocol/routes/worlds.ts) carry the paths and the revalidation both of them
 * need, since a re-exported asset must never come from a stale cache.
 */
export function httpWorldSource(options: HttpWorldSourceOptions): HttpWorldSource {
  const client = createRouteClient(WORLD_ROUTES, options);
  const baseUrl = options.baseUrl ?? "";

  return {
    manifest: () => client.worldManifest(),

    world(slug: string): WorldSource {
      return {
        describe: baseUrl + worldPayloadPath(slug),

        payload: () => client.worldPayload({ slug }),

        async asset(relPath: string): Promise<Uint8Array | undefined> {
          try {
            return await client.worldAsset({ slug, rest: relPath });
          } catch (e) {
            // A world naming an asset it does not have is ordinary — a prop
            // hull that is absent, a texture a material falls back from.
            // Anything that is not an answer from the api still throws.
            if (e instanceof HttpError) {
              return undefined;
            }
            throw e;
          }
        },
      };
    },
  };
}
