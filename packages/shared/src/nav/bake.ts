// A decoded `nav.bin` plus a world's movement collision → the graph bots walk.
//
// A resumable job, because it is seconds of work and a game server has a tick to
// keep: `run` does as much as a budget allows and returns, and the next call
// carries on. The budget is handed in (a clock and a slice, or a count of work
// units) so this module keeps no clock of its own, and **the result never
// depends on it**: the same file, world and rules give the same graph byte for
// byte however the work was sliced. Everything is visited in index order.
//
// The stages, each in its own module:
//   1. snap every node onto the floor (nav/snap.ts);
//   2. gather the file's links, and with DERIVE_WALK_LINKS the candidate walk
//      links (nav/derive.ts), each pair probed both ways (nav/probe.ts);
//   3. simulate every link still undecided (nav/validate.ts).
// docs/engine/navigation.md has the numbers each is tuned by.

import type { CapsuleWorld } from "../sim/capsule.js";
import { movementEnv, PLAYER_MOVEMENT, type MovementRules } from "../sim/movement.js";
import { derivePairs, DERIVE_DEFAULTS, type DeriveOptions } from "./derive.js";
import { NO_INDEX_16, type NavFile } from "./format.js";
import { allocateGraph, LINK_ORIGIN, LINK_REASON, LINK_REASON_NAMES, LINK_STATUS, NavGraph, TRAVERSAL_KIND_NAMES, type NavGraphData } from "./graph.js";
import { probePair, type ProbeVerdict } from "./probe.js";
import { createSnapStats, snapNodes, type SnapStats } from "./snap.js";
import { simulateLink, type LinkOutcome, type ValidateEnv } from "./validate.js";
import { HEADER_FLAGS, LINK_KINDS, TRAVERSAL_KINDS } from "./vocab.js";

export interface NavBakeOptions {
  /** The match's tick rate: links are walked in simulation at the rate a bot walks them. */
  tickRate: number;
  derive?: Partial<DeriveOptions>;
}

/** How much a `run` call may do: a slice of a clock, or a count of work units. */
export type NavBudget = { now: () => number; ms: number } | { units: number };

export interface NavBakeSummary {
  nodes: number;
  usable: number;
  /** Unusable nodes by NODE_REASON name. */
  unusable: Record<string, number>;
  /** Usable nodes pushed off a wall to stand. */
  nudged: number;
  /** How far each usable node's file position was above the floor it snapped to, m. */
  snapDrop: { median: number; p95: number; max: number };
  /** Links in the file, and how many of them are traversals. */
  fileLinks: number;
  traversalLinks: number;
  derived: {
    /** Node pairs within reach. */
    pairs: number;
    /** Directed links those make, less any the file already has. */
    candidates: number;
    /** Candidates the probe passed on to simulation. */
    probed: number;
    /** Candidates the simulation walked. */
    valid: number;
  };
  links: number;
  valid: number;
  invalid: number;
  /** INVALID links by LINK_REASON name. */
  reasons: Record<string, number>;
  /** Traversal links by kind name. */
  traversals: Record<string, { valid: number; invalid: number }>;
  /** Links simulated, and the ticks that took. */
  simulated: number;
  simulatedTicks: number;
  probeSamples: number;
  /** CPU time spent in `run`, ms, per stage and in all; null when the budget had no clock. */
  cpuMs: { snap: number; derive: number; validate: number; total: number } | null;
}

/** The three stages of a bake, in order. */
export type NavBakeStage = "snap" | "derive" | "validate";

/** Nodes snapped, and pairs probed, between two points `run` may stop at: each well under a millisecond. */
const SNAP_BATCH = 32;
const PROBE_BATCH = 32;

/**
 * Each stage's share of `progress`: roughly where the time goes on the maps
 * measured (docs/engine/navigation.md, "Budgets"). A progress bar's weights,
 * never read by the bake itself.
 */
const STAGE_WEIGHT = { snap: 0.01, derive: 0.15, validate: 0.84 } as const;

/** A bake in progress. `run` until it returns true, then read `graph` and `summary`. */
export class NavBake {
  private readonly steps: Generator<NavBakeStage, void, void>;
  private stage: NavBakeStage = "snap";
  private finished = false;
  private graphOut: NavGraph | null = null;
  private readonly tickRate: number;
  private readonly derive: DeriveOptions;
  private readonly cpu = { snap: 0, derive: 0, validate: 0, total: 0 };
  private clocked = false;
  private snapStats: SnapStats | null = null;
  private readonly counts = { pairs: 0, candidates: 0, probed: 0, simulated: 0, ticks: 0, samples: 0 };
  /** How far each stage has got, for `progress`: nodes snapped, pairs probed, and the links there are to simulate. */
  private readonly reached = { snapped: 0, pairsProbed: 0, toSimulate: 0 };

  constructor(
    private readonly file: NavFile,
    private readonly world: CapsuleWorld,
    private readonly rules: MovementRules,
    options: NavBakeOptions,
  ) {
    this.tickRate = options.tickRate;
    this.derive = { ...DERIVE_DEFAULTS, ...options.derive };
    this.steps = this.bake();
  }

  get done(): boolean {
    return this.finished;
  }

  /** The finished graph. Throws before the bake is done. */
  get graph(): NavGraph {
    if (!this.graphOut) {
      throw new Error("nav: the bake has not finished");
    }
    return this.graphOut;
  }

  /** The stage the bake is in. */
  get currentStage(): NavBakeStage {
    return this.stage;
  }

  /**
   * How far the bake has got, from 0 to 1: each stage's fraction done, weighted
   * by `STAGE_WEIGHT`. An estimate for a progress bar; it only ever grows.
   */
  get progress(): number {
    if (this.finished) {
      return 1;
    }
    const { snapped, pairsProbed, toSimulate } = this.reached;
    const n = this.file.nodes.count;
    const snap = n === 0 ? 1 : snapped / n;
    const validating = this.stage === "validate";
    const derive = validating ? 1 : this.counts.pairs === 0 ? 0 : pairsProbed / this.counts.pairs;
    const validate = !validating || toSimulate === 0 ? 0 : this.counts.simulated / toSimulate;
    return Math.min(1, STAGE_WEIGHT.snap * snap + STAGE_WEIGHT.derive * derive + STAGE_WEIGHT.validate * validate);
  }

  /** Carry on for as long as `budget` allows; true once finished. */
  run(budget: NavBudget): boolean {
    if (this.finished) {
      return true;
    }
    if ("units" in budget) {
      for (let i = 0; i < budget.units && !this.finished; i++) {
        this.advance();
      }
      return this.finished;
    }
    this.clocked = true;
    const start = budget.now();
    let last = start;
    while (!this.finished) {
      const stage = this.stage;
      this.advance();
      const now = budget.now();
      this.cpu[stage] += now - last;
      last = now;
      if (now - start >= budget.ms) {
        break;
      }
    }
    this.cpu.total += last - start;
    return this.finished;
  }

  private advance(): void {
    const next = this.steps.next();
    if (next.done) {
      this.finished = true;
    } else {
      this.stage = next.value;
    }
  }

  /** The work, as a generator: each `yield` is a point `run` may stop at, named by the stage it is in. */
  private *bake(): Generator<NavBakeStage, void, void> {
    const file = this.file;
    const nodes = file.nodes;
    const n = nodes.count;

    // 1. Snap. A graph's node arrays exist before its links do, so these are
    //    written into scratch arrays and copied into the graph once its size is known.
    const feet = new Float32Array(n * 3);
    const usable = new Uint8Array(n);
    const nodeReason = new Uint8Array(n);
    this.snapStats = createSnapStats();
    for (let i = 0; i < n; i += SNAP_BATCH) {
      snapNodes(nodes, this.world, feet, usable, nodeReason, this.snapStats, i, Math.min(n, i + SNAP_BATCH));
      this.reached.snapped = Math.min(n, i + SNAP_BATCH);
      yield "snap";
    }

    // 2. The links: the file's, then the derived candidates, probed.
    const fileLinks = file.links;
    const derived: number[][] = Array.from({ length: n }, () => []);
    const derivedReason: number[][] = Array.from({ length: n }, () => []);
    if (file.flags & HEADER_FLAGS.DERIVE_WALK_LINKS) {
      const pairs = derivePairs({ nodeCount: n, feet, usable }, this.derive);
      this.counts.pairs = pairs.length / 2;
      yield "derive";
      const has = (a: number, b: number) => {
        for (let l = fileLinks.first[a]!; l < fileLinks.first[a + 1]!; l++) {
          if (fileLinks.target[l] === b) {
            return true;
          }
        }
        return false;
      };
      const verdict: ProbeVerdict = { forward: 0, backward: 0, samples: 0 };
      const a3 = { x: 0, y: 0, z: 0 };
      const b3 = { x: 0, y: 0, z: 0 };
      for (let k = 0; k < pairs.length; k += 2) {
        const a = pairs[k]!;
        const b = pairs[k + 1]!;
        const wantAB = !has(a, b);
        const wantBA = !has(b, a);
        if (!wantAB && !wantBA) {
          continue;
        }
        a3.x = feet[a * 3]!;
        a3.y = feet[a * 3 + 1]!;
        a3.z = feet[a * 3 + 2]!;
        b3.x = feet[b * 3]!;
        b3.y = feet[b * 3 + 1]!;
        b3.z = feet[b * 3 + 2]!;
        probePair(this.world, a3, b3, verdict);
        this.counts.samples += verdict.samples;
        if (wantAB) {
          derived[a]!.push(b);
          derivedReason[a]!.push(verdict.forward);
        }
        if (wantBA) {
          derived[b]!.push(a);
          derivedReason[b]!.push(verdict.backward);
        }
        if ((k / 2) % PROBE_BATCH === PROBE_BATCH - 1) {
          this.reached.pairsProbed = k / 2 + 1;
          yield "derive";
        }
      }
    }

    let derivedCount = 0;
    for (let i = 0; i < n; i++) {
      // Each row ascending by target, so a row's order depends on nothing but the pairs.
      const order = derived[i]!.map((_, k) => k).sort((p, q) => derived[i]![p]! - derived[i]![q]!);
      derived[i] = order.map((k) => derived[i]![k]!);
      derivedReason[i] = order.map((k) => derivedReason[i]![k]!);
      derivedCount += order.length;
    }
    this.counts.candidates = derivedCount;

    const g = allocateGraph(n, fileLinks.count + derivedCount);
    g.feet.set(feet);
    g.usable.set(usable);
    g.nodeReason.set(nodeReason);
    let l = 0;
    for (let i = 0; i < n; i++) {
      g.first[i] = l;
      for (let k = fileLinks.first[i]!; k < fileLinks.first[i + 1]!; k++, l++) {
        const kind = fileLinks.kind[k]!;
        const trav = fileLinks.traversal[k]!;
        g.source[l] = i;
        g.target[l] = fileLinks.target[k]!;
        g.kind[l] = kind;
        g.traversal[l] = trav;
        g.traversalKind[l] = kind === LINK_KINDS.TRAVERSE && trav !== NO_INDEX_16 ? file.traversals.kind[trav]! : TRAVERSAL_KINDS.UNKNOWN;
        g.flags[l] = fileLinks.flags[k]!;
        g.origin[l] = LINK_ORIGIN.FILE;
        g.gameCost[l] = fileLinks.gameCost[k]!;
        if (!movable(g, l)) {
          decide(g, l, LINK_REASON.NO_MOVE);
        }
      }
      for (let k = 0; k < derived[i]!.length; k++, l++) {
        g.source[l] = i;
        g.target[l] = derived[i]![k]!;
        g.kind[l] = LINK_KINDS.WALK;
        g.traversal[l] = NO_INDEX_16;
        g.traversalKind[l] = TRAVERSAL_KINDS.UNKNOWN;
        g.origin[l] = LINK_ORIGIN.DERIVED;
        g.gameCost[l] = Number.NaN;
        const reason = derivedReason[i]![k]!;
        if (reason !== LINK_REASON.NONE) {
          decide(g, l, reason);
        } else {
          this.counts.probed++;
        }
      }
    }
    g.first[n] = l;
    for (let k = 0; k < g.linkCount; k++) {
      if (g.status[k] === LINK_STATUS.UNKNOWN && (!usable[g.source[k]!] || !usable[g.target[k]!])) {
        decide(g, k, LINK_REASON.NODE);
      }
      if (g.status[k] === LINK_STATUS.UNKNOWN) {
        this.reached.toSimulate++;
      }
    }
    yield "derive";

    // 3. Walk every link still undecided.
    const movement = movementEnv(this.world, this.rules, PLAYER_MOVEMENT);
    const env: ValidateEnv = { movement, dt: 1 / this.tickRate, graph: g, nodeAbilities: nodes.abilities };
    const outcome: LinkOutcome = { status: 0, reason: 0, seconds: 0, requires: 0, ticks: 0 };
    for (let k = 0; k < g.linkCount; k++) {
      if (g.status[k] !== LINK_STATUS.UNKNOWN) {
        continue;
      }
      simulateLink(env, k, outcome);
      this.counts.simulated++;
      this.counts.ticks += outcome.ticks;
      g.status[k] = outcome.status;
      g.reason[k] = outcome.reason;
      g.requires[k] = outcome.requires;
      g.cost[k] = outcome.seconds;
      yield "validate";
    }

    this.graphOut = new NavGraph(g, file);
  }

  /** What the bake found. Complete once `done`; before that, as far as it has got. */
  get summary(): NavBakeSummary {
    const stats = this.snapStats;
    const drops = stats ? [...stats.drops].sort((a, b) => a - b) : [];
    const pick = (q: number) => (drops.length === 0 ? 0 : drops[Math.min(drops.length - 1, Math.floor(q * drops.length))]!);
    const summary: NavBakeSummary = {
      nodes: this.file.nodes.count,
      usable: stats?.usable ?? 0,
      unusable: stats?.unusable ?? {},
      nudged: stats?.nudged ?? 0,
      snapDrop: { median: pick(0.5), p95: pick(0.95), max: drops.length === 0 ? 0 : drops[drops.length - 1]! },
      fileLinks: this.file.links.count,
      traversalLinks: 0,
      derived: { pairs: this.counts.pairs, candidates: this.counts.candidates, probed: this.counts.probed, valid: 0 },
      links: 0,
      valid: 0,
      invalid: 0,
      reasons: {},
      traversals: {},
      simulated: this.counts.simulated,
      simulatedTicks: this.counts.ticks,
      probeSamples: this.counts.samples,
      cpuMs: this.clocked ? { ...this.cpu } : null,
    };
    const g = this.graphOut;
    if (!g) {
      return summary;
    }
    summary.links = g.linkCount;
    for (let l = 0; l < g.linkCount; l++) {
      const valid = g.status[l] === LINK_STATUS.VALID;
      if (valid) {
        summary.valid++;
        if (g.origin[l] === LINK_ORIGIN.DERIVED) {
          summary.derived.valid++;
        }
      } else {
        summary.invalid++;
        const name = LINK_REASON_NAMES[g.reason[l]!] ?? `reason${g.reason[l]}`;
        summary.reasons[name] = (summary.reasons[name] ?? 0) + 1;
      }
      if (g.kind[l] === LINK_KINDS.TRAVERSE) {
        summary.traversalLinks++;
        const name = TRAVERSAL_KIND_NAMES[g.traversalKind[l]!] ?? `kind${g.traversalKind[l]}`;
        const entry = (summary.traversals[name] ??= { valid: 0, invalid: 0 });
        if (valid) {
          entry.valid++;
        } else {
          entry.invalid++;
        }
      }
    }
    return summary;
  }
}

/** Bake to completion in one go: tests, tools, and anything with no tick to keep. */
export function bakeNav(
  file: NavFile,
  world: CapsuleWorld,
  rules: MovementRules,
  options: NavBakeOptions,
  now?: () => number,
): { graph: NavGraph; summary: NavBakeSummary } {
  const job = new NavBake(file, world, rules, options);
  while (!job.run(now ? { now, ms: Infinity } : { units: Number.MAX_SAFE_INTEGER })) {
    // `run` returns only when finished or out of budget, and neither budget runs out.
  }
  return { graph: job.graph, summary: job.summary };
}

/** Whether our player has a move for this link at all: a walk, or a traversal of a kind the follower knows. */
function movable(g: NavGraphData, l: number): boolean {
  if (g.kind[l] === LINK_KINDS.WALK) {
    return true;
  }
  if (g.kind[l] !== LINK_KINDS.TRAVERSE || g.traversal[l] === NO_INDEX_16) {
    return false;
  }
  const kind = g.traversalKind[l];
  return kind !== TRAVERSAL_KINDS.SPECIAL && kind !== TRAVERSAL_KINDS.UNKNOWN && kind! <= TRAVERSAL_KINDS.SPECIAL;
}

function decide(g: NavGraphData, l: number, reason: number): void {
  g.status[l] = LINK_STATUS.INVALID;
  g.reason[l] = reason;
}
