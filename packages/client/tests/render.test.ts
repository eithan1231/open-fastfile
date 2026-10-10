// The render mechanisms features plug into (engine/render/): patches compose
// rather than overwrite, passes run and prewarm in their declared order, and
// what the scene keeps survives a world being swapped.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { addPatch, hasPatch } from "../src/engine/render/patches.js";
import { FramePipeline, PASSES, type PassContext } from "../src/engine/render/pipeline.js";
import { SceneRoots } from "../src/engine/render/roots.js";
import { applyFlagMaterial } from "../src/scene/flag.js";
import { applyLayers } from "../src/scene/layers.js";

function compiled(material: THREE.Material): THREE.WebGLProgramParametersWithUniforms {
  const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader };
  material.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, {} as THREE.WebGLRenderer);
  return shader as unknown as THREE.WebGLProgramParametersWithUniforms;
}

describe("shader patches", () => {
  it("keeps both of two features' patches on one material, in order, in one key", () => {
    const material = new THREE.MeshStandardMaterial();
    applyLayers(material, [{ mode: "blend", map: new THREE.Texture(), attribute: "_layer1" }]);
    applyFlagMaterial(material, { speed: 1, offset: 0 }, { value: 0 });

    const shader = compiled(material);
    expect(shader.fragmentShader).toContain("layerMap0");
    expect(shader.vertexShader).toContain("_flag_weight");
    expect(material.customProgramCacheKey()).toBe("layers:blend@_layer1|flag-wind");
  });

  it("replaces a patch added again under the same name rather than running it twice", () => {
    const material = new THREE.MeshBasicMaterial();
    let runs = 0;
    const patch = { name: "x", key: "x1", apply: () => void runs++ };
    addPatch(material, patch);
    addPatch(material, { ...patch, key: "x2" });
    compiled(material);
    expect(runs).toBe(1);
    expect(material.customProgramCacheKey()).toBe("x2");
    expect(hasPatch(material, "x")).toBe(true);
    expect(hasPatch(new THREE.MeshBasicMaterial(), "x")).toBe(false);
  });
});

describe("frame pipeline", () => {
  const ctx = { renderer: { shadowMap: { needsUpdate: false } }, scene: { traverse: () => {} } } as unknown as PassContext;

  it("runs the passes in PASSES order whatever order they were filled in", () => {
    const pipeline = new FramePipeline();
    const ran: string[] = [];
    for (const name of [...PASSES].reverse()) {
      pipeline.use(name, { render: () => void ran.push(name) });
    }
    pipeline.render(ctx);
    expect(ran).toEqual([...PASSES]);
    expect(pipeline.format()).toContain("world");
  });

  it("prewarms every pass in order, then draws one frame with the shadow map invalidated", async () => {
    const pipeline = new FramePipeline();
    const log: string[] = [];
    pipeline.use("viewmodel", { render: () => void log.push("render viewmodel"), prewarm: async () => void log.push("prewarm viewmodel") });
    pipeline.use("world", {
      render: (c) => void log.push(`render world, shadows ${c.renderer.shadowMap.needsUpdate}`),
      prewarm: async () => void log.push("prewarm world"),
    });
    await pipeline.prewarm(ctx);
    expect(log).toEqual([
      "prewarm world",
      "prewarm viewmodel",
      "render world, shadows false",
      "render viewmodel",
      "render world, shadows true",
      "render viewmodel",
    ]);
  });
});

describe("scene roots", () => {
  it("swaps the world and its sky while kept roots stay", () => {
    const scene = new THREE.Scene();
    const roots = new SceneRoots(scene);
    const kept = new THREE.Group();
    roots.keep(kept);
    const first = new THREE.Group();
    const second = new THREE.Group();
    const sky = new THREE.Color("#123456");

    roots.setWorld(first, { background: sky, fog: new THREE.FogExp2(sky, 0.01) });
    roots.setWorld(second);
    expect(scene.children).toEqual([kept, second]);
    expect(scene.background).toBeNull();
    expect(scene.fog).toBeNull();

    roots.setWorld(undefined);
    expect(scene.children).toEqual([kept]);
  });
});
