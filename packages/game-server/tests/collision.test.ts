// A game server can build the collision a capsule will be resolved against,
// headlessly, from bytes it did not read off disk itself.
//
// Runs against the repo's real worlds/ rather than a fixture, because the thing
// worth testing is that an actual exported map loads. The WorldSource here is a
// local one over fs: where the bytes come from is exactly what buildServerCollision
// is not supposed to care about, and in production they come from @3d/api.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { loadResolvedWorld } from "@3d/shared/worlds/load.js";
import type { WorldSource } from "@3d/shared/worlds/source.js";
import { buildServerCollision } from "../src/collision.js";

const WORLDS = path.resolve(import.meta.dirname, "../../../worlds");
/** An imported map, whose assets are gitignored; the tests needing them skip when it has not been exported. */
const IMPORTED = "dome-mw3";

/** The smallest WorldSource there is, so this file tests collision and nothing else. */
function dirSource(slug: string): WorldSource {
  const dir = path.join(WORLDS, slug);
  return {
    describe: dir,
    payload: () =>
      Promise.resolve({
        entryPath: "world.world",
        sources: Object.fromEntries(
          fs
            .readdirSync(dir)
            .filter((f) => f.endsWith(".world"))
            .map((f) => [f, fs.readFileSync(path.join(dir, f), "utf8")]),
        ),
      }),
    asset: (relPath) => {
      const file = path.join(dir, relPath);
      return Promise.resolve(fs.existsSync(file) ? new Uint8Array(fs.readFileSync(file)) : undefined);
    },
  };
}

/** A WorldSource over literal text, for a world that has no folder on disk. */
function textSource(text: string): WorldSource {
  return {
    describe: "<inline>",
    payload: () => Promise.resolve({ entryPath: "world.world", sources: { "world.world": text } }),
    asset: () => Promise.resolve(undefined),
  };
}

const has = (slug: string): boolean => fs.existsSync(path.join(WORLDS, slug, "world.world"));

/**
 * Reads a catalogue file off disk, the way the api would serve one.
 *
 * A prop belongs to the catalogue now, so without this every prop on every
 * imported map is missing — which is exactly what happened in production, because
 * the test that should have caught it guarded on `assets/props` and silently
 * skipped once that directory stopped existing. A guard that turns into a skip is
 * worse than no test; this one reads the catalogue and the assertions below say
 * so out loud when it is not built.
 */
const catalogRoot = path.join(WORLDS, "catalog");
const catalogFile = (ref: { kind: string; game: string; id: string }, rel: string): Promise<Uint8Array | undefined> => {
  const file = path.join(catalogRoot, ref.kind, ref.game, ref.id, rel);
  return Promise.resolve(fs.existsSync(file) ? new Uint8Array(fs.readFileSync(file)) : undefined);
};
/** Whether the shared catalogue has been built, which the prop assertions need. */
const hasCatalog = fs.existsSync(catalogRoot);

describe("buildServerCollision", () => {
  it("builds a BVH from an imported map's collision mesh, with no DOM", async () => {
    if (!has(IMPORTED) || !fs.existsSync(path.join(WORLDS, IMPORTED, "assets/collision.glb"))) {
      return;
    }
    const source = dirSource(IMPORTED);
    const loaded = await loadResolvedWorld(source);
    const collision = await buildServerCollision(loaded.world!, source, catalogFile);

    expect(collision).toBeDefined();
    expect(collision!.triangles).toBeGreaterThan(1000);
    expect(collision!.world.ready).toBe(true);
  });

  it("collides an imported map's props, not only its clipmap", async () => {
    // Guarded on the *catalogue*, which is where a prop lives. The old guard named
    // `assets/props`, a per-world directory that stopped existing when props moved
    // — so this test skipped rather than failing, and a server that collided with
    // no prop at all looked fine for as long as it did not correct anybody.
    if (!has(IMPORTED) || !hasCatalog) {
      return;
    }
    const source = dirSource(IMPORTED);
    const loaded = await loadResolvedWorld(source);
    const collision = await buildServerCollision(loaded.world!, source, catalogFile);

    // The clipmap stops you at the level's walls; a car or a crate is a prop,
    // and before these were built it was solid on the client and air here.
    expect(collision!.props.placements).toBeGreaterThan(100);
    expect(collision!.props.assets).toBeGreaterThan(10);
    // Every hull the map asks for resolved: a missing one is a hole a player
    // walks through here and not on their own screen.
    expect(collision!.props.missing).toBe(0);
    expect(collision!.world.hullStats.instances).toBe(collision!.props.placements);
  });

  it("returns undefined for a world with nothing to install", async () => {
    // No clipmap and no props, so there is genuinely nothing for a capsule to
    // hit. The caller reports that rather than holding a world that silently
    // stops nothing.
    const source = textSource('world { name: "Empty" }\nspawn { at: 0 1.7 0 }');
    const loaded = await loadResolvedWorld(source);

    expect(loaded.world).toBeDefined();
    expect(await buildServerCollision(loaded.world!, source, catalogFile)).toBeUndefined();
  });

  it("says which mesh is missing when a world declares one it cannot fetch", async () => {
    if (!has(IMPORTED)) {
      return;
    }
    const source = dirSource(IMPORTED);
    const loaded = await loadResolvedWorld(source);
    const empty: WorldSource = { ...source, asset: () => Promise.resolve(undefined) };

    await expect(buildServerCollision(loaded.world!, empty, catalogFile)).rejects.toThrow(/collision mesh not found/);
  });
});
