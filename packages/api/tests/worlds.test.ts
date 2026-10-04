// The api's own reader and the three world URLs it serves.
//
// Against the repo's real worlds/ rather than a fixture, because the thing worth
// testing is that an actual exported map loads. Mounted with `app.request()`, so
// there is no socket and no port: the old version of this file stood up a real
// http server per request because there was no way to get at the app.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hasErrors } from "@3d/shared/dsl/diagnostics.js";
import { loadResolvedWorld } from "@3d/shared/worlds/load.js";
import { TEST_WORLD, TEST_WORLD_FILE, TEST_WORLDS, testApp } from "../testing/app.js";
import { buildManifest } from "../src/worlds/manifest.js";
import { fsWorldDirSource } from "../src/worlds/source.js";

const { app } = testApp();

describe("loading a world off disk", () => {
  it("resolves a world through the same pipeline the browser runs", async () => {
    const loaded = await loadResolvedWorld(fsWorldDirSource(path.join(TEST_WORLDS, TEST_WORLD)));
    expect(loaded.error).toBeUndefined();
    expect(hasErrors(loaded.diagnostics)).toBe(false);
    expect(loaded.world?.topLevelObjects.length).toBeGreaterThan(0);
  });

  it("reports a missing world without throwing", async () => {
    const loaded = await loadResolvedWorld(fsWorldDirSource(path.join(TEST_WORLDS, "no-such-world")));
    expect(loaded.error).toMatch(/no world at/);
    expect(loaded.world).toBeUndefined();
  });
});

describe("the worlds routes", () => {
  it("serves the manifest of every world in worlds/", async () => {
    const res = await app.request("/worlds-manifest.json");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(JSON.parse(JSON.stringify(await buildManifest(TEST_WORLDS))));
  });

  it("serves a world's sources as a WorldPayload", async () => {
    const res = await app.request(`/worlds/${TEST_WORLD}.json`);
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { entryPath: string; sources: Record<string, string> };
    expect(payload.entryPath).toBe("world.world");
    expect(payload.sources["world.world"]).toContain("world");
  });

  it("404s a world that is not there", async () => {
    expect((await app.request("/worlds/no-such-world.json")).status).toBe(404);
  });

  it("serves a file out of a world's folder", async () => {
    const res = await app.request(`/worlds/${TEST_WORLD}/${TEST_WORLD_FILE}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
  });

  it("answers 304 for a file the caller already has", async () => {
    const first = await app.request(`/worlds/${TEST_WORLD}/${TEST_WORLD_FILE}`);
    const lastModified = first.headers.get("Last-Modified");
    expect(lastModified).toBeTruthy();

    // Without this a hot reload re-downloads every texture in full — around
    // 100 MB for an imported map, through the dev proxy.
    const second = await app.request(`/worlds/${TEST_WORLD}/${TEST_WORLD_FILE}`, {
      headers: { "If-Modified-Since": lastModified! },
    });
    expect(second.status).toBe(304);
  });

  it("404s a file that is not there", async () => {
    expect((await app.request(`/worlds/${TEST_WORLD}/assets/no-such-file.png`)).status).toBe(404);
  });

  it("refuses an encoded traversal, which is the form that reaches the handler", async () => {
    // The unencoded form never gets here: URL parsing collapses "../" before any
    // router sees it. tests/paths.test.ts is where the guard itself is tested.
    expect((await app.request("/worlds/dome-mw3/%2e%2e%2f%2e%2e%2fpackage.json")).status).toBe(404);
    expect((await app.request("/worlds/%2e%2e%2f%2e%2e%2fpackage.json")).status).toBe(404);
  });

  // The sources route splices the slug into a path too, and used to be guarded
  // by the params schema alone. Both ends of every URL a traversal can be
  // spelled in, and the answer is always 404 — never a file, never a 500.
  it("refuses a traversal in every form either world URL can carry one", async () => {
    const urls = [
      "/worlds/%2e%2e%2fpackage.json",
      "/worlds/%2e%2e%2f%2e%2e%2fpackage.json.json",
      "/worlds/%2e.json",
      "/worlds/%2e%2e.json",
      "/worlds/%2e%2e%2fpackages%2fapi%2fpackage.json",
      "/worlds/dome-mw3%00.json",
      "/worlds/dome-mw3/%2e%2e%2fdome-mw3%2fworld.world",
      "/worlds/dome-mw3/assets%2f%2e%2e%2f%2e%2e%2f%2e%2e%2fpackage.json",
      "/worlds/dome-mw3/%2e%2egit%2fconfig",
      "/worlds/dome-mw3/..%5c..%5cpackage.json",
      "/worlds/dome-mw3/%00world.world",
      "/worlds/dome-mw3//world.world",
    ];

    for (const url of urls) {
      expect([url, (await app.request(url)).status]).toEqual([url, 404]);
    }
  });

  it("serves a world's own sources and nothing above them", async () => {
    const res = await app.request(`/worlds/${TEST_WORLD}.json`);
    const { sources } = (await res.json()) as { sources: Record<string, string> };
    for (const key of Object.keys(sources)) {
      expect(key.startsWith("..")).toBe(false);
      expect(key.startsWith("/")).toBe(false);
    }
  });
});

// The catalogue's two routes over a catalogue of the test's own: the index
// carries each kind this build reads, and an entry's files are served by path.
describe("the catalogue routes", () => {
  it("serve an actor entry and its files", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-"));
    const entry = { id: "zombie_ger", game: "t5", kind: "zombie", bodies: ["body.glb"], animations: "zombie", hitboxes: "zombie_ger.hitboxes.json" };
    fs.mkdirSync(path.join(root, "catalog", "actors", "t5", "zombie_ger"), { recursive: true });
    fs.writeFileSync(path.join(root, "catalog", "index.json"), JSON.stringify({ version: 1, weapons: [], actors: [entry] }));
    fs.writeFileSync(path.join(root, "catalog", "actors", "t5", "zombie_ger", "zombie_ger.json"), JSON.stringify(entry));
    try {
      const { app: own } = testApp({ worldsRoot: root });
      const index = (await (await own.request("/api/catalog")).json()) as { actors?: unknown[] };
      expect(index.actors).toEqual([entry]);
      const file = await own.request("/api/catalog/actors/t5/zombie_ger/zombie_ger.json");
      expect(file.status).toBe(200);
      expect(await file.json()).toEqual(entry);
      expect((await own.request("/api/catalog/actors/t5/zombie_ger/missing.glb")).status).toBe(404);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
