// What the game is made of, for the page's lifetime: the weapon registry and
// the cast catalogue, fetched once at boot, and the gametype being played.
//
// One object, held by reference by everything that reads it. The catalogue
// arrives a moment after the page does and a world can be mounted before or
// after that, so nothing may copy a field out of this and keep it.

import { catalogueViewOf, type CatalogueView } from "@3d/shared/game/catalogueView.js";
import { defaultGametype } from "@3d/shared/game/gametypes/default.js";
import type { GametypeDecl } from "@3d/shared/game/gametypes/declaration.js";
import { defaultLoadout, type Loadout } from "@3d/shared/sim/loadout.js";
import type { WeaponDef } from "@3d/shared/sim/weaponDef.js";
import { CATALOG_VERSION, resolveWeapon, WeaponRegistry } from "@3d/shared/sim/weaponRegistry.js";
import type { WeaponSource } from "../engine/audio/weapons.js";
import { loadCatalog } from "../net/catalog.js";
import type { UiState } from "./uiBridge.js";

export class GameContent implements WeaponSource {
  /**
   * Every weapon this build can name. Empty until the fetch lands and if it
   * never does, which is survivable: a snapshot's weapon index resolves to
   * nothing and a peer keeps the weapon it was drawn with.
   */
  weapons = new WeaponRegistry([]);
  /** The cast the catalogue offers. Empty until the fetch lands. */
  catalogue: CatalogueView = catalogueViewOf({ version: CATALOG_VERSION }, new WeaponRegistry([]));
  /**
   * Which gametype is being played: the default until matchmaking names one,
   * since a world is walked around offline far more often than it is played.
   */
  gametype: GametypeDecl = defaultGametype;

  constructor(private readonly ui: UiState) {}

  /** Fetch the catalogue, once; resolves with the registry when it is in. */
  async load(): Promise<WeaponRegistry> {
    const { weapons, catalogue } = await loadCatalog();
    this.weapons = weapons;
    this.catalogue = catalogue;
    return weapons;
  }

  /** The class the player spawns with: the one last chosen, read when a world is mounted. */
  loadout(): Loadout {
    return this.ui.loadouts.value[this.ui.selectedLoadout.value] ?? defaultLoadout(0);
  }

  /**
   * A peer's weapon index and attachments as the definition they name.
   * `resolveWeapon` hands back the entry's own object where nothing is fitted,
   * so the usual peer costs no allocation.
   */
  defAt(index: number | null, attachments: readonly number[]): WeaponDef | undefined {
    const entry = this.weapons.entry(this.weapons.idAt(index));
    return entry === undefined ? undefined : resolveWeapon(entry, attachments);
  }
}
