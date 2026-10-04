// Animated `model` placements: `animate:` in the DSL, the rig the AssetStore
// keeps beside the baked mesh, the placement build, and engine/animator.ts.

import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { parseWorldFile } from "@3d/shared/dsl/parser.js";
import { resolveWorld } from "@3d/shared/dsl/resolve.js";
import type { ResolvedObject } from "@3d/shared/dsl/resolved.js";
import { Animator, phaseOf } from "../src/engine/animator.js";
import { bindPoseDepthMaterial, sampleAnimatedBounds, type AnimatedPlacement } from "../src/scene/animation.js";
import { AssetStore } from "../src/scene/assets.js";
import { buildModelMesh } from "../src/scene/models.js";

/** A glTF-like scene: two bones, a quad whose top half follows `tip`, and a clip that swings `tip` 90° over a second. */
function riggedScene(): THREE.Group {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0], 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
  geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4));
  geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4));
  geometry.setIndex([0, 1, 2, 1, 3, 2]);

  const root = new THREE.Bone();
  root.name = "root";
  const tip = new THREE.Bone();
  tip.name = "tip";
  tip.position.set(0, 1, 0);
  root.add(tip);

  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshStandardMaterial());
  mesh.name = "surf";
  mesh.add(root);
  mesh.bind(new THREE.Skeleton([root, tip]));

  const scene = new THREE.Group();
  scene.add(mesh);
  const turned = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
  scene.animations = [new THREE.AnimationClip("wave", 1, [new THREE.QuaternionKeyframeTrack("tip.quaternion", [0, 1], [0, 0, 0, 1, ...turned.toArray()])])];
  return scene;
}

function storeOf(scene: () => THREE.Group = riggedScene) {
  return new AssetStore({ gltf: vi.fn(async () => scene()), texture: vi.fn(() => new THREE.Texture()) });
}

function placement(animation?: string): ResolvedObject {
  return {
    id: 0,
    tags: [],
    asset: "arm",
    position: { x: 3, y: 0, z: -2 },
    rotation: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1 },
    size: { x: 1, y: 1, z: 1 },
    collide: "none",
    visible: true,
    animation,
  };
}

async function build(obj: ResolvedObject, store = storeOf()) {
  const pending: Promise<void>[] = [];
  const animated: AnimatedPlacement[] = [];
  const group = buildModelMesh(obj, { name: "arm", source: "arm.glb" }, { baseUrl: "/w/", pending, store, animated });
  await Promise.all(pending);
  const meshes: THREE.Mesh[] = [];
  group.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      meshes.push(o);
    }
  });
  return { group, animated, meshes };
}

function tipOf(root: THREE.Object3D): THREE.Bone {
  return root.getObjectByName("tip") as THREE.Bone;
}

describe("animate:", () => {
  const resolve = (src: string) => resolveWorld(parseWorldFile(src, "w.world").ast.statements);

  it("names the clip a model loops", () => {
    const { world, diagnostics } = resolve(`
      world { name: "W" }
      asset windmill { source: "p/windmill.glb" }
      group { model { asset: windmill, size: 1 1 1, animate: "windmill_spin_med" } }
    `);
    expect(diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
    expect(world!.topLevelObjects[0]!.animation).toBe("windmill_spin_med");
  });

  it("belongs to models only", () => {
    const { diagnostics } = resolve(`
      world { name: "W" }
      light l { type: point, at: 0 1 0, animate: "spin" }
    `);
    expect(diagnostics.some((d) => d.severity === "error" && d.message.includes("animate"))).toBe(true);
  });
});

describe("AssetStore, for an asset with clips", () => {
  it("keeps the rig and its clips beside the baked mesh", async () => {
    const loaded = (await storeOf().model("/w/arm.glb"))!;
    let bakedSkins = 0;
    loaded.scene.traverse((o) => (bakedSkins += o instanceof THREE.SkinnedMesh ? 1 : 0));
    expect(bakedSkins).toBe(0); // still placements are baked, so instancing can pool them
    expect(loaded.rig!.clips.map((c) => c.name)).toEqual(["wave"]);
    expect(loaded.rig!.scene.getObjectByName("surf")).toBeInstanceOf(THREE.SkinnedMesh);
  });

  it("keeps no rig for an asset without clips", async () => {
    const still = () => {
      const scene = riggedScene();
      scene.animations = [];
      return scene;
    };
    expect((await storeOf(still).model("/w/arm.glb"))!.rig).toBeUndefined();
  });

  it("frees the rig's skinned geometry and its shadow materials on dispose", async () => {
    const store = storeOf();
    const loaded = (await store.model("/w/arm.glb"))!;
    const rigMesh = loaded.rig!.scene.getObjectByName("surf") as THREE.SkinnedMesh;
    const depth = store.bindPoseDepth("/w/arm.glb", rigMesh.material as THREE.Material);
    expect(store.bindPoseDepth("/w/arm.glb", rigMesh.material as THREE.Material)).toBe(depth);
    let geometryGone = false;
    let depthGone = false;
    rigMesh.geometry.addEventListener("dispose", () => (geometryGone = true));
    depth.addEventListener("dispose", () => (depthGone = true));
    store.dispose();
    expect([geometryGone, depthGone]).toEqual([true, true]);
  });
});

describe("an animate: placement", () => {
  it("clones the rig, shadows in the bind pose and is handed to the animator", async () => {
    const { animated, meshes } = await build(placement("wave"));
    expect(meshes).toHaveLength(1);
    expect(meshes[0]).toBeInstanceOf(THREE.SkinnedMesh);
    expect(meshes[0]!.customDepthMaterial).toBeInstanceOf(THREE.MeshDepthMaterial);
    expect(animated).toHaveLength(1);
    expect(animated[0]!.clip.name).toBe("wave");
  });

  it("gets its own bones, so one placement's pose never moves another", async () => {
    const store = storeOf();
    const a = await build(placement("wave"), store);
    const b = await build(placement("wave"), store);
    expect(tipOf(a.animated[0]!.root)).not.toBe(tipOf(b.animated[0]!.root));
  });

  it("stands still, with a warning naming the clips there are, when its clip is not in the asset", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { animated, meshes } = await build(placement("wav"));
    expect(animated).toHaveLength(0);
    expect(meshes[0]).not.toBeInstanceOf(THREE.SkinnedMesh);
    expect(warn.mock.calls[0]![0]).toContain('no clip "wav" (it has "wave")');
    warn.mockRestore();
  });

  it("builds a still placement of the same asset from the baked mesh", async () => {
    const { animated, meshes } = await build(placement());
    expect(animated).toHaveLength(0);
    expect(meshes[0]).not.toBeInstanceOf(THREE.SkinnedMesh);
  });
});

describe("sampleAnimatedBounds", () => {
  it("covers every pose the clips reach, then returns the rig to rest", () => {
    const rig = riggedScene();
    rig.updateMatrixWorld(true);
    const mesh = rig.getObjectByName("surf") as THREE.SkinnedMesh;
    mesh.computeBoundingBox();
    const atRest = mesh.boundingBox!.clone();

    sampleAnimatedBounds(rig, rig.animations);
    // Swung upright, the quad's top corner reaches y = 2; at rest nothing is above 1.
    expect(mesh.boundingBox!.max.y).toBeCloseTo(2, 5);
    expect(mesh.boundingBox!.containsBox(atRest)).toBe(true);
    expect(mesh.boundingSphere!.radius).toBeGreaterThan(0);
    expect(tipOf(rig).quaternion.equals(new THREE.Quaternion())).toBe(true);
  });
});

describe("bindPoseDepthMaterial", () => {
  it("drops skinning from the shadow pass", () => {
    const material = bindPoseDepthMaterial();
    const shader = {
      vertexShader: "#include <skinbase_vertex>\n#include <begin_vertex>\n#include <skinning_vertex>",
    } as THREE.WebGLProgramParametersWithUniforms;
    material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
    expect(shader.vertexShader).not.toContain("skinning_vertex");
    expect(shader.vertexShader).not.toContain("skinbase_vertex");
    expect(shader.vertexShader).toContain("begin_vertex");
    expect(material.depthPacking).toBe(THREE.RGBADepthPacking); // what three's own shadow depth material uses
  });
});

describe("Animator", () => {
  function frozenPlacement(): AnimatedPlacement {
    const rig = riggedScene();
    const parent = new THREE.Group();
    parent.position.set(3, 0, -2);
    parent.add(rig);
    parent.updateMatrixWorld(true);
    parent.traverse((o) => (o.matrixAutoUpdate = false)); // as WorldSession's "freeze matrices" leaves it
    return { root: rig, clip: rig.animations[0]! };
  }

  it("moves bones the build froze, and keeps their world matrices current", () => {
    const animator = new Animator();
    const placed = frozenPlacement();
    const tip = tipOf(placed.root);
    animator.attach([placed]);
    const start = tip.getWorldQuaternion(new THREE.Quaternion()).clone();
    animator.update(0.25);
    const after = new THREE.Quaternion().setFromRotationMatrix(tip.matrixWorld);
    expect(tip.matrixAutoUpdate).toBe(true);
    expect(after.angleTo(start)).toBeGreaterThan(0.1);
    expect(animator.count).toBe(1);
  });

  it("advances the flag-wind clock with the mixers", () => {
    const animator = new Animator();
    const clock = { value: 2 };
    animator.attach([], clock);
    animator.update(0.5);
    expect(clock.value).toBe(2.5);
    animator.clear();
    animator.update(1);
    expect(clock.value).toBe(2.5); // cleared: the old world's clock is no longer driven
  });

  it("holds time while paused, for a held screenshot pose", () => {
    const animator = new Animator();
    const placed = frozenPlacement();
    const clock = { value: 0 };
    animator.attach([placed], clock);
    animator.paused = true;
    const before = tipOf(placed.root).quaternion.clone();
    animator.update(0.5);
    expect(tipOf(placed.root).quaternion.equals(before)).toBe(true);
    expect(clock.value).toBe(0);
  });

  it("stops everything on clear", () => {
    const animator = new Animator();
    const placed = frozenPlacement();
    animator.attach([placed]);
    animator.clear();
    const before = tipOf(placed.root).quaternion.clone();
    animator.update(0.5);
    expect(animator.count).toBe(0);
    expect(tipOf(placed.root).quaternion.equals(before)).toBe(true);
  });
});

describe("phaseOf", () => {
  it("is deterministic, in [0, 1), and differs between neighbours", () => {
    const a = phaseOf(new THREE.Vector3(12.5, -7.8, -8.2));
    expect(phaseOf(new THREE.Vector3(12.5, -7.8, -8.2))).toBe(a);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(1);
    expect(phaseOf(new THREE.Vector3(13.5, -7.8, -8.2))).not.toBeCloseTo(a, 2);
  });
});
