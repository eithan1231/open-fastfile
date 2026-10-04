// The three world routes, as handlers behind their declarations:
//
//   GET /worlds-manifest.json       -> WorldManifestEntry[]
//   GET /worlds/<slug>.json         -> WorldPayload (every .world source)
//   GET /worlds/<slug>/<relPath>    -> the file
//
// One implementation, for both the browser and a game server, and in dev as well
// as in production: Vite proxies these rather than serving its own copy, so what
// a developer sees and what a deployed client sees are literally the same code
// rather than two implementations kept in step.
//
// The paths, the shapes and the guards on `:slug` and the remainder are
// @3d/shared/protocol/routes/worlds.js. What is left here is the disk — reached
// only through src/worlds/, never with a path of this file's own. Nothing in
// routes/ imports node:fs or node:path, and ESLint keeps it that way: a slug and
// a URL remainder become a file in exactly one place (src/worlds/paths.ts), and
// a handler's only move is to ask it.

import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { inject, singleton } from "tsyringe";
import { worldAssetRoute, worldManifestRoute, worldPayloadRoute, type WorldPayload } from "@3d/shared/protocol/routes/worlds.js";
import { Config } from "../config.js";
import { assetLastModified, assetStream, ENTRY_FILE, readWorldSources } from "../worlds/fs.js";
import { ManifestCache } from "../worlds/manifestCache.js";
import { assetMime, resolveWorldAsset, worldDir, worldFile } from "../worlds/paths.js";
import { Mount, type RouteGroup } from "./mount.js";

@singleton()
export class WorldRoutes implements RouteGroup {
  private readonly worldsRoot: string;

  constructor(
    @inject(Mount) private readonly mount: Mount,
    @inject(Config) config: Config,
    @inject(ManifestCache) private readonly manifest: ManifestCache,
  ) {
    this.worldsRoot = config.worldsRoot;
  }

  register(app: Hono): void {
    this.mount.route(app, worldManifestRoute, () => this.manifest.get());

    this.mount.route(app, worldPayloadRoute, async ({ params: { slug } }): Promise<WorldPayload> => {
      const dir = await worldDir(this.worldsRoot, slug);
      if (dir === undefined || (await worldFile(dir, ENTRY_FILE)) === undefined) {
        throw new HTTPException(404, { message: `no world "${slug}"` });
      }
      return { entryPath: ENTRY_FILE, sources: await readWorldSources(dir) };
    });

    this.mount.route(app, worldAssetRoute, async ({ params: { slug, rest }, c }) => {
      const file = await resolveWorldAsset(this.worldsRoot, slug, rest);
      if (file === undefined) {
        throw new HTTPException(404, { message: `no asset "${rest}" in world "${slug}"` });
      }

      // Revalidate every time, but let an unchanged file answer 304. A re-exported
      // asset must never come from a stale cache; equally, a hot reload that
      // re-downloaded every texture in full would move ~100 MB for an imported map.
      const lastModified = await assetLastModified(file);
      c.header("Cache-Control", "no-cache");
      c.header("Last-Modified", lastModified);
      if (c.req.header("If-Modified-Since") === lastModified) {
        return c.body(null, 304);
      }

      c.header("Content-Type", assetMime(file));
      return c.body(assetStream(file));
    });
  }
}
