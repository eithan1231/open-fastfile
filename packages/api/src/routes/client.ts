// Serving the built client.
//
// This is the last group app.ts registers, so it can never shadow a route above
// it: every unclaimed path falls through to index.html, which is what makes a
// pose link (/#slug@x,y,z,...) load.

import fs from "node:fs";
import { serveStatic } from "@hono/node-server/serve-static";
import type { Hono } from "hono";
import { inject, singleton } from "tsyringe";
import { Config } from "../config.js";
import type { RouteGroup } from "./mount.js";

// Vite fingerprints everything under assets/, so those are immutable; the entry
// document must never be, or a deploy is invisible until a hard reload.
const IMMUTABLE = "public, max-age=31536000, immutable";
const NO_CACHE = "no-cache";

@singleton()
export class ClientRoutes implements RouteGroup {
  private readonly dist: string | undefined;

  constructor(@inject(Config) config: Config) {
    this.dist = config.clientDist;
  }

  /** Nothing at all in dev, where Vite serves the client and proxies the routes here. */
  register(app: Hono): void {
    const root = this.dist;
    if (root === undefined || !fs.existsSync(root)) {
      return;
    }

    // serveStatic's `root` is resolved against the working directory, which for
    // `pnpm --filter @3d/api start` is packages/api — which is why
    // Config.clientDist is absolute. It also rejects a path that climbs out of
    // root, so a miss there is just a miss, and the fallback answers it.
    app.get(
      "/*",
      // Prepared here rather than in serveStatic's onFound, which runs after the
      // body is built and so is too late for a header to land.
      async (c, next) => {
        const document = c.req.path === "/" || c.req.path === "/index.html";
        c.header("Cache-Control", document ? NO_CACHE : IMMUTABLE);
        await next();
      },
      serveStatic({ root }),
      // No such file, so this is a route the client owns: hand it the app, under
      // the document's policy rather than the one prepared above.
      async (c, next) => {
        c.header("Cache-Control", NO_CACHE);
        await next();
      },
      serveStatic({ root, path: "index.html" }),
    );
  }
}
