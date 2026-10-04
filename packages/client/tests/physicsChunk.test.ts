// The physics engine must not be in the bundle a menu is drawn from.
//
// `@dimforge/rapier3d-deterministic-compat` inlines its wasm as base64, so it is
// about 2.9 MB of JavaScript — 1.1 MB gzipped, or four times the rest of the client
// put together. It belongs in a chunk fetched while a world loads, which is what
// `WorldSession`'s `"physics"` step is for.
//
// One ordinary `import` anywhere in the static graph undoes that, silently and
// completely: the chunk stops being a chunk and the entry bundle quadruples. It has
// already happened once — `net/corpses.ts` imported `ragdollShape` for its value,
// which looked like nothing and put the whole engine in `index.js` — and the only
// reason anybody noticed was reading a build log.
//
// So it is a test rather than a habit. Reading the sources rather than a build,
// because `dist/` is a build step away and this should fail in the same second the
// import is written. Type imports are erased and are the intended way to name any
// of it (`RagdollApi` in net/corpses.ts is the pattern).

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const SRC = path.resolve(import.meta.dirname, "../src");

/** Every .ts/.tsx under the client's source tree. */
function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return sources(full);
    }
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

/**
 * A static `import` of a value from the physics subtree or the engine itself.
 *
 * `import type` is allowed and `await import(...)` is the whole point, so neither
 * matches: this looks only for a declaration that begins `import` and is not
 * `import type`.
 */
const OFFENDING = /^\s*import\s+(?!type\s)[^;]*?from\s*["'](@dimforge\/[^"']*|@3d\/shared\/physics\/[^"']*)["']/gm;

describe("the physics chunk", () => {
  it("is not reachable from the client's static import graph", () => {
    const offenders: string[] = [];
    for (const file of sources(SRC)) {
      const text = fs.readFileSync(file, "utf8");
      for (const match of text.matchAll(OFFENDING)) {
        offenders.push(`${path.relative(SRC, file)}: ${match[0].trim().split("\n")[0]}`);
      }
    }
    expect(offenders, "use `import type`, or load it through WorldSession's dynamic import").toEqual([]);
  });

  it("is still reached somewhere, or the corpses are not drawn at all", () => {
    // The negative. A regex that matched nothing would pass the test above on a
    // client that had deleted the feature.
    const session = fs.readFileSync(path.join(SRC, "app/WorldSession.ts"), "utf8");
    expect(session, "WorldSession no longer loads the engine").toMatch(/\bimport\(\s*["']@3d\/shared\/physics\/engine\.js["']\s*\)/);
  });
});
