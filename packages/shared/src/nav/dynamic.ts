// What one match changes about a shared graph: links shut by something in the way.
//
// The graph is baked once per world and shared by every game on it, so nothing
// here writes to it. A match keeps a blocked count per link instead — blockers
// that overlap add, so opening one door never opens a link another still shuts —
// and an epoch that moves whenever any count changes. A path planned at one
// epoch is rechecked (`pathOpen`) only when the epoch has moved, and replanned
// if a link on what is left of it has shut.
//
// Nothing builds doors yet. This is the seam they, and scripts, will use:
// `addBlocker` with a box or with the links themselves, then `setBlocked` to
// open and shut it. A file's START_DISCONNECTED links begin behind one.

import type { Vec3 } from "../sim/capsule.js";
import { HEIGHT, RADIUS } from "../sim/movement.js";
import type { NavGraph } from "./graph.js";
import { NavLinkGrid } from "./grid.js";
import { LINK_FLAGS } from "./vocab.js";

/** An upright box, turned `yaw` about +Y (three.js' convention, as a mantle volume is). */
export interface NavBox {
  center: Vec3;
  halfExtents: Vec3;
  yaw: number;
}

/** A blocker's shape: a box whose links are found for it, or the links themselves. */
export type NavBlockerShape = NavBox | { links: readonly number[] };

/** The blocker every START_DISCONNECTED link starts behind. */
export const START_DISCONNECTED_BLOCKER = "#start-disconnected";

interface Blocker {
  links: readonly number[];
  on: boolean;
}

/** Link corridors by cell, per graph: built on the first box blocker any match adds, then shared. */
const linkGrids = new WeakMap<NavGraph, NavLinkGrid>();

export class NavMatchState {
  /** Per link: how many blockers that are on hold it shut. A link with any is not walked. */
  readonly blocked: Uint8Array;
  /** Moves whenever any link opens or shuts. */
  epoch = 0;
  private readonly blockers = new Map<string, Blocker>();
  private readonly scratch: number[] = [];

  constructor(readonly graph: NavGraph) {
    this.blocked = new Uint8Array(graph.linkCount);
    const disconnected: number[] = [];
    for (let l = 0; l < graph.linkCount; l++) {
      if (graph.flags[l]! & LINK_FLAGS.START_DISCONNECTED) {
        disconnected.push(l);
      }
    }
    if (disconnected.length > 0) {
      this.addBlocker(START_DISCONNECTED_BLOCKER, { links: disconnected });
    }
  }

  /**
   * Register a blocker under `id`, on (shutting its links) unless `on` is false.
   * Returns the links it covers, ascending. An id already in use is replaced.
   */
  addBlocker(id: string, shape: NavBlockerShape, on = true): readonly number[] {
    this.removeBlocker(id);
    const links = "links" in shape ? [...new Set(shape.links)].sort((a, b) => a - b) : this.linksThrough(shape);
    this.blockers.set(id, { links, on: false });
    this.setBlocked(id, on);
    return links;
  }

  /** Open (false) or shut (true) a blocker. Returns whether anything changed. */
  setBlocked(id: string, on: boolean): boolean {
    const blocker = this.blockers.get(id);
    if (!blocker || blocker.on === on) {
      return false;
    }
    blocker.on = on;
    for (const l of blocker.links) {
      if (on) {
        if (this.blocked[l] === 255) {
          throw new Error(`nav: link ${l} is behind more than 255 blockers`);
        }
        this.blocked[l]!++;
      } else {
        this.blocked[l]!--;
      }
    }
    if (blocker.links.length > 0) {
      this.epoch++;
    }
    return true;
  }

  removeBlocker(id: string): void {
    if (this.blockers.has(id)) {
      this.setBlocked(id, false);
      this.blockers.delete(id);
    }
  }

  isOpen(link: number): boolean {
    return this.blocked[link] === 0;
  }

  /** Whether every link of `links` from index `from` on is open. */
  pathOpen(links: ArrayLike<number>, from = 0): boolean {
    for (let i = from; i < links.length; i++) {
      if (this.blocked[links[i]!] !== 0) {
        return false;
      }
    }
    return true;
  }

  /**
   * The links whose corridor a body walking them would sweep through `box`: the
   * segment between their feet, grown by the body's radius sideways and its
   * height upward. A square grown corner rather than a rounded one, so a box
   * shuts a little more than it strictly touches, never less.
   */
  private linksThrough(box: NavBox): number[] {
    const graph = this.graph;
    let grid = linkGrids.get(graph);
    if (!grid) {
      grid = new NavLinkGrid(graph, RADIUS);
      linkGrids.set(graph, grid);
    }
    const hx = box.halfExtents.x + RADIUS;
    const hz = box.halfExtents.z + RADIUS;
    const c = Math.cos(box.yaw);
    const s = Math.sin(box.yaw);
    // The box's own footprint on the ground plane, for the broad phase.
    const ex = Math.abs(c) * box.halfExtents.x + Math.abs(s) * box.halfExtents.z + RADIUS;
    const ez = Math.abs(s) * box.halfExtents.x + Math.abs(c) * box.halfExtents.z + RADIUS;
    const out: number[] = [];
    const f = graph.feet;
    for (const l of grid.near(box.center.x - ex, box.center.z - ez, box.center.x + ex, box.center.z + ez, this.scratch)) {
      const a = graph.source[l]! * 3;
      const b = graph.target[l]! * 3;
      const low = Math.min(f[a + 1]!, f[b + 1]!);
      const high = Math.max(f[a + 1]!, f[b + 1]!) + HEIGHT;
      if (high < box.center.y - box.halfExtents.y || low > box.center.y + box.halfExtents.y) {
        continue;
      }
      // Into the box's frame: turn the offsets by -yaw.
      const ax = f[a]! - box.center.x;
      const az = f[a + 2]! - box.center.z;
      const bx = f[b]! - box.center.x;
      const bz = f[b + 2]! - box.center.z;
      const px = ax * c - az * s;
      const pz = ax * s + az * c;
      const qx = bx * c - bz * s;
      const qz = bx * s + bz * c;
      if (segmentMeetsRect(px, pz, qx, qz, hx, hz)) {
        out.push(l);
      }
    }
    return out;
  }
}

/** Whether the segment (px, pz)–(qx, qz) meets the rectangle |x| ≤ hx, |z| ≤ hz. */
function segmentMeetsRect(px: number, pz: number, qx: number, qz: number, hx: number, hz: number): boolean {
  let enter = 0;
  let exit = 1;
  for (const [p, d, h] of [
    [px, qx - px, hx],
    [pz, qz - pz, hz],
  ] as const) {
    if (Math.abs(d) < 1e-12) {
      if (Math.abs(p) > h) {
        return false;
      }
      continue;
    }
    const t0 = (-h - p) / d;
    const t1 = (h - p) / d;
    enter = Math.max(enter, Math.min(t0, t1));
    exit = Math.min(exit, Math.max(t0, t1));
    if (enter > exit) {
      return false;
    }
  }
  return true;
}
