import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { blendedMaterialFor } from "../src/scene/importedMaterials.js";

function source(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true });
  m.name = "wc/ship_wall_stain1";
  m.userData = { blend: "multiply", sortKey: 9 };
  return m;
}

describe("decal blend equations", () => {
  it.each(["multiply", "add", "screen"])("leaves the canvas alpha alone (%s)", (mode) => {
    // three builds the context with alpha:true and composites it premultiplied,
    // so the canvas alpha decides what the page shows through. A decal's alpha is
    // its fade weight, not coverage: blending it into dst.a punched a
    // decal-shaped hole in the frame that the compositor filled with the page.
    const m = blendedMaterialFor(source(), mode)!;
    expect(m.blendSrcAlpha).toBe(THREE.ZeroFactor);
    expect(m.blendDstAlpha).toBe(THREE.OneFactor);
    expect(m.blendEquationAlpha).toBe(THREE.AddEquation);
  });

  it("multiplies colour with ZERO/SRC_COLOR rather than THREE.MultiplyBlending", () => {
    // MultiplyBlending emits a plain `blendFunc`, whose factors apply to alpha
    // too, and three has no way to override only the alpha half of a preset.
    const m = blendedMaterialFor(source(), "multiply")!;
    expect(m.blending).toBe(THREE.CustomBlending);
    expect(m.blendSrc).toBe(THREE.ZeroFactor);
    expect(m.blendDst).toBe(THREE.SrcColorFactor);
  });

  it("draws a stain as multiply, so the wall shows through it", () => {
    // 20 of mp_dome's 28 decal materials are `zero/srccolor`. Drawn as alpha
    // blend a stain *replaces* the wall rather than dirtying it, which is what
    // makes an imported map's decals read as vibrant opaque patches.
    const m = blendedMaterialFor(source(), "multiply")!;
    expect(m.blendSrc).toBe(THREE.ZeroFactor);
    expect(m.blendDst).toBe(THREE.SrcColorFactor);
    expect(m.transparent).toBe(true);
  });

  it("uses ONE/ONE for additive lettering, not three's AdditiveBlending", () => {
    // THREE.AdditiveBlending is SRC_ALPHA/ONE. The game asks for ONE/ONE, and
    // these textures carry no alpha channel at all — 27 of 28 are RGB JPEGs —
    // so SRC_ALPHA would be 1 by luck rather than by intent.
    const m = blendedMaterialFor(source(), "add")!;
    expect(m.blending).toBe(THREE.CustomBlending);
    expect(m.blendSrc).toBe(THREE.OneFactor);
    expect(m.blendDst).toBe(THREE.OneFactor);
    expect(m.blendEquation).toBe(THREE.AddEquation);
  });

  it("maps screen to invdestcolor/one", () => {
    const m = blendedMaterialFor(source(), "screen")!;
    expect(m.blendSrc).toBe(THREE.OneMinusDstColorFactor);
    expect(m.blendDst).toBe(THREE.OneFactor);
  });

  it("makes the decal unlit, because multiply would otherwise light it twice", () => {
    // result = decal * wall, and the wall has already been through the lighting.
    // A lit decal applies it a second time and the stain goes black in sunlight.
    const m = blendedMaterialFor(source(), "multiply")!;
    expect(m).toBeInstanceOf(THREE.MeshBasicMaterial);
    expect(m).not.toBeInstanceOf(THREE.MeshStandardMaterial);
  });

  it("carries the identity forward so picking and sortKey still work", () => {
    const src = source();
    const m = blendedMaterialFor(src, "multiply")!;
    expect(m.name).toBe(src.name);
    expect(m.userData.sortKey).toBe(9);
  });

  /** Run the material's onBeforeCompile against three's real chunk and return the GLSL. */
  function compiled(mode: string): string {
    const m = blendedMaterialFor(source(), mode)!;
    const shader = { fragmentShader: "void main() {\n#include <opaque_fragment>\n}" } as THREE.WebGLProgramParametersWithUniforms;
    m.onBeforeCompile(shader, null as unknown as THREE.WebGLRenderer);
    return shader.fragmentShader;
  }

  it("fades a multiply decal toward white, its no-effect colour", () => {
    // None of these equations reads src.a — `zero/srccolor` is `dst = src * dst`
    // — so the vertex alpha gradient is invisible to the blend and has to be
    // pre-multiplied into the colour. Without it every decal keeps the hard edge
    // of its own quad, and these textures are not white at their borders:
    // ship_wall_stain1 is 141/255 along its edge, a 44% darkening in a straight line.
    expect(compiled("multiply")).toContain("mix( vec3( 1.0 ), gl_FragColor.rgb, gl_FragColor.a )");
  });

  it("fades an additive decal toward black instead", () => {
    // `src + dst` leaves dst alone when src is black, not when it is white.
    expect(compiled("add")).toContain("mix( vec3( 0.0 ), gl_FragColor.rgb, gl_FragColor.a )");
    expect(compiled("screen")).toContain("mix( vec3( 0.0 ), gl_FragColor.rgb, gl_FragColor.a )");
  });

  it("is not tone mapped, so it modulates the wall instead of being crushed", () => {
    // three tone-maps in each material's own fragment shader and blends after,
    // so a multiply decal computes ACES(decal) * ACES(wall) where the film gives
    // ACES(decal * wall). ACES is an S-curve, not a power law: at exposure 0.35
    // a 0.2 decal over a 2.0 wall lands 4.2x too dark, 7.7x over a 4.0 wall. The
    // error grows with wall brightness, which is why it shows as black blobs on
    // lit surfaces and why the exposure slider never fixed it.
    for (const mode of ["multiply", "add", "screen"]) {
      expect(blendedMaterialFor(source(), mode)!.toneMapped, mode).toBe(false);
    }
  });

  it("stays transparent, or the fade is silently discarded", () => {
    // three's opaque_fragment forces `diffuseColor.a = 1.0` under #ifdef OPAQUE,
    // which is defined for any material that is not transparent. That would pin
    // the fade at fully-applied everywhere.
    for (const mode of ["multiply", "add", "screen"]) {
      expect(blendedMaterialFor(source(), mode)!.transparent, mode).toBe(true);
    }
  });

  it("is not fogged, or a distant stain darkens the wall instead of fading out", () => {
    // Every world with a `sky:` gets exponential fog, and three fogs a material
    // toward the sky colour *after* the fade. None of these equations treat the
    // sky colour as "no effect": a multiply decal fogged to a 0.5 grey darkens
    // the wall by half at the fog distance, faded quad included, so every stain
    // reappears as a hard grey rectangle at range; an additive one glows.
    for (const mode of ["multiply", "add", "screen"]) {
      expect((blendedMaterialFor(source(), mode) as THREE.MeshBasicMaterial).fog, mode).toBe(false);
    }
  });

  it("does not let two fade variants share one compiled program", () => {
    const a = blendedMaterialFor(source(), "multiply")!;
    const b = blendedMaterialFor(source(), "add")!;
    expect(a.customProgramCacheKey()).not.toBe(b.customProgramCacheKey());
  });

  it("leaves an ordinary alpha-blended material alone", () => {
    // The shell's 54 blended materials really are srcalpha/invsrcalpha; glTF's
    // BLEND already expresses that, so there is nothing to rebuild.
    expect(blendedMaterialFor(source(), "alpha")).toBeNull();
  });
});
