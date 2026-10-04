// The game's flag vertex wind (src/scene/flag.ts): which materials get it and
// what it compiles into their vertex shader.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { applyFlagWind } from "../src/scene/flag.js";

function meshWith(userData: Record<string, unknown>): THREE.Mesh {
  const material = new THREE.MeshStandardMaterial();
  material.userData = userData;
  return new THREE.Mesh(new THREE.BoxGeometry(), material);
}

function compiled(material: THREE.Material): THREE.WebGLProgramParametersWithUniforms {
  const shader = {
    uniforms: {},
    vertexShader: THREE.ShaderLib.physical.vertexShader,
    fragmentShader: THREE.ShaderLib.physical.fragmentShader,
  } as unknown as THREE.WebGLProgramParametersWithUniforms;
  material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
  return shader;
}

describe("applyFlagWind", () => {
  it("patches only the materials the exporter marked as flags, once", () => {
    const root = new THREE.Group();
    root.add(meshWith({ flag: { speed: 1.22, offset: 0 } }), meshWith({ castsShadow: true }));
    const clock = { value: 0 };
    expect(applyFlagWind(root, clock)).toBe(1);
    expect(applyFlagWind(root, clock)).toBe(0); // shared materials are visited again by every placement
  });

  it("moves vertices along the normal, weighted by the vertex's flag weight and driven by the shared clock", () => {
    const mesh = meshWith({ flag: { speed: 1.22, offset: 0.5 } });
    const clock = { value: 3 };
    applyFlagWind(mesh, clock);
    const material = mesh.material as THREE.Material;
    const shader = compiled(material);

    expect(shader.uniforms.flagTime).toBe(clock); // by reference: the animator advances it
    expect((shader.uniforms.flagParams!.value as THREE.Vector2).toArray()).toEqual([1.22, 0.5]);
    expect(shader.vertexShader).toContain("attribute float _flag_weight;");
    // After begin_vertex, so the offset lands before skinning and the model/instance transform.
    const begin = shader.vertexShader.indexOf("#include <begin_vertex>");
    const offset = shader.vertexShader.indexOf("transformed += normalize( objectNormal )");
    expect(offset).toBeGreaterThan(begin);
    expect(shader.vertexShader.indexOf("#include <project_vertex>")).toBeGreaterThan(offset);
    expect(material.customProgramCacheKey()).toBe("flag-wind");
  });
});
