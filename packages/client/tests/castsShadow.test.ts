import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { castsShadow, isBlended } from "../src/scene/importedMaterials.js";

/** A glTF material as GLTFLoader hands it over: `extras` copied onto userData. */
function material(opts: { transparent?: boolean; castsShadow?: boolean } = {}): THREE.Material {
  const m = new THREE.MeshStandardMaterial({ transparent: opts.transparent ?? false });
  if (opts.castsShadow !== undefined) {
    m.userData = { castsShadow: opts.castsShadow };
  }
  return m;
}

describe("castsShadow — the map's own shadow flag beats the transparency proxy", () => {
  it("obeys the flag when the material carries one", () => {
    expect(castsShadow(material({ castsShadow: true }))).toBe(true);
    expect(castsShadow(material({ castsShadow: false }))).toBe(false);
  });

  it("obeys it even against what transparency would imply", () => {
    // Both directions matter, and both occur on mp_dome. Opaque cutouts —
    // chainlink, steel mesh, floor grating — carry gameFlags 0x80 and do cast
    // an alpha-tested shadow. The sky, the editor tool surfaces and eleven
    // props whose techsets say `_nocast` are opaque and cast nothing.
    const opaqueNoShadow = material({ transparent: false, castsShadow: false });
    expect(isBlended(opaqueNoShadow)).toBe(false); // the proxy would say "cast"
    expect(castsShadow(opaqueNoShadow)).toBe(false);

    const blendedShadow = material({ transparent: true, castsShadow: true });
    expect(isBlended(blendedShadow)).toBe(true); // the proxy would say "don't"
    expect(castsShadow(blendedShadow)).toBe(true);
  });

  it("falls back to the transparency proxy with no flag", () => {
    // DSL-authored worlds carry no gameFlags, and neither do the ~1% of imported
    // prop materials whose render state the exporter could not read.
    expect(castsShadow(material({ transparent: false }))).toBe(true);
    expect(castsShadow(material({ transparent: true }))).toBe(false);
  });

  it("does not mistake a missing flag for a false one", () => {
    // userData present but without the key: an imported material that carries a
    // sortKey and nothing else must still fall back rather than stop casting.
    const m = new THREE.MeshStandardMaterial({ transparent: false });
    m.userData = { sortKey: 1 };
    expect(castsShadow(m)).toBe(true);
  });

  it("reads the first material of a multi-material mesh, as sortKeyOf does", () => {
    expect(castsShadow([material({ castsShadow: false }), material({ castsShadow: true })])).toBe(false);
  });
});
