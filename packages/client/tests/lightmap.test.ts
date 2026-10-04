// Baked lighting on an imported `model`.
//
// The map shell's light is overwhelmingly baked: without the lightmap the
// shell is lit by one directional light plus ambient and reads flat and cold
// next to the game. The subtle part is *which UVs it is sampled with* — three
// defaults every texture to UV channel 0, and a shell's channel-0 UVs tile
// into the hundreds, so getting that wrong smears one atlas texel over the
// whole map rather than failing visibly. Hence the texture-settings tests.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { parseWorldFile } from "@3d/shared/dsl/parser.js";
import { resolveWorld } from "@3d/shared/dsl/resolve.js";
import { hasErrors } from "@3d/shared/dsl/diagnostics.js";
import { configureLightmapTexture, applyLightmap } from "../src/scene/importedMaterials.js";
import { LIGHTMAP_SCALE, AMBIENT_SCALE } from "../src/scene/lights.js";

function resolve(src: string) {
  const { ast } = parseWorldFile(src, "world.world");
  return resolveWorld(ast.statements);
}

// `model` is not a top-level type — it lives in a room or a group, which is
// how worlds/dome-mw3 declares its shell too.
const SHELL = `
  world { name: "W" }
  asset world { source: "assets/world.glb" }
  group map {
    model shell { asset: world, size: 10 10 10, lightmap: "assets/lightmap.png", lightmap-intensity: 0.8 }
  }
`;

describe("lightmap — schema and resolve", () => {
  it("resolves the path and intensity onto the model", () => {
    const { world, diagnostics } = resolve(SHELL);
    expect(hasErrors(diagnostics)).toBe(false);
    const obj = world!.topLevelObjects[0]!;
    expect(obj.lightmap).toBe("assets/lightmap.png");
    expect(obj.lightmapIntensity).toBeCloseTo(0.8);
  });

  it("defaults intensity to 1", () => {
    const { world } = resolve(`
      world { name: "W" }
      asset world { source: "assets/world.glb" }
      group map { model shell { asset: world, size: 1 1 1, lightmap: "assets/lm.png" } }
    `);
    expect(world!.topLevelObjects[0]!.lightmapIntensity).toBe(1);
  });

  it("leaves lightmap undefined when not declared", () => {
    const { world } = resolve(`
      world { name: "W" }
      asset world { source: "assets/world.glb" }
      group map { model shell { asset: world, size: 1 1 1 } }
    `);
    expect(world!.topLevelObjects[0]!.lightmap).toBeUndefined();
  });

  it("is a model-only property — a box may not carry one", () => {
    const { diagnostics } = resolve(`
      world { name: "W" }
      room hall { size: 4 4
        box { size: 1 1 1, lightmap: "assets/lm.png" }
      }
    `);
    expect(hasErrors(diagnostics)).toBe(true);
  });

  it("warns when intensity is given with no lightmap to scale", () => {
    const { diagnostics } = resolve(`
      world { name: "W" }
      asset world { source: "assets/world.glb" }
      group map { model shell { asset: world, size: 1 1 1, lightmap-intensity: 0.5 } }
    `);
    expect(diagnostics.some((d) => d.code === "unused-lightmap-intensity")).toBe(true);
    expect(hasErrors(diagnostics)).toBe(false); // a warning, not an error
  });
});

describe("lightmap — texture settings", () => {
  it("samples the second UV set, not the tiling world UVs", () => {
    // The one that silently ruins the result if wrong: three.js defaults
    // Texture.channel to 0, and a shell's channel-0 UVs run to ±190, so a
    // lightmap sampled with them smears one atlas texel over the whole map.
    expect(configureLightmapTexture(new THREE.Texture()).channel).toBe(1);
  });

  it("uses the glTF vertical convention and clamps rather than wraps", () => {
    const tex = configureLightmapTexture(new THREE.Texture());
    expect(tex.flipY).toBe(false); // uv1 came out of a glTF
    expect(tex.wrapS).toBe(THREE.ClampToEdgeWrapping); // atlas, addressed strictly 0..1
    expect(tex.wrapT).toBe(THREE.ClampToEdgeWrapping);
    expect(tex.colorSpace).toBe(THREE.SRGBColorSpace); // colour, not linear data
  });

  it("does not mipmap the atlas", () => {
    // Same hazard as the clamp above, and the same failure: an atlas's
    // neighbours are unrelated parts of the map, so every mip level averages
    // across chart boundaries. Sampled through each shell's own uv1, level 1
    // already moves the value by a mean of 15-24 of 255 and level 2 by 25-36.
    // Visible as bright or dark seams tracing chart edges, because the mip
    // level is picked from the uv1 derivative and that jumps at a seam.
    const tex = configureLightmapTexture(new THREE.Texture());
    expect(tex.generateMipmaps).toBe(false);
    // Asking for a mip chain that is not generated samples an empty one, so
    // this half is not optional.
    expect(tex.minFilter).toBe(THREE.LinearFilter);
  });
});

describe("lightmap — application", () => {
  function mesh(withUv1: boolean): THREE.Mesh {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0], 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0], 2));
    if (withUv1) {
      geo.setAttribute("uv1", new THREE.Float32BufferAttribute([0, 0], 2));
    }
    return new THREE.Mesh(geo, new THREE.MeshStandardMaterial());
  }

  it("applies to every material that has uv1 to sample it with", () => {
    const root = new THREE.Group();
    root.add(mesh(true), mesh(true));
    const tex = new THREE.Texture();

    expect(applyLightmap(root, tex, 0.7)).toBe(2);
    for (const child of root.children) {
      const mat = (child as THREE.Mesh).material as THREE.MeshStandardMaterial;
      expect(mat.lightMap).toBe(tex);
      expect(mat.lightMapIntensity).toBeCloseTo(0.7);
      // Material.needsUpdate is a setter-only property in three.js — reading it
      // gives undefined — so assert the version bump it actually causes.
      expect(mat.version).toBeGreaterThan(0); // USE_LIGHTMAP is a compile-time define
    }
  });

  it("skips meshes with no uv1 rather than sampling garbage", () => {
    const root = new THREE.Group();
    root.add(mesh(false));

    expect(applyLightmap(root, new THREE.Texture(), 1)).toBe(0);
    expect(((root.children[0] as THREE.Mesh).material as THREE.MeshStandardMaterial).lightMap).toBeNull();
  });

  it("reports zero when a whole asset lacks uv1, so the caller can warn", () => {
    const root = new THREE.Group();
    root.add(mesh(false), mesh(false));
    expect(applyLightmap(root, new THREE.Texture(), 1)).toBe(0);
  });

  it("does not recompile a material that already has this lightmap", () => {
    const root = new THREE.Group();
    root.add(mesh(true));
    const tex = new THREE.Texture();
    const mat = (root.children[0] as THREE.Mesh).material as THREE.MeshStandardMaterial;

    applyLightmap(root, tex, 1);
    const version = mat.version;
    applyLightmap(root, tex, 1);

    // `USE_LIGHTMAP` is a compile-time define, so re-assigning the texture would
    // recompile every material of a 156-material shell for no change.
    expect(mat.version).toBe(version);
  });

  it("updates intensity even when the texture is unchanged", () => {
    // The reason editing `lightmap-intensity:` appeared to do nothing at all:
    // an asset's materials and the lightmap texture are both cached for the life
    // of the page, so on the hot reload after an edit this sees the same texture
    // on the same material. Guarding intensity behind that carried the old value
    // forward until a full page reload.
    const root = new THREE.Group();
    root.add(mesh(true));
    const tex = new THREE.Texture();
    const mat = (root.children[0] as THREE.Mesh).material as THREE.MeshStandardMaterial;

    applyLightmap(root, tex, 1);
    applyLightmap(root, tex, 2.5);

    expect(mat.lightMapIntensity).toBeCloseTo(2.5);
  });
});

describe("lightmap — scale", () => {
  it("carries lightmap intensity into the same units as the world's lights", () => {
    // three.js accumulates a lightmap into the *same* irradiance total as the
    // ambient and hemisphere lights, so it has to be scaled the same way. Left
    // raw, mp_dome's bake was 0.8% of the light on a sunlit surface: a median
    // texel is 0.223 linear against an authored ambient of 0.156 * 18 = 2.81
    // and a sun of 1.2 * 20 = 24. That is why `lightmap-intensity:` looked
    // inert whatever it was set to.
    expect(LIGHTMAP_SCALE).toBe(AMBIENT_SCALE);

    const medianTexelLinear = 0.223;
    const authoredAmbient = 0.156 * AMBIENT_SCALE;
    expect(medianTexelLinear / (medianTexelLinear + authoredAmbient)).toBeLessThan(0.1); // before
    const scaled = medianTexelLinear * LIGHTMAP_SCALE;
    expect(scaled / (scaled + authoredAmbient)).toBeGreaterThan(0.5); // after: the bake leads indoors
  });
});
