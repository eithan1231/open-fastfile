// The one script there is: it dresses players and arms them.
//
// It exists to make the seam real while changing nothing. Both halves answer
// exactly what the two `.world` files answered — `client.cast` replaces
// `characters { … }` and the `hands:` of `viewmodel { … }`, and the weapon it
// names replaces that node's `weapon:` — so a world can stop declaring any of it
// without anything looking different.
//
// Both halves, because both ends need the answer and must reach the same one: the
// browser draws the body, and a game server decides what a player spawns holding.

import { castFor } from "../cast.js";
import type { Script } from "../hooks.js";

export const castScript: Script = {
  id: "cast",
  // Every gametype and every map: what a player wears is not one mode's question.
  server: {
    /**
     * The spawns this gametype wants.
     *
     * With the default gametype this is `{ start: true }` and nothing else, which
     * is precisely what `Match.spawnFor` already asks — so wiring this in changes
     * no behaviour. A gametype that names a `spawnMode` starts collecting the
     * per-mode, per-side spawns every imported map already carries.
     */
    playerSpawn: (ctx) => ({ mode: ctx.gametype.spawnMode, team: undefined, start: true }),
  },
  client: {
    cast: (view, team) => castFor({ game: view.game, gametype: view.gametype, team }, view.catalogue),
  },
};
