// Everything a world loads from its asset files, shared by every placement:
// parsed glTF scenes (and the rigs of animated ones), files kept exactly as
// loaded (viewmodel rigs, the collision mesh), collision hulls, textures
// (lightmaps, scope overlays), decoded sound clips, binary files read whole (a
// `nav.bin`), and the materials derived from them (blend replacements,
// bind-pose shadows, the flag wind's clock).
//
// One store belongs to one world. The app keeps it across a hot reload of the
// same world, so only files that changed are fetched and parsed again
// (`invalidate`), and disposes it when the world is left, which frees the GPU
// memory of every asset the world loaded.

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import * as SkeletonUtils from "three/examples/jsm/utils/SkeletonUtils.js";
import { bindPoseDepthMaterial, sampleAnimatedBounds } from "./animation.js";
import { bakeSkinnedMeshes } from "./bake.js";
import { applyFlagWind, type ShaderClock } from "./flag.js";
import { hullGeometryFrom } from "@3d/shared/collision/hulls.js";
import { blendedMaterialFor, configureLightmapTexture } from "./importedMaterials.js";
import { audioContext } from "../engine/audio/context.js";

export interface LoadedAsset {
  /** Pristine: never parented or mutated after load. Every placement clones it. */
  scene: THREE.Group;
  /** Local-space bounds, measured once; a `collide: box` proxy is built from them. */
  bounds: THREE.Box3;
  /** A rig the bake left in place (morph targets), which needs SkeletonUtils.clone. */
  skinned: boolean;
  /**
   * For a glTF with animations: its rig as loaded, before the bake, which
   * `animate:` placements clone instead of `scene`. Shares materials with it.
   */
  rig?: { scene: THREE.Group; clips: THREE.AnimationClip[] };
}

/** A glTF as loaded, skinning and all: a viewmodel's weapon or hands (scene/viewmodel.ts), or a map's collision mesh (scene/collision.ts). */
export interface GltfAsset {
  /** Pristine: every user clones or copies it. `userData` holds the glTF scene's extras. */
  scene: THREE.Group;
  clips: THREE.AnimationClip[];
}

interface GltfEntry {
  loaded: Promise<GltfAsset | undefined>;
  asset?: GltfAsset;
  disposed?: boolean;
}

export interface AssetLoaders {
  /** The glTF's scene, with its animation clips on `scene.animations`. */
  gltf: (url: string) => Promise<THREE.Group>;
  texture: (url: string) => THREE.Texture;
  /** A JSON sidecar beside an asset, parsed. Rejects; the store turns that into a warning. */
  json: (url: string) => Promise<unknown>;
  /** A sound clip, fetched and decoded. Rejects; the store turns that into a warning. */
  audio: (url: string) => Promise<AudioBuffer>;
  /** A binary file as it is: a world's `nav.bin`. Rejects; the store turns that into a warning. */
  bytes: (url: string) => Promise<Uint8Array>;
}

interface ModelEntry {
  loaded: Promise<LoadedAsset | undefined>;
  hull?: Promise<THREE.BufferGeometry | undefined>;
  /** The settled values, so a dispose can free them synchronously. */
  asset?: LoadedAsset;
  hullGeometry?: THREE.BufferGeometry;
  disposed?: boolean;
  /** Blend replacements, keyed by the source material they replace. */
  blends: Map<THREE.Material, THREE.Material | null>;
  /** Bind-pose shadow materials for animated placements, keyed by the material they shadow for. */
  depths: Map<THREE.Material, THREE.MeshDepthMaterial>;
}

function defaultLoaders(): AssetLoaders {
  const gltf = new GLTFLoader();
  const textures = new THREE.TextureLoader();
  return {
    gltf: (url) =>
      gltf.loadAsync(url).then((asset) => {
        asset.scene.animations = asset.animations;
        return asset.scene;
      }),
    texture: (url) => textures.load(url, undefined, undefined, () => console.warn(`Failed to load texture: ${url}`)),
    json: (url) => fetch(url).then((response) => (response.ok ? (response.json() as Promise<unknown>) : Promise.reject(new Error(`HTTP ${response.status}`)))),
    // The context is reached for lazily, never at construction: a test builds a
    // store in Node, where there is no `window.AudioContext` to create one from.
    audio: async (url) => {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return audioContext().decodeAudioData(await response.arrayBuffer());
    },
    bytes: async (url) => {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}

export class AssetStore {
  private readonly models = new Map<string, ModelEntry>();
  private readonly raw = new Map<string, GltfEntry>();
  private readonly textures = new Map<string, THREE.Texture>();
  /** Parsed JSON sidecars. Nothing to free, so they are simply dropped rather than retired. */
  private readonly jsons = new Map<string, Promise<unknown>>();
  /** Binary files read whole, like `jsons`: nothing to free. */
  private readonly binaries = new Map<string, Promise<Uint8Array | undefined>>();
  /**
   * Decoded sound clips. Like a texture: expensive, keyed by the URL it came
   * from, and freed with the world — an `AudioBuffer` has no `dispose()`, so
   * dropping the last reference to it *is* freeing it, which is why a voice
   * clears its buffer when it is retired (engine/audio/voices.ts).
   */
  private readonly audios = new Map<string, Promise<AudioBuffer | undefined>>();
  /** Entries dropped by `invalidate`, disposed once the scene that used them is gone. */
  private retired: ModelEntry[] = [];
  private retiredRaw: GltfEntry[] = [];
  private retiredTextures: THREE.Texture[] = [];
  private readonly loaders: AssetLoaders;
  /** Time for every flag-wind material this store loads (scene/flag.ts); engine/animator.ts advances it. */
  readonly shaderClock: ShaderClock = { value: 0 };

  constructor(loaders?: Partial<AssetLoaders>) {
    this.loaders = { ...defaultLoaders(), ...loaders };
  }

  /** A model, loaded and prepared once per URL. Resolves undefined (with a warning) if it cannot be loaded. */
  model(url: string): Promise<LoadedAsset | undefined> {
    return this.entry(url).loaded;
  }

  /** The positions-only collision hull built from a model. */
  hull(url: string): Promise<THREE.BufferGeometry | undefined> {
    const entry = this.entry(url);
    entry.hull ??= entry.loaded.then((loaded) => {
      const geo = loaded ? hullGeometryFrom(loaded.scene) : undefined;
      if (entry.disposed) {
        geo?.dispose();
      } else {
        entry.hullGeometry = geo;
      }
      return geo;
    });
    return entry.hull;
  }

  /** The material that draws `source` with the game's blend equation (null to keep `source`), shared by every placement. */
  blendReplacement(url: string, source: THREE.Material, mode: string): THREE.Material | null {
    const blends = this.entry(url).blends;
    let replacement = blends.get(source);
    if (replacement === undefined) {
      replacement = blendedMaterialFor(source, mode);
      blends.set(source, replacement);
    }
    return replacement;
  }

  /** The material that shadows an animated placement of this model in its bind pose (scene/animation.ts), shared by every placement. */
  bindPoseDepth(url: string, source: THREE.Material): THREE.MeshDepthMaterial {
    const depths = this.entry(url).depths;
    let depth = depths.get(source);
    if (!depth) {
      depth = bindPoseDepthMaterial();
      depths.set(source, depth);
    }
    return depth;
  }

  /**
   * A glTF kept exactly as loaded: not baked, not instanced. A viewmodel rig
   * clones it and an imported map's collision mesh copies its meshes, so what
   * comes back must never be mutated. Resolves undefined (with a warning) if it
   * cannot be loaded.
   */
  gltf(url: string): Promise<GltfAsset | undefined> {
    let entry = this.raw.get(url);
    if (!entry) {
      const created: GltfEntry = {
        loaded: this.loaders.gltf(url).then(
          (scene) => ({ scene, clips: scene.animations ?? [] }),
          () => {
            console.warn(`Failed to load model: ${url}`);
            return undefined;
          },
        ),
      };
      void created.loaded.then((asset) => {
        if (created.disposed && asset) {
          disposeGltf(asset);
        } else {
          created.asset = asset;
        }
      });
      entry = created;
      this.raw.set(url, entry);
    }
    return entry.loaded;
  }

  /**
   * A JSON sidecar beside an asset: a body's hit boxes (`@3d/shared/rig/hitboxes.ts`).
   *
   * Keyed by URL like every other asset, so it is invalidated with the file it
   * describes and forgotten with the world. Resolves undefined (with a warning)
   * rather than rejecting, as `gltf` does: a sidecar that will not load must not
   * stall whatever asked for it.
   */
  json(url: string): Promise<unknown> {
    let entry = this.jsons.get(url);
    if (!entry) {
      entry = this.loaders.json(url).catch(() => {
        console.warn(`Failed to load sidecar: ${url}`);
        return undefined;
      });
      this.jsons.set(url, entry);
    }
    return entry;
  }

  /**
   * A binary file, whole: the world's `nav.bin`, which only the navigation view
   * reads in a browser (engine/navView.ts). Resolves undefined (with a warning),
   * as `json` does.
   */
  bytes(url: string): Promise<Uint8Array | undefined> {
    let entry = this.binaries.get(url);
    if (!entry) {
      entry = this.loaders.bytes(url).catch(() => {
        console.warn(`Failed to load file: ${url}`);
        return undefined;
      });
      this.binaries.set(url, entry);
    }
    return entry;
  }

  /**
   * A decoded sound clip.
   *
   * Resolves undefined (with a warning) rather than rejecting, as `json` does: a
   * clip that will not load costs one sound, and must not stall the world around
   * it. One decode per URL however many voices ask for it — nineteen chainlink
   * loops share one buffer.
   */
  audio(url: string): Promise<AudioBuffer | undefined> {
    let entry = this.audios.get(url);
    if (!entry) {
      entry = this.loaders.audio(url).catch(() => {
        console.warn(`Failed to load sound: ${url}`);
        return undefined;
      });
      this.audios.set(url, entry);
    }
    return entry;
  }

  /** A lightmap atlas. Returned at once and filled in when it arrives. */
  lightmap(url: string): THREE.Texture {
    return this.texture(url, configureLightmapTexture);
  }

  /**
   * A screen-space picture: a scope overlay (engine/viewmodel.ts). Clamped and
   * unmipped because it is drawn once, at one size, over the whole frame — and
   * sRGB, since it is multiplied onto a frame that is already encoded.
   */
  picture(url: string): THREE.Texture {
    return this.texture(url, (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.generateMipmaps = false;
      tex.minFilter = tex.magFilter = THREE.LinearFilter;
      return tex;
    });
  }

  /**
   * An effect's sprite sheet. sRGB like any colour map, mipped because particles
   * are drawn at every size from a few pixels to most of the screen, and clamped
   * because an atlas cell that wraps bleeds its neighbour in along the seam.
   */
  fxSprite(url: string): THREE.Texture {
    return this.texture(url, (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.generateMipmaps = true;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      return tex;
    });
  }

  /** One texture per URL, configured on first use. Returned at once and filled in when it arrives. */
  private texture(url: string, configure: (tex: THREE.Texture) => THREE.Texture): THREE.Texture {
    let tex = this.textures.get(url);
    if (!tex) {
      tex = configure(this.loaders.texture(url));
      this.textures.set(url, tex);
    }
    return tex;
  }

  /** Forget whatever was loaded from `url`, so the next build fetches it again. Returns whether anything was. */
  invalidate(url: string): boolean {
    let dropped = false;
    const model = this.models.get(url);
    if (model) {
      this.models.delete(url);
      this.retired.push(model);
      dropped = true;
    }
    const raw = this.raw.get(url);
    if (raw) {
      this.raw.delete(url);
      this.retiredRaw.push(raw);
      dropped = true;
    }
    const texture = this.textures.get(url);
    if (texture) {
      this.textures.delete(url);
      this.retiredTextures.push(texture);
      dropped = true;
    }
    if (this.jsons.delete(url)) {
      dropped = true;
    }
    if (this.binaries.delete(url)) {
      dropped = true;
    }
    if (this.audios.delete(url)) {
      dropped = true;
    }
    return dropped;
  }

  /** Free what `invalidate` dropped. Call once the scene that used it has been disposed. */
  disposeRetired(): void {
    for (const entry of this.retired) {
      disposeEntry(entry);
    }
    for (const tex of this.retiredTextures) {
      tex.dispose();
    }
    for (const entry of this.retiredRaw) {
      entry.disposed = true;
      if (entry.asset) {
        disposeGltf(entry.asset);
      }
    }
    this.retiredRaw = [];
    this.retired = [];
    this.retiredTextures = [];
  }

  /** Free everything. The store must not be used afterwards. */
  dispose(): void {
    for (const url of [
      ...this.models.keys(),
      ...this.raw.keys(),
      ...this.textures.keys(),
      ...this.jsons.keys(),
      ...this.binaries.keys(),
      ...this.audios.keys(),
    ]) {
      this.invalidate(url);
    }
    this.disposeRetired();
  }

  get size(): { models: number; gltfs: number; textures: number; sounds: number } {
    return { models: this.models.size, gltfs: this.raw.size, textures: this.textures.size, sounds: this.audios.size };
  }

  private entry(url: string): ModelEntry {
    let entry = this.models.get(url);
    if (!entry) {
      const created: ModelEntry = { loaded: this.load(url), blends: new Map(), depths: new Map() };
      void created.loaded.then((asset) => {
        if (created.disposed && asset) {
          disposeAsset(asset);
        } // disposed while still loading
        else {
          created.asset = asset;
        }
      });
      entry = created;
      this.models.set(url, entry);
    }
    return entry;
  }

  private async load(url: string): Promise<LoadedAsset | undefined> {
    let scene: THREE.Group;
    try {
      scene = await this.loaders.gltf(url);
    } catch {
      console.warn(`Failed to load model: ${url}`);
      return undefined; // a missing asset must not stall the whole scene build
    }
    // Before the bake and the rig clone, which share these materials.
    applyFlagWind(scene, this.shaderClock);
    // Pose the bones first: the bake resolves skinning from their world matrices.
    scene.updateMatrixWorld(true);
    // `animate:` placements need the rig the bake is about to flatten.
    const clips = scene.animations ?? [];
    let rig: LoadedAsset["rig"];
    if (clips.length > 0) {
      const rigScene = SkeletonUtils.clone(scene) as THREE.Group;
      sampleAnimatedBounds(rigScene, clips);
      rig = { scene: rigScene, clips };
    }
    // A still placement never moves, and a SkinnedMesh is the one thing instancing cannot pool.
    bakeSkinnedMeshes(scene);
    let skinned = false;
    for (const root of rig ? [scene, rig.scene] : [scene]) {
      root.traverse((child) => {
        if (child instanceof THREE.SkinnedMesh && root === scene) {
          skinned = true;
        }
        // Owned by this store, not by a built scene: disposeScene must leave it alone.
        if (child instanceof THREE.Mesh) {
          child.geometry.userData.shared = true;
        }
      });
    }
    scene.updateMatrixWorld(true); // again: the bake swapped nodes in and out
    return { scene, bounds: new THREE.Box3().setFromObject(scene), skinned, rig };
  }
}

/** Every texture a material references directly, except its lightmap (which the store owns separately). */
function texturesOf(material: THREE.Material): THREE.Texture[] {
  const out: THREE.Texture[] = [];
  for (const [key, value] of Object.entries(material)) {
    if (value instanceof THREE.Texture && key !== "lightMap") {
      out.push(value);
    }
  }
  return out;
}

function disposeEntry(entry: ModelEntry): void {
  entry.disposed = true;
  entry.hullGeometry?.dispose();
  for (const replacement of entry.blends.values()) {
    replacement?.dispose();
  } // shares the source's map; not disposed here
  for (const depth of entry.depths.values()) {
    depth.dispose();
  }
  if (entry.asset) {
    disposeAsset(entry.asset);
  }
}

function disposeAsset(asset: LoadedAsset): void {
  disposeMeshes(asset.scene);
  // The rig keeps the skinned geometry the bake replaced; its materials went above.
  asset.rig?.scene.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.geometry.dispose();
    }
  });
}

function disposeGltf(asset: GltfAsset): void {
  disposeMeshes(asset.scene);
}

/** Every mesh's geometry, materials and their textures under `root`. */
function disposeMeshes(root: THREE.Object3D): void {
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) {
      return;
    }
    child.geometry.dispose();
    for (const mat of Array.isArray(child.material) ? child.material : [child.material]) {
      for (const tex of texturesOf(mat)) {
        tex.dispose();
      }
      mat.dispose();
    }
  });
}
