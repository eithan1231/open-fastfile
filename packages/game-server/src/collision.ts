// Building a world's collision on the server, headlessly.
//
// This is the point of @3d/shared/collision existing: the BVH the server
// resolves a capsule against is built by the same code, from the same file, as
// the one the client predicts against. three.js is used here purely as a
// geometry library — no renderer is constructed and no DOM is touched.
//
// Both things that stop a player are handled here: the map's authored clipmap,
// and its `model` placements (@3d/shared/collision/props.ts), which the client
// collides against out of its finished scene graph and a server has to derive
// from the resolved world instead.
//
// Everything arrives as bytes from a WorldSource rather than a path, because
// this process has no worlds on disk: it fetches everything from @3d/api.

import "./gltfGlobals.js";

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { CollisionWorld } from "@3d/shared/collision/world.js";
import { buildCollisionGroups } from "@3d/shared/collision/source.js";
import { buildPropCollision } from "@3d/shared/collision/props.js";
import type { CatalogEntryRef, ResolvedWorld } from "@3d/shared/dsl/resolved.js";
import type { WorldSource } from "@3d/shared/worlds/source.js";

/** Stands in for the client's invisible material; the server never draws any of this. */
const HEADLESS_MATERIAL = new THREE.MeshBasicMaterial();

const loader = new GLTFLoader();

async function parseGltf(bytes: Uint8Array): Promise<THREE.Object3D> {
  // parseAsync wants an ArrayBuffer of exactly the glb; a Uint8Array off the
  // wire or off disk may be a view into a larger buffer.
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const gltf = await loader.parseAsync(buffer, "");
  return gltf.scene;
}

export interface ServerCollision {
  world: CollisionWorld;
  /** Triangles in the map's clipmap — the one number that says the map really loaded. 0 for a world with none. */
  triangles: number;
  /** What the world's `model` placements contributed, which is what a client is mostly colliding with. */
  props: { assets: number; placements: number; missing: number };
}

/**
 * Build the collision for an already-resolved world, reading every mesh through
 * whatever the world came from — which for a game server is the api, over HTTP.
 *
 * Returns undefined when nothing at all was installed: no clipmap and no
 * colliding props. That is not an error (see the note above), but it does
 * mean this process cannot check these players, and the caller says so.
 */
/** Reads one file out of a catalogue entry. The route is public, so this needs no token. */
export type CatalogFileReader = (ref: CatalogEntryRef, rel: string) => Promise<Uint8Array | undefined>;

export async function buildServerCollision(world: ResolvedWorld, source: WorldSource, catalogFile: CatalogFileReader): Promise<ServerCollision | undefined> {
  const collision = new CollisionWorld();
  let triangles = 0;

  if (world.collision) {
    const bytes = await source.asset(world.collision.source);
    if (!bytes) {
      throw new Error(`collision mesh not found: "${world.collision.source}" in ${source.describe}`);
    }

    // With the actors' channel: any game on the map may run actors, and they are
    // stopped by the AI clip and not the player-only clip (docs/engine/collision.md).
    collision.rebuild(
      buildCollisionGroups(await parseGltf(bytes), HEADLESS_MATERIAL),
      world.solids.map((solid) => solid.part),
      { ai: true },
    );
    // Before setHulls, or debugSurfaces() reports the props as well. Summed over
    // every tree it returns rather than the first: the clipmap is two of them now
    // (what stops a bullet, and what stops only a player), and reading one would
    // report three quarters of the map and call it all of it.
    for (const surface of collision.debugSurfaces()) {
      const index = surface.geometry.getIndex();
      triangles += (index?.count ?? surface.geometry.getAttribute("position")?.count ?? 0) / 3;
    }
  }

  // A missing prop is a hole in the collision rather than a reason to refuse
  // the map, so `load` resolves to undefined and buildPropCollision counts it.
  //
  // Two roots, because a prop belongs to the catalogue and a world's own files do
  // not. This is the server's half of `scene/assetUrl.ts`: the same decision, made
  // on the same field, over a different transport — the client spells a URL and
  // fetches it, and here a world file comes off the world source while a catalogue
  // file comes off the api. Getting it wrong is silent, and was: every prop on
  // every imported map resolved to a world-relative path that does not exist any
  // more, so this server collided with none of them while every client collided
  // with all of them.
  const props = await buildPropCollision(world, async (asset) => {
    const bytes = asset.catalog ? await catalogFile(asset.catalog, asset.source) : await source.asset(asset.source);
    return bytes ? await parseGltf(bytes) : undefined;
  });

  collision.setHulls(props.geometries, props.placements);

  if (!collision.ready) {
    return undefined;
  }
  return {
    world: collision,
    triangles,
    props: { assets: props.geometries.size, placements: props.placements.length, missing: props.missing },
  };
}
