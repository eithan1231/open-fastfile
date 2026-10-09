// `ResolvedWorld.effects` -> what the runtime needs: placements, the library, and
// one batch per material.
//
// The build half only; engine/fx/ owns the simulation. Textures come from the
// world's AssetStore, so leaving the world frees them with everything else.

import { FxBatch, fxMaterial } from "../engine/fx/batch.js";
import { FxCloudBatch, cloudGeometry } from "../engine/fx/cloud.js";
import { readFxLibrary, type FxLibrary } from "../engine/fx/library.js";
import type { FxBuild, FxPlacement } from "../engine/fx/system.js";
import type { AssetStore } from "./assets.js";
import type { ResolvedEffect, ResolvedWorld } from "@3d/shared/dsl/resolved.js";

/** Per material, how many particles its batch can hold at once. */
const BATCH_CAPACITY = 2048;
/** Per material, how many clouds can draw at once: each is a mesh of its own. */
const CLOUD_CAPACITY = 64;

export interface BuiltFx {
  library: FxLibrary;
  placements: FxPlacement[];
  build: FxBuild;
}

export function fxPlacements(effects: readonly ResolvedEffect[]): FxPlacement[] {
  return effects.map((e) => ({
    id: e.id,
    fx: e.fx,
    position: { x: e.position.x, y: e.position.y, z: e.position.z },
    rotation: { x: e.rotation.x, y: e.rotation.y, z: e.rotation.z },
    delay: e.delay,
    repeat: e.repeat,
  }));
}

/**
 * Fetch a world's effect library and build a batch per material it draws with.
 *
 * Returns undefined for a world that declares no `fx` node, which is most of
 * them. A library that fails to parse is fatal rather than silent: an effect
 * that spawns nothing is indistinguishable from a rendering bug.
 */
export async function buildFx(world: ResolvedWorld, baseUrl: string, assets: AssetStore): Promise<BuiltFx | undefined> {
  if (!world.fx || world.effects.length === 0) {
    return undefined;
  }
  // `baseUrl` is a site-relative prefix like "/worlds/dome-mw3/", so it is
  // concatenated as everything else in scene/ does. `new URL(x, baseUrl)` throws
  // on a relative base.
  const url = baseUrl + world.fx.source;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url}: ${response.status} ${response.statusText}`);
  }
  const library = readFxLibrary(await response.json(), world.fx.source);

  // Every material any placed effect draws with, and the atlas each one uses.
  const wanted = new Map<string, { cols: number; rows: number; sortOrder: number }>();
  const clouded = new Map<string, number>();
  const seen = new Set<string>();
  const walk = (name: string, depth: number): void => {
    const effect = library.effects[name];
    if (!effect || depth > 4 || seen.has(`${name}:${depth}`)) {
      return;
    }
    seen.add(`${name}:${depth}`);
    for (const elem of effect.elems) {
      if (elem.type === "RUNNER") {
        for (const child of elem.visuals.names) {
          walk(child, depth + 1);
        }
        continue;
      }
      if (elem.type === "CLOUD") {
        for (const material of elem.visuals.names) {
          clouded.set(material, elem.sortOrder);
        }
        continue;
      }
      for (const material of elem.visuals.names) {
        if (wanted.has(material)) {
          continue;
        }
        // The atlas is a square-ish grid of entryCount cells; the index bits say
        // how it is cut. 2 col bits and 2 row bits is the common 4x4 sheet.
        const cols = 1 << elem.atlas.colIndexBits;
        const rows = 1 << elem.atlas.rowIndexBits;
        wanted.set(material, { cols: Math.max(cols, 1), rows: Math.max(rows, 1), sortOrder: elem.sortOrder });
      }
    }
  };
  for (const placement of world.effects) {
    walk(placement.fx, 0);
  }

  const batches = new Map<string, FxBatch>();
  const batchOf = new Map<string, string>();
  for (const [material, atlas] of wanted) {
    // The exporter names a sheet after the image, not the material that draws
    // it, and several effects share one -- so the mapping travels in the library
    // rather than being guessed from the material name.
    const state = library.materials[material];
    if (!state || state.undrawn) {
      continue;
    }
    const texture = assets.fxSprite(`${baseUrl}assets/fx/textures/${state.texture}`);
    const mat = fxMaterial(
      texture,
      {
        blendOp: state.blendOp,
        blendSrc: state.blendSrc,
        blendDst: state.blendDst,
        doubleSided: state.doubleSided,
        fog: state.fog,
        featherDepth: state.featherDepth ?? 0,
        output: state.output,
        fogFade: state.fogFade,
        falloff: state.falloff,
        eyeOffset: state.eyeOffset,
      },
      atlas,
    );
    // The game's own sort key where it has one: these sheets all ship 48, well
    // above the opaque tiers, and it keeps effects in the order it drew them.
    batches.set(material, new FxBatch(mat, BATCH_CAPACITY, state.sortKey ?? atlas.sortOrder));
    batchOf.set(material, material);
  }

  // One point buffer for every cloud in the world, built only when one is drawn.
  const clouds = new Map<string, FxCloudBatch>();
  const buffer = clouded.size > 0 ? cloudGeometry() : undefined;
  for (const [material, sortOrder] of clouded) {
    const state = library.materials[material];
    if (!state || state.undrawn || !buffer) {
      continue;
    }
    const texture = assets.fxSprite(`${baseUrl}assets/fx/textures/${state.texture}`);
    const opts = { output: state.output, blendSrc: state.blendSrc, blendDst: state.blendDst };
    clouds.set(material, new FxCloudBatch(texture, buffer, opts, CLOUD_CAPACITY, state.sortKey ?? sortOrder));
  }

  return { library, placements: fxPlacements(world.effects), build: { batches, batchOf, clouds } };
}
