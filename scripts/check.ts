#!/usr/bin/env tsx
// Headless world validator: `pnpm check [path]`.
//
// The same pipeline the browser runs, printing diagnostics exactly as the
// in-browser error screen shows them. The fast loop for authoring a world.
//
// Usage:
//   pnpm check                  # validate every world under worlds/
//   pnpm check worlds/my-world  # validate just one

import { readFile } from "node:fs/promises";
import path from "node:path";
import { listWorldFolders } from "@3d/api/worlds/fs.js";
import { resolveCatalogFile, worldFile } from "@3d/api/worlds/paths.js";
import { fsWorldDirSource } from "@3d/api/worlds/source.js";
import { loadResolvedWorld } from "@3d/shared/worlds/load.js";
import type { ResolvedWorld } from "@3d/shared/dsl/resolved.js";
import { formatDiagnosticsAcrossFiles, hasErrors } from "@3d/shared/dsl/diagnostics.js";
import { decodeNav, NavFormatError } from "@3d/shared/nav/format.js";
import { HEADER_FLAGS } from "@3d/shared/nav/vocab.js";

// Relative to the repo, not the caller: `pnpm check` may run from anywhere in
// the workspace. The *argument*, though, stays cwd-relative — that is what a
// shell-completed path means.
const WORLDS_ROOT = path.resolve(import.meta.dirname, "..", "worlds");

// A path typed at a shell is the operator's own and answers to no worlds root:
// `pnpm check ../elsewhere/my-world` is a supported thing to do. Everything
// *inside* the world is still resolved through the same guard the server uses,
// which is what `missing` below is.
async function resolveTargets(arg: string | undefined): Promise<{ name: string; dir: string }[]> {
  if (arg) {
    const dir = path.resolve(process.cwd(), arg);
    return [{ name: path.basename(dir), dir }];
  }
  const slugs = await listWorldFolders(WORLDS_ROOT);
  return slugs.map((slug) => ({ name: slug, dir: path.join(WORLDS_ROOT, slug) }));
}

async function checkOne(name: string, dir: string): Promise<boolean> {
  // The same headless load the server does, so the validator and the game
  // cannot disagree about what a world is.
  const result = await loadResolvedWorld(fsWorldDirSource(dir));
  const { sources, diagnostics } = result;
  if (result.error !== undefined) {
    console.error(`${name}: ${result.error}`);
    return false;
  }

  // Referenced texture files must exist on disk. This is a filesystem check,
  // so it lives here rather than in the three.js-free resolver — otherwise a
  // typo'd path only fails silently once the world is loaded in a browser.
  const textureWarnings: string[] = [];
  // Faults in a file the world names rather than in its text: a nav.bin that
  // does not decode fails the world, as a diagnostic error would.
  const fileErrors: string[] = [];
  let navigation = "";
  // Through the server's own guard rather than a bare existence check: a
  // declared path that climbs out of the world is "not found" here for the same
  // reason the api refuses to serve it, rather than quietly passing because the
  // file happens to exist somewhere else on disk.
  const missing = async (rel: string): Promise<boolean> => (await worldFile(dir, rel)) === undefined;
  if (result.world) {
    // In the browser
    // a missing asset is only a console warning on a prop that silently isn't
    // there. Checked per declared asset rather than per placement — 232 checks
    // for interchange-mw3's 8,420 models.
    if (result.world.collision && (await missing(result.world.collision.source))) {
      textureWarnings.push(`warning: collision mesh "${result.world.collision.source}" not found`);
    }
    if (result.world.navigation) {
      navigation = await checkNavigation(dir, result.world.navigation.source, textureWarnings, fileErrors);
    }
    if (result.world.minimap && (await missing(result.world.minimap.source))) {
      textureWarnings.push(`warning: minimap image "${result.world.minimap.source}" not found`);
    }
    for (const asset of Object.values(result.world.assets)) {
      // Two different faults with two different fixes, so they must not share one
      // message: a missing world file wants the map re-exported, and a missing
      // catalogue entry wants the catalogue rebuilt. Told apart by where the asset
      // says it lives, not by guessing from the path.
      if (asset.catalog) {
        const { kind, game, id } = asset.catalog;
        const file = await resolveCatalogFile(WORLDS_ROOT, kind, game, id, asset.source);
        if (file === undefined) {
          textureWarnings.push(
            `warning: asset "${asset.name}" names catalogue entry "${kind}/${game}/${id}/${asset.source}", which is not built` +
              " — rebuild it with `python3 -m scripts.cod harvest`",
          );
        }
      } else if (await missing(asset.source)) {
        textureWarnings.push(`warning: asset "${asset.name}" "${asset.source}" not found`);
      }
    }
  }

  const errors = diagnostics.filter((d) => d.severity === "error").length + fileErrors.length;
  const warnings = diagnostics.length - (errors - fileErrors.length) + textureWarnings.length;

  if (diagnostics.length > 0) {
    console.log(formatDiagnosticsAcrossFiles(sources, diagnostics));
    console.log("");
  }
  for (const e of fileErrors) {
    console.log(e);
  }
  for (const w of textureWarnings) {
    console.log(w);
  }
  if (textureWarnings.length + fileErrors.length > 0) {
    console.log("");
  }

  const status = errors > 0 ? "FAILED" : warnings > 0 ? "ok (with warnings)" : "ok";
  console.log(
    `${name}: ${status}${errors ? ` — ${errors} error${errors === 1 ? "" : "s"}` : ""}${warnings ? `, ${warnings} warning${warnings === 1 ? "" : "s"}` : ""}`,
  );

  if (!hasErrors(diagnostics) && result.world) {
    console.log(`  ${result.world.topLevelObjects.length} object(s), ${result.world.lights.length} light(s)${gameplaySummary(result.world)}${navigation}`);
  }

  return errors === 0;
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  const targets = await resolveTargets(arg);

  if (targets.length === 0) {
    console.error(arg ? `No world found at "${arg}".` : `No worlds found under ${WORLDS_ROOT}.`);
    process.exit(1);
  }

  let ok = true;
  // One world at a time: in parallel, 52 worlds' diagnostics interleave into
  // something nobody can read.
  for (const { name, dir } of targets) {
    if (!(await checkOne(name, dir))) {
      ok = false;
    }
    console.log("");
  }

  process.exit(ok ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

/**
 * Decode the world's `nav.bin` with the reader the game server uses, and say
 * what is in it. A missing file is a warning — the world then has no bot
 * navigation, as one naming none has — and a file the reader refuses is an error.
 */
async function checkNavigation(dir: string, source: string, warnings: string[], errors: string[]): Promise<string> {
  const file = await worldFile(dir, source);
  if (file === undefined) {
    warnings.push(`warning: navigation graph "${source}" not found`);
    return "";
  }
  try {
    const nav = decodeNav(new Uint8Array(await readFile(file)));
    const flags = Object.entries(HEADER_FLAGS)
      .filter(([, bit]) => nav.flags & bit)
      .map(([name]) => name);
    return (
      `\n  navigation: ${nav.nodes.count} node(s), ${nav.links.count} link(s), ${nav.traversals.count} traversal(s)` +
      (flags.length ? ` [${flags.join(", ")}]` : "")
    );
  } catch (err) {
    if (err instanceof NavFormatError) {
      errors.push(`error: navigation graph "${source}": ${err.message}`);
      return "";
    }
    throw err;
  }
}

/**
 * The gameplay a world declares, when it declares any. Kept off the main line
 * for a world that declares none, so its report does not grow a row of zeroes.
 */
function gameplaySummary(world: ResolvedWorld): string {
  const parts: string[] = [];
  if (world.spawnPoints.length > 1) {
    const modes = new Set(world.spawnPoints.flatMap((s) => s.modes ?? ["any"]));
    parts.push(`${world.spawnPoints.length} spawn(s) over ${modes.size} mode(s)`);
  }
  if (world.triggers.length) {
    parts.push(`${world.triggers.length} trigger(s)`);
  }
  if (world.points.length) {
    parts.push(`${world.points.length} point(s)`);
  }
  if (world.solids.length) {
    parts.push(`${world.solids.length} solid(s)`);
  }
  if (world.mantles.length) {
    // How many name a kind matters: a Black Ops map can never name one, so an
    // all-unnamed count is expected there and suspicious on a Modern Warfare map.
    const named = world.mantles.filter((m) => m.kind).length;
    parts.push(`${world.mantles.length} mantle(s)${named ? `, ${named} named` : ""}`);
  }
  if (world.ladders.length) {
    parts.push(`${world.ladders.length} ladder(s)`);
  }
  if (world.effects.length) {
    // Distinct effects as well as placements: one effect placed 20 times is a
    // detail scattered about, 20 effects placed once each is a map's whole mood,
    // and the two read very differently when a re-export changes the number.
    const distinct = new Set(world.effects.map((e) => e.fx)).size;
    parts.push(`${world.effects.length} effect placement(s) of ${distinct}`);
  }
  if (world.sounds.length) {
    const distinct = new Set(world.sounds.map((s) => s.alias)).size;
    parts.push(`${world.sounds.length} sound placement(s) of ${distinct}`);
  }
  const objects = world.topLevelObjects;
  const behaved = objects.filter((o) => o.behaviours).length;
  if (behaved) {
    parts.push(`${behaved} with behaviours`);
  }
  const tags = new Set(objects.flatMap((o) => o.tags));
  if (tags.size) {
    parts.push(`${tags.size} tag(s)`);
  }
  return parts.length ? `\n  ${parts.join(", ")}` : "";
}
