// The per-world asset store: one load per URL, shared by every placement;
// `invalidate` for a hot reload; `dispose` so leaving a world frees its GPU memory.

import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { AssetStore } from "../src/scene/assets.js";

function fakeScene(): THREE.Group {
  const map = new THREE.Texture();
  const material = new THREE.MeshStandardMaterial({ map });
  material.userData.blend = "multiply";
  const geometry = new THREE.BoxGeometry();
  const scene = new THREE.Group();
  scene.add(new THREE.Mesh(geometry, material));
  return scene;
}

function storeWith(loadGltf = vi.fn(async () => fakeScene())) {
  const texture = vi.fn(() => new THREE.Texture());
  return { store: new AssetStore({ gltf: loadGltf, texture }), loadGltf, texture };
}

function disposed(obj: THREE.EventDispatcher<{ dispose: object }>): () => boolean {
  let hit = false;
  obj.addEventListener("dispose", () => (hit = true));
  return () => hit;
}

async function meshOf(store: AssetStore, url: string): Promise<THREE.Mesh> {
  const loaded = await store.model(url);
  return loaded!.scene.children[0] as THREE.Mesh;
}

describe("AssetStore", () => {
  it("loads each URL once, however many placements ask", async () => {
    const { store, loadGltf } = storeWith();
    const [a, b] = await Promise.all([store.model("/w/a.glb"), store.model("/w/a.glb")]);
    expect(a).toBe(b);
    expect(loadGltf).toHaveBeenCalledTimes(1);
    expect(a!.bounds.isEmpty()).toBe(false);
  });

  it("marks loaded geometry shared, so disposing a built scene leaves it alone", async () => {
    const { store } = storeWith();
    expect((await meshOf(store, "/w/a.glb")).geometry.userData.shared).toBe(true);
  });

  it("resolves undefined for a model that fails to load", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { store } = storeWith(vi.fn(() => Promise.reject(new Error("404"))));
    expect(await store.model("/w/missing.glb")).toBeUndefined();
    warn.mockRestore();
  });

  it("shares one blend replacement per source material", async () => {
    const { store } = storeWith();
    const mesh = await meshOf(store, "/w/a.glb");
    const first = store.blendReplacement("/w/a.glb", mesh.material as THREE.Material, "multiply");
    const again = store.blendReplacement("/w/a.glb", mesh.material as THREE.Material, "multiply");
    expect(first).toBeInstanceOf(THREE.MeshBasicMaterial);
    expect(again).toBe(first); // one material across placements, so instancing can pool them
  });

  it("configures and caches lightmaps", () => {
    const { store, texture } = storeWith();
    const lm = store.lightmap("/w/lightmap.png");
    expect(store.lightmap("/w/lightmap.png")).toBe(lm);
    expect(texture).toHaveBeenCalledTimes(1);
    expect(lm.channel).toBe(1);
  });

  it("reloads an invalidated file and disposes the old one only when asked", async () => {
    const { store, loadGltf } = storeWith();
    const oldMesh = await meshOf(store, "/w/a.glb");
    const geometryGone = disposed(oldMesh.geometry);
    const mapGone = disposed((oldMesh.material as THREE.MeshStandardMaterial).map!);

    expect(store.invalidate("/w/a.glb")).toBe(true);
    expect(store.invalidate("/w/unknown.glb")).toBe(false);
    expect(geometryGone()).toBe(false); // the scene on screen may still be drawing it

    const newMesh = await meshOf(store, "/w/a.glb");
    expect(newMesh).not.toBe(oldMesh);
    expect(loadGltf).toHaveBeenCalledTimes(2);

    store.disposeRetired();
    expect(geometryGone()).toBe(true); // synchronously, for anything already loaded
    expect(mapGone()).toBe(true);
    expect(disposed(newMesh.geometry)()).toBe(false);
  });

  it("frees a model that finishes loading after the store was disposed", async () => {
    let resolve!: (scene: THREE.Group) => void;
    const { store } = storeWith(vi.fn(() => new Promise<THREE.Group>((r) => (resolve = r))));
    const pending = store.model("/w/slow.glb");
    store.dispose();
    const scene = fakeScene();
    const gone = disposed((scene.children[0] as THREE.Mesh).geometry);
    resolve(scene);
    await pending;
    await Promise.resolve();
    expect(gone()).toBe(true);
  });

  it("reads a JSON sidecar once per URL, and lets a hot reload drop it with the file it describes", async () => {
    const json = vi.fn(async (url: string) => ({ url }));
    const store = new AssetStore({ gltf: vi.fn(async () => fakeScene()), texture: vi.fn(() => new THREE.Texture()), json });
    const [a, b] = await Promise.all([store.json("/c/body.hitboxes.json"), store.json("/c/body.hitboxes.json")]);
    expect(a).toBe(b);
    expect(json).toHaveBeenCalledTimes(1);

    // Keyed by URL like every other asset, which is what makes a re-exported
    // sidecar arrive rather than the one already parsed.
    expect(store.invalidate("/c/body.hitboxes.json")).toBe(true);
    await store.json("/c/body.hitboxes.json");
    expect(json).toHaveBeenCalledTimes(2);
  });

  it("warns and resolves undefined for a sidecar that will not load, rather than rejecting", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = new AssetStore({
      gltf: vi.fn(async () => fakeScene()),
      texture: vi.fn(() => new THREE.Texture()),
      json: () => Promise.reject(new Error("HTTP 404")),
    });
    await expect(store.json("/c/missing.json")).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("reads a binary file once per URL, drops it on a hot reload, and resolves undefined when it will not load", async () => {
    const bytes = vi.fn(async () => new Uint8Array([1, 2, 3]));
    const store = new AssetStore({ gltf: vi.fn(async () => fakeScene()), texture: vi.fn(() => new THREE.Texture()), bytes });
    const [a, b] = await Promise.all([store.bytes("/w/assets/nav.bin"), store.bytes("/w/assets/nav.bin")]);
    expect(a).toBe(b);
    expect(bytes).toHaveBeenCalledTimes(1);
    expect(store.invalidate("/w/assets/nav.bin")).toBe(true);
    await store.bytes("/w/assets/nav.bin");
    expect(bytes).toHaveBeenCalledTimes(2);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failing = new AssetStore({ bytes: () => Promise.reject(new Error("HTTP 404")) });
    await expect(failing.bytes("/w/assets/missing.bin")).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("frees everything it loaded on dispose", async () => {
    const { store } = storeWith();
    const mesh = await meshOf(store, "/w/a.glb");
    const blend = store.blendReplacement("/w/a.glb", mesh.material as THREE.Material, "multiply")!;
    const hull = (await store.hull("/w/a.glb"))!;
    const lightmap = store.lightmap("/w/lm.png");
    const gone = [disposed(mesh.geometry), disposed(mesh.material as THREE.Material), disposed(blend), disposed(hull), disposed(lightmap)];

    store.dispose();
    expect(gone.map((g) => g())).toEqual([true, true, true, true, true]);
    expect(store.size).toEqual({ models: 0, gltfs: 0, textures: 0, sounds: 0 });
  });

  it("decodes a sound clip once per URL, and lets go of it with the world", async () => {
    // An AudioBuffer has no `dispose()`, so "freed" here means the store is no
    // longer the thing holding it — which is exactly what the invariant asks of a
    // texture too, and what a module-level cache of decoded audio would break.
    const buffer = { duration: 2 } as AudioBuffer;
    const audio = vi.fn(async () => buffer);
    const store = new AssetStore({ gltf: vi.fn(async () => fakeScene()), texture: vi.fn(() => new THREE.Texture()), audio });
    const [a, b] = await Promise.all([store.audio("/w/s.webm"), store.audio("/w/s.webm")]);
    expect(a).toBe(buffer);
    expect(b).toBe(buffer);
    expect(audio).toHaveBeenCalledTimes(1);
    expect(store.size.sounds).toBe(1);
    // A hot reload re-fetches only the file that changed.
    expect(store.invalidate("/w/s.webm")).toBe(true);
    expect(store.size.sounds).toBe(0);
    await store.audio("/w/s.webm");
    expect(audio).toHaveBeenCalledTimes(2);
    store.dispose();
    expect(store.size.sounds).toBe(0);
  });

  it("warns and resolves undefined for a clip that will not load, rather than stalling the world", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = new AssetStore({
      gltf: vi.fn(async () => fakeScene()),
      texture: vi.fn(() => new THREE.Texture()),
      audio: () => Promise.reject(new Error("HTTP 404")),
    });
    await expect(store.audio("/w/missing.webm")).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
