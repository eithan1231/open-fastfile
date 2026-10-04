// Where an asset's file is fetched from: the world's folder, or the catalogue.
//
// One join point, because the AssetStore is keyed by the URL it loaded with and
// hot-reload invalidation is keyed by the same string. A second spelling of one
// file silently stops invalidating it — the trap documented in
// protocol/routes/worlds.ts.

import { describe, expect, it } from "vitest";
import type { ResolvedAsset } from "@3d/shared/dsl/resolved.js";
import { catalogFilePath, catalogSoundClipPath, catalogSoundsPath } from "@3d/shared/protocol/routes/catalog.js";
import { worldAssetPath } from "@3d/shared/protocol/routes/worlds.js";
import { assetUrl, soundClipUrl, soundLibraryUrl, worldFileUrl } from "../src/scene/assetUrl.js";

const WORLD_BASE = worldAssetPath("dome-mw3", "");

describe("assetUrl", () => {
  it("joins a world's own asset onto that world's prefix", () => {
    const asset: ResolvedAsset = { name: "chair", source: "assets/chair.glb" };
    expect(assetUrl(asset, WORLD_BASE)).toBe(`${WORLD_BASE}assets/chair.glb`);
  });

  it("ignores the world prefix for a catalogue asset", () => {
    const asset: ResolvedAsset = {
      name: "barrel",
      source: "com_barrel_lod0.glb",
      catalog: { kind: "props", game: "iw5", id: "com_barrel_lod0" },
    };
    // A shared prop is not relative to whichever map is being walked.
    expect(assetUrl(asset, WORLD_BASE)).toBe(catalogFilePath("props", "iw5", "com_barrel_lod0", "com_barrel_lod0.glb"));
    expect(assetUrl(asset, WORLD_BASE)).not.toContain("dome-mw3");
  });

  it("gives the same URL whichever world asks, which is what makes the entry shared", () => {
    const asset: ResolvedAsset = {
      name: "barrel",
      source: "com_barrel_lod0.glb",
      catalog: { kind: "props", game: "iw5", id: "com_barrel_lod0" },
    };
    expect(assetUrl(asset, worldAssetPath("dome-mw3", ""))).toBe(assetUrl(asset, worldAssetPath("rust-mw2", "")));
  });

  // Ghosts ships `rock_lod0.glb` twice, once under `mv/`, with different bytes.
  // The ids differ, so the URLs must.
  it("separates two entries whose files share a name", () => {
    const top: ResolvedAsset = { name: "a", source: "rock_lod0.glb", catalog: { kind: "props", game: "iw6", id: "rock_lod0" } };
    const mv: ResolvedAsset = { name: "b", source: "rock_lod0.glb", catalog: { kind: "props", game: "iw6", id: "mv.rock_lod0" } };
    expect(assetUrl(top, WORLD_BASE)).not.toBe(assetUrl(mv, WORLD_BASE));
  });
});

describe("worldFileUrl", () => {
  it("spells a world's own file exactly as assetUrl does, so one file has one key", () => {
    expect(worldFileUrl("assets/nav.bin", WORLD_BASE)).toBe(`${WORLD_BASE}assets/nav.bin`);
    expect(worldFileUrl("assets/nav.bin", WORLD_BASE)).toBe(assetUrl({ name: "nav", source: "assets/nav.bin" }, WORLD_BASE));
  });
});

describe("sound URLs", () => {
  const worldHome = { base: WORLD_BASE, source: "assets/sounds/sounds.json" };

  it("joins a world's table and its clips onto that world's prefix", () => {
    expect(soundLibraryUrl(worldHome)).toBe(`${WORLD_BASE}assets/sounds/sounds.json`);
    // The table names a file with no extension, at the game's own path; the
    // `.webm` is added here and on the catalogue branch, and nowhere else.
    expect(soundClipUrl(worldHome, "footsteps/foot_dirt01")).toBe(`${WORLD_BASE}assets/sounds/clips/footsteps/foot_dirt01.webm`);
  });

  it("ignores the world entirely for the catalogue's bank", () => {
    expect(soundLibraryUrl({ game: "iw5" })).toBe(catalogSoundsPath("iw5"));
    expect(soundClipUrl({ game: "iw5" }, "footsteps/foot_dirt01")).toBe(catalogSoundClipPath("iw5", "footsteps/foot_dirt01"));
    expect(soundClipUrl({ game: "iw5" }, "footsteps/foot_dirt01")).not.toContain("dome-mw3");
  });

  it("separates the two games' banks, since the same alias name exists in both", () => {
    expect(soundLibraryUrl({ game: "iw4" })).not.toBe(soundLibraryUrl({ game: "iw5" }));
  });
});
