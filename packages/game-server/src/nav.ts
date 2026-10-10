// A world's navigation on this server: its graph, baked as the world loads.
//
// The bake is seconds of CPU (docs/engine/navigation.md, "Budgets"), and this
// process hosts several games on one event loop, so it is never run in one go.
// `NavBaker` runs each bake in slices of `NAV_SLICE_MS` with a macrotask between
// them, which is where the tick's timer fires: a tick waits behind at most one
// slice, and the bake has whatever the ticks leave. Nothing waits for it. A game
// on the map is joinable as soon as its collision is built, and its bots stand
// still until `WorldNav.graph` is there (match/bots.ts).
//
// One bake at a time, oldest first: the first map finishes as soon as it can
// rather than every map finishing late together.

import { performance } from "node:perf_hooks";
import { singleton } from "tsyringe";
import { LoopBase } from "@3d/shared/lifecycle/loop.js";
import { NavBake, type NavBakeSummary } from "@3d/shared/nav/bake.js";
import type { NavFile } from "@3d/shared/nav/format.js";
import type { NavGraph } from "@3d/shared/nav/graph.js";
import type { CapsuleWorld } from "@3d/shared/sim/capsule.js";
import type { MovementRules } from "@3d/shared/sim/worldRules.js";
import { linksThroughParts, type NavPart } from "@3d/shared/nav/parts.js";
import { actorMover } from "@3d/shared/nav/mover.js";
import { config } from "./config.js";

/** How often an idle baker looks for work, ms. A bake queued in between waits this long to start, against seconds of baking. */
const IDLE_MS = 100;

/** A clock in milliseconds. `performance.now` in the process; a test may hand in its own. */
export type Clock = () => number;

/**
 * One world's navigation: a bake in progress, then its graph.
 *
 * Shared by every game on the map, like its collision, and dropped with it. The
 * graph is immutable once baked; what one game changes about it is that game's
 * `NavMatchState`.
 */
export class WorldNav {
  private job: NavBake | null;
  private baked: NavGraph | null = null;
  private outcome: "baking" | "ready" | "failed" | "cancelled" = "baking";
  private resolve!: (graph: NavGraph | null) => void;
  /** Settles with the graph once baked, or null if the bake failed or was cancelled. For a test, or anything that must wait. */
  readonly settled: Promise<NavGraph | null>;
  /** When the bake was queued, on the baker's clock. */
  readonly queuedAt: number;
  /** The bake's own account once it finished: counts, and the time `run` took. */
  summary: NavBakeSummary | null = null;
  /** From queued to finished, ms on the baker's clock: the slices and everything between them. */
  wallMs: number | null = null;
  /** The links each of the world's solids shuts while present, by solid index. Empty until the graph is there. */
  partLinks: readonly (readonly number[])[] = [];
  /**
   * The same for an actor: found over the actor's links (nav/mover.ts) against the
   * `ai` channel, so an AI-only window clip shuts its window's climb and a player
   * clip shuts nothing. Empty where the collision has no `ai` channel.
   */
  actorPartLinks: readonly (readonly number[])[] = [];

  constructor(
    readonly map: string,
    job: NavBake,
    queuedAt: number,
    /** The world the graph is baked against, and its removable parts: what `partLinks` is found with. */
    private readonly parts?: NavPartSets,
  ) {
    this.job = job;
    this.queuedAt = queuedAt;
    this.settled = new Promise((resolve) => (this.resolve = resolve));
  }

  /** The graph, once the bake is done; null before then, and for good if it failed or was cancelled. */
  get graph(): NavGraph | null {
    return this.baked;
  }

  get ready(): boolean {
    return this.outcome === "ready";
  }

  /** Whether the baker still has work to do on this. */
  get pending(): boolean {
    return this.outcome === "baking";
  }

  /** Stop baking: the world is being unloaded. A finished graph is kept for whoever still holds it. */
  cancel(): void {
    if (this.outcome !== "baking") {
      return;
    }
    this.outcome = "cancelled";
    this.job = null;
    this.resolve(null);
  }

  /** One slice. True once there is nothing left to do. */
  step(now: Clock, sliceMs: number): boolean {
    const job = this.job;
    if (!job || this.outcome !== "baking") {
      return true;
    }
    let done: boolean;
    try {
      done = job.run({ now, ms: sliceMs });
    } catch (err) {
      // A bake that throws is a bug in it, and a world with no bots is the right
      // answer to one: the games on the map play on without them.
      console.warn(`  ! nav "${this.map}": the bake failed, so bots here will stand still: ${err instanceof Error ? err.message : String(err)}`);
      this.outcome = "failed";
      this.job = null;
      this.resolve(null);
      return true;
    }
    if (!done) {
      return false;
    }
    // Before the graph is handed over, so no match ever sees it without them.
    this.partLinks = this.parts ? linksThroughParts(job.graph, this.parts.ground, this.parts.parts) : [];
    const actor = this.parts?.actor;
    this.actorPartLinks = actor ? linksThroughParts(job.graph, actor.ground, actor.parts, actorMover(job.graph).valid) : [];
    this.baked = job.graph;
    this.summary = job.summary;
    this.wallMs = now() - this.queuedAt;
    this.outcome = "ready";
    this.job = null;
    console.log(`    ${describeBake(this.map, this.summary, this.wallMs)}`);
    for (const [who, sets] of [
      ["", this.partLinks],
      [" for actors", this.actorPartLinks],
    ] as const) {
      const shut = sets.filter((links) => links.length > 0);
      if (shut.length > 0) {
        console.log(`    nav "${this.map}": ${shut.length} part(s) shut ${shut.reduce((n, links) => n + links.length, 0)} link(s)${who} while present`);
      }
    }
    this.resolve(this.baked);
    return true;
  }
}

/** A world's base and its removable parts, as a player meets them and, where built, as an actor does. */
export interface NavPartSets {
  ground: CapsuleWorld;
  parts: readonly (NavPart | undefined)[];
  /** The `ai` channel's base and parts. */
  actor?: { ground: CapsuleWorld; parts: readonly (NavPart | undefined)[] };
}

/** The one line a finished bake is logged as. */
export function describeBake(map: string, s: NavBakeSummary, wallMs: number): string {
  let traversalsValid = 0;
  let traversals = 0;
  for (const kind of Object.values(s.traversals)) {
    traversalsValid += kind.valid;
    traversals += kind.valid + kind.invalid;
  }
  const cpu = s.cpuMs?.total ?? 0;
  return (
    `nav "${map}": ${s.usable}/${s.nodes} nodes usable, ${s.valid.toLocaleString()} links valid, ${s.invalid.toLocaleString()} invalid, ` +
    `${traversalsValid}/${traversals} traversals valid; baked in ${Math.round(cpu)}ms of slices over ${Math.round(wallMs)}ms`
  );
}

/**
 * Runs every world's bake, a slice at a time.
 *
 * A `LoopBase` like the tick and the heartbeat, so it stops with them. Its delay
 * is the thing that makes it cooperative: between two slices it waits for one
 * turn of the event loop (`setImmediate`), which runs any timer that came due —
 * the tick's among them — before the next slice starts.
 */
@singleton()
export class NavBaker extends LoopBase {
  protected loopDuration = IDLE_MS;

  private readonly queue: WorldNav[] = [];

  constructor(private readonly now: Clock = () => performance.now()) {
    super();
  }

  /** Queue the bake of one world's navigation. Its graph appears on the result when done. */
  bake(
    map: string,
    file: NavFile,
    world: CapsuleWorld,
    rules: MovementRules,
    parts: readonly (NavPart | undefined)[] = [],
    actor?: NavPartSets["actor"],
  ): WorldNav {
    const nav = new WorldNav(map, new NavBake(file, world, rules, { tickRate: config.tickRate }), this.now(), { ground: world, parts, actor });
    this.queue.push(nav);
    return nav;
  }

  /** Bakes queued or under way. */
  get backlog(): number {
    return this.queue.filter((nav) => nav.pending).length;
  }

  protected async loopIteration(): Promise<void> {
    while (this.queue.length > 0 && !this.queue[0]!.pending) {
      this.queue.shift(); // cancelled while queued
    }
    const nav = this.queue[0];
    if (nav && nav.step(this.now, config.navSliceMs)) {
      this.queue.shift();
    }
  }

  protected override delay(): Promise<void> {
    if (this.queue.length === 0) {
      return super.delay();
    }
    return new Promise((resolve) => setImmediate(resolve));
  }

  /** A stopping process bakes nothing more; whatever was waiting settles with no graph. */
  protected override async loopClosed(): Promise<void> {
    for (const nav of this.queue.splice(0)) {
      nav.cancel();
    }
  }
}
