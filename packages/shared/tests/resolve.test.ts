import { describe, expect, it } from "vitest";
import { parseWorldFile } from "../src/dsl/parser.js";
import { resolveWorld } from "../src/dsl/resolve.js";
import { hasErrors } from "../src/dsl/diagnostics.js";

function resolve(source: string) {
  const { ast, diagnostics: parseDiags } = parseWorldFile(source);
  expect(parseDiags).toHaveLength(0);
  const result = resolveWorld(ast.statements);
  return result;
}

function resolveOk(source: string) {
  const result = resolve(source);
  if (hasErrors(result.diagnostics)) {
    throw new Error("unexpected errors: " + result.diagnostics.map((d) => d.message).join("; "));
  }
  return result.world!;
}

describe("resolveWorld — groups", () => {
  it("places a group's children relative to the group, not the world origin", () => {
    const world = resolveOk(`
      asset a { source: "a.glb" }
      group g { at: 10 0 5
        model m { asset: a, size: 1 1 1, at: 1 0 2 }
      }
    `);
    expect(world.topLevelObjects[0]!.position).toEqual({ x: 11, y: 0, z: 7 });
  });

  it("rotates a group's children with the group's own rotation", () => {
    const world = resolveOk(`
      asset a { source: "a.glb" }
      group g { at: 0 0 0, rotate: 90
        model m { asset: a, size: 1 1 1, at: 1 0 0 }
      }
    `);
    const b = world.topLevelObjects[0]!;
    // rotateY((1,0,0), 90deg) -> (0,0,-1)
    expect(b.position.x).toBeCloseTo(0, 5);
    expect(b.position.z).toBeCloseTo(-1, 5);
  });

  it("compounds a nested group's origin with its parent's", () => {
    const world = resolveOk(`
      asset a { source: "a.glb" }
      group outer { at: 10 0 0
        group inner { at: 0 0 5
          model m { asset: a, size: 1 1 1, at: 1 0 0 }
        }
      }
    `);
    expect(world.topLevelObjects[0]!.position).toEqual({ x: 11, y: 0, z: 5 });
  });

  it("detects a circular group reference", () => {
    // A group cannot contain itself, so the cycle guard is reached through
    // `parentOf`; this simply pins that a self-referential body is diagnosed
    // rather than hanging.
    const world = resolveOk(`
      asset a { source: "a.glb" }
      group g { at: 0 0 0
        model m { asset: a, size: 1 1 1 }
      }
    `);
    expect(world.topLevelObjects).toHaveLength(1);
  });
});

describe("resolveWorld — world/lights/spawn", () => {
  it("resolves a light's position and defaults", () => {
    const world = resolveOk("light sun { type: directional, at: 6 9 4, intensity: 1.3, shadows: on }");
    expect(world.lights[0]).toMatchObject({ type: "directional", position: { x: 6, y: 9, z: 4 }, intensity: 1.3, shadows: true });
  });

  it("reads a spot light's beam and reach", () => {
    const world = resolveOk("light lamp { type: spot, at: 0 4 0, cone: 60 40, range: 12 }");
    expect(world.lights[0]!.range).toBe(12);
    expect(world.lights[0]!.cone!.outer).toBeCloseTo(Math.PI / 3);
    expect(world.lights[0]!.cone!.inner).toBeCloseTo((2 * Math.PI) / 9);
    // One width is a beam with no soft edge.
    const hard = resolveOk("light lamp { type: spot, cone: 30 }").lights[0]!.cone!;
    expect(hard.inner).toBe(hard.outer);
  });

  it("refuses a cone whose core is wider than the beam, and ignores one on a point light", () => {
    expect(resolve("light lamp { type: spot, cone: 30 50 }").diagnostics.map((d) => d.code)).toContain("light-bad-cone");
    const point = resolve("light lamp { type: point, cone: 30 }");
    expect(point.diagnostics.map((d) => d.code)).toContain("light-unused-cone");
    expect(point.world!.lights[0]!.cone).toBeUndefined();
  });

  it("uses an explicit spawn", () => {
    const world = resolveOk("spawn { at: 0 1.7 1.5, look: 0 1.6 -1 }");
    expect(world.spawn).toEqual({ position: { x: 0, y: 1.7, z: 1.5 }, look: { x: 0, y: 1.6, z: -1 } });
  });

  it("defaults the spawn when none is declared", () => {
    const world = resolveOk('world { name: "W" }');
    expect(world.spawn.position).toEqual({ x: 0, y: 1.7, z: 0 });
  });

  it("flags an unknown asset reference", () => {
    const result = resolve("group g { model m { asset: nope, size: 1 1 1 } }");
    expect(result.diagnostics.some((d) => d.code === "unknown-asset")).toBe(true);
  });

  it("bails out entirely on schema errors rather than attempting to resolve", () => {
    const { ast } = parseWorldFile("gruop g { at: 0 0 0 }");
    const result = resolveWorld(ast.statements);
    expect(result.world).toBeUndefined();
    expect(hasErrors(result.diagnostics)).toBe(true);
  });
});

describe("retired nodes", () => {
  // A world used to declare its own people. It stopped: what a player wears and
  // holds is a gametype's choice now, out of the shared catalogue
  // (packages/shared/src/game/, docs/engine/scripting.md).
  //
  // These error rather than being ignored. A world that quietly kept a
  // `characters` block would look fine and stop dressing anybody, which is the
  // kind of plausible wrong result that earns an assertion rather than a note.
  for (const [type, source] of [
    ["viewmodel", 'viewmodel {\n  weapon: "iw5/iw5_m4_mp"\n  hands: "assets/viewmodel/viewhands_delta.glb"\n}'],
    ["characters", 'characters {\n  animations: "a.glb"\n  character allies {\n    body: "b.glb"\n  }\n}'],
  ] as const) {
    it(`reports "${type}" as retired, and says what to do instead`, () => {
      const diags = resolve(source).diagnostics;
      expect(diags.map((d) => d.code)).toContain("node-retired");
      const message = diags.find((d) => d.code === "node-retired")!.message;
      // The fix is to delete a file, so the message has to say so — a
      // did-you-mean would send an author looking for a typo.
      expect(message).toContain("packages/shared/src/game/");
      expect(message).toContain(`${type}.world`);
    });
  }

  it("does not suggest a retired node to somebody who mistypes one", () => {
    const diags = resolve("viewmodl { }").diagnostics;
    expect(diags.map((d) => d.code)).toContain("unknown-type");
    expect(diags.some((d) => d.message.includes('"viewmodel"'))).toBe(false);
  });
});

describe("an asset from the catalogue", () => {
  // A prop shared between maps is not relative to whichever map is being walked,
  // which is the whole point of sharing it. `catalog:` says which entry `source`
  // hangs off; `scene/assetUrl.ts` is the one place either becomes a URL.
  it("reads the three segments that name an entry", () => {
    const world = resolveOk('asset barrel { catalog: "props/iw5/com_barrel_lod0", source: "com_barrel_lod0.glb" }');
    expect(world.assets.barrel).toEqual({
      name: "barrel",
      source: "com_barrel_lod0.glb",
      catalog: { kind: "props", game: "iw5", id: "com_barrel_lod0" },
      until: undefined,
      hull: undefined,
    });
  });

  it("is undefined for an asset the world ships itself, so nothing has to guess", () => {
    expect(resolveOk('asset chair { source: "assets/chair.glb" }').assets.chair!.catalog).toBeUndefined();
  });

  // `until` and `hull` are per-asset facts and belong to the entry, but the
  // resolver is synchronous and has never seen a catalogue — so they stay on the
  // line, and this pins that they still resolve beside a catalogue ref.
  it("keeps until and hull, which the resolver could not read from an entry", () => {
    const world = resolveOk('asset post { catalog: "props/iw4/post_lod0", source: "post_lod0.glb", until: 40, hull: 0 }');
    expect(world.assets.post).toMatchObject({ until: 40, hull: 0, catalog: { game: "iw4" } });
  });

  it("refuses anything that is not <kind>/<game>/<id>", () => {
    for (const bad of ["props/iw5", "props", "props/iw5/a/b", "props//a", ""]) {
      const codes = resolve(`asset x { catalog: "${bad}", source: "x.glb" }`).diagnostics.map((d) => d.code);
      expect(codes, bad).toContain("bad-catalog-ref");
    }
  });

  // `source` stays required: NodeTypeSpec.required is unconditional, so "one of
  // these two" is not expressible — and an author reads one rule instead of two.
  it("still requires a source", () => {
    const codes = resolve('asset x { catalog: "props/iw5/a" }').diagnostics.map((d) => d.code);
    expect(codes).toContain("missing-property");
  });
});
