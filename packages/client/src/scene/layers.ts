// A layered world material: up to three textures drawn over the base colour in
// one pass, each weighted per vertex, as Black Ops' generated `*` materials are.
// The exporter writes them as the `COD_material_layers` glTF extension and a
// `_LAYERk` attribute (u, v, weight) per layer (scripts/cod/shell.py); each
// mode is the game's lit pixel shader's own (docs/cod/reference.md#layered-materials).

import * as THREE from "three";
import type { GLTFLoaderPlugin, GLTFParser } from "three/examples/jsm/loaders/GLTFLoader.js";
import { addPatch } from "../engine/render/patches.js";

export const LAYERS_EXTENSION = "COD_material_layers";

export type LayerMode = "blend" | "multiply" | "add" | "test";

export interface MaterialLayer {
  mode: LayerMode;
  map: THREE.Texture;
  /** The geometry attribute holding this layer's (u, v, weight), as GLTFLoader names it: `_layer1`.. */
  attribute: string;
}

interface LayerDef {
  mode: string;
  texture: { index: number };
  attribute: string;
}

const MODES: readonly string[] = ["blend", "multiply", "add", "test"] satisfies LayerMode[];

// `w` is the layer's vertex weight and `c` its colour. Each line is one mode of
// T5's `pimp_shader_layer_lmap_*`, applied to the base before lighting, so the
// lightmap and fog land on the result once.
const MODE_GLSL: Record<LayerMode, string> = {
  blend: "diffuseColor.rgb = mix( diffuseColor.rgb, c.rgb, c.a * w );",
  multiply: "diffuseColor.rgb *= mix( vec3( 1.0 ), c.rgb, w );",
  add: "diffuseColor.rgb += c.rgb * c.a * w;",
  test: "if ( c.a * w >= 0.5 ) diffuseColor.rgb = c.rgb;",
};

// Not `userData`: `Material.copy` deep-copies that through JSON, which a texture does not survive.
const applied = new WeakMap<THREE.Material, MaterialLayer[]>();

/** The layers drawn over `material`, if any; their maps are the material's to dispose. */
export function layersOf(material: THREE.Material): readonly MaterialLayer[] {
  return applied.get(material) ?? [];
}

/** Draw `layers` over `material`'s base colour, in order. Its geometry must carry each layer's attribute. */
export function applyLayers(material: THREE.Material, layers: MaterialLayer[]): void {
  applied.set(material, layers);
  const uniforms = layers.map((layer) => ({ value: layer.map }));
  const each = (line: (layer: MaterialLayer, k: number) => string) => layers.map(line).join("\n");

  const key = `layers:${layers.map((layer) => `${layer.mode}@${layer.attribute}`).join(",")}`;
  addPatch(material, {
    name: "layers",
    key,
    apply: (shader) => {
      uniforms.forEach((uniform, k) => (shader.uniforms[`layerMap${k}`] = uniform));
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", `#include <common>\n${each((layer, k) => `attribute vec3 ${layer.attribute};\nvarying vec3 vLayer${k};`)}`)
        .replace("#include <uv_vertex>", `#include <uv_vertex>\n${each((layer, k) => `vLayer${k} = ${layer.attribute};`)}`);
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", `#include <common>\n${each((_, k) => `uniform sampler2D layerMap${k};\nvarying vec3 vLayer${k};`)}`)
        .replace(
          "#include <map_fragment>",
          `#include <map_fragment>\n${each((layer, k) => `{ vec4 c = texture2D( layerMap${k}, vLayer${k}.xy ); float w = vLayer${k}.z; ${MODE_GLSL[layer.mode]} }`)}`,
        );
    },
  });
}

/**
 * GLTFLoader plugin: resolves each material's layer textures and applies them.
 * After the root, because GLTFLoader clones a material per vertex-colour
 * variant and the clone carries no `onBeforeCompile`; the associations map
 * names the source material of every clone too.
 */
export function layersPlugin(parser: GLTFParser): GLTFLoaderPlugin {
  return {
    name: LAYERS_EXTENSION,
    afterRoot: async () => {
      const defs = (parser.json as { materials?: { extensions?: Record<string, { layers?: LayerDef[] }> }[] }).materials ?? [];
      const pending: Promise<void>[] = [];

      for (const [object, association] of parser.associations) {
        // Undefined for objects GLTFLoader made itself, such as a mesh's default material.
        const index = association?.materials;
        const defsHere = index === undefined ? undefined : defs[index]?.extensions?.[LAYERS_EXTENSION]?.layers;

        if (!(object instanceof THREE.Material) || !defsHere?.length || applied.has(object)) {
          continue;
        }

        // The first layer this cannot draw ends the list, as in the exporter: a layer drawn without the one under it is not the game's.
        const stop = defsHere.findIndex((def) => !MODES.includes(def.mode) || !/^_[A-Z0-9_]+$/.test(def.attribute));
        const usable = stop === -1 ? defsHere : defsHere.slice(0, stop);
        pending.push(
          Promise.all(usable.map((def) => parser.getDependency("texture", def.texture.index) as Promise<THREE.Texture>)).then((maps) => {
            for (const map of maps) {
              map.colorSpace = THREE.SRGBColorSpace;
            }
            applyLayers(
              object,
              // GLTFLoader names a custom attribute by lower-casing it.
              usable.map((def, k) => ({ mode: def.mode as LayerMode, map: maps[k]!, attribute: def.attribute.toLowerCase() })),
            );
          }),
        );
      }

      await Promise.all(pending);
    },
  };
}
