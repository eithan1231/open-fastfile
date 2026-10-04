// What drives a bot, as a match sees it.
//
// A bot is a `Match` member like any player: it is spawned, armed, stepped, shot
// and snapshotted by the same code. The one difference is where its input comes
// from. A player's arrives over the network; a bot's is written by a controller,
// once a tick, just before the inputs are drained (`Match.thinkBots`).
//
// The controller a real game uses is `BotDriver` (@3d/shared/game/bots/driver.ts):
// a brain, its memory and a motor, which is all of a bot's behaviour and lives in
// tier one. A script adds one by naming a brain (`ServerContext.bots.add`), and
// the match wraps it here and does nothing else. The seam stays an interface so
// a test can stand anything behind it.

import type { BotTurn } from "@3d/shared/game/bots/driver.js";
import type { Objective } from "@3d/shared/game/bots/objective.js";
import type { TeamId } from "@3d/shared/game/gametypes/declaration.js";
import type { Loadout } from "@3d/shared/sim/loadout.js";
import type { PlayerInput } from "@3d/shared/sim/input.js";

export type { BotTurn };

/** Makes one bot's input. `BotDriver` is one. */
export interface BotController {
  /**
   * Write this tick's input into `out`, which arrives as an idle input facing
   * where the bot faces. Called once a tick while the match has a graph to
   * walk, dead or alive — a dead bot's input is spent on nothing, but a
   * controller may want to know it died. The match rounds what it writes as the
   * wire would.
   */
  think(turn: BotTurn, out: PlayerInput): void;
}

/** A bot to add to a match. */
export interface BotOptions {
  controller: BotController;
  /** Its side, by a name the gametype's `teams` lists. Absent: the side a joining player would get. */
  team?: TeamId;
  /** A class to carry. Absent: armed as a player with no class is, by the gametype. */
  loadout?: Loadout;
  /** What it is for. Absent: `none`. */
  objective?: Objective;
}
