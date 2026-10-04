// The `grade` node: schema, resolve, and the GLSL it compiles into.
//
// Tints are absolute multipliers on a 0..2 scale where 1 is neutral, and they
// reach the shader exactly as authored — no rescaling. These pin that down,
// because an earlier version of engine/grade.ts *did* rescale them (dividing
// by the midtone's luminance, to hold off highlight clipping) and that quietly
// changed what every authored number meant for a 0.03 gain in clipping
// headroom.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { parseWorldFile } from "@3d/shared/dsl/parser.js";
import { resolveWorld } from "@3d/shared/dsl/resolve.js";
import type { ResolvedGrade } from "@3d/shared/dsl/resolved.js";
import { hasErrors } from "@3d/shared/dsl/diagnostics.js";
import { gradeGlsl, applyGrade } from "../src/engine/grade.js";

function resolve(source: string) {
  const { ast, diagnostics: parseDiags } = parseWorldFile(source);
  expect(parseDiags).toHaveLength(0);
  return resolveWorld(ast.statements);
}

function resolveOk(source: string) {
  const result = resolve(source);
  if (hasErrors(result.diagnostics)) {
    throw new Error("unexpected errors: " + result.diagnostics.map((d) => d.message).join("; "));
  }
  return result.world!;
}

/** mp_dome's actual vision values, as written into worlds/dome-mw3/world.world. */
const DOME = `
grade {
  light-tint: 1.59238 1.56238 1.40199
  medium-tint: 1.07764 1.0866 1.09892
  dark-tint: 0.706566 0.904928 1.05143
  desaturation: 0.191536
  desaturation-dark: 0.0538634
}`;

describe("grade — schema", () => {
  it("accepts a full grade node", () => {
    expect(hasErrors(resolve(DOME).diagnostics)).toBe(false);
  });

  it("accepts an empty grade node as the identity grade", () => {
    const world = resolveOk("grade { }");
    expect(world.grade).toEqual({
      lightTint: { x: 1, y: 1, z: 1 },
      mediumTint: { x: 1, y: 1, z: 1 },
      darkTint: { x: 1, y: 1, z: 1 },
      desaturation: 0,
      desaturationDark: 0,
    });
  });

  it("leaves grade undefined when no node is declared", () => {
    expect(resolveOk('world { name: "W" }').grade).toBeUndefined();
  });

  it("rejects a tint that is not three numbers", () => {
    const diags = resolve("grade { light-tint: 1 1 }").diagnostics;
    expect(hasErrors(diags)).toBe(true);
  });

  it("rejects an unknown property", () => {
    const diags = resolve("grade { gamma: 2.2 }").diagnostics;
    expect(diags.some((d) => d.message.includes("gamma"))).toBe(true);
  });

  it("warns when a tint leaves the 0..2 scale, the usual sign of wrong units", () => {
    // e.g. an 0..255 colour pasted straight in.
    const diags = resolve("grade { dark-tint: 179 231 255 }").diagnostics;
    expect(diags.some((d) => d.code === "tint-out-of-range")).toBe(true);
    expect(hasErrors(diags)).toBe(false); // nothing breaks; it just looks wrong
  });

  it("warns when desaturation leaves its 0..4 scale", () => {
    const diags = resolve("grade { desaturation: 40 }").diagnostics;
    expect(diags.some((d) => d.code === "desaturation-out-of-range")).toBe(true);
    expect(hasErrors(diags)).toBe(false);
  });

  it("accepts desaturation across the whole 0..4 scale", () => {
    const diags = resolve("grade { desaturation: 4, desaturation-dark: 0 }").diagnostics;
    expect(diags.some((d) => d.code === "desaturation-out-of-range")).toBe(false);
  });

  it("accepts the full 0..2 range without complaint", () => {
    const diags = resolve("grade { light-tint: 0 1 2, dark-tint: 2 2 2 }").diagnostics;
    expect(diags.some((d) => d.code === "tint-out-of-range")).toBe(false);
  });

  it("warns about a name, since a world has only one grade", () => {
    // A warning rather than an error, matching `world` / `collision` / `lod`:
    // the name is simply ignored and the world still loads.
    const diags = resolve("grade oops { desaturation: 0.1 }").diagnostics;
    expect(hasErrors(diags)).toBe(false);
    expect(diags.some((d) => d.code === "unexpected-name")).toBe(true);
  });
});

describe("grade — resolve", () => {
  it("carries the authored values through verbatim", () => {
    const g = resolveOk(DOME).grade!;
    expect(g.lightTint.x).toBeCloseTo(1.59238, 6);
    expect(g.darkTint.z).toBeCloseTo(1.05143, 6);
    expect(g.desaturation).toBeCloseTo(0.191536, 6);
    expect(g.desaturationDark).toBeCloseTo(0.0538634, 6);
  });
});

describe("grade — GLSL", () => {
  const identity: ResolvedGrade = {
    lightTint: { x: 1, y: 1, z: 1 },
    mediumTint: { x: 1, y: 1, z: 1 },
    darkTint: { x: 1, y: 1, z: 1 },
    desaturation: 0,
    desaturationDark: 0,
  };

  /** Every float literal in GLSL needs a decimal point; a bare `1` is an int and fails to compile. */
  it("emits only well-formed float literals", () => {
    const glsl = gradeGlsl(identity);
    for (const lit of glsl.matchAll(/(?<![\w.])(\d+)(?![\w.])/g)) {
      // The only bare integers allowed are GLSL swizzle-free vector sizes.
      expect(["3"]).toContain(lit[1]);
    }
  });

  it("runs ACES first, so a grade is strictly additive to the existing look", () => {
    expect(gradeGlsl(identity)).toContain("ACESFilmicToneMapping( color )");
  });

  /** Pull one named `const vec3 <zone> = vec3( r, g, b );` back out of the generated GLSL. */
  function zone(glsl: string, name: string): [number, number, number] {
    const m = new RegExp(`${name} = vec3\\( ([\\d.]+), ([\\d.]+), ([\\d.]+) \\)`).exec(glsl);
    if (!m) {
      throw new Error(`no ${name} in generated GLSL`);
    }
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  }

  it("passes the authored tints through verbatim — no rescaling", () => {
    const glsl = gradeGlsl(resolveOk(DOME).grade!);
    expect(zone(glsl, "gradeDark")).toEqual([0.706566, 0.904928, 1.05143]);
    expect(zone(glsl, "gradeMedium")).toEqual([1.07764, 1.0866, 1.09892]);
    expect(zone(glsl, "gradeLight")).toEqual([1.59238, 1.56238, 1.40199]);
  });

  it("treats 1 1 1 as the identity, since 1 is the neutral point of the scale", () => {
    const glsl = gradeGlsl(identity);
    for (const name of ["gradeDark", "gradeMedium", "gradeLight"]) {
      expect(zone(glsl, name)).toEqual([1, 1, 1]);
    }
  });

  it("keeps the ratio between zones — dome stays warm up top and blue down low", () => {
    const glsl = gradeGlsl(resolveOk(DOME).grade!);
    const light = zone(glsl, "gradeLight");
    const dark = zone(glsl, "gradeDark");
    expect(light[0]).toBeGreaterThan(light[2]); // R > B: warm highlights
    expect(dark[2]).toBeGreaterThan(dark[0]); // B > R: cool shadows
    // And the grade genuinely separates the zones rather than flattening them.
    expect(light[0] / light[2]).toBeGreaterThan(dark[0] / dark[2]);
  });

  it("clamps desaturation at fully grey, so a value past 1 cannot invert colour", () => {
    // mix(colour, grey, t) with t > 1 extrapolates through grey into
    // complementary colours. The authored value is kept verbatim; the clamp
    // lives at the point of use.
    const glsl = gradeGlsl({ ...identity, desaturation: 4, desaturationDark: 4 });
    expect(glsl).toContain("clamp( gradeD, 0.0, 1.0 )");
  });

  it("emits float literals GLSL will accept", () => {
    expect(gradeGlsl(identity)).toContain("gradeLight = vec3( 1.000000, 1.000000, 1.000000 )");
  });
});

describe("grade — install", () => {
  it("switches the renderer to CustomToneMapping and back to ACES", () => {
    const renderer = { toneMapping: THREE.ACESFilmicToneMapping } as THREE.WebGLRenderer;
    const pristine = THREE.ShaderChunk.tonemapping_pars_fragment;

    applyGrade(renderer, resolveOk(DOME).grade);
    expect(renderer.toneMapping).toBe(THREE.CustomToneMapping);
    expect(THREE.ShaderChunk.tonemapping_pars_fragment).not.toBe(pristine);
    expect(THREE.ShaderChunk.tonemapping_pars_fragment).toContain("gradeLight");

    applyGrade(renderer, undefined);
    expect(renderer.toneMapping).toBe(THREE.ACESFilmicToneMapping);
    expect(THREE.ShaderChunk.tonemapping_pars_fragment).toBe(pristine);
  });

  it("leaves no trace of a previous world's grade", () => {
    const renderer = { toneMapping: THREE.ACESFilmicToneMapping } as THREE.WebGLRenderer;
    applyGrade(renderer, resolveOk(DOME).grade);
    const first = THREE.ShaderChunk.tonemapping_pars_fragment;
    applyGrade(renderer, resolveOk("grade { dark-tint: 0.5 0.5 0.5 }").grade);
    const second = THREE.ShaderChunk.tonemapping_pars_fragment;
    // Substitution is against the pristine chunk each time, never against the
    // already-substituted one, so a grade never accumulates.
    expect(second).not.toBe(first);
    expect(second).toContain("gradeDark = vec3( 0.500000, 0.500000, 0.500000 )");
    expect(second).not.toContain("1.051430"); // dome's dark-tint blue is gone
    expect(second.match(/CustomToneMapping/g)?.length).toBe(first.match(/CustomToneMapping/g)?.length);
    applyGrade(renderer, undefined);
  });
});
