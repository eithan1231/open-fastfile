// One match's way of asking the world's graph where to go.
//
// The graph is baked once per world and shared; the blocked links are this
// match's (`NavMatchState`). A planner holds both, plus the one `NavSearch` every
// bot in the match plans with — a search is scratch arrays the size of the graph,
// reused rather than cleared, and the match's bots think one after another on one
// thread, so one is enough.
//
// Points become nodes here and nowhere else (`nearestNode`), with a height limit:
// a node on the floor above or below somebody is not where they are standing.

import { createPath, NavSearch } from "../../nav/astar.js";
import type { NavMatchState } from "../../nav/dynamic.js";
import type { NavGraph } from "../../nav/graph.js";
import { PLAYER_MOVER, type NavMover } from "../../nav/mover.js";
import { ABILITIES } from "../../nav/vocab.js";
import type { Vec3 } from "../../sim/capsule.js";

/** Every ability our player has: a bot walks, drops, mantles, climbs and jumps as a player does. */
export const ALL_ABILITIES = Object.values(ABILITIES).reduce((a, b) => a | b, 0);

/**
 * A point is at a node no further above or below it than this, m. Feet are on
 * the floor and so are a node's, so this only has to allow a slope and a step;
 * a storey is about three metres, and must not count.
 */
export const GROUND_DY = 1.5;
/** ...and no further away horizontally than this, m. Past it, a point is off the graph. */
export const GROUND_REACH = 8;

/** A path planned between two nodes: what a brain hands the motor so it need not plan twice. */
export interface Route {
  readonly start: number;
  readonly end: number;
  /** Link ids, start to end. Empty when the two are one node. */
  readonly links: readonly number[];
  /** Seconds, as the bake simulated them. */
  readonly cost: number;
  /** `NavMatchState.epoch` when it was planned: an older route may cross a link shut since. */
  readonly epoch: number;
}

export class NavPlanner {
  private readonly search: NavSearch;
  private readonly scratch = createPath();

  constructor(
    readonly graph: NavGraph,
    readonly state: NavMatchState,
    readonly abilities = ALL_ABILITIES,
    /** Whose links: a bot's (the bake's verdict) or an actor's (nav/mover.ts). Each has its own `state`. */
    readonly mover: NavMover = PLAYER_MOVER,
  ) {
    this.search = new NavSearch(graph);
  }

  /** Always true: a planner exists only once the world's graph is baked. */
  get ready(): boolean {
    return true;
  }

  /** The usable node nearest `point`, within `maxDy` of its height and `maxDistance` across; -1 for none. */
  nearestNode(point: Vec3, maxDy = GROUND_DY, maxDistance = GROUND_REACH): number {
    return this.graph.nearestNode(point, maxDy, maxDistance);
  }

  /** Where a node's feet are. */
  nodeFeet(node: number): Vec3 {
    const f = this.graph.feet;
    return { x: f[node * 3]!, y: f[node * 3 + 1]!, z: f[node * 3 + 2]! };
  }

  /** A path from the node at `from` to the node at `to`, or null when either is off the graph or no path is open. */
  route(from: Vec3, to: Vec3): Route | null {
    const start = this.nearestNode(from);
    const end = this.nearestNode(to);
    return start < 0 || end < 0 ? null : this.between(start, end);
  }

  /** A path between two nodes, or null. */
  between(start: number, end: number): Route | null {
    const status = this.search.find(start, end, { abilities: this.abilities, blocked: this.state.blocked, mover: this.mover }, this.scratch);
    if (status !== "found") {
      return null;
    }
    return { start, end, links: [...this.scratch.links], cost: this.scratch.cost, epoch: this.state.epoch };
  }
}
