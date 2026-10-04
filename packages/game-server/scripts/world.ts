#!/usr/bin/env tsx
// Load one world the way a game server does and report what came back:
//
//   pnpm --filter @3d/game-server world dome-mw3
//
// Over HTTP from @3d/api, exactly as the real thing — so `pnpm dev:api` has to
// be running. That is the point: this exercises the path a deployed game server
// takes, rather than a disk read no game server ever does.
//
// Useful for telling "this map is broken" apart from "this map does not draw",
// which is the distinction docs/cod/pitfalls.md is mostly about. For a world on
// disk, with no api involved, `pnpm check worlds/<slug>` is the faster loop.

import "reflect-metadata";

import { container } from "tsyringe";
import { formatDiagnosticsAcrossFiles, hasErrors } from "@3d/shared/dsl/diagnostics.js";
import { loadResolvedWorld } from "@3d/shared/worlds/load.js";
import { config } from "../src/config.js";
import { Api } from "../src/api.js";
import { buildServerCollision } from "../src/collision.js";

const slug = process.argv[2];
if (!slug) {
  console.error("usage: pnpm --filter @3d/game-server world <slug>");
  process.exit(2);
}

const api = container.resolve(Api);
const source = api.worlds.world(slug);
const loaded = await loadResolvedWorld(source);

if (loaded.error !== undefined) {
  console.error(loaded.error);
  console.error(`\nIs the api running? This reads worlds from ${config.apiUrl} — start it with \`pnpm dev:api\`.`);
  process.exit(1);
}
if (loaded.diagnostics.length > 0) {
  console.log(formatDiagnosticsAcrossFiles(loaded.sources, loaded.diagnostics));
}
if (!loaded.world || hasErrors(loaded.diagnostics)) {
  process.exit(1);
}

const { world } = loaded;
console.log(`${slug}: ${world.topLevelObjects.length} object(s), ${world.lights.length} light(s)`);
console.log(`  spawn (${world.spawn.position.x.toFixed(1)}, ${world.spawn.position.y.toFixed(1)}, ${world.spawn.position.z.toFixed(1)})`);

const started = Date.now();
const collision = await buildServerCollision(world, source, (ref, rel) =>
  api.client.catalogFile({ kind: ref.kind, game: ref.game, id: ref.id, rest: rel }),
);
if (!collision) {
  console.log("  no authored collision mesh — no server collision for this world");
} else {
  console.log(`  collision BVH ${collision.triangles.toLocaleString()} triangles in ${Date.now() - started}ms`);
}
