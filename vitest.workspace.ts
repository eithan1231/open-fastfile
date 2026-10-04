// One vitest run over the whole workspace: `pnpm test`, one reporter, one
// summary, `--project shared` to slice.
//
// The projects are inline objects rather than a "packages/*" glob on purpose. A
// glob makes vitest look for a config file in each matched directory and it
// would find packages/client/vite.config.ts, pulling the worlds plugin and the
// preact plugin into every test run. An inline project loads no config file at
// all, which is what the single root vitest.config.ts used to give us.
//
// JSX still compiles without the preact plugin because esbuild reads the
// nearest tsconfig.json to each file — for the client's tests that is
// packages/client/tsconfig.json, with jsxImportSource: "preact".
import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  { test: { name: "shared", root: "./packages/shared", include: ["tests/**/*.test.ts"] } },
  { test: { name: "api", root: "./packages/api", include: ["tests/**/*.test.ts"], setupFiles: ["../../vitest.setup.ts"] } },
  { test: { name: "game-server", root: "./packages/game-server", include: ["tests/**/*.test.ts"], setupFiles: ["../../vitest.setup.ts"] } },
  { test: { name: "client", root: "./packages/client", include: ["tests/**/*.test.{ts,tsx}"] } },
]);
