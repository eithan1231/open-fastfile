// The shared asset catalogue, as handlers behind its declarations:
//
//   GET /api/catalog                         -> every entry, definitions included
//   GET /api/catalog/<kind>/<game>/<id>/<f>  -> one file of one entry
//
// Weapons are the first tenant, not the purpose: `kind` is a path segment so
// vehicles and characters move in here without a route each.
//
// As in routes/worlds.ts, the disk is reached only through src/worlds/ and never
// with a path of this file's own — ESLint keeps routes/ away from node:fs and
// node:path entirely, so a URL becomes a file in exactly one module.

import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { inject, singleton } from "tsyringe";
import { catalogFileRoute, catalogIndexRoute } from "@3d/shared/protocol/routes/catalog.js";
import { Catalog } from "../catalog.js";
import { Config } from "../config.js";
import { assetLastModified, assetStream } from "../worlds/fs.js";
import { assetMime, resolveCatalogFile } from "../worlds/paths.js";
import { Mount, type RouteGroup } from "./mount.js";

@singleton()
export class CatalogRoutes implements RouteGroup {
  private readonly worldsRoot: string;

  constructor(
    @inject(Mount) private readonly mount: Mount,
    @inject(Catalog) private readonly catalog: Catalog,
    @inject(Config) config: Config,
  ) {
    this.worldsRoot = config.worldsRoot;
  }

  register(app: Hono): void {
    // An empty catalogue rather than a 404 for a deployment that has not built
    // one: a game with no weapons is not a broken api, and both ends hash an
    // empty list to the same thing, so they still agree. `Catalog` answers that
    // way, and holds the registry a stored class is read against beside it.
    this.mount.route(app, catalogIndexRoute, () => this.catalog.index());

    this.mount.route(app, catalogFileRoute, async ({ params: { kind, game, id, rest }, c }) => {
      const file = await resolveCatalogFile(this.worldsRoot, kind, game, id, rest);
      if (file === undefined) {
        throw new HTTPException(404, { message: `no "${rest}" in catalog entry ${kind}/${game}/${id}` });
      }

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
