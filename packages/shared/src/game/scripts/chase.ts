// Chase: a horde of bots hunts the people. The worked example of a gametype
// with bots in it, and the proof that the three layers meet.
//
// This is the script's layer and nothing below it: it adds the horde, puts
// everyone on a side and says where each side spawns. What a bot does is its
// brain's (`seek-nearest`, game/bots/brains/), named here by id and never
// imported — this module is in the script table a browser loads, and the brains
// are server-only.
//
// The horde deals no damage: the brain never fires. Being caught is the whole
// of it, for now.

import type { Script } from "../hooks.js";
import { CHASE_GAMETYPE } from "../gametypes/chase.js";

/** How many bots hunt. */
export const HORDE_SIZE = 8;

const SURVIVORS = "survivors";
const HORDE = "horde";

/**
 * The side each spawns as, in the maps' own words: the survivors start at one
 * end of the map and the horde at the other.
 */
const SPAWNS_AS: Readonly<Record<string, string>> = { [SURVIVORS]: "allies", [HORDE]: "axis" };

export const chaseScript: Script = {
  id: "chase",
  gametypes: [CHASE_GAMETYPE],
  server: {
    matchStart: (ctx) => {
      for (let i = 0; i < HORDE_SIZE; i++) {
        ctx.bots.add({ brain: "seek-nearest", team: HORDE, objective: { kind: "hunt" } });
      }
    },
    // The default side balances by head count, and eight bots would put the
    // first eight people on the horde. People are survivors, whatever the count;
    // a mode that fills empty seats with bots would balance differently.
    playerJoin: (ctx, id) => {
      if (!ctx.player(id)?.bot) {
        ctx.setTeam(id, SURVIVORS);
      }
    },
    playerSpawn: (ctx, id) => {
      const team = ctx.player(id)?.team;
      return { mode: ctx.gametype.spawnMode, team: team === undefined ? undefined : SPAWNS_AS[team], start: true };
    },
  },
};
