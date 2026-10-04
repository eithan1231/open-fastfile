// An imported map's collision mesh (src/scene/collision.ts). It is the largest
// single file a world loads — up to 400k triangles — and it now comes from the
// AssetStore, so a hot reload of one `.world` line does not refetch it (P9).
//
// The build copies the store's meshes rather than using them: both this code
// and collider view overwrite `material` on what they are handed, and the
// store's copy has to survive for the next mount.

import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { AssetStore } from "../src/scene/assets.js";
import { buildCollisionMesh } from "../src/scene/collision.js";
import { HIDDEN_COLLIDER } from "../src/scene/materials.js";

/** A collision glTF as the exporter writes it: one node per group, the decoded bits in its extras. */
function collisionGltf(): THREE.Group {
  const scene = new THREE.Group();
  const node = new THREE.Group();
  node.position.set(0, 0, -5); // a node transform the build has to keep
  node.userData = {
    group: "clip:0x08030000",
    contents: "0x08030000",
    blocks: ["player", "ai"],
    brushes: 2,
    brushStarts: [0, 12],
    collides: true,
  };
  node.add(new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshStandardMaterial()));
  scene.add(node);
  return scene;
}

function storeWith(): { store: AssetStore; loadGltf: ReturnType<typeof vi.fn> } {
  const loadGltf = vi.fn(async () => collisionGltf());
  return { store: new AssetStore({ gltf: loadGltf, texture: () => new THREE.Texture() }), loadGltf };
}

/** Build the mesh and wait for the load behind it. */
async function build(store: AssetStore): Promise<THREE.Object3D> {
  const pending: Promise<void>[] = [];
  const group = buildCollisionMesh("assets/collision.glb", "/worlds/interchange-mw3/", pending, store);
  await Promise.all(pending);
  return group;
}

function meshesOf(root: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  root.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      out.push(o);
    }
  });
  return out;
}

describe("buildCollisionMesh", () => {
  it("fetches the file once, however many times a world is mounted", async () => {
    const { store, loadGltf } = storeWith();
    const first = await build(store);
    const second = await build(store);

    expect(loadGltf).toHaveBeenCalledTimes(1);
    expect(loadGltf).toHaveBeenCalledWith("/worlds/interchange-mw3/assets/collision.glb");
    // The same geometry, so the second mount rebuilds no BVH either.
    expect(meshesOf(second)[0]!.geometry).toBe(meshesOf(first)[0]!.geometry);
    expect(meshesOf(second)[0]).not.toBe(meshesOf(first)[0]);
  });

  it("carries the group's extras down onto the mesh, flattened into place", async () => {
    const { store } = storeWith();
    const mesh = meshesOf(await build(store))[0]!;

    expect(mesh.userData).toMatchObject({
      collisionMesh: true,
      collide: true,
      clipGroup: "clip:0x08030000",
      collisionGroup: "clip:0x08030000",
      clipContents: "0x08030000",
      clipBlocks: ["player", "ai"],
      clipBrushes: 2,
      brushStarts: [0, 12],
      clipOnly: true,
    });
    mesh.updateMatrixWorld(true);
    expect(mesh.position.toArray()).toEqual([0, 0, -5]); // the glTF node's own transform
  });

  it("hides the copy by material and leaves the store's own meshes alone", async () => {
    const { store } = storeWith();
    const built = meshesOf(await build(store))[0]!;
    const stored = meshesOf((await store.gltf("/worlds/interchange-mw3/assets/collision.glb"))!.scene)[0]!;

    expect(built.material).toBe(HIDDEN_COLLIDER);
    expect(stored.material).not.toBe(HIDDEN_COLLIDER); // or collider view's materials would leak into it
    // Owned by the store, which frees it; `disposeScene` leaves `shared` geometry be.
    expect(built.geometry.userData.shared).toBe(true);
  });

  it("warns and stays empty when the file cannot be loaded", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = new AssetStore({ gltf: () => Promise.reject(new Error("404")), texture: () => new THREE.Texture() });

    const group = await build(store);

    expect(meshesOf(group)).toHaveLength(0);
    expect(error).toHaveBeenCalled();
    warn.mockRestore();
    error.mockRestore();
  });
});
