// Chase: the survivors run, the horde follows. The first gametype with bots in it.
//
// Plain data, like every declaration; the behaviour is `scripts/chase.ts`. The
// horde is bots and the survivors are people, and nothing here says so — the
// script puts each on their side, because a declaration says what a gametype is
// and never who is who.

import type { GametypeDecl } from "./declaration.js";

export const CHASE_GAMETYPE = "chase";

export const chaseGametype: GametypeDecl = {
  id: CHASE_GAMETYPE,
  display: "Chase",
  description: "The survivors run and a horde of bots hunts them down.",
  teams: ["survivors", "horde"],
  // Team deathmatch's spawns: every imported map has them, one start per side at
  // opposite ends, which is where a chase should begin.
  spawnMode: "tdm",
  // And team deathmatch's furniture: a wager barrier is not a wall in a chase.
  mode: "tdm",
  // Only where there is navigation to chase over and spawns to start from
  // (docs/cod/navigation.md): MW3's graph, and AW's own. Ghosts has a graph but
  // no MP spawns in its lump, so a chase there would start everyone in one place.
  // Black Ops has both, but its exported collision keeps brush models TDM
  // deletes, which cut most of its maps' graphs apart.
  games: ["iw5", "s1"],
};
