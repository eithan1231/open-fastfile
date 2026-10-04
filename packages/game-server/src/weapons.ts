// The weapons this instance can build, fetched from the authority at boot.
//
// A game server used to hold no weapon at all: `WeaponDef` was read out of a
// world's viewmodel GLB in the client's scene/, so a server `Player` had none
// and `sprintAllowed` was therefore always true — while the client drops to a
// walk while firing, aiming or reloading. That gap is the documented reason
// drift rises during a fight (docs/server/README.md). This closes it, and does
// so without the process learning what a model is: a definition is plain data,
// served beside the model rather than inside it.

import { inject, singleton } from "tsyringe";
import { CATALOG_VERSION, WeaponRegistry, type WeaponEntry } from "@3d/shared/sim/weaponRegistry.js";
import { catalogueViewOf, type CatalogueView } from "@3d/shared/game/catalogueView.js";
import { Api } from "./api.js";

@singleton()
export class Weapons {
  private registry = new WeaponRegistry([]);
  /**
   * The same fetch, read as a cast rather than as an armoury.
   *
   * One read behind both, as `api/src/catalog.ts` keeps one behind its two
   * accessors and for the same reason: what a player is dressed in and what they
   * hold must not be able to come from two different rebuilds.
   */
  private view: CatalogueView = catalogueViewOf({ version: CATALOG_VERSION }, new WeaponRegistry([]));

  constructor(@inject(Api) private readonly api: Api) {}

  get all(): WeaponRegistry {
    return this.registry;
  }

  /** The catalogue a gametype chooses a cast out of. */
  get catalogue(): CatalogueView {
    return this.view;
  }

  /** The digest a joining client's own catalogue must match. */
  get hash(): string {
    return this.registry.hash;
  }

  /**
   * Load the catalogue. Not fatal when it is empty or unreadable: an instance
   * with no weapons still hosts a walkable match, which is what a deployment
   * that has not built a catalogue yet has always had. It is said loudly,
   * though, because "every player is unarmed" reads as a netcode fault and is
   * not one.
   */
  async load(): Promise<void> {
    const body = await this.api.client.catalogIndex();
    if (body.version !== CATALOG_VERSION) {
      console.warn(`! the weapon catalogue is version ${body.version} and this build reads ${CATALOG_VERSION}; hosting with none`);
      return;
    }

    this.registry = new WeaponRegistry(body.weapons as WeaponEntry[]);
    this.view = catalogueViewOf(body, this.registry);
    if (this.registry.size === 0) {
      console.warn("! the weapon catalogue is empty: every player here is unarmed, and drift will read high in a fight");
      return;
    }
    console.log(`weapons: ${this.registry.size} in the catalogue (${this.registry.hash})`);
  }
}
