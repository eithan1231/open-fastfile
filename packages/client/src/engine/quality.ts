// Render-quality levels, cycled at runtime and remembered per browser: the same
// world is a different amount of work on a laptop iGPU and a desktop card, so
// the machine makes these trades, not the world author.

import * as THREE from "three";

export type QualityLevel = "low" | "medium" | "high";

/** Cycle order, ascending, so repeated presses climb then wrap. */
export const QUALITY_LEVELS: readonly QualityLevel[] = ["low", "medium", "high"];

export interface QualitySettings {
  /** Upper bound on devicePixelRatio: the main lever when fragment-bound. */
  pixelRatioCap: number;
  shadowType: THREE.ShadowMapType;
  shadowMapSize: number;
  /**
   * Half-width in metres of the region around the player kept in shadow
   * (engine/shadows.ts). Tuned together with `shadowMapSize`: their ratio is the
   * shadow texel's world size, which decides both acne and detachment.
   */
  shadowFocusRadius: number;
  /** Meshes smaller than this many shadow texels stop casting: their shadow would be under a texel anyway. */
  minShadowCasterTexels: number;
  /** Anisotropic filtering, capped by the GPU. Keeps ground and floor textures sharp at grazing angles. */
  anisotropy: number;
}

export const QUALITY: Record<QualityLevel, QualitySettings> = {
  // 3.9 cm per shadow texel.
  high: { pixelRatioCap: 2, shadowType: THREE.PCFSoftShadowMap, shadowMapSize: 4096, shadowFocusRadius: 80, minShadowCasterTexels: 1, anisotropy: 16 },
  // 5.9 cm per shadow texel.
  medium: { pixelRatioCap: 1.5, shadowType: THREE.PCFShadowMap, shadowMapSize: 2048, shadowFocusRadius: 60, minShadowCasterTexels: 2, anisotropy: 4 },
  // 9.8 cm per shadow texel.
  low: { pixelRatioCap: 1, shadowType: THREE.PCFShadowMap, shadowMapSize: 1024, shadowFocusRadius: 50, minShadowCasterTexels: 4, anisotropy: 1 },
};

const STORAGE_KEY = "3d-designer:quality";
const DEFAULT_LEVEL: QualityLevel = "high";

function isLevel(value: string | null): value is QualityLevel {
  return value !== null && (QUALITY_LEVELS as readonly string[]).includes(value);
}

export function loadQualityLevel(): QualityLevel {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return isLevel(stored) ? stored : DEFAULT_LEVEL;
  } catch {
    return DEFAULT_LEVEL; // storage can be disabled outright
  }
}

export function saveQualityLevel(level: QualityLevel): void {
  try {
    localStorage.setItem(STORAGE_KEY, level);
  } catch {
    // not being able to remember the setting is not worth failing over
  }
}

export function nextQualityLevel(level: QualityLevel): QualityLevel {
  const i = QUALITY_LEVELS.indexOf(level);
  return QUALITY_LEVELS[(i + 1) % QUALITY_LEVELS.length]!;
}

/** Per-renderer bookkeeping, owned by the Viewer. */
export interface QualityState {
  /** The shadow filter compiled into the scene's shaders; changing it means recompiling every material. */
  compiledShadowType?: THREE.ShadowMapType;
}

/**
 * Apply a level to the renderer and the scene. `root` (BuiltScene.root) and
 * `texelSize` (from ShadowFit.build) enable the shadow-caster threshold, which
 * is measured in shadow texels. Callers must invalidate the shadow map afterwards.
 */
export function applyQuality(
  level: QualityLevel,
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  state: QualityState,
  root?: THREE.Object3D,
  texelSize?: number,
): void {
  const settings = QUALITY[level];
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, settings.pixelRatioCap)); // re-runs setSize itself

  const recompile = state.compiledShadowType !== settings.shadowType;
  if (recompile) {
    renderer.shadowMap.type = settings.shadowType;
    state.compiledShadowType = settings.shadowType;
  }
  const anisotropy = Math.min(settings.anisotropy, renderer.capabilities.getMaxAnisotropy());
  // Thousands of meshes share a few dozen materials, and both passes below are
  // per material: walking each one's properties per mesh is the same work over
  // and over.
  const seen = new Set<THREE.Material>();
  scene.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      for (const material of Array.isArray(obj.material) ? obj.material : [obj.material]) {
        if (!material || seen.has(material)) {
          continue;
        }
        seen.add(material);
        if (recompile) {
          material.needsUpdate = true;
        } // the filter is baked into each shader
        setAnisotropy(material, anisotropy);
      }
    } else if (obj instanceof THREE.Light && obj.castShadow && obj.shadow && obj.shadow.mapSize.width !== settings.shadowMapSize) {
      obj.shadow.mapSize.set(settings.shadowMapSize, settings.shadowMapSize);
      obj.shadow.map?.dispose(); // the render target keeps its old size until released
      obj.shadow.map = null;
    }
  });

  if (root && texelSize !== undefined) {
    applyShadowCasterThreshold(root, settings.minShadowCasterTexels * texelSize);
  }
}

/** Set every texture a material samples to `anisotropy`, re-uploading those already on the GPU. */
export function setAnisotropy(material: THREE.Material, anisotropy: number): void {
  for (const value of Object.values(material)) {
    if (!(value instanceof THREE.Texture) || value.anisotropy === anisotropy) {
      continue;
    }
    value.anisotropy = anisotropy;
    if (value.image) {
      value.needsUpdate = true;
    } // one still loading picks the value up when it arrives
  }
}

const scratchSize = new THREE.Vector3();
const scratchScale = new THREE.Vector3();
const scratchMatrix = new THREE.Matrix4();
const scratchInstanceScale = new THREE.Vector3();

/** The scale to size a mesh by. For an InstancedMesh, the largest instance's: casting is all-or-nothing per batch. */
function scaleOf(mesh: THREE.Mesh): THREE.Vector3 {
  if (!(mesh instanceof THREE.InstancedMesh)) {
    return mesh.getWorldScale(scratchScale);
  }
  scratchScale.setScalar(0);
  for (let i = 0; i < mesh.count; i++) {
    mesh.getMatrixAt(i, scratchMatrix);
    scratchInstanceScale.setFromMatrixScale(scratchMatrix);
    scratchScale.max(scratchInstanceScale);
  }
  return scratchScale;
}

/**
 * Stop anything smaller than `minSize` casting, and restore the rest. The
 * build-time decision is stashed on first visit, so raising the level never
 * turns casting on for things that deliberately never cast (collider proxies).
 */
function applyShadowCasterThreshold(root: THREE.Object3D, minSize: number): void {
  root.updateMatrixWorld(true); // world matrices are frozen after a build
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) {
      return;
    }
    const authored = obj.userData.castShadowDefault;
    const base = typeof authored === "boolean" ? authored : obj.castShadow;
    if (typeof authored !== "boolean") {
      obj.userData.castShadowDefault = base;
    }
    if (!base || minSize <= 0) {
      obj.castShadow = base;
      return;
    }
    if (!obj.geometry.boundingBox) {
      obj.geometry.computeBoundingBox();
    }
    const box = obj.geometry.boundingBox;
    if (!box) {
      return;
    }
    box.getSize(scratchSize).multiply(scaleOf(obj)); // local bounds scaled: exact enough for a threshold
    obj.castShadow = scratchSize.length() >= minSize;
  });
}
