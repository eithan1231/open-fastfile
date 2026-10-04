// Fetching the shared weapon catalogue, once, at boot.
//
// The catalogue is what makes a weapon nameable: a snapshot carries a weapon as
// an index into it, so the client needs it before it can read one — which is why
// it is fetched at boot beside the world manifest rather than per world or per
// match. It is small (definitions only; the models are fetched when a weapon is
// actually drawn), so one request answers for the whole session.
//
// Transport only, like the rest of net/: it decides nothing about when to load,
// and holds no three.js. app/ owns the lifetime.

import { CATALOG_INDEX_PATH, catalogFilePath, weaponModelPath } from "@3d/shared/protocol/routes/catalog.js";
import { CATALOG_VERSION, splitWeaponKey, WeaponRegistry, type WeaponEntry, type WeaponId } from "@3d/shared/sim/weaponRegistry.js";
import { catalogueViewOf, type CatalogIndexBody, type CatalogueView } from "@3d/shared/game/catalogueView.js";

/**
 * Where a weapon's model is served, from its catalogue id. Undefined for an id
 * that is not one — a world exported before weapons were named rather than
 * packed says `assets/viewmodel/iw5_m4_mp.glb` here, and that is not a weapon,
 * it is a file. `resolveWorld` reports it; this only declines to fetch it.
 */
export function weaponModelUrl(weapon: WeaponId): string | undefined {
  const parts = splitWeaponKey(weapon);
  return parts ? weaponModelPath(parts.game, parts.name) : undefined;
}

/**
 * Where an attachment's model is served. One file per *model*, not per
 * attachment: an ACOG and an SMG ACOG are two entries sharing one
 * `viewmodel_acog`, so the entry's `model` is what names the file.
 */
export function attachmentModelUrl(game: string, model: string): string {
  return catalogFilePath("attachments", game, model, `${model}.glb`);
}

/**
 * Where a scope's overlay picture is served. One entry per *material*, not per
 * weapon: `scope_overlay_us_iw5` is what four Modern Warfare 3 snipers and every
 * variable-zoom scope on them look through, so the id names the picture.
 */
export function overlayImageUrl(game: string, overlay: string): string {
  return catalogFilePath("overlays", game, overlay, `${overlay}.png`);
}

/**
 * Both readings of the one fetch: the weapons, and the cast.
 *
 * One request and one parse behind both, so what a player is dressed in and what
 * they hold can never be a rebuild apart — the same reason `api/src/catalog.ts`
 * keeps one read behind its two accessors.
 */
export interface LoadedCatalog {
  weapons: WeaponRegistry;
  catalogue: CatalogueView;
}

const EMPTY_CATALOG: LoadedCatalog = (() => {
  const weapons = new WeaponRegistry([]);
  return { weapons, catalogue: catalogueViewOf({ version: CATALOG_VERSION }, weapons) };
})();

/**
 * The catalogue, or an empty one.
 *
 * Empty rather than thrown, for the reason every other failure in net/ is
 * survivable: a client that cannot reach the catalogue still has a world to walk
 * around, and a game server holding a different catalogue refuses the join with
 * a reason rather than putting the wrong gun in anyone's hands. An empty
 * registry hashes the same on both ends, so two ends that both have none still
 * agree — which is what a deployment with no catalogue built yet wants.
 */
export async function loadCatalog(): Promise<LoadedCatalog> {
  try {
    const response = await fetch(CATALOG_INDEX_PATH);
    if (!response.ok) {
      console.warn(`no catalogue (${response.status}); weapons will not be named on the wire`);
      return EMPTY_CATALOG;
    }

    const body = (await response.json()) as CatalogIndexBody & { weapons?: WeaponEntry[] };
    if (body.version !== CATALOG_VERSION) {
      console.warn(`the weapon catalogue is version ${body.version}, and this build reads ${CATALOG_VERSION}`);
      return EMPTY_CATALOG;
    }

    const weapons = new WeaponRegistry(body.weapons ?? []);
    return { weapons, catalogue: catalogueViewOf(body, weapons) };
  } catch (error) {
    console.warn("could not load the catalogue:", error);
    return EMPTY_CATALOG;
  }
}
