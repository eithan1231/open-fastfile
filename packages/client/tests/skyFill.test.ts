import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { buildScene } from "../src/scene/scene.js";
import { loadWorld } from "@3d/shared/dsl/loader.js";
import { resolveWorld } from "@3d/shared/dsl/resolve.js";
import { AssetStore } from "../src/scene/assets.js";

function build(source: string): THREE.Group {
  const loaded = loadWorld("world.world", { "world.world": source });
  const { world, diagnostics } = resolveWorld(loaded.statements);
  expect(diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  return buildScene(world!, "", new AssetStore({ gltf: () => Promise.reject(new Error("no network in tests")) })).root;
}

function hemispheres(root: THREE.Object3D): THREE.HemisphereLight[] {
  const out: THREE.HemisphereLight[] = [];
  root.traverse((o) => {
    if (o instanceof THREE.HemisphereLight) {
      out.push(o);
    }
  });
  return out;
}

const SUN = `light sun { type: directional, at: 30 70 -92, intensity: 1.2, shadows: on }
light fill { type: ambient, intensity: 0.156, color: #def0ff }`;

describe("automatic sky fill", () => {
  it("fills an outdoor world that declares its own lights", () => {
    // Declaring a light switches off the default rig, so without this a face
    // turned away from every light renders pure black.
    const root = build(`world { name: "w", sky: #b9c6d4 }
${SUN}
spawn { at: 0 1.7 0, look: 0 1.7 -1 }`);

    expect(hemispheres(root)).toHaveLength(1);
  });

  it("does not fill a world whose geometry is lightmapped", () => {
    // A lightmap already carries the sky fill and the ground bounce, so the
    // synthetic hemisphere double-counts it. On dome-mw3 that was 10.8 against
    // the map's own authored ambient of 2.81 — nearly 4x the light the map asks
    // for, in pale blue, washing warm concrete out to flat cold white.
    const root = build(`world { name: "w", sky: #b9c6d4 }
asset shell { source: "assets/world.glb" }
group map { at: 0 0 0
  model { asset: shell, size: 100 20 100, at: 0 0 0, lightmap: "assets/lightmap.png" }
}
${SUN}
spawn { at: 0 1.7 0, look: 0 1.7 -1 }`);

    expect(hemispheres(root)).toHaveLength(0);
  });

  it("still fills a world whose models are not lightmapped", () => {
    // The other 21 imported maps: they declare an ambient of ~2 and have no
    // baked lighting at all, so this fill is what keeps them off black.
    const root = build(`world { name: "w", sky: #b9c6d4 }
asset shell { source: "assets/world.glb" }
group map { at: 0 0 0
  model { asset: shell, size: 100 20 100, at: 0 0 0 }
}
${SUN}
spawn { at: 0 1.7 0, look: 0 1.7 -1 }`);

    expect(hemispheres(root)).toHaveLength(1);
  });

  it("keeps the default rig's own hemisphere when a world declares no lights", () => {
    const root = build(`world { name: "w", sky: #b9c6d4 }
spawn { at: 0 1.7 0, look: 0 1.7 -1 }`);

    expect(hemispheres(root)).toHaveLength(1);
  });
});
