// The collision a world's `model` placements contribute, built without a scene.
//
// The client gets this for free: it has already built the props to draw them,
// so engine/collision.ts collects them out of the finished scene graph. A game
// server draws nothing and has no scene to collect from, and until it had this
// it collided against the map's clipmap alone — so every prop was solid on one
// end and open air on the other, and running into a parked car produced a drift
// that read as a netcode problem rather than as a missing collider.
//
// So this derives the same colliders from the resolved world instead: one
// geometry per asset, one matrix per placement, which is exactly what
// CollisionWorld.setHulls already instances. Both ends go through
// `hullGeometryFrom` and `boxProxy`, so the geometry is the same by
// construction rather than by two implementations agreeing.
//
// What is deliberately not here: the map's own clipmap, which is a `collision`
// mesh the caller builds directly. See docs/engine/collision.md.

import * as THREE from "three";
import type { ResolvedAsset, ResolvedObject, ResolvedWorld } from "../dsl/resolved.js";
import { boxProxy, hullGeometryFrom, hullSourceOf, type HullPlacement } from "./hulls.js";

/**
 * Reads one asset into a glTF scene. Undefined if it is missing.
 *
 * Takes the **asset**, not a path, and that is the fix for a bug worth naming:
 * `ResolvedAsset.source` is relative to the world folder *or to a catalogue entry*
 * depending on whether `catalog` is set, and this module used to be handed the
 * bare string. Since a prop belongs to the catalogue now, that meant every prop on
 * every imported map resolved to a file that is not there — dome-mw3 has 133 such
 * assets under 1,223 colliding placements, and the server collided with none of
 * them while the client collided with all of them. Resolving a path is the
 * caller's job because only the caller knows how it fetches; deciding *which root*
 * is the asset's own business, and now it travels with it.
 */
export type AssetLoader = (asset: ResolvedAsset) => Promise<THREE.Object3D | undefined>;

/**
 * A stable identity for the file an asset names, so two assets are read once if
 * and only if they are the same file.
 *
 * `source` alone is not it. Two catalogue entries may ship a file of the same
 * name — `props/iw5/x/model.glb` and `props/iw6/y/model.glb` — and deduplicating
 * on the basename alone would hand one of them the other's geometry, which is a
 * prop with the wrong collision and nothing to suggest why.
 */
export function assetFileKey(asset: ResolvedAsset): string {
  const { catalog, source } = asset;
  return catalog === undefined ? source : `${catalog.kind}/${catalog.game}/${catalog.id}/${source}`;
}

export interface PropCollision {
  /** One geometry per distinct collider, keyed as `placements[].asset`. */
  geometries: Map<string, THREE.BufferGeometry>;
  placements: HullPlacement[];
  /** Placements whose asset never arrived. They collide with nothing, which is worth logging. */
  missing: number;
}

/** A placement's collider: the asset's own mesh, or a box standing in for it. */
type Kind = "mesh" | "box";

/**
 * Every colliding `model` placement in `world`, as per-asset geometry and
 * per-placement transforms for `CollisionWorld.setHulls`.
 *
 * Each distinct asset is read once however many times it is placed. `load`
 * failures are counted rather than thrown: one missing prop is a hole in the
 * collision, not a reason to refuse to host the map.
 */
export async function buildPropCollision(world: ResolvedWorld, load: AssetLoader): Promise<PropCollision> {
  const placements: HullPlacement[] = [];
  /** Colliders to build, by the key their placements name, each with the asset it comes from. */
  const wanted = new Map<string, { asset: ResolvedAsset; kind: Kind }>();

  for (const obj of modelPlacements(world)) {
    const asset = obj.asset === undefined ? undefined : world.assets[obj.asset];
    if (!asset) {
      continue;
    }
    // A box stands in for a hull only when the asset has none to give — the
    // same fallback the client applies in scene/models.ts.
    const kind: Kind = obj.collide === "box" || (obj.collide === "hull" && !hullSourceOf(asset)) ? "box" : "mesh";
    // Two placements of one asset may want different colliders, so the box
    // proxy is keyed apart from the asset's own mesh.
    const key = kind === "box" ? `${asset.name}#box` : asset.name;
    wanted.set(key, { asset, kind });
    placements.push({ asset: key, matrix: placementMatrix(obj), modes: obj.modes });
  }

  const geometries = new Map<string, THREE.BufferGeometry>();
  let missing = 0;

  // One read per distinct asset *file*, in parallel: the same shape as the
  // client's `pending` loads, and a map with 184 props would otherwise boot in
  // series. Keyed by `assetFileKey` rather than by `source`, so two catalogue
  // entries shipping a file of the same name are two reads and not one.
  const files = new Map<string, ResolvedAsset>();
  for (const { asset } of wanted.values()) {
    files.set(assetFileKey(asset), asset);
  }
  const scenes = new Map<string, THREE.Object3D | undefined>();
  await Promise.all([...files].map(async ([fileKey, asset]) => scenes.set(fileKey, await load(asset))));

  for (const [key, { asset, kind }] of wanted) {
    const scene = scenes.get(assetFileKey(asset));
    if (!scene) {
      missing++;
      continue;
    }
    const geometry = kind === "box" ? boxGeometry(scene) : hullGeometryFrom(scene);
    if (geometry) {
      geometries.set(key, geometry);
    } else {
      missing++;
    }
  }

  // A placement whose collider failed is not a placement: setHulls would skip
  // it anyway, and counting it here keeps `placements.length` honest.
  return { geometries, placements: placements.filter((p) => geometries.has(p.asset)), missing };
}

/**
 * Every placement that collides.
 *
 * `visible: off` is skipped because the client's BVH skips it too: its meshes
 * are in the scene graph but StaticGeometryGenerator walks past an invisible
 * node, which is why a hidden collider is hidden by material instead.
 */
function* modelPlacements(world: ResolvedWorld): Generator<ResolvedObject> {
  for (const obj of world.topLevelObjects) {
    if (obj.collide !== "none" && obj.visible) {
      yield obj;
    }
  }
}

/**
 * A placement's world transform. `ResolvedObject` is a flat list with a group's
 * transform already baked in, so there is no parent to compose with; the euler
 * order is three's own default, which is what the client's `group.rotation.set`
 * uses.
 */
function placementMatrix(obj: ResolvedObject): THREE.Matrix4 {
  const euler = new THREE.Euler(obj.rotation.x, obj.rotation.y, obj.rotation.z);
  return new THREE.Matrix4().compose(
    new THREE.Vector3(obj.position.x, obj.position.y, obj.position.z),
    new THREE.Quaternion().setFromEuler(euler),
    new THREE.Vector3(obj.scale.x, obj.scale.y, obj.scale.z),
  );
}

/** The `collide: box` proxy as geometry, positioned in the asset's local space. */
function boxGeometry(scene: THREE.Object3D): THREE.BufferGeometry {
  const { center, size } = boxProxy(new THREE.Box3().setFromObject(scene));
  return new THREE.BoxGeometry(size.x, size.y, size.z).translate(center.x, center.y, center.z);
}
