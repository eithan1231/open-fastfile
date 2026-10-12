// Every body the catalogue on this disk holds, loaded as a game server loads
// them: through the api's own routes, into the rigs a shot is traced against.
// Null where no catalogue has been built, which is what the tests that need
// real bodies skip on.

import "reflect-metadata";
import { testApp } from "@3d/api/testing/app.js";
import type { GameKey } from "@3d/shared/dsl/resolved.js";
import { catalogueViewOf, type CatalogueView } from "@3d/shared/game/catalogueView.js";
import { createApiClient, type ApiClient } from "@3d/shared/protocol/api.js";
import type { HttpFetch } from "@3d/shared/protocol/http.js";
import { readHitboxes, type Hitbox } from "@3d/shared/rig/hitboxes.js";
import { WeaponRegistry, type WeaponEntry } from "@3d/shared/sim/weaponRegistry.js";
import type { Api } from "../src/api.js";
import { Bodies } from "../src/bodies.js";
import type { Weapons } from "../src/weapons.js";

/** The games with bodies of their own. Black Ops II wears Black Ops'. */
export const GAMES: GameKey[] = ["iw4", "iw5", "iw6", "t5", "s1"];

export interface CatalogueBodies {
  bodies: Bodies;
  catalogue: CatalogueView;
  client: ApiClient;
}

export async function catalogueBodies(): Promise<CatalogueBodies | null> {
  const { app } = testApp();
  const client = createApiClient({ fetch: app.request.bind(app) as HttpFetch });
  const index = await client.catalogIndex();
  const catalogue = catalogueViewOf(index, new WeaponRegistry(index.weapons as WeaponEntry[]));
  if (GAMES.every((game) => catalogue.charactersFor(game).length === 0)) {
    return null;
  }
  const bodies = new Bodies({ client } as unknown as Api, { catalogue } as unknown as Weapons);
  await bodies.load();
  return { bodies, catalogue, client };
}

/** The sidecar a body's boxes came from: `BoundHitboxes` keeps them, and does not hand them back. */
export async function sidecar(client: ApiClient, game: GameKey, id: string): Promise<Hitbox[]> {
  const bytes = await client.catalogFile({ kind: "characters", game, id, rest: `${id}.hitboxes.json` });
  return readHitboxes(JSON.parse(new TextDecoder().decode(bytes)));
}
