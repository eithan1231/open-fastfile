// Watching worlds/ so an edit reloads in the browser.
//
// Serving worlds is @3d/api's job, and in dev Vite proxies to it (see
// vite.config.ts) rather than keeping its own copy of those routes — so what a
// developer sees and what a deployed client sees are the same code rather than
// two implementations kept in step. What is left for a plugin to do is notice a
// change and say so: the client reloads the world and invalidates the one asset
// that changed (src/app/App.ts).

import path from "node:path";
import type { Plugin, ViteDevServer } from "vite";

/** Also decides which file edits count as an asset change worth reloading for. */
const ASSET_EXTENSIONS = new Set([
  ".png",
  // GLTFLoader ignores the type, but without these a re-exported .glb triggers no reload.
  ".glb",
  ".gltf",
  ".bin",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
]);

/**
 * The catalogue kinds a dev server watches.
 *
 * `props` is deliberately absent: it is the one kind big enough to exhaust the
 * watch budget on its own, and nothing edits a prop by hand.
 */
const CATALOG_KINDS_WATCHED = ["characters", "viewhands", "animations", "worldweapons", "weapons", "attachments", "overlays"];

export function worldsWatcher(worldsDir: string): Plugin {
  return {
    name: "worlds-watcher",
    apply: "serve",

    configureServer(server: ViteDevServer) {
      // Only the sources and the served assets. Adding whole world folders would
      // also pick up exporter scratch space (tens of thousands of files, which
      // exhausts inotify watches).
      //
      // The catalogue is watched by kind, for that same reason and not as caution:
      // `catalog/props/` alone holds over 7,000 entries. The cast is small and is
      // what somebody re-harvests while a client is open, so those kinds are
      // watched and props are not — re-run a props harvest and reload the page.
      server.watcher.add([
        path.join(worldsDir, "*", "*.world"),
        path.join(worldsDir, "*", "assets", "**"),
        ...CATALOG_KINDS_WATCHED.map((kind) => path.join(worldsDir, "catalog", kind, "**")),
      ]);

      server.watcher.on("all", (_event, changedPath) => {
        if (!changedPath.startsWith(worldsDir)) {
          return;
        }
        const isWorld = changedPath.endsWith(".world");
        const isAsset = ASSET_EXTENSIONS.has(path.extname(changedPath).toLowerCase());
        if (!isWorld && !isAsset) {
          return;
        }
        server.ws.send({ type: "custom", event: "world-source-changed", data: { path: path.relative(worldsDir, changedPath) } });
      });
    },
  };
}
