// A `model` node: a glTF asset placed in the world.

import * as THREE from "three";
import * as SkeletonUtils from "three/examples/jsm/utils/SkeletonUtils.js";
import type { ResolvedAsset, ResolvedObject } from "@3d/shared/dsl/resolved.js";
import type { AnimatedPlacement } from "./animation.js";
import type { AssetStore } from "./assets.js";
import { boxProxy, hullSourceOf, type HullPlacement } from "@3d/shared/collision/hulls.js";
import { applyDecalBias, applyLightmap, applySortKey, blendModeOf, castsShadow, setShadowSide, sortKeyOf } from "./importedMaterials.js";
import { LIGHTMAP_SCALE } from "./lights.js";
import { HIDDEN_COLLIDER, unitBox } from "./materials.js";
import { assetUrl } from "./assetUrl.js";

/** Per-build collision hulls: one geometry per asset, and a transform per colliding placement. */
export interface BuildHulls {
  /** Finished hulls. An asset still loading, or one whose hull failed, is simply absent. */
  geometries: Map<string, THREE.BufferGeometry>;
  /** Assets whose hull load has already been started, so a second placement does not request it again. */
  requested: Set<string>;
  placements: HullPlacement[];
}

/** What building one `model` placement needs of the build in progress. */
export interface ModelBuild {
  /** Prefixes every asset path, e.g. "/worlds/dome-mw3/". */
  baseUrl: string;
  /** Model loads in flight. Anything that reads finished geometry must await them. */
  pending: Promise<void>[];
  store: AssetStore;
  hulls?: BuildHulls;
  animated?: AnimatedPlacement[];
}

/**
 * Build a `model` placement.
 *
 * Returns an empty group at the right transform at once and fills it in when
 * the asset arrives, pushing the load onto `pending`. Anything that needs the
 * finished meshes (the collision BVH above all) must await `pending` first.
 *
 * The declared `size` is not applied: it exists so anchors have a box during
 * the synchronous resolve. `scale` resizes the asset; `material:` is ignored.
 * Under `collide: box` a proxy box stands in for the asset and none of its own
 * geometry reaches the collision.
 *
 * An `animate:` placement clones the asset's rig rather than its baked mesh
 * and is pushed onto `animated` for engine/animator.ts to play.
 */
export function buildModelMesh(obj: ResolvedObject, asset: ResolvedAsset | undefined, build: ModelBuild): THREE.Object3D {
  const { baseUrl, pending, store, hulls, animated } = build;
  const source = asset?.source;
  const group = new THREE.Group();

  group.position.set(obj.position.x, obj.position.y, obj.position.z);
  group.rotation.set(obj.rotation.x, obj.rotation.y, obj.rotation.z);
  group.scale.set(obj.scale.x, obj.scale.y, obj.scale.z);
  group.visible = obj.visible;

  // Identity for the inspector. A generated prop has no name, so its asset path is its identity.
  group.userData.name = obj.name;
  group.userData.tags = obj.tags;
  group.userData.model = true;
  group.userData.source = source;
  group.userData.asset = obj.asset;
  group.userData.collideMode = obj.collide;

  if (obj.animation) {
    group.userData.animation = obj.animation;
  }

  // An unresolved `asset:` (resolve reports it) draws nothing, and there is no
  // file to name. Narrowing on the asset rather than its source, so what follows
  // needs no assertion about which of the two is set.
  if (!asset || !source) {
    return group;
  }

  // The world's folder or the catalogue, decided once (assetUrl.ts).
  const url = assetUrl(asset, baseUrl);
  const solid = obj.collide !== "none";

  // Hull collision: the asset's own mesh, one per asset, instanced through each
  // placement's transform (see hulls.ts).
  const hullSource = obj.collide === "hull" ? hullSourceOf(asset) : undefined;
  if (solid && hullSource && hulls && asset) {
    group.updateMatrix(); // `matrix` is otherwise only refreshed by updateMatrixWorld
    hulls.placements.push({ asset: asset.name, matrix: group.matrix.clone() });
    if (!hulls.requested.has(asset.name)) {
      hulls.requested.add(asset.name);
      pending.push(
        store.hull(assetUrl(asset, baseUrl)).then((geo) => {
          // Left absent if it failed to load: its placements then do not collide.
          if (geo) {
            hulls.geometries.set(asset.name, geo);
          }
        }),
      );
    }
  }

  pending.push(
    store.model(url).then((loaded) => {
      if (!loaded) {
        return;
      }

      const clip = obj.animation ? loaded.rig?.clips.find((c) => c.name === obj.animation) : undefined;
      if (obj.animation && !clip) {
        const names = loaded.rig?.clips.map((c) => `"${c.name}"`).join(", ") || "none";
        console.warn(`[animation] ${obj.asset ?? source} has no clip "${obj.animation}" (it has ${names}); placed still`);
      }

      // The hierarchy is cloned per placement; geometry and materials stay shared.
      // Mutate only the clone, or one placement's settings leak into all of them.
      const instance = clip ? SkeletonUtils.clone(loaded.rig!.scene) : loaded.skinned ? SkeletonUtils.clone(loaded.scene) : loaded.scene.clone(true);
      instance.traverse((child) => {
        if (!(child instanceof THREE.Mesh)) {
          return;
        }

        child.castShadow = obj.visible && castsShadow(child.material);
        child.receiveShadow = true;

        setShadowSide(child.material);

        const mode = blendModeOf(child.material);

        if (mode !== undefined && !Array.isArray(child.material)) {
          const replacement = store.blendReplacement(url, child.material, mode);

          if (replacement) {
            child.material = replacement;
          }
        }

        const key = sortKeyOf(child.material);
        if (key !== undefined) {
          applySortKey(child, key);
        } else if (obj.decal) {
          applyDecalBias(child.material);
        }

        // The shadow map is not redrawn per frame, so it keeps the rest pose rather than a stale one.
        if (clip && child instanceof THREE.SkinnedMesh && !Array.isArray(child.material)) {
          child.customDepthMaterial = store.bindPoseDepth(url, child.material);
        }

        // Read per mesh by the BVH, which is built before anything animates: an animated prop collides at rest, as in the game.
        // Under `box` the proxy below collides instead.
        child.userData.collide = solid && obj.collide === "mesh";
      });

      if (clip) {
        animated?.push({ root: instance, clip });
      }

      if (obj.lightmap) {
        const intensity = (obj.lightmapIntensity ?? 1) * LIGHTMAP_SCALE;

        if (applyLightmap(instance, store.lightmap(baseUrl + obj.lightmap), intensity) === 0) {
          console.warn(`[lightmap] "${obj.lightmap}" applied to nothing: ${obj.asset ?? "model"} has no uv1 (TEXCOORD_1) to sample it with`);
        }
      }

      group.add(instance);

      // A box stands in for a hull only when the asset has none to give.
      if (solid && (obj.collide === "box" || (obj.collide === "hull" && !hullSource))) {
        group.add(buildBoxCollider(obj, loaded.bounds));
      }
    }),
  );

  return group;
}

/**
 * The box standing in for a model under `collide: box` (`boxProxy` sizes it, so
 * a game server stands in the same box). Hidden by material rather than
 * `visible = false`, which would drop it from the BVH, and marked `collider` so
 * picking resolves a hit on it to the prop it stands for.
 */
export function buildBoxCollider(obj: ResolvedObject, bounds: THREE.Box3): THREE.Mesh {
  const { center, size } = boxProxy(bounds);
  const mesh = new THREE.Mesh(unitBox(), HIDDEN_COLLIDER);

  mesh.position.copy(center);
  mesh.scale.copy(size);
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.userData.collide = true;
  mesh.userData.collider = true;

  if (obj.name) {
    mesh.userData.name = `${obj.name}.collider`;
  }

  return mesh;
}
