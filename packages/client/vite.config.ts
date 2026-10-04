import path from "node:path";
import preact from "@preact/preset-vite";
import { defineConfig, loadEnv } from "vite";
import { worldsWatcher } from "./vite/worldsWatcher.js";

// worlds/ and .env.local live at the repo root, not in this package.
const repoRoot = path.resolve(import.meta.dirname, "../..");

/**
 * Everything @3d/api owns. Proxied rather than served here, so the routes a
 * developer hits are the same code a deployed client hits — in production the api
 * serves this bundle itself, from one origin, which is also why there is no CORS
 * anywhere. The consequence: `pnpm dev` starts both processes, and `pnpm preview`
 * and `pnpm shots` need `pnpm dev:api` beside them.
 */
const apiProxy = (target: string) => ({
  "/worlds-manifest.json": { target },
  "/worlds": { target },
  "/api": { target },
});

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, repoRoot, "DEV_");
  const allowedHosts = env.DEV_ALLOWED_HOSTS?.split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  const proxy = apiProxy(env.DEV_API_URL || "http://localhost:9208");

  return {
    envDir: repoRoot,
    plugins: [preact(), worldsWatcher(path.join(repoRoot, "worlds"))],
    server: {
      host: env.DEV_HOST || "localhost",
      port: 5173,
      ...(allowedHosts?.length ? { allowedHosts } : {}),
      proxy,
      watch: { ignored: ["**/.cache/**", "**/.work/**"] },
    },
    preview: { proxy },
  };
});
