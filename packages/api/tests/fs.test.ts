// What counts as one of a world's sources.
//
// Over temp fixtures rather than the repo's worlds/, because the cases worth
// pinning are the folders an author would not expect to be read.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readCatalogIndex, readWorldSources } from "../src/worlds/fs.js";

let root: string;

/** Build a world folder on disk: `{ "assets/x.png": "..." }` -> real files. */
function makeWorld(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(root, "world-"));
  for (const [rel, contents] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents);
  }
  return dir;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "worldassets-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("readWorldSources", () => {
  it("reads .world files but ignores those under _- and .-prefixed directories", async () => {
    const src = makeWorld({
      "world.world": 'world { name: "W" }',
      "props.world": 'asset a { source: "assets/a.glb" }',
      "_reference/scratch.world": 'asset ignored { source: "x.glb" }',
      ".work/stale.world": 'asset ignored { source: "x.glb" }',
    });
    expect(Object.keys(await readWorldSources(src)).sort()).toEqual(["props.world", "world.world"]);
  });

  // A walk that follows a symlink is how reading "a world's own files" turns
  // into reading something else's.
  it("does not follow a symlink out of the world", async () => {
    fs.writeFileSync(path.join(root, "outside.world"), 'asset leaked { source: "x.glb" }');
    const src = makeWorld({ "world.world": 'world { name: "W" }' });
    fs.symlinkSync(path.join(root, "outside.world"), path.join(src, "linked.world"));
    fs.symlinkSync(root, path.join(src, "up"));

    expect(Object.keys(await readWorldSources(src)).sort()).toEqual(["world.world"]);
  });
});

// The catalogue index, whose shape has to admit a kind this build has never
// heard of without any reader refusing the file. That is the whole reason
// `CATALOG_VERSION` did not move when characters and view-hands moved in.
describe("readCatalogIndex", () => {
  /** A worlds root with `catalog/index.json` in it. */
  function makeCatalog(body: string): string {
    const dir = fs.mkdtempSync(path.join(root, "worlds-"));
    fs.mkdirSync(path.join(dir, "catalog"), { recursive: true });
    fs.writeFileSync(path.join(dir, "catalog", "index.json"), body);
    return dir;
  }

  it("reads a catalogue built before any other kind existed", async () => {
    const dir = makeCatalog(JSON.stringify({ version: 1, weapons: [{ id: "a" }] }));
    const index = await readCatalogIndex(dir);
    expect(index?.version).toBe(1);
    expect(index?.weapons).toHaveLength(1);
    // Absent, not empty: a reader tells "no catalogue of this kind" from "one
    // that is built and holds nothing" by the key being there at all.
    expect(index?.characters).toBeUndefined();
    expect(index?.viewhands).toBeUndefined();
    expect(index?.animations).toBeUndefined();
    expect(index?.actors).toBeUndefined();
  });

  it("carries every kind it knows through", async () => {
    const dir = makeCatalog(
      JSON.stringify({
        version: 1,
        weapons: [{ id: "w" }],
        characters: [{ id: "body" }, { id: "body2" }],
        viewhands: [{ id: "hands" }],
        animations: [{ id: "autorifle" }],
        actors: [{ id: "zombie_ger" }],
      }),
    );
    const index = await readCatalogIndex(dir);
    expect(index?.characters).toHaveLength(2);
    expect(index?.viewhands).toHaveLength(1);
    expect(index?.animations).toHaveLength(1);
    expect(index?.actors).toHaveLength(1);
  });

  // The api must not become a courier for bytes it has no reader for: a kind
  // added by a newer exporter is dropped rather than forwarded.
  it("drops a kind this build does not know", async () => {
    const dir = makeCatalog(JSON.stringify({ version: 1, weapons: [], vehicles: [{ id: "rcxd" }] }));
    const index = await readCatalogIndex(dir);
    expect(index).toEqual({ version: 1, weapons: [] });
  });

  it("refuses a file that is not a catalogue at all", async () => {
    // No `weapons`, so it is not one — as opposed to a missing optional kind.
    expect(await readCatalogIndex(makeCatalog(JSON.stringify({ version: 1 })))).toBeUndefined();
    expect(await readCatalogIndex(makeCatalog("not json"))).toBeUndefined();
  });

  it("ignores a kind whose value is not an array", async () => {
    const dir = makeCatalog(JSON.stringify({ version: 1, weapons: [], characters: "no" }));
    expect((await readCatalogIndex(dir))?.characters).toBeUndefined();
  });
});
