// The traversal guards, tested directly — the only way they can be.
//
// A request for "/worlds/w/../../etc/passwd" never reaches a route handler:
// WHATWG URL parsing collapses the dot segments first, so what arrives is a
// plain "/etc/passwd" that misses every route and 404s whether the guard works
// or not. These inputs are the ones a route test cannot pose.
//
// The encoded form (%2e%2e) *does* reach the handler, and tests/worlds.test.ts
// covers that end of it.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isSafeAssetPath, isSafeSlug, resolveWorldAsset, worldDir, worldFile } from "../src/worlds/paths.js";

describe("isSafeSlug", () => {
  it("accepts one directory name, dots in it included", () => {
    expect(isSafeSlug("hardhat-mw3")).toBe(true);
    expect(isSafeSlug("dome.v2")).toBe(true);
    expect(isSafeSlug("Hillside_2")).toBe(true);
  });

  it("refuses anything that is a path or a dot segment", () => {
    expect(isSafeSlug("")).toBe(false);
    expect(isSafeSlug(".")).toBe(false);
    expect(isSafeSlug("..")).toBe(false);
    expect(isSafeSlug("a/b")).toBe(false);
    expect(isSafeSlug("a\\b")).toBe(false);
    expect(isSafeSlug("../etc")).toBe(false);
  });

  // The reason the rule is an allowlist: each of these walks around a different
  // one of the refusals a denylist would have had to think of first.
  it("refuses what a list of refusals would have had to enumerate", () => {
    expect(isSafeSlug("w\0.png")).toBe(false);
    expect(isSafeSlug(".hidden")).toBe(false);
    expect(isSafeSlug("C:")).toBe(false);
    expect(isSafeSlug("%2e%2e")).toBe(false);
    expect(isSafeSlug("w\nx")).toBe(false);
    expect(isSafeSlug("‥")).toBe(false); // U+2025, a two-dot leader
    expect(isSafeSlug("x".repeat(65))).toBe(false);
  });
});

// Tested on its own, not only through resolveWorldAsset: there the containment
// check would refuse these anyway, and a layer that is only ever exercised
// behind another one is a layer nobody notices the loss of.
describe("isSafeAssetPath", () => {
  it("accepts a path inside a world", () => {
    expect(isSafeAssetPath("assets/tex.png")).toBe(true);
    expect(isSafeAssetPath("assets/nested/deep.png")).toBe(true);
    expect(isSafeAssetPath("world.world")).toBe(true);
    expect(isSafeAssetPath("assets/Load Screen.jpg")).toBe(true);
  });

  it("refuses anything that is not one", () => {
    expect(isSafeAssetPath("")).toBe(false);
    expect(isSafeAssetPath("..")).toBe(false);
    expect(isSafeAssetPath("assets/../../secret.txt")).toBe(false);
    expect(isSafeAssetPath("/etc/passwd")).toBe(false);
    expect(isSafeAssetPath("assets/")).toBe(false);
    expect(isSafeAssetPath("assets//tex.png")).toBe(false);
    expect(isSafeAssetPath("assets\\..\\secret.txt")).toBe(false);
    expect(isSafeAssetPath("assets/.git/config")).toBe(false);
    expect(isSafeAssetPath("assets/tex.png\0.jpg")).toBe(false);
    expect(isSafeAssetPath("a/".repeat(300))).toBe(false);
  });
});

describe("resolveWorldAsset", () => {
  let root: string;

  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "worlds-paths-")));
    fs.mkdirSync(path.join(root, "w", "assets", "nested"), { recursive: true });
    fs.writeFileSync(path.join(root, "w", "world.world"), "world {}\n");
    fs.writeFileSync(path.join(root, "w", "assets", "tex.png"), "x");
    fs.writeFileSync(path.join(root, "w", "assets", "nested", "deep.png"), "x");
    // The file a traversal would be trying to reach.
    fs.writeFileSync(path.join(root, "secret.txt"), "x");
  });

  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it("resolves a file inside the world", async () => {
    expect(await resolveWorldAsset(root, "w", "assets/tex.png")).toBe(path.join(root, "w", "assets", "tex.png"));
    expect(await resolveWorldAsset(root, "w", "assets/nested/deep.png")).toBe(path.join(root, "w", "assets", "nested", "deep.png"));
  });

  it("returns undefined for a file that is not there, and for a directory", async () => {
    expect(await resolveWorldAsset(root, "w", "assets/missing.png")).toBeUndefined();
    expect(await resolveWorldAsset(root, "w", "assets")).toBeUndefined();
    expect(await resolveWorldAsset(root, "w", "")).toBeUndefined();
  });

  // Both halves end up spliced into a filesystem path, so both need checking:
  // traversal in the slug escapes the worlds root entirely.
  it("refuses traversal in the relative path", async () => {
    expect(await resolveWorldAsset(root, "w", "../secret.txt")).toBeUndefined();
    expect(await resolveWorldAsset(root, "w", "assets/../../secret.txt")).toBeUndefined();
    expect(await resolveWorldAsset(root, "w", "../../etc/passwd")).toBeUndefined();
    expect(await resolveWorldAsset(root, "w", "assets/..%2f../secret.txt")).toBeUndefined();
    expect(await resolveWorldAsset(root, "w", "assets\\..\\..\\secret.txt")).toBeUndefined();
  });

  it("refuses traversal in the slug", async () => {
    expect(await resolveWorldAsset(root, "..", "secret.txt")).toBeUndefined();
    expect(await resolveWorldAsset(root, ".", "secret.txt")).toBeUndefined();
    expect(await resolveWorldAsset(root, "../..", "etc/passwd")).toBeUndefined();
    expect(await resolveWorldAsset(root, "w/..", "secret.txt")).toBeUndefined();
  });

  it("refuses an absolute path in either half", async () => {
    expect(await resolveWorldAsset(root, "w", "/etc/passwd")).toBeUndefined();
    expect(await resolveWorldAsset(root, "/etc", "passwd")).toBeUndefined();
  });

  // The property the individual cases are examples of: whatever comes back is
  // inside the world, or nothing comes back. Everything above is one row here.
  it("never returns a path outside the world, for any input", async () => {
    const slugs = ["w", "..", ".", "", "/etc", "w/..", "..%2f..", "w\0", "‥", "w/", "./w", "W"];
    const rests = [
      "assets/tex.png",
      "../secret.txt",
      "..",
      "./../secret.txt",
      "assets/./../../secret.txt",
      "%2e%2e/secret.txt",
      "\\..\\secret.txt",
      "/etc/passwd",
      "assets//../../secret.txt",
      "assets/tex.png\0.jpg",
      "",
    ];

    for (const slug of slugs) {
      for (const rest of rests) {
        const file = await resolveWorldAsset(root, slug, rest);
        if (file !== undefined) {
          expect(file.startsWith(path.join(root, "w") + path.sep)).toBe(true);
        }
      }
    }
  });
});

// A symlink inside a world is the traversal that survives every string check:
// each segment is a name, the joined path is under the world, and it still ends
// up somewhere else entirely. Only comparing the *real* paths catches it.
describe("symlinks", () => {
  let root: string;

  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "worlds-links-")));
    fs.mkdirSync(path.join(root, "w", "assets"), { recursive: true });
    fs.writeFileSync(path.join(root, "w", "world.world"), "world {}\n");
    fs.writeFileSync(path.join(root, "secret.txt"), "x");
    fs.symlinkSync(path.join(root, "secret.txt"), path.join(root, "w", "assets", "escape.txt"));
    fs.symlinkSync(root, path.join(root, "w", "assets", "out"));
  });

  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it("refuses a symlink that leaves the world", async () => {
    expect(await resolveWorldAsset(root, "w", "assets/escape.txt")).toBeUndefined();
    expect(await resolveWorldAsset(root, "w", "assets/out/secret.txt")).toBeUndefined();
  });

  // The operator's own layout, not a request's doing: a world folder may be a
  // symlink to storage elsewhere, and everything inside it is then measured
  // against where it really is.
  it("allows a world folder that is itself a symlink", async () => {
    const elsewhere = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "worlds-elsewhere-")));
    fs.mkdirSync(path.join(elsewhere, "big", "assets"), { recursive: true });
    fs.writeFileSync(path.join(elsewhere, "big", "assets", "tex.png"), "x");
    fs.symlinkSync(path.join(elsewhere, "big"), path.join(root, "big"));

    expect(await resolveWorldAsset(root, "big", "assets/tex.png")).toBe(path.join(elsewhere, "big", "assets", "tex.png"));
    expect(await resolveWorldAsset(root, "big", "../secret.txt")).toBeUndefined();

    fs.rmSync(elsewhere, { recursive: true, force: true });
  });
});

describe("worldDir, and a directory a CLI named itself", () => {
  let root: string;

  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "worlds-dir-")));
    fs.mkdirSync(path.join(root, "w"), { recursive: true });
    fs.writeFileSync(path.join(root, "w", "world.world"), "world {}\n");
    fs.writeFileSync(path.join(root, "loose.txt"), "x");
  });

  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it("resolves a world folder and refuses everything else", async () => {
    expect(await worldDir(root, "w")).toBe(path.join(root, "w"));
    expect(await worldDir(root, "no-such-world")).toBeUndefined();
    expect(await worldDir(root, "loose.txt")).toBeUndefined(); // a file, not a world
    expect(await worldDir(root, "..")).toBeUndefined();
  });

  // A directory named on the command line answers to no worlds root —
  // `pnpm check ../elsewhere` is a supported thing to do — but what is read
  // *inside* it still goes through the same guard.
  it("guards inside a directory named on the command line", async () => {
    const dir = path.join(root, "w");
    expect(await worldFile(dir, "world.world")).toBe(path.join(root, "w", "world.world"));
    expect(await worldFile(dir, "../loose.txt")).toBeUndefined();
  });
});
