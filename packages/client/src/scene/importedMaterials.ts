// How an imported map's materials are drawn: the render state the exporter
// carried out of the game (glTF `extras`, copied by GLTFLoader onto
// material.userData) turned into three.js settings. The reasoning behind each
// rule is in docs/engine/rendering.md#imported-materials.

import * as THREE from "three";
import { addPatch } from "../engine/render/patches.js";

type Materials = THREE.Material | THREE.Material[];

const each = (material: Materials): THREE.Material[] => (Array.isArray(material) ? material : [material]);

function firstUserData(material: Materials): Record<string, unknown> | undefined {
  return each(material)[0]?.userData;
}

/** Blended (glTF BLEND). three's shadow pass ignores blending, so a blended quad would shadow its whole rectangle. */
export function isBlended(material: Materials): boolean {
  return Array.isArray(material) ? material.every(isBlended) : material.transparent;
}

/** The game's own shadow flag where the exporter carried one; otherwise "not blended". */
export function castsShadow(material: Materials): boolean {
  const flag = firstUserData(material)?.castsShadow;
  return typeof flag === "boolean" ? flag : !isBlended(material);
}

/**
 * Render front faces into the shadow map whatever the material's culling.
 * three inverts `side` for the depth pass, which suits closed solids but drops
 * single-quad panels and thin brush slabs out of the shadow map entirely.
 */
export function setShadowSide(material: Materials): void {
  for (const mat of each(material)) {
    if (mat.side !== THREE.DoubleSide) {
      mat.shadowSide = THREE.FrontSide;
    }
  }
}

/** The sortKey below which a surface is ordinary opaque world geometry (1 on every imported map). */
export const OPAQUE_SORT_KEY = 6;

/**
 * Reproduce the game's draw order: `renderOrder` puts the overlay tiers in
 * sequence and a polygon offset in depth-buffer units separates each from the
 * coplanar surface under it. The slope factor must stay 0: any slope term
 * drags large ground planes through walls when viewed edge-on.
 */
export function applySortKey(mesh: THREE.Mesh, key: number): void {
  if (key < OPAQUE_SORT_KEY) {
    return;
  }

  mesh.renderOrder = key;

  for (const mat of each(mesh.material)) {
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = 0;
    mat.polygonOffsetUnits = -(key - OPAQUE_SORT_KEY + 1);

    if (mat.transparent) {
      mat.depthWrite = false; // an overlay must not occlude the tiers above it
    }
  }
}

/**
 * A replacement material that draws the game's blend equation, or null to keep
 * the original. glTF can only say "alpha blend"; most decals multiply or add.
 * The replacement is unlit, not tone mapped and not fogged, because it
 * modulates a wall that already went through all three, and it fades toward
 * its equation's identity by vertex alpha, which none of these equations read.
 */
export function blendedMaterialFor(source: THREE.Material, mode: string): THREE.Material | null {
  const src = source as THREE.MeshStandardMaterial;
  const mat = new THREE.MeshBasicMaterial({
    map: src.map,
    color: src.color,
    vertexColors: src.vertexColors,
    transparent: true,
    depthWrite: false,
    side: src.side,
    alphaTest: src.alphaTest,
    toneMapped: false,
    fog: false,
  });

  mat.name = src.name;
  mat.userData = { ...src.userData }; // a copy: the picker writes tags per material

  // A new material, so it carries none of the source's patches (layers, wind).
  const toward = mode === "multiply" ? "vec3( 1.0 )" : "vec3( 0.0 )";
  addPatch(mat, {
    name: "decal-fade",
    key: `decal-fade-${mode}`,
    apply: (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <opaque_fragment>",
        `#include <opaque_fragment>
       gl_FragColor.rgb = mix( ${toward}, gl_FragColor.rgb, gl_FragColor.a );`,
      );
    },
  });

  switch (mode) {
    case "multiply":
      // ZERO/SRC_COLOR, CoD's `zero/srccolor`. Not THREE.MultiplyBlending: that
      // emits a plain `blendFunc`, so its factors hit alpha too (keepAlpha).
      mat.blending = THREE.CustomBlending;
      mat.blendEquation = THREE.AddEquation;
      mat.blendSrc = THREE.ZeroFactor;
      mat.blendDst = THREE.SrcColorFactor;
      break;

    case "add":
      // ONE/ONE, not THREE.AdditiveBlending (SRC_ALPHA/ONE): these textures have no alpha.
      mat.blending = THREE.CustomBlending;
      mat.blendEquation = THREE.AddEquation;
      mat.blendSrc = THREE.OneFactor;
      mat.blendDst = THREE.OneFactor;
      break;

    case "screen":
      mat.blending = THREE.CustomBlending;
      mat.blendEquation = THREE.AddEquation;
      mat.blendSrc = THREE.OneMinusDstColorFactor;
      mat.blendDst = THREE.OneFactor;
      break;

    default:
      mat.dispose();
      return null;
  }
  keepAlpha(mat);
  return mat;
}

/**
 * Blend the colour only, leaving the framebuffer's alpha alone.
 *
 * three always creates the context with `alpha: true` and composites it
 * premultiplied, so the canvas's alpha is what the page shows through. A decal's
 * own alpha is its fade weight, not coverage — and three writes CustomBlending's
 * alpha factors from the colour ones unless they are set, so `dst.a *= src.a`
 * punches a decal-shaped hole in the frame that the compositor fills with the
 * page behind it. ZERO/ONE keeps `dst.a` exactly as the pass before it left it.
 */
export function keepAlpha(mat: THREE.Material): void {
  mat.blendEquationAlpha = THREE.AddEquation;
  mat.blendSrcAlpha = THREE.ZeroFactor;
  mat.blendDstAlpha = THREE.OneFactor;
}

/** The blend equation carried in glTF `extras`, if any. */
export function blendModeOf(material: Materials): string | undefined {
  const mode = firstUserData(material)?.blend;
  return typeof mode === "string" ? mode : undefined;
}

/** The game's draw order carried in glTF `extras`, if any. */
export function sortKeyOf(material: Materials): number | undefined {
  const key = firstUserData(material)?.sortKey;
  return typeof key === "number" ? key : undefined;
}

/** For a `decal: on` model without sort keys: pull it out of the depth fight with the surface under it. */
export function applyDecalBias(material: Materials): void {
  for (const mat of each(material)) {
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = -1;
    mat.polygonOffsetUnits = -1;
    mat.depthWrite = false;
  }
}

/**
 * Settings for a baked lightmap atlas: the second UV set, glTF's vertical
 * convention, clamped, and no mipmaps (neighbouring charts are unrelated parts
 * of the map, so mip levels bleed them into bright or dark seams).
 */
export function configureLightmapTexture(tex: THREE.Texture): THREE.Texture {
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.channel = 1;
  tex.flipY = false;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter; // with mipmaps off, a mipmapping filter samples nothing

  return tex;
}

/**
 * Hang a lightmap off every standard material under `root` whose mesh has a
 * second UV set; returns how many. These materials are shared by every
 * placement of the asset, which suits the one case this serves: a map shell,
 * placed once.
 */
export function applyLightmap(root: THREE.Object3D, tex: THREE.Texture, intensity: number): number {
  let applied = 0;
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh) || !child.geometry.getAttribute("uv1")) {
      return;
    }

    for (const mat of each(child.material)) {
      if (!(mat instanceof THREE.MeshStandardMaterial)) {
        continue;
      }

      mat.lightMapIntensity = intensity; // a uniform: set every time, or a hot reload keeps the old value

      if (mat.lightMap !== tex) {
        mat.lightMap = tex; // a compile-time define, so only on change
        mat.needsUpdate = true;
      }

      applied++;
    }
  });

  return applied;
}
