// A bot's body: a goal carried out, one tick of input at a time.
//
// The last of a bot's three layers (brain.ts). It plans with A* (planner.ts),
// walks with the follower the bake validated every link with (nav/follow.ts),
// and decides only what neither of those can:
//
// - **When to plan again.** A new goal whose end node is the one already being
//   walked to moves the point and keeps the path; another end node, or a link on
//   what is left of the path shut since it was planned (the match's epoch moved
//   and `pathOpen` says so), plans again — but never in the air, on a ladder, in
//   a mantle or part-way through a traversal, which would abandon a move half made.
//   Planned again part-way along a walk link, the path goes on from that link's
//   end with the link kept (`onward`): a quarry on the move would otherwise turn
//   it back and forth between two routes of about one cost around the same pillar.
// - **What a stuck follower means.** Stuck on a link it entered from that link's
//   own start, the link is to blame: it is shut for the rest of the match
//   (`stuck:<link>`, `NavMatchState.addBlocker`) and the motor plans around it.
//   Stuck on its first leg (walking onto the graph from wherever it stood) or its
//   last (off the graph, straight to the point), the straight line is: it walks to
//   the path's own start or end node first (a detour) and goes on from there.
//   Stuck again, it stands, says `stuck`, and waits for the brain to choose again.
// - **When it is there.** Within the goal's `arrive` it stops and faces the
//   point, and stays stopped until the point is half a metre further off.
// - **Whose traversal it is.** A bot's follower crosses a traversal with a
//   player's input. A mover that animates its traversals (an actor, nav/mover.ts)
//   walks to the link's begin instead, stands, and hands the link over
//   (`traversal`); its runtime plays it along the link and says `traversed`.

import {
  createCursor,
  followPath,
  nextLeg,
  FOLLOW_ARRIVE,
  FOLLOW_ARRIVE_DY,
  FOLLOW_STUCK_PROGRESS,
  FOLLOW_STUCK_TICKS,
  type FollowStatus,
  type NavCursor,
} from "../../nav/follow.js";
import { LINK_KINDS } from "../../nav/vocab.js";
import type { PlayerInput } from "../../sim/input.js";
import type { MovementState, Vec3 } from "../../sim/movement.js";
import { IDLE, type Goal, type MotorStatus, type MotorView, type MoveTo } from "./brain.js";
import type { NavPlanner, Route } from "./planner.js";

/** Within `arrive` horizontally, and this vertically, m, is there: a target on the floor above is not. */
export const ARRIVE_DY = 1;
/** Once there, it stays there until this much further than `arrive`, m, so a target shuffling on the spot is not chased. */
export const ARRIVE_SLACK = 0.5;
/** A tracked point that has moved this far, m, is a new target for the follower's progress check. */
const RETARGET = 0.5;

/** Where a player's feet are, for a goal that tracks one. */
export type FeetOf = (id: string) => Readonly<Vec3> | undefined;

export class Motor implements MotorView {
  status: MotorStatus = "idle";
  goal: Goal = IDLE;
  private cursor: NavCursor | null = null;
  private route: Route | null = null;
  /** A route the brain handed over with its goal, to take instead of planning. */
  private offered: Route | null = null;
  /** The point being walked to: the cursor's goal, moved in place when the goal moves. */
  private readonly point: Vec3 = { x: 0, y: 0, z: 0 };
  /** Where the point was when the follower's progress was last measured from scratch. */
  private readonly anchor: Vec3 = { x: 0, y: 0, z: 0 };
  /** The goal needs a new path: another end node, or the old one shut. */
  private stale = false;
  /** Nothing to do until the brain gives another goal: no path, or stuck with nothing to blame. */
  private halted = false;
  /** Within `arrive` last tick: what lets the slack apply. */
  private here = false;
  /** A node walked to straight before the path goes on — its start or end, after a leg off the graph stuck — or -1. */
  private detour = -1;
  /** This path has had its detour: stuck on a leg off the graph again, it gives up. */
  private detoured = false;
  /** The first link was entered from its own start (a detour went there): stuck on it, the link is to blame. */
  private fromStart = false;
  private epoch = -1;
  /**
   * A traversal link the motor stands at the begin of, handed to the runtime to
   * cross (a mover that animates them); -1 for none. The runtime says `traversed`.
   */
  traversal = -1;

  /** The links being walked and how far along, for a test or a debug view. */
  get path(): { readonly links: readonly number[]; readonly index: number } | null {
    return this.cursor && this.route ? { links: this.route.links, index: this.cursor.index } : null;
  }

  /** Take a new goal. Called when the brain thinks, which may be with the goal it had. */
  setGoal(goal: Goal, nav: NavPlanner | null): void {
    this.goal = goal;
    this.halted = false;
    if (goal.kind !== "moveTo") {
      this.drop();
      return;
    }
    copy(this.point, goal.point);
    this.offered = goal.route ?? null;
    const end = goal.route?.end ?? nav?.nearestNode(goal.point) ?? -1;
    if (this.cursor && this.route && end === this.route.end && this.cursor.index <= this.route.links.length) {
      this.offered = null;
      this.retarget();
      return;
    }
    this.stale = true;
  }

  /** The runtime has crossed `traversal`: the path goes on from its end. */
  traversed(): void {
    const cursor = this.cursor;
    if (cursor && this.traversal >= 0 && cursor.index < cursor.links.length && cursor.links[cursor.index] === this.traversal) {
      nextLeg(cursor);
    }
    this.traversal = -1;
  }

  /**
   * The runtime pushed it out of another body: the leg's progress is measured
   * afresh from where it was left, so a crowd queueing at a window, or a walker
   * shoved back half a metre, is not a stuck link shut for every mover in the match.
   */
  jostled(): void {
    if (this.cursor) {
      this.cursor.best = Infinity;
      this.cursor.sinceBest = 0;
    }
  }

  /** Forget the goal and the path: the bot died, or left. */
  reset(): void {
    this.goal = IDLE;
    this.status = "idle";
    this.halted = false;
    this.drop();
  }

  /**
   * Write this tick's input into `out`, which arrives as an idle input facing
   * where the bot faces, and say how the goal is going.
   */
  step(m: Readonly<MovementState>, dt: number, nav: NavPlanner, out: PlayerInput, feetOf?: FeetOf): MotorStatus {
    const goal = this.goal;
    if (goal.kind === "idle") {
      if (goal.look) {
        face(out, m, goal.look);
      }
      return (this.status = "idle");
    }
    if (goal.kind === "look") {
      face(out, m, goal.point);
      return (this.status = "idle");
    }
    if (goal.kind === "attack") {
      const target = feetOf?.(goal.target);
      if (target) {
        face(out, m, target);
      }
      return (this.status = "arrived");
    }
    return (this.status = this.move(goal, m, dt, nav, out, feetOf));
  }

  private move(goal: MoveTo, m: Readonly<MovementState>, dt: number, nav: NavPlanner, out: PlayerInput, feetOf: FeetOf | undefined): MotorStatus {
    const tracked = goal.track !== undefined ? feetOf?.(goal.track) : undefined;
    if (tracked) {
      copy(this.point, tracked);
      if (distance(this.point, this.anchor) > RETARGET) {
        this.retarget();
      }
    }

    const settled = m.grounded && m.mantle === null && m.ladder === null;
    const arrive = Math.max(goal.arrive ?? FOLLOW_ARRIVE, FOLLOW_ARRIVE);
    const horizontal = Math.hypot(this.point.x - m.feet.x, this.point.z - m.feet.z);
    if (settled && Math.abs(this.point.y - m.feet.y) <= ARRIVE_DY && horizontal <= arrive + (this.here ? ARRIVE_SLACK : 0)) {
      this.here = true;
      this.drop();
      face(out, m, goal.look ?? this.point);
      return "arrived";
    }
    this.here = false;
    if (this.halted) {
      face(out, m, this.point);
      return this.status;
    }

    const cursor = this.cursor;
    if (cursor && nav.state.epoch !== this.epoch) {
      this.epoch = nav.state.epoch;
      if (!nav.state.pathOpen(cursor.links, cursor.index)) {
        this.stale = true;
      }
    }
    // Plan on the ground or a ladder, never mid-flight or mid-mantle; with a path
    // in hand, only standing and between traversals, so a move is never left half
    // made. A mover whose runtime crosses its traversals is never in one here.
    const animated = nav.mover.animatesTraversals;
    const mayPlan = cursor ? settled && (animated || !this.onTraversal(nav)) : m.mantle === null && (m.grounded || m.ladder !== null);
    if ((this.stale || !cursor) && mayPlan) {
      if (!this.plan(m, dt, nav)) {
        this.halted = true;
        face(out, m, this.point);
        return "noPath";
      }
    }
    if (!this.cursor) {
      return "moving"; // falling onto the map from a spawn: nothing to plan from yet
    }

    let status = this.detour >= 0 ? this.toDetour(m, nav, out) : null;
    if (status === null && animated) {
      status = this.toTraversal(m, nav, out, false);
    }
    if (status === null) {
      status = followPath(m, this.cursor, nav.graph, out);
      // Just past a traversal's begin node: hand it over now, not a tick later from further on.
      if (status === "moving" && animated) {
        this.toTraversal(m, nav, out, true);
      }
    }
    if (status === "moving") {
      if (goal.run === false) {
        out.run = false;
      }
      return "moving";
    }
    if (status === "arrived") {
      this.here = true;
      this.drop();
      face(out, m, goal.look ?? this.point);
      return "arrived";
    }

    // Stuck. Blame the link only if it was entered from its own start; off the
    // graph, walk to the path's own node at that end and try the leg from there.
    // Stuck again from the start node, the first link is to blame after all.
    const { links, index } = this.cursor;
    const onGraph = index > 0 || this.fromStart;
    if ((!onGraph || index >= links.length) && this.detour < 0 && !this.detoured && this.route) {
      this.detour = index === 0 ? this.route.start : this.route.end;
      this.detoured = true;
      restart(this.cursor);
      stand(out);
      return "moving";
    }
    const blamed = onGraph && index < links.length ? links[index]! : -1;
    this.drop();
    stand(out);
    face(out, m, this.point);
    if (blamed >= 0) {
      nav.state.addBlocker(`stuck:${blamed}`, { links: [blamed] });
      this.stale = true;
      return "moving";
    }
    this.halted = true;
    return "stuck";
  }

  private plan(m: Readonly<MovementState>, dt: number, nav: NavPlanner): boolean {
    const offered = this.offered;
    this.offered = null;
    const old = this.cursor;
    const onward = this.onward(nav);
    const route = onward ?? (offered && offered.epoch === nav.state.epoch ? offered : nav.route(m.feet, this.point));
    if (!route) {
      this.drop();
      return false;
    }
    this.route = route;
    this.cursor = createCursor(route.links, dt, this.point);
    if (onward && old) {
      // The same leg goes on: so does the measure of whether it is getting anywhere.
      Object.assign(this.cursor, { best: old.best, sinceBest: old.sinceBest, tries: old.tries, lastX: old.lastX, lastZ: old.lastZ, hasLast: old.hasLast });
    } else {
      this.detour = -1;
      this.detoured = false;
      this.fromStart = false;
    }
    this.epoch = nav.state.epoch;
    this.stale = false;
    copy(this.anchor, this.point);
    return true;
  }

  /**
   * For a mover that animates traversals, with the cursor on one: at its begin,
   * stand and hand it over; short of it, walk straight there (a path whose first
   * link is one starts wherever the mover stood) unless `onlyThere`. Null when
   * the cursor is not on a traversal, or is and `onlyThere` finds it short.
   */
  private toTraversal(m: Readonly<MovementState>, nav: NavPlanner, out: PlayerInput, onlyThere: boolean): FollowStatus | null {
    const cursor = this.cursor!;
    if (!this.onTraversal(nav)) {
      return null;
    }
    const graph = nav.graph;
    const link = cursor.links[cursor.index]!;
    const f = graph.feet;
    const begin = graph.source[link]! * 3;
    const dx = f[begin]! - m.feet.x;
    const dz = f[begin + 2]! - m.feet.z;
    const horizontal = Math.hypot(dx, dz);
    if (horizontal <= FOLLOW_ARRIVE && Math.abs(f[begin + 1]! - m.feet.y) <= FOLLOW_ARRIVE_DY && m.grounded) {
      this.traversal = link;
      stand(out);
      const end = graph.target[link]! * 3;
      face(out, m, { x: f[end]!, y: f[end + 1]!, z: f[end + 2]! });
      return "moving";
    }
    if (onlyThere) {
      return null;
    }
    // The follower's own progress rule, on the walk to the begin.
    if (horizontal < cursor.best - FOLLOW_STUCK_PROGRESS) {
      cursor.best = horizontal;
      cursor.sinceBest = 0;
    } else if (++cursor.sinceBest >= FOLLOW_STUCK_TICKS) {
      return "stuck";
    }
    out.yaw = Math.atan2(-dx, -dz);
    out.forward = 1;
    out.run = this.goal.kind === "moveTo" && this.goal.run !== false;
    return "moving";
  }

  /**
   * The path from the end of the walk link being walked to the goal's end node,
   * that link first; null when not on an open walk link, or no path goes on from it.
   */
  private onward(nav: NavPlanner): Route | null {
    const cursor = this.cursor;
    if (!cursor || cursor.index >= cursor.links.length) {
      return null;
    }
    const link = cursor.links[cursor.index]!;
    const end = nav.nearestNode(this.point);
    if (nav.graph.kind[link] !== LINK_KINDS.WALK || nav.state.blocked[link] !== 0 || end < 0) {
      return null;
    }
    const next = nav.between(nav.graph.target[link]!, end);
    return next && { start: nav.graph.source[link]!, end, links: [link, ...next.links], cost: next.cost, epoch: next.epoch };
  }

  /**
   * Walk straight to the detour node. There, the path goes on from it this same
   * tick (null); short of it, "moving", or "stuck" by the follower's own
   * progress rule.
   */
  private toDetour(m: Readonly<MovementState>, nav: NavPlanner, out: PlayerInput): FollowStatus | null {
    const cursor = this.cursor!;
    const f = nav.graph.feet;
    const at = this.detour * 3;
    const dx = f[at]! - m.feet.x;
    const dz = f[at + 2]! - m.feet.z;
    const horizontal = Math.hypot(dx, dz);
    if (horizontal <= FOLLOW_ARRIVE && Math.abs(f[at + 1]! - m.feet.y) <= FOLLOW_ARRIVE_DY) {
      this.fromStart = cursor.index === 0;
      this.detour = -1;
      restart(cursor);
      return null;
    }
    if (horizontal < cursor.best - FOLLOW_STUCK_PROGRESS) {
      cursor.best = horizontal;
      cursor.sinceBest = 0;
    } else if (++cursor.sinceBest >= FOLLOW_STUCK_TICKS) {
      return "stuck";
    }
    out.yaw = Math.atan2(-dx, -dz);
    out.forward = 1;
    out.run = this.goal.kind === "moveTo" && this.goal.run !== false;
    return "moving";
  }

  /** On a traversal link: a mantle, a jump or a ladder, begun or about to be. */
  private onTraversal(nav: NavPlanner): boolean {
    const cursor = this.cursor;
    return cursor !== null && cursor.index < cursor.links.length && nav.graph.kind[cursor.links[cursor.index]!] !== LINK_KINDS.WALK;
  }

  /** The point moved: measure the follower's progress towards it afresh, so a quarry running away is not "stuck". */
  private retarget(): void {
    copy(this.anchor, this.point);
    const cursor = this.cursor;
    if (cursor && cursor.index >= cursor.links.length) {
      cursor.best = Infinity;
      cursor.sinceBest = 0;
      cursor.tries = 0;
    }
  }

  private drop(): void {
    this.traversal = -1;
    this.detour = -1;
    this.cursor = null;
    this.route = null;
    this.offered = null;
    this.stale = false;
  }
}

/** Measure a leg's progress afresh: a detour's walk is not the leg's, and the leg starts again after it. */
function restart(cursor: NavCursor): void {
  cursor.best = Infinity;
  cursor.sinceBest = 0;
  cursor.tries = 0;
}

function copy(to: Vec3, from: Readonly<Vec3>): void {
  to.x = from.x;
  to.y = from.y;
  to.z = from.z;
}

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function stand(out: PlayerInput): void {
  out.forward = 0;
  out.right = 0;
  out.run = false;
  out.jump = false;
}

/** Turn to face a point, level: the player faces (-sin yaw, -cos yaw). */
function face(out: PlayerInput, m: Readonly<MovementState>, point: Readonly<Vec3>): void {
  const dx = point.x - m.feet.x;
  const dz = point.z - m.feet.z;
  if (Math.hypot(dx, dz) > 0.05) {
    out.yaw = Math.atan2(-dx, -dz);
  }
}
