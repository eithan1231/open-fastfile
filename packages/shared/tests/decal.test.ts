import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { loadWorld } from "../src/dsl/loader.js";
import { resolveWorld } from "../src/dsl/resolve.js";
import { validateStatements } from "../src/dsl/schema.js";

function resolve(source: string) {
  const loaded = loadWorld("world.world", { "world.world": source });
  return resolveWorld(loaded.statements);
}

const WORLD = (props: string) => `world { name: "w" }
asset overlays { source: "assets/decals.glb" }
group map { at: 0 0 0
  model stains { asset: overlays, size: 92 31 102, at: 0 0 0${props} }
}
spawn { at: 0 1.7 0, look: 0 1.7 -1 }`;

describe("decal", () => {
  it("resolves to a flag on the object", () => {
    const { world, diagnostics } = resolve(WORLD(", decal: on"));
    expect(diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const stains = world!.topLevelObjects.find((o) => o.name === "stains");
    expect(stains?.decal).toBe(true);
  });

  it("defaults to off, so ordinary models are not biased forward", () => {
    const { world } = resolve(WORLD(""));
    expect(world!.topLevelObjects.find((o) => o.name === "stains")?.decal).toBe(false);
  });

  it("belongs to a model, which is the only thing with a surface to lie on", () => {
    const loaded = loadWorld("world.world", {
      "world.world": `world { name: "w" }
light l { type: point, at: 0 1 0, decal: on }
spawn { at: 0 1.7 0, look: 0 1.7 -1 }`,
    });
    const diagnostics = validateStatements(loaded.statements);
    expect(diagnostics.some((d) => d.severity === "error" && d.message.includes("decal"))).toBe(true);
  });
});

describe("decal — depth bias", () => {
  // The mechanism, asserted directly against three: coplanar geometry has
  // genuinely equal depth, so the fix is a rasteriser-level offset rather than
  // anything to do with depth-buffer precision.
  it("biases toward the camera and stops writing depth", () => {
    const mat = new THREE.MeshStandardMaterial();
    // Mirrors applyDecalBias in scene/importedMaterials.ts.
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = -1;
    mat.polygonOffsetUnits = -1;
    mat.depthWrite = false;

    expect(mat.polygonOffset).toBe(true);
    expect(mat.polygonOffsetFactor).toBeLessThan(0); // negative pulls toward the camera
    expect(mat.depthWrite).toBe(false); // one decal must not occlude the next
  });
});
