// The weapon catalogue as the api holds it: the index it serves, and the
// registry it reads a stored class against.
//
// Cached on a TTL, exactly as ManifestCache is and for the same reasons: the
// index is 700 KB of JSON, which is far too much to parse per request and cheap
// enough to redo on a timer — and a catalogue rebuilt on the volume has to show
// up without a restart, because rebuilding it is how a weapon is added.
//
// One read behind both accessors, so the bytes the client is sent and the
// registry a loadout is reconciled against can never be a rebuild apart.

import { inject, singleton } from "tsyringe";
import { WeaponRegistry, type WeaponEntry } from "@3d/shared/sim/weaponRegistry.js";
import { Clock } from "./clock.js";
import { Config } from "./config.js";
import { readCatalogIndex, type CatalogIndex } from "./worlds/fs.js";

const TTL_MS = 2000;

/**
 * What the index route answers with when there is no catalogue: an empty one,
 * which both ends hash alike. No kind's key at all, which every reader takes as
 * "this deployment has none" and degrades on.
 */
const EMPTY: CatalogIndex = { version: 1, weapons: [] };

interface Loaded {
  index: CatalogIndex;
  registry: WeaponRegistry;
}

@singleton()
export class Catalog {
  private cached: Promise<Loaded> | undefined;
  private builtAt = 0;

  constructor(
    @inject(Config) private readonly config: Config,
    @inject(Clock) private readonly clock: Clock,
  ) {}

  /** The whole catalogue, every kind of it, as the client and a game server fetch it. */
  async index(): Promise<CatalogIndex> {
    return (await this.load()).index;
  }

  /** The same catalogue as a registry, for deciding what a stored class still names. */
  async registry(): Promise<WeaponRegistry> {
    return (await this.load()).registry;
  }

  private load(): Promise<Loaded> {
    if (this.cached === undefined || this.clock.now() - this.builtAt > TTL_MS) {
      this.builtAt = this.clock.now();
      this.cached = this.read().catch((error: unknown) => {
        this.cached = undefined;
        throw error;
      });
    }
    return this.cached;
  }

  private async read(): Promise<Loaded> {
    const index = (await readCatalogIndex(this.config.worldsRoot)) ?? EMPTY;
    try {
      return { index, registry: new WeaponRegistry(index.weapons as WeaponEntry[]) };
    } catch (error) {
      // A catalogue the registry refuses — two weapons sharing an id, or one
      // offering more attachments than the wire can name — is a build problem,
      // and a loud empty one beats an api that 500s every request that touches a
      // class. The bytes are still served: a client that can build it can.
      console.warn(`the catalogue cannot be read as a registry (${String(error)}); classes will name nothing`);
      return { index, registry: new WeaponRegistry([]) };
    }
  }
}
