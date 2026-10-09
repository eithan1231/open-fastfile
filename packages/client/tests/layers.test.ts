// Layered world materials (src/scene/layers.ts): what the glTF extension
// resolves to, and what each layer mode compiles into the fragment shader.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import type { GLTFParser } from "three/examples/jsm/loaders/GLTFLoader.js";
import { applyLayers, LAYERS_EXTENSION, layersOf, layersPlugin } from "../src/scene/layers.js";

function compiled(material: THREE.Material): THREE.WebGLProgramParametersWithUniforms {
  const shader = {
    uniforms: {},
    vertexShader: THREE.ShaderLib.physical.vertexShader,
    fragmentShader: THREE.ShaderLib.physical.fragmentShader,
  } as unknown as THREE.WebGLProgramParametersWithUniforms;
  material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
  return shader;
}

/** Just enough of GLTFParser for the plugin: the JSON, the associations, and a texture per index. */
function fakeParser(layers: unknown[], materials: THREE.Material[]): { parser: GLTFParser; textures: THREE.Texture[] } {
  const textures = [new THREE.Texture(), new THREE.Texture(), new THREE.Texture()];
  const parser = {
    json: { materials: [{ extensions: { [LAYERS_EXTENSION]: { layers } } }] },
    associations: new Map(materials.map((m) => [m, { materials: 0 }])),
    getDependency: (type: string, index: number) => Promise.resolve(type === "texture" ? textures[index] : undefined),
  } as unknown as GLTFParser;
  return { parser, textures };
}

describe("layersPlugin", () => {
  it("gives every material made from a layered glTF material its layers, in sRGB", async () => {
    // GLTFLoader clones a material per vertex-colour variant; both are associated with index 0.
    const source = new THREE.MeshStandardMaterial();
    const clone = source.clone();
    const { parser, textures } = fakeParser(
      [
        { mode: "blend", texture: { index: 2 }, attribute: "_LAYER1" },
        { mode: "multiply", texture: { index: 0 }, attribute: "_LAYER2" },
      ],
      [source, clone],
    );

    await layersPlugin(parser).afterRoot!({} as never);

    for (const material of [source, clone]) {
      expect(layersOf(material).map((l) => [l.mode, l.map, l.attribute])).toEqual([
        ["blend", textures[2], "_layer1"],
        ["multiply", textures[0], "_layer2"],
      ]);
    }
    expect(textures[2]!.colorSpace).toBe(THREE.SRGBColorSpace);
  });

  it("stops at the first layer it cannot draw rather than shifting the next into its place", async () => {
    const material = new THREE.MeshStandardMaterial();
    const { parser } = fakeParser(
      [
        { mode: "blend", texture: { index: 0 }, attribute: "_LAYER1" },
        { mode: "overlay", texture: { index: 1 }, attribute: "_LAYER2" },
        { mode: "add", texture: { index: 2 }, attribute: "_LAYER3" },
      ],
      [material],
    );

    await layersPlugin(parser).afterRoot!({} as never);

    expect(layersOf(material).map((l) => l.mode)).toEqual(["blend"]);
  });

  it("skips objects with no association, or every collision.glb fails to load", async () => {
    const material = new THREE.MeshStandardMaterial();
    const { parser } = fakeParser([{ mode: "blend", texture: { index: 0 }, attribute: "_LAYER1" }], [material]);
    (parser.associations as Map<unknown, unknown>).set(new THREE.MeshStandardMaterial(), undefined);

    await layersPlugin(parser).afterRoot!({} as never);

    expect(layersOf(material).map((l) => l.mode)).toEqual(["blend"]);
  });
});

describe("applyLayers", () => {
  it("draws each layer over the base colour before the vertex colour and the lighting", () => {
    const material = new THREE.MeshStandardMaterial();
    const map = new THREE.Texture();
    applyLayers(material, [
      { mode: "blend", map, attribute: "_layer1" },
      { mode: "test", map, attribute: "_layer2" },
    ]);
    const shader = compiled(material);

    expect(shader.uniforms.layerMap0!.value).toBe(map);
    expect(shader.vertexShader).toContain("attribute vec3 _layer1;");
    expect(shader.vertexShader).toContain("vLayer1 = _layer2;");
    const fragment = shader.fragmentShader;
    const map0 = fragment.indexOf("#include <map_fragment>");
    const blend = fragment.indexOf("mix( diffuseColor.rgb, c.rgb, c.a * w )");
    const test = fragment.indexOf("if ( c.a * w >= 0.5 ) diffuseColor.rgb = c.rgb;");
    expect(blend).toBeGreaterThan(map0);
    expect(test).toBeGreaterThan(blend); // in the game's order: layer 2 lands on layer 1's result
    expect(fragment.indexOf("#include <color_fragment>")).toBeGreaterThan(test);
    expect(fragment.indexOf("#include <lights_fragment_begin>")).toBeGreaterThan(test);
  });

  it("compiles one program per combination of modes", () => {
    const map = new THREE.Texture();
    const a = new THREE.MeshStandardMaterial();
    const b = new THREE.MeshStandardMaterial();
    applyLayers(a, [{ mode: "blend", map, attribute: "_layer1" }]);
    applyLayers(b, [{ mode: "multiply", map, attribute: "_layer1" }]);
    expect(a.customProgramCacheKey()).not.toBe(b.customProgramCacheKey());
  });
});
