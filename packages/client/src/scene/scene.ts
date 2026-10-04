// Turns a ResolvedWorld into a THREE.Group, plus what the app needs beside it:
// the spawn, and the model loads still in flight.

import * as THREE from "three";
import type { EntityId, ResolvedObject, ResolvedWorld } from "@3d/shared/dsl/resolved.js";
import { buildModelMesh, type BuildHulls, type ModelBuild } from "./models.js";
import type { AnimatedPlacement } from "./animation.js";
import type { AssetStore } from "./assets.js";
import { buildCollisionMesh } from "./collision.js";
import { buildLight, AMBIENT_SCALE, DIRECTIONAL_SCALE } from "./lights.js";
import type { Presence } from "@3d/shared/worlds/presence.js";

export interface BuiltScene {
  root: THREE.Group;
  spawn: { position: THREE.Vector3; look: THREE.Vector3 };
  /** Model loads in flight. Anything that reads finished geometry (collision above all) must await them. */
  pending: Promise<void>[];
  /** Prop collision hulls, one geometry per asset plus each placement's transform. Not drawn; complete once `pending` resolves. */
  hulls: BuildHulls;
  /** `animate:` placements for engine/animator.ts; complete once `pending` resolves. */
  animated: AnimatedPlacement[];
  /**
   * EntityId -> the placement node built for it, for anything that addresses one
   * object at runtime. Instancing keeps these groups (scene/instancing.ts), so a
   * reference here stays valid — but after it the group has no meshes of its own
   * and is drawn through `userData.instancedParts`.
   */
  nodes: Map<EntityId, THREE.Object3D>;
}

/**
 * Build a world's scene graph. `baseUrl` prefixes every asset path (e.g.
 * "/worlds/dome-mw3/"); `assets` loads them. A `model` whose `mode:` the match's
 * `presence` does not admit is not built at all, as a game server does not
 * collide with it: nothing here or after has to hide it.
 */
export function buildScene(world: ResolvedWorld, baseUrl: string, assets: AssetStore, presence?: Presence): BuiltScene {
  const root = new THREE.Group();
  root.name = "world-root";
  const pending: Promise<void>[] = [];
  const hulls: BuildHulls = { geometries: new Map(), requested: new Set(), placements: [] };
  const animated: AnimatedPlacement[] = [];
  const nodes = new Map<EntityId, THREE.Object3D>();
  const build: SceneBuild = { world, baseUrl, pending, store: assets, hulls, animated, nodes };

  if (world.collision) {
    root.add(buildCollisionMesh(world.collision.source, baseUrl, pending, assets));
  }

  for (const shape of world.topLevelObjects) {
    if (!presence || presence.hasModes(shape.modes)) {
      root.add(buildObject(shape, build));
    }
  }

  if (world.lights.length === 0) {
    root.add(...defaultLighting());
  } else {
    for (const light of world.lights) {
      root.add(buildLight(light));
    }

    // Declared lights replace the default rig and its hemisphere fill, so an
    // outdoor world (`sky:`) gets a sky fill instead, or faces turned from every
    // light render black. Not with a lightmap, which already contains the sky
    // (on dome-mw3 the fill was nearly four times the map's own ambient).
    if (world.sky && !hasBakedLighting(world)) {
      root.add(skyFill(world.sky));
    }
  }

  if (world.ambient) {
    root.add(new THREE.AmbientLight(new THREE.Color(world.ambient), 0.6 * AMBIENT_SCALE));
  }

  const spawn = {
    position: new THREE.Vector3(world.spawn.position.x, world.spawn.position.y, world.spawn.position.z),
    look: new THREE.Vector3(world.spawn.look.x, world.spawn.look.y, world.spawn.look.z),
  };

  return { root, spawn, pending, hulls, animated, nodes };
}

/** Whether any model carries a lightmap: in practice, an imported map's shell. */
function hasBakedLighting(world: ResolvedWorld): boolean {
  return world.topLevelObjects.some((item) => item.lightmap !== undefined);
}

/**
 * Ambient fill derived from `sky:` — the sky color from above, a muted earth
 * tone from below. Roughly matched to `defaultLighting`'s own hemisphere so
 * an outdoor world reads the same whether or not it declares its own lights.
 */
function skyFill(sky: string): THREE.HemisphereLight {
  return new THREE.HemisphereLight(new THREE.Color(sky), new THREE.Color(0x3a3226), 0.6 * AMBIENT_SCALE);
}

/** One build's shared state, threaded through the per-object builders. */
interface SceneBuild extends ModelBuild {
  world: ResolvedWorld;
  nodes: Map<EntityId, THREE.Object3D>;
}

/** One placement, tagged with its runtime address. */
function buildObject(obj: ResolvedObject, build: SceneBuild): THREE.Object3D {
  const node = buildModelMesh(obj, obj.asset ? build.world.assets[obj.asset] : undefined, build);
  node.userData.id = obj.id;
  build.nodes.set(obj.id, node);
  return node;
}

function defaultLighting(): THREE.Object3D[] {
  const hemi = new THREE.HemisphereLight(0xddeeff, 0x445544, 0.7 * AMBIENT_SCALE);
  const sun = new THREE.DirectionalLight(0xfff2e0, 1.1 * DIRECTIONAL_SCALE);

  sun.position.set(8, 12, 6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);

  // Frustum and bias are fitted at runtime (engine/shadows.ts).
  return [hemi, sun, sun.target];
}

/**
 * Bounds of the built world, for dollhouse framing and shadow fitting. Empty
 * for a world of models until `BuiltScene.pending` has resolved.
 */
export function contentBounds(root: THREE.Object3D): THREE.Box3 {
  const box = new THREE.Box3();
  root.traverse((item) => {
    if (item instanceof THREE.Mesh) {
      box.expandByObject(item);
    }
  });
  return box;
}

export function disposeScene(built: BuiltScene): void {
  // The hull geometries belong to the AssetStore; only this world's map of them goes.
  built.hulls.geometries.clear();
  built.hulls.requested.clear();
  built.hulls.placements.length = 0;
  built.animated.length = 0;
  built.root.traverse((obj) => {
    // A shadow-casting light owns its shadow map render target (64 MB at 4096²).
    if (obj instanceof THREE.Light) {
      obj.dispose();
    }

    // An InstancedMesh owns a per-instance matrix buffer (and optionally a
    // colour one) that its shared geometry knows nothing about.
    if (obj instanceof THREE.InstancedMesh) {
      obj.dispose();
    }

    // The shared unit box and asset geometries are tagged `shared` and outlive a build.
    if (obj instanceof THREE.Mesh && !obj.geometry.userData.shared) {
      obj.geometry.dispose();
    }
  });
}
