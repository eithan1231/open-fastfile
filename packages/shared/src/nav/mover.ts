// Who walks a graph, and whose verdict on its links they go by.
//
// One graph serves every mover on a world, and the bake's verdict on a link
// (`status`) is a *player's*: it walked the link in simulation with the player's
// capsule, collision and moves. That is right for a bot and wrong for an actor,
// which CoD moves by other rules — it ignores player clip, is stopped by AI clip,
// and crosses a traversal by playing its animation along the link. So an actor
// goes by the game's own compiled links instead, trusted as the game compiled
// them for its AI: a mover is a validity mask and a cost per link over the same
// link ids, so a match's blockers (a door's `part:` links, a stuck link) mean
// the same links to both. docs/engine/navigation.md, "Movers".

import { NO_INDEX_16 } from "./format.js";
import { LINK_ORIGIN, LINK_STATUS, type NavGraph } from "./graph.js";
import { RUN_SPEED } from "../sim/movement.js";
import { LINK_FLAGS, LINK_KINDS, TRAVERSAL_KINDS } from "./vocab.js";

/** Seconds a traversal costs an actor on top of its length at a run: a window climb is about a second and a half of clip. */
export const ACTOR_TRAVERSE_COST = 1.5;

export interface NavMover {
  readonly kind: "player" | "actor";
  /**
   * Per link, 1 where this mover may take it. Null: the bake's own verdict — any
   * link it did not rule out, whose required abilities the mover has.
   */
  readonly valid: Uint8Array | null;
  /** Per link, seconds. Null: the bake's simulated cost. */
  readonly cost: Float32Array | null;
  /** Crosses a traversal link by playing it (an actor's runtime), not by the follower's input. */
  readonly animatesTraversals: boolean;
}

/** A bot: the bake's verdict, the follower's moves. */
export const PLAYER_MOVER: NavMover = { kind: "player", valid: null, cost: null, animatesTraversals: false };

const actorMovers = new WeakMap<NavGraph, NavMover>();

/** An actor on `graph`: built once per graph, then shared by every match on the world. */
export function actorMover(graph: NavGraph): NavMover {
  let mover = actorMovers.get(graph);
  if (!mover) {
    const valid = new Uint8Array(graph.linkCount);
    const cost = new Float32Array(graph.linkCount);
    const f = graph.feet;
    for (let l = 0; l < graph.linkCount; l++) {
      valid[l] = actorMayTake(graph, l) ? 1 : 0;
      const a = graph.source[l]! * 3;
      const b = graph.target[l]! * 3;
      const length = Math.hypot(f[b]! - f[a]!, f[b + 1]! - f[a + 1]!, f[b + 2]! - f[a + 2]!);
      cost[l] = length / RUN_SPEED + (graph.kind[l] === LINK_KINDS.TRAVERSE ? ACTOR_TRAVERSE_COST : 0);
    }
    mover = { kind: "actor", valid, cost, animatesTraversals: true };
    actorMovers.set(graph, mover);
  }
  return mover;
}

/**
 * Whether an actor may take link `l`. Both ends must be usable nodes. A link the
 * game compiled (the file's, flagged `GAME`) is trusted whatever our player made
 * of it: a walk, or a traversal of a kind with a motion (not SPECIAL or UNKNOWN).
 * Any other link — derived at load, where the file had no walk links of its
 * own — goes by the bake's verdict, the only one there is.
 */
export function actorMayTake(graph: NavGraph, l: number): boolean {
  if (!graph.usable[graph.source[l]!] || !graph.usable[graph.target[l]!]) {
    return false;
  }
  if (graph.origin[l] === LINK_ORIGIN.FILE && graph.flags[l]! & LINK_FLAGS.GAME) {
    if (graph.kind[l] === LINK_KINDS.WALK) {
      return true;
    }
    const kind = graph.traversalKind[l]!;
    return (
      graph.kind[l] === LINK_KINDS.TRAVERSE &&
      graph.traversal[l] !== NO_INDEX_16 &&
      kind !== TRAVERSAL_KINDS.UNKNOWN &&
      kind !== TRAVERSAL_KINDS.SPECIAL &&
      kind < TRAVERSAL_KINDS.SPECIAL
    );
  }
  return graph.status[l] === LINK_STATUS.VALID;
}
