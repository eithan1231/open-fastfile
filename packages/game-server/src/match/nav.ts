// A match's navigation: the world's graph once it is baked, this match's blocked
// links on it, and the searches its bots and actors share. What a script's
// `ctx.nav` is.
//
// The bake is shared by every game on the map and finishes when it finishes
// (game-server/src/nav.ts), so a match polls for it once a tick rather than
// asking a getter that builds as a side effect.

import { NavMatchState, type NavBlockerShape } from "@3d/shared/nav/dynamic.js";
import type { NavGraph } from "@3d/shared/nav/graph.js";
import { actorMover } from "@3d/shared/nav/mover.js";
import { ALL_ABILITIES, NavPlanner } from "@3d/shared/game/bots/planner.js";
import type { ServerContext } from "@3d/shared/game/context.js";
import type { Vec3 } from "@3d/shared/sim/capsule.js";
import type { MatchParts } from "../parts.js";

/** The world's navigation as `Playing` hands it over: a graph that is null until baked, and the links each part fills. */
export interface NavSource {
  readonly graph: NavGraph | null;
  readonly partLinks?: readonly (readonly number[])[];
  readonly actorPartLinks?: readonly (readonly number[])[];
}

export class MatchNav implements Readonly<ServerContext["nav"]> {
  /** The graph, this match's blocked links and the search its bots share, once the world's bake is done. */
  private players: NavPlanner | null = null;
  /** The same graph by an actor's links (nav/mover.ts), with blocked links of its own. Built beside `players`. */
  private actors: NavPlanner | null = null;
  /** Blockers a script added before the graph was baked, applied the moment it is. */
  private readonly pending = new Map<string, { shape: NavBlockerShape; on: boolean }>();

  constructor(
    private readonly source: NavSource | undefined,
    private readonly parts: MatchParts,
  ) {
    this.poll();
  }

  /**
   * Build the planners if the bake has finished since the last poll, with
   * whatever blockers a script added meanwhile. A world with no navigation never
   * gets any, and its bots stand for good.
   */
  poll(): void {
    const graph = this.source?.graph;
    if (this.players || !graph) {
      return;
    }
    const state = new NavMatchState(graph);
    const actorState = new NavMatchState(graph);
    for (const [id, { shape, on }] of this.pending) {
      state.addBlocker(id, shape, on);
      actorState.addBlocker(id, shape, on);
    }
    this.pending.clear();
    this.parts.registerBlockers(state, this.source?.partLinks);
    this.parts.registerBlockers(actorState, this.source?.actorPartLinks);
    this.players = new NavPlanner(graph, state);
    this.actors = new NavPlanner(graph, actorState, ALL_ABILITIES, actorMover(graph));
  }

  /** The players' planner, or null until the bake is done. */
  get planner(): NavPlanner | null {
    return this.players;
  }

  /** The actors' planner: null exactly when `planner` is. */
  get actorPlanner(): NavPlanner | null {
    return this.actors;
  }

  get ready(): boolean {
    return this.players !== null;
  }

  nearestNode(point: Vec3, maxDy?: number): number {
    return this.players?.nearestNode(point, maxDy) ?? -1;
  }

  /** `ServerContext.nav.addBlocker`: on the match's state, or kept until there is one. */
  addBlocker(id: string, shape: NavBlockerShape, on = true): readonly number[] {
    if (!this.players) {
      this.pending.set(id, { shape, on });
      return [];
    }
    this.actors?.state.addBlocker(id, shape, on);
    return this.players.state.addBlocker(id, shape, on);
  }

  setBlocked(id: string, on: boolean): boolean {
    if (!this.players) {
      const pending = this.pending.get(id);
      if (!pending || pending.on === on) {
        return false;
      }
      pending.on = on;
      return true;
    }
    this.actors?.state.setBlocked(id, on);
    return this.players.state.setBlocked(id, on);
  }
}
