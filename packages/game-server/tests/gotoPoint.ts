// A bot controller for tests: plan an A* path to one point, and walk it.
//
// The least a controller can be and still exercise everything under a bot: the
// graph, the match's blocked links, `NavSearch`, and `followPath` driving the
// same `Player.step` a client's input does. It replans when a link on what is
// left of its path shuts, and gives up (standing still) when there is no path or
// the follower says it is stuck. A brain choosing *where* to go is not here.

import { NavSearch, createPath } from "@3d/shared/nav/astar.js";
import { createCursor, followPath, type NavCursor } from "@3d/shared/nav/follow.js";
import { ABILITIES } from "@3d/shared/nav/vocab.js";
import type { PlayerInput } from "@3d/shared/sim/input.js";
import type { Vec3 } from "@3d/shared/sim/movement.js";
import type { BotController, BotTurn } from "../src/bots.js";

export const ALL_ABILITIES = Object.values(ABILITIES).reduce((a, b) => a | b, 0);

export type GotoStatus = "waiting" | "moving" | "arrived" | "noPath" | "stuck";

export class GotoPoint implements BotController {
  status: GotoStatus = "waiting";
  /** How often it has planned: once at the start, and again each time its path was shut. */
  plans = 0;
  /** Ticks it was asked to think. */
  thinks = 0;
  readonly path = createPath();
  private search: NavSearch | null = null;
  private cursor: NavCursor | null = null;
  private epoch = -1;

  constructor(
    /** Where to go. Null: stand still until one is set. */
    public target: Vec3 | null,
    private readonly abilities = ALL_ABILITIES,
  ) {}

  /** The link the follower is on, or -1. */
  get leg(): number {
    return this.cursor ? this.cursor.index : -1;
  }

  think(bot: BotTurn, out: PlayerInput): void {
    this.thinks++;
    if (!bot.alive || this.target === null || this.status === "arrived" || this.status === "noPath" || this.status === "stuck") {
      return;
    }
    const { graph, state } = bot.nav;
    if (this.cursor && state.epoch !== this.epoch) {
      this.epoch = state.epoch;
      if (!state.pathOpen(this.path.links, this.cursor.index)) {
        this.cursor = null;
      }
    }
    if (!this.cursor && !this.plan(bot)) {
      return;
    }
    const status = followPath(bot.movement, this.cursor!, graph, out);
    if (status === "stuck") {
      Object.assign(out, { forward: 0, right: 0, run: false, jump: false });
    }
    this.status = status;
  }

  private plan(bot: BotTurn): boolean {
    const { graph, state } = bot.nav;
    this.plans++;
    this.epoch = state.epoch;
    this.search ??= new NavSearch(graph);
    const start = graph.nearestNode(bot.movement.feet, 2, 8);
    const goal = graph.nearestNode(this.target!, 2, 8);
    if (start < 0 || goal < 0 || this.search.find(start, goal, { abilities: this.abilities, blocked: state.blocked }, this.path) !== "found") {
      this.status = "noPath";
      return false;
    }
    this.cursor = createCursor(this.path.links, bot.dt, this.target);
    this.status = "moving";
    return true;
  }
}
