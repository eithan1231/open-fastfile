// The gametype a world is played with when nothing has chosen one.
//
// It exists to be exactly what the engine does today, so that moving the cast out
// of the world files changes no behaviour: two sides, every map, every game, and
// no mode — which makes `spawnPoints(world, { mode: undefined, team: undefined,
// start: true })` widen to the `{ start: true }` that `Spawns.place` already
// asks for.
//
// The sides are named as the maps name them (`worlds/*/gameplay.world`), so the
// day a gametype starts assigning teams there is nothing to translate.

import type { GametypeDecl } from "./declaration.js";

export const DEFAULT_GAMETYPE = "default";

export const defaultGametype: GametypeDecl = {
  id: DEFAULT_GAMETYPE,
  display: "Free Roam",
  description: "No rules and no score: walk the map, alone or with whoever joins.",
  teams: ["allies", "axis"],
  // No `spawnMode`, no `maps`, no `games`: today's behaviour on every world.
};
