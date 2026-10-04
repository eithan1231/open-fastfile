// The map, as Rapier sees it.
//
// `three-mesh-bvh` cannot be handed to a physics engine, so the map's triangles go
// in a second time as a Rapier trimesh. That is the one genuinely expensive thing
// in this subtree and the place to know the numbers: dome-mw3's shots tree is
// 88,168 triangles and interchange-mw3's is 296,000
// (docs/engine/collision.md), and a Rapier trimesh builds a QBVH over all of them.
//
// **It is paid per physics world, not per map.** A Rapier collider belongs to one
// `World`, so two games on one map build it twice even though they share the one
// `ResolvedWorld` and the one BVH off `WorldRegistry`. `buildTerrain` returns what
// it cost so that the caller can say so out loud rather than wonder.
//
// -- Which triangles --------------------------------------------------------
//
// The map is two trees, and taking one is a claim about what is being modelled
// (`CollisionWorld.mapSurfaces`). A corpse takes `"shots"`: what stops a bullet is
// what a body can be seen to rest on, and a corpse lying on an invisible railing
// reads worse than one that slides off a real one. The mirror of that is the thing
// to expect rather than debug — **a body can fall through a gap a living player
// cannot walk through**, because `clip_player` over a window stops a player and
// stops nothing here.
//
// Prop hulls are not in yet. A corpse can sink into a crate, which is visible and
// unimportant; interchange-mw3 has 2,842 placements over 192 assets and 191k
// triangles, and doing it properly means one merged static trimesh rather than
// 2,842 QBVH builds.

import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-deterministic-compat";
import type { CollisionWorld } from "../collision/world.js";

/** Which of the map's two trees a physics world is built from. */
export type TerrainSet = "shots" | "player";

export interface TerrainStats {
  triangles: number;
  /** How long the trimesh and its QBVH took, ms. The number worth printing at boot. */
  ms: number;
}

/**
 * Install the map as static geometry.
 *
 * One trimesh collider per tree taken, in a fixed order — every collider added to a
 * Rapier world is part of the construction order its determinism depends on, and
 * "the map, then the entities" has to mean the same thing on every machine.
 */
export function buildTerrain(world: RAPIER.World, collision: CollisionWorld, set: TerrainSet = "shots"): TerrainStats {
  const started = Date.now();
  let triangles = 0;
  for (const geometry of wantedOf(collision.mapSurfaces(), set)) {
    triangles += trimeshCollider(world, geometry)?.triangles ?? 0;
  }
  return { triangles, ms: Date.now() - started };
}

/**
 * One removable part's trimesh colliders, from the same tree set as the map's.
 * Empty for a part with nothing in that set. The caller owns them: a part that
 * leaves is `removeCollider`'d, and one that comes back is built again.
 */
export function buildPart(world: RAPIER.World, collision: CollisionWorld, index: number, set: TerrainSet = "shots"): RAPIER.Collider[] {
  const colliders: RAPIER.Collider[] = [];
  for (const geometry of wantedOf(collision.partSurfaces(index), set)) {
    const built = trimeshCollider(world, geometry);
    if (built) {
      colliders.push(built.collider);
    }
  }
  return colliders;
}

/** The geometries a set takes, shots first. */
function wantedOf(surfaces: { shots?: THREE.BufferGeometry; clip?: THREE.BufferGeometry }, set: TerrainSet): THREE.BufferGeometry[] {
  const wanted = set === "shots" ? [surfaces.shots] : [surfaces.shots, surfaces.clip];
  return wanted.filter((geometry): geometry is THREE.BufferGeometry => geometry !== undefined);
}

function trimeshCollider(world: RAPIER.World, geometry: THREE.BufferGeometry): { collider: RAPIER.Collider; triangles: number } | undefined {
  const mesh = trimeshOf(geometry);
  if (!mesh) {
    return undefined;
  }
  return { collider: world.createCollider(RAPIER.ColliderDesc.trimesh(mesh.vertices, mesh.indices)), triangles: mesh.indices.length / 3 };
}

/**
 * A geometry's positions and indices in the shapes Rapier wants.
 *
 * `CollisionWorld` merges every colliding mesh into one buffer with its world
 * matrix already applied, so there is no transform to carry here — which is also
 * why this takes the geometry rather than a scene: the thing being copied is the
 * tree's own input, so the two cannot come to disagree about what the map is.
 */
function trimeshOf(geometry: THREE.BufferGeometry): { vertices: Float32Array; indices: Uint32Array } | undefined {
  const position = geometry.getAttribute("position");
  if (!position || position.count === 0) {
    return undefined;
  }
  const vertices = position.array instanceof Float32Array ? position.array : Float32Array.from(position.array);

  const index = geometry.getIndex();
  if (index) {
    const indices = index.array instanceof Uint32Array ? index.array : Uint32Array.from(index.array);
    return { vertices, indices };
  }
  // A non-indexed merge is three vertices per triangle in order, which is the one
  // case where the index buffer is just the natural numbers.
  const indices = new Uint32Array(position.count);
  for (let i = 0; i < indices.length; i++) {
    indices[i] = i;
  }
  return { vertices, indices };
}
