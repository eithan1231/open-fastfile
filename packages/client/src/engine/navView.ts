// Navigation view (`K`): the graph a bot walks, as this browser bakes it from
// the world's `nav.bin` and its own collision (docs/engine/navigation.md).
//
// Nothing crosses the wire for it. The bake is the same `NavBake` a game server
// runs, against the same movement collision a player here walks, so what it
// draws is what a server with this world would decide — and a link drawn red
// is one no bot will take. It is seconds of work, so it runs only once the view
// is first turned on, a slice per frame (`update`); the nodes are drawn from the
// file at once and redrawn on their snapped feet when the bake is done.
//
// Two modes, because the rejected candidates outnumber nothing else on a map
// and bury the graph: `graph` is the nodes, every VALID link and every
// traversal; `everything` adds the INVALID walk links, coloured by which check
// turned them down. A link is drawn from dim at its source to bright at its
// target, a little to its own right, so the two directions of a pair sit side
// by side and can be told apart.

import * as THREE from "three";
import { NavBake, type NavBakeSummary } from "@3d/shared/nav/bake.js";
import type { NavFile } from "@3d/shared/nav/format.js";
import {
  LINK_ORIGIN,
  LINK_REASON,
  LINK_REASON_NAMES,
  LINK_STATUS,
  NODE_REASON,
  NODE_REASON_NAMES,
  TRAVERSAL_KIND_NAMES,
  type NavGraph,
  type NavGraphData,
} from "@3d/shared/nav/graph.js";
import { SNAP_SEARCH } from "@3d/shared/nav/snap.js";
import { LINK_FLAGS, LINK_KINDS, NODE_FLAGS, NODE_TYPES, TRAVERSAL_KINDS } from "@3d/shared/nav/vocab.js";
import type { CapsuleWorld } from "@3d/shared/sim/capsule.js";
import type { MovementRules } from "@3d/shared/sim/worldRules.js";

export type NavViewMode = "off" | "graph" | "everything";

const MODES: readonly NavViewMode[] = ["off", "graph", "everything"];

/** What a node is for, as the view colours it. */
export type NodeCategory = "path" | "cover" | "traverse";

const NODE_COLOUR: Record<NodeCategory, number> = {
  path: 0xd8dee9,
  cover: 0x4f9dff,
  traverse: 0xffa040,
};

/** An unusable node, by why (NODE_REASON). */
const UNUSABLE_COLOUR: Record<number, number> = {
  [NODE_REASON.NO_GROUND]: 0xff4fd8,
  [NODE_REASON.INSIDE]: 0xff3b3b,
  [NODE_REASON.DYNAMIC]: 0xffd54f,
};

/** What a drawn link is, as the view colours it and the legend counts it. */
export type LinkCategory =
  "game walk" | "derived walk" | "traversal" | "invalid traversal" | "rejected by the probe" | "failed in simulation" | "unusable end or no move";

const LINK_COLOUR: Record<Exclude<LinkCategory, "traversal">, number> = {
  "game walk": 0x5cff9d,
  "derived walk": 0x3fc1c9,
  "invalid traversal": 0xff3b3b,
  // The probe turning a candidate down is ordinary: most of a map's pairs are
  // across a wall. Dim, so the graph stays readable in `everything`.
  "rejected by the probe": 0x7a3434,
  // The probe passed it and the walk failed: rare, and the interesting red.
  "failed in simulation": 0xff3b3b,
  "unusable end or no move": 0x6b6b6b,
};

/** A valid link a present removable part holds shut: magenta, so a door's links read at a glance. */
const SHUT_BY_PART_COLOUR = 0xff40ff;

/** A VALID traversal, by kind: what a bot does there. */
const TRAVERSAL_COLOUR: Record<number, number> = {
  [TRAVERSAL_KINDS.STEP_UP]: 0xfff176,
  [TRAVERSAL_KINDS.MANTLE_ON]: 0xffb74d,
  [TRAVERSAL_KINDS.MANTLE_OVER]: 0xff7043,
  [TRAVERSAL_KINDS.JUMP_DOWN]: 0xba68c8,
  [TRAVERSAL_KINDS.JUMP_ACROSS]: 0xf06292,
  [TRAVERSAL_KINDS.JUMP_UP]: 0xe1bee7,
  [TRAVERSAL_KINDS.LADDER_UP]: 0xff9e57,
  [TRAVERSAL_KINDS.LADDER_DOWN]: 0xd84315,
};
const UNKNOWN_TRAVERSAL_COLOUR = 0x9aa5b1;

/** Link reasons from the probe, as against the simulation or the nodes. */
const PROBE_REASONS: ReadonlySet<number> = new Set([LINK_REASON.GAP, LINK_REASON.BLOCKED, LINK_REASON.RISE, LINK_REASON.DROP, LINK_REASON.LEVEL]);
const SIMULATION_REASONS: ReadonlySet<number> = new Set([LINK_REASON.TIMEOUT, LINK_REASON.STUCK, LINK_REASON.FELL]);

/** A node's post, from its feet up, m. */
const POST = 0.5;
/** Half a node's cross at its feet, and an unusable node's larger one, m. */
const CROSS = 0.15;
const UNUSABLE_CROSS = 0.3;
/** How far a yawed node's facing tick reaches from the top of its post, m. */
const FACING = 0.35;
/** Links float this far above the feet, and sit this far to their own right, m. */
const LINK_LIFT = 0.12;
const LINK_SIDE = 0.06;
/** A traversal is an arc: its midpoint this far above the higher end, m. */
const ARC = 0.5;
/** A link's brightness at its source; its target is at full. */
const SOURCE_DIM = 0.35;
/** A node drawn from the file before the bake has placed it. */
const PENDING_DIM = 0.5;

/** Vertices for one LineSegments: xyz and rgb per vertex, two vertices a segment. */
export interface LineBuffers {
  positions: Float32Array;
  colours: Float32Array;
}

/** What a node is for. Cover includes concealment; every type that is neither cover nor a traversal's end is a place to walk through. */
export function nodeCategory(type: number): NodeCategory {
  if (type >= NODE_TYPES.COVER_STAND && type <= NODE_TYPES.CONCEALMENT_PRONE) {
    return "cover";
  }
  if (type === NODE_TYPES.TRAVERSE_BEGIN || type === NODE_TYPES.TRAVERSE_END || type === NODE_TYPES.JUMP || type === NODE_TYPES.JUMP_ATTACK) {
    return "traverse";
  }
  return "path";
}

/** What link `l` is to the view: which colour it gets and which legend row counts it. */
export function linkCategory(graph: NavGraphData, l: number): LinkCategory {
  const traversal = graph.kind[l] === LINK_KINDS.TRAVERSE;
  if (graph.status[l] === LINK_STATUS.VALID) {
    if (traversal) {
      return "traversal";
    }
    return graph.origin[l] === LINK_ORIGIN.FILE && (graph.flags[l]! & LINK_FLAGS.GAME) !== 0 ? "game walk" : "derived walk";
  }
  if (traversal) {
    return "invalid traversal";
  }
  const reason = graph.reason[l]!;
  if (PROBE_REASONS.has(reason)) {
    return "rejected by the probe";
  }
  if (SIMULATION_REASONS.has(reason)) {
    return "failed in simulation";
  }
  return "unusable end or no move";
}

/** Whether `mode` draws a link of `category`: `graph` leaves out the INVALID walk links, and keeps every traversal. */
export function drawsLink(mode: NavViewMode, category: LinkCategory): boolean {
  if (mode === "off") {
    return false;
  }
  if (mode === "everything") {
    return true;
  }
  return category === "game walk" || category === "derived walk" || category === "traversal" || category === "invalid traversal";
}

/** The colour of link `l`, which `linkCategory` has already classed. */
function linkColour(graph: NavGraphData, l: number, category: LinkCategory): number {
  return category === "traversal" ? (TRAVERSAL_COLOUR[graph.traversalKind[l]!] ?? UNKNOWN_TRAVERSAL_COLOUR) : LINK_COLOUR[category];
}

/** The nodes as markers: where they stand, their type and, once baked, whether they are usable. */
export interface NodeSource {
  readonly count: number;
  /** x y z per node: the file's positions before a bake, the snapped feet after. */
  readonly position: Float32Array;
  readonly type: Uint8Array;
  readonly flags: Uint8Array;
  readonly yaw: Uint16Array;
  /** Absent before a bake: every node drawn dim, as the file has it. */
  readonly usable?: Uint8Array;
  readonly nodeReason?: Uint8Array;
}

/**
 * One marker per node: a post up from its feet and a cross at them, with a tick
 * toward its yaw where it has one (a cover node faces its wall). An unusable
 * node is a larger cross in its reason's colour; one with no ground also gets a
 * line down as far as the snap searched.
 */
export function nodeLines(nodes: NodeSource): LineBuffers {
  const out = new LineWriter();
  const colour = new THREE.Color();
  for (let i = 0; i < nodes.count; i++) {
    const x = nodes.position[i * 3]!;
    const y = nodes.position[i * 3 + 1]!;
    const z = nodes.position[i * 3 + 2]!;
    const baked = nodes.usable !== undefined;
    const usable = !baked || nodes.usable![i] === 1;
    if (!usable) {
      const reason = nodes.nodeReason?.[i] ?? NODE_REASON.NONE;
      colour.setHex(UNUSABLE_COLOUR[reason] ?? UNUSABLE_COLOUR[NODE_REASON.INSIDE]!);
      const r = UNUSABLE_CROSS;
      out.segment(x - r, y + 0.02, z - r, x + r, y + 0.02, z + r, colour, colour);
      out.segment(x - r, y + 0.02, z + r, x + r, y + 0.02, z - r, colour, colour);
      out.segment(x, y, z, x, y + POST, z, colour, colour);
      if (reason === NODE_REASON.NO_GROUND) {
        const below = colour.clone().multiplyScalar(0.4);
        out.segment(x, y, z, x, y - SNAP_SEARCH, z, colour, below);
      }
      continue;
    }
    colour.setHex(NODE_COLOUR[nodeCategory(nodes.type[i]!)]);
    if (!baked) {
      colour.multiplyScalar(PENDING_DIM);
    }
    const c = CROSS;
    out.segment(x - c, y + 0.02, z, x + c, y + 0.02, z, colour, colour);
    out.segment(x, y + 0.02, z - c, x, y + 0.02, z + c, colour, colour);
    out.segment(x, y, z, x, y + POST, z, colour, colour);
    if (nodes.flags[i]! & NODE_FLAGS.HAS_YAW) {
      // Facing (-sin yaw, 0, -cos yaw), as the player does (nav/format.ts, `yawRadians`).
      const yaw = (nodes.yaw[i]! / 65536) * 2 * Math.PI;
      out.segment(x, y + POST, z, x - Math.sin(yaw) * FACING, y + POST, z - Math.cos(yaw) * FACING, colour, colour);
    }
  }
  return out.finish();
}

/** Every link `mode` draws: a walk as a straight line, a traversal as an arc over whatever it climbs. */
export function linkLines(graph: NavGraphData, mode: NavViewMode, shut: ReadonlySet<number> = new Set()): LineBuffers {
  const out = new LineWriter();
  const from = new THREE.Color();
  const to = new THREE.Color();
  for (let l = 0; l < graph.linkCount; l++) {
    const category = linkCategory(graph, l);
    if (!drawsLink(mode, category)) {
      continue;
    }
    to.setHex(shut.has(l) ? SHUT_BY_PART_COLOUR : linkColour(graph, l, category));
    from.copy(to).multiplyScalar(SOURCE_DIM);
    const a = graph.source[l]! * 3;
    const b = graph.target[l]! * 3;
    const ax = graph.feet[a]!;
    const ay = graph.feet[a + 1]! + LINK_LIFT;
    const az = graph.feet[a + 2]!;
    const bx = graph.feet[b]!;
    const by = graph.feet[b + 1]! + LINK_LIFT;
    const bz = graph.feet[b + 2]!;
    // A little to the link's own right, so A → B and B → A do not overlap.
    const dx = bx - ax;
    const dz = bz - az;
    const length = Math.hypot(dx, dz);
    const sx = length > 1e-6 ? (-dz / length) * LINK_SIDE : 0;
    const sz = length > 1e-6 ? (dx / length) * LINK_SIDE : 0;
    if (graph.kind[l] === LINK_KINDS.TRAVERSE) {
      const mx = (ax + bx) / 2 + sx;
      const my = Math.max(ay, by) + ARC;
      const mz = (az + bz) / 2 + sz;
      const mid = from.clone().lerp(to, 0.5);
      out.segment(ax + sx, ay, az + sz, mx, my, mz, from, mid);
      out.segment(mx, my, mz, bx + sx, by, bz + sz, mid, to);
    } else {
      out.segment(ax + sx, ay, az + sz, bx + sx, by, bz + sz, from, to);
    }
  }
  return out.finish();
}

/** One row of the legend: what a colour means and how many of it the graph has. */
export interface LegendRow {
  label: string;
  colour: number;
  count: number;
}

/**
 * What each colour means on this graph, with its count. INVALID links are
 * counted by reason too (`LINK_REASON` names), because the colour groups them
 * and the reason is the answer to "why not?".
 */
export function legend(graph: NavGraphData, types: Uint8Array): { nodes: LegendRow[]; links: LegendRow[]; reasons: Record<string, number> } {
  const nodes = new Map<string, LegendRow>();
  const bump = (map: Map<string, LegendRow>, label: string, colour: number) => {
    const row = map.get(label) ?? { label, colour, count: 0 };
    row.count++;
    map.set(label, row);
  };
  for (let i = 0; i < graph.nodeCount; i++) {
    if (graph.usable[i]) {
      const category = nodeCategory(types[i]!);
      bump(nodes, category, NODE_COLOUR[category]);
    } else {
      const reason = graph.nodeReason[i]!;
      bump(nodes, `unusable: ${NODE_REASON_NAMES[reason] ?? reason}`, UNUSABLE_COLOUR[reason] ?? UNUSABLE_COLOUR[NODE_REASON.INSIDE]!);
    }
  }
  const links = new Map<string, LegendRow>();
  const reasons: Record<string, number> = {};
  for (let l = 0; l < graph.linkCount; l++) {
    const category = linkCategory(graph, l);
    if (category === "traversal") {
      const kind = graph.traversalKind[l]!;
      const name = TRAVERSAL_KIND_NAMES[kind] ?? `kind ${kind}`;
      bump(links, `traversal ${name}`, TRAVERSAL_COLOUR[kind] ?? UNKNOWN_TRAVERSAL_COLOUR);
    } else {
      bump(links, category, linkColour(graph, l, category));
    }
    if (graph.status[l] === LINK_STATUS.INVALID) {
      const name = LINK_REASON_NAMES[graph.reason[l]!] ?? `reason ${graph.reason[l]}`;
      reasons[name] = (reasons[name] ?? 0) + 1;
    }
  }
  return { nodes: [...nodes.values()], links: [...links.values()], reasons };
}

/**
 * One node, for the stats line: its type, and what its links out came to —
 * the reasons included, since that is the question standing next to one asks.
 */
export function describeNode(graph: NavGraph, i: number): string {
  const type = graph.file.nodes.type[i]!;
  const name = (Object.keys(NODE_TYPES) as (keyof typeof NODE_TYPES)[]).find((k) => NODE_TYPES[k] === type)?.toLowerCase() ?? `type ${type}`;
  let valid = 0;
  const invalid: string[] = [];
  for (let l = graph.first[i]!; l < graph.first[i + 1]!; l++) {
    if (graph.status[l] === LINK_STATUS.VALID) {
      valid++;
    } else {
      invalid.push(LINK_REASON_NAMES[graph.reason[l]!] ?? `reason ${graph.reason[l]}`);
    }
  }
  const out = invalid.length === 0 ? "" : `, ${invalid.length} invalid (${[...new Set(invalid)].join(", ")})`;
  return `node #${i} ${name}: ${valid} link${valid === 1 ? "" : "s"} out${out}`;
}

export class NavView {
  /** Every node's marker, one draw call. */
  readonly nodeObject = new THREE.LineSegments(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9 }),
  );
  /** Every link the mode draws, one draw call. */
  readonly linkObject = new THREE.LineSegments(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85 }),
  );

  private viewMode: NavViewMode = "off";
  private job: NavBake | null = null;
  private file: NavFile | null = null;
  private baked: NavGraph | null = null;
  private bakeSummary: NavBakeSummary | null = null;
  private startedAt = 0;
  private finishedIn: number | null = null;
  private failed: string | null = null;
  private shut: ReadonlySet<number> = new Set();

  constructor() {
    for (const object of [this.nodeObject, this.linkObject]) {
      object.visible = false;
      object.frustumCulled = false; // one object spanning the whole world
      object.renderOrder = 998;
    }
    this.nodeObject.name = "nav-view-nodes";
    this.linkObject.name = "nav-view-links";
  }

  get mode(): NavViewMode {
    return this.viewMode;
  }

  get visible(): boolean {
    return this.viewMode !== "off";
  }

  /** Nothing loaded, a bake under way, a graph to draw, or a bake that threw (`failure`). */
  get state(): "empty" | "baking" | "ready" | "failed" {
    return this.baked ? "ready" : this.job ? "baking" : this.failed !== null ? "failed" : "empty";
  }

  /** Why the last bake stopped short, if it did. */
  get failure(): string | null {
    return this.failed;
  }

  /** How far the bake has got, 0 to 1 (`NavBake.progress`). */
  get progress(): number {
    return this.baked ? 1 : (this.job?.progress ?? 0);
  }

  get graph(): NavGraph | null {
    return this.baked;
  }

  get summary(): NavBakeSummary | null {
    return this.bakeSummary;
  }

  /** From `bake` to the last slice, ms: every frame in between, not only the slices. */
  get wallMs(): number | null {
    return this.finishedIn;
  }

  nextMode(): NavViewMode {
    return MODES[(MODES.indexOf(this.viewMode) + 1) % MODES.length]!;
  }

  /** The links present parts hold shut this match (nav/parts.ts), drawn in their own colour. */
  setShut(links: ReadonlySet<number>): void {
    this.shut = links;
    this.drawLinks();
  }

  setMode(mode: NavViewMode): void {
    const redraw = this.baked !== null && mode !== "off" && mode !== this.viewMode;
    this.viewMode = mode;
    this.nodeObject.visible = mode !== "off";
    this.linkObject.visible = mode !== "off";
    if (redraw) {
      this.drawLinks();
    }
  }

  /** Start baking `file` against `world`. Its nodes are drawn at once, where the file puts them. */
  bake(file: NavFile, world: CapsuleWorld, rules: MovementRules, tickRate: number, now: number): void {
    this.clear();
    this.file = file;
    this.job = new NavBake(file, world, rules, { tickRate });
    this.startedAt = now;
    setGeometry(this.nodeObject, nodeLines(file.nodes));
  }

  /**
   * One slice of the bake, if there is one under way. True on the call that
   * finished it, which is when the graph is drawn.
   */
  update(now: () => number, sliceMs: number): boolean {
    const job = this.job;
    if (!job || this.baked) {
      return false;
    }
    let done: boolean;
    try {
      done = job.run({ now, ms: sliceMs });
    } catch (err) {
      // A bug in the bake, which a game server would log and play on without
      // bots. Here it must not take the frame loop down with it.
      this.job = null;
      this.failed = err instanceof Error ? err.message : String(err);
      return false;
    }
    if (!done) {
      return false;
    }
    this.baked = job.graph;
    this.bakeSummary = job.summary;
    this.finishedIn = now() - this.startedAt;
    this.job = null;
    const graph = this.baked;
    const nodes = this.file!.nodes;
    setGeometry(this.nodeObject, nodeLines({ ...nodes, position: graph.feet, usable: graph.usable, nodeReason: graph.nodeReason }));
    this.drawLinks();
    return true;
  }

  /** What the colours mean on the baked graph, with counts; null before it is baked. */
  legend(): ReturnType<typeof legend> | null {
    return this.baked && this.file ? legend(this.baked, this.file.nodes.type) : null;
  }

  /** Forget the bake and everything drawn, and free the GPU's copies. The mode is kept. */
  clear(): void {
    this.job = null;
    this.file = null;
    this.baked = null;
    this.bakeSummary = null;
    this.finishedIn = null;
    this.failed = null;
    this.shut = new Set();
    for (const object of [this.nodeObject, this.linkObject]) {
      object.geometry.dispose();
      object.geometry = new THREE.BufferGeometry();
      // A disposed material is compiled again if it is drawn again: the next bake's.
      object.material.dispose();
    }
  }

  dispose(): void {
    this.clear();
  }

  private drawLinks(): void {
    if (this.baked) {
      setGeometry(this.linkObject, linkLines(this.baked, this.viewMode === "off" ? "graph" : this.viewMode, this.shut));
    }
  }
}

/** Replace an object's geometry with these lines, freeing the one it had. */
function setGeometry(object: THREE.LineSegments, lines: LineBuffers): void {
  object.geometry.dispose();
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(lines.positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(lines.colours, 3));
  object.geometry = geometry;
}

/** Segments into growable arrays, trimmed to size at the end. */
class LineWriter {
  private positions: number[] = [];
  private colours: number[] = [];

  segment(ax: number, ay: number, az: number, bx: number, by: number, bz: number, a: THREE.Color, b: THREE.Color): void {
    this.positions.push(ax, ay, az, bx, by, bz);
    this.colours.push(a.r, a.g, a.b, b.r, b.g, b.b);
  }

  finish(): LineBuffers {
    return { positions: Float32Array.from(this.positions), colours: Float32Array.from(this.colours) };
  }
}
