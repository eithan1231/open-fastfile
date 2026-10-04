// The ladders a world declares, and the one question a movement step asks of
// them: sweeping the player's probe this way, is the first thing it touches a
// side of a ladder that can be climbed?
//
// That is the games' own test (IW5 `PM_CheckLadderMove`, 0x4230d0): a box trace
// ahead of the player against surfaces flagged as ladders. In the maps every
// ladder is a thin player-clip brush of its own, so a trace against the box is
// the trace the game made, and the world's collision is not asked — which also
// keeps this free of any geometry library. What that leaves out is a wall
// between the player and the ladder, which the maps do not build.
//
// What a ladder means is in dsl/resolved.ts's `ResolvedLadder`; how the grab
// and the climb use this, in sim/movement.ts and docs/engine/player.md.

import type { ResolvedLadder } from "../dsl/resolved.js";
import type { Vec3 } from "./capsule.js";

/** One game unit (an inch), metres. The games' ladder numbers are all in these. */
export const UNIT = 0.0254;

/**
 * The probe is the body with each horizontal half-width shrunk by this, and its
 * bottom raised by PROBE_FLOOR (IW5 0x41fc00). The inset leaves a body pressed
 * against a ladder 6 units short of it, which the reach then covers.
 */
const PROBE_INSET = 6 * UNIT;
const PROBE_FLOOR = 8 * UNIT;

/** The capsule a probe is cut from: sim/movement.ts's, passed in because that module imports this one. */
export interface LadderBody {
  radius: number;
  height: number;
}

/** What a probe touched: the ladder, and the outward normal of the side it touched, world space. */
export interface LadderHit {
  ladder: ResolvedLadder;
  /** Unit and horizontal: a probe is swept flat, so it only ever meets a ladder's sides. */
  x: number;
  z: number;
}

/** Turn `v` about +Y by `theta`. three.js' convention, as `dsl/resolveUtil.ts`'s `rotateY`. */
function rotateY(x: number, z: number, theta: number): { x: number; z: number } {
  const s = Math.sin(theta);
  const c = Math.cos(theta);
  return { x: x * c + z * s, z: -x * s + z * c };
}

/**
 * Where a segment from `p` along `d` is between -h and h on one axis, as
 * distances along it; null if it never is. A segment parallel to the slab is in
 * it for good or not at all.
 */
function slab(p: number, d: number, h: number): { enter: number; exit: number } | null {
  if (Math.abs(d) < 1e-9) {
    return Math.abs(p) < h ? { enter: -Infinity, exit: Infinity } : null;
  }
  const t0 = (-h - p) / d;
  const t1 = (h - p) / d;
  return { enter: Math.min(t0, t1), exit: Math.max(t0, t1) };
}

/** The side of a box whose outward normal is `sign` along its local X (`alongX`) or Z. See `ResolvedLadder.face`. */
function sideName(alongX: boolean, sign: number): NonNullable<ResolvedLadder["face"]> {
  if (alongX) {
    return sign > 0 ? "right" : "left";
  }
  return sign > 0 ? "back" : "front";
}

/**
 * The ladders of one world. A map has a handful (MW2's derail has the most, 24),
 * so a query tests every one rather than keeping a broad phase.
 */
export class LadderVolumes {
  constructor(private readonly ladders: readonly ResolvedLadder[]) {}

  get count(): number {
    return this.ladders.length;
  }

  /**
   * Sweep the probe from `feet` along the unit horizontal `(dirX, dirZ)` for
   * `reach` metres, and return the ladder side it meets first — or null if it
   * meets nothing, or first meets a side of a ladder that cannot be climbed
   * there (`face`): the game's trace stops at the first surface either way.
   *
   * A probe that starts inside a box touches nothing of it, as a start-solid
   * trace reports nothing to climb. The body cannot be there anyway: the box
   * is a wall in the world's collision, and the probe is narrower than the body.
   *
   * Deterministic: a server runs this for every player every tick, and has to
   * reach the answer the client did from the same state.
   */
  trace(feet: Vec3, dirX: number, dirZ: number, reach: number, body: LadderBody): LadderHit | null {
    const half = body.radius - PROBE_INSET;
    const bottom = feet.y + PROBE_FLOOR;
    const top = feet.y + body.height;

    let nearest = Infinity;
    let hit: { ladder: ResolvedLadder; alongX: boolean; sign: number } | null = null;
    for (const ladder of this.ladders) {
      const floor = ladder.position.y - ladder.size.y / 2;
      if (top <= floor || bottom >= floor + ladder.size.y) {
        continue;
      }
      // Into the box's frame (see ResolvedLadder), where the swept probe is a
      // segment against the box grown by the probe's half-width.
      const s = Math.sin(-ladder.yaw);
      const c = Math.cos(-ladder.yaw);
      const ox = feet.x - ladder.position.x;
      const oz = feet.z - ladder.position.z;
      const px = ox * c + oz * s;
      const pz = -ox * s + oz * c;
      const dx = dirX * c + dirZ * s;
      const dz = -dirX * s + dirZ * c;
      const hx = ladder.size.x / 2 + half;
      const hz = ladder.size.z / 2 + half;
      if (Math.abs(px) < hx && Math.abs(pz) < hz) {
        continue;
      }

      // Slabs: the segment enters the box at the later of its two entries, and
      // through the side of that axis facing back along the sweep.
      const x = slab(px, dx, hx);
      const z = slab(pz, dz, hz);
      if (!x || !z) {
        continue;
      }
      const alongX = x.enter >= z.enter;
      const enter = Math.max(x.enter, z.enter);
      if (enter < 0 || enter > Math.min(x.exit, z.exit) || enter > reach || enter >= nearest) {
        continue;
      }
      const sign = (alongX ? dx : dz) > 0 ? -1 : 1;
      nearest = enter;
      hit = { ladder, alongX, sign };
    }

    if (!hit || (hit.ladder.face !== undefined && hit.ladder.face !== sideName(hit.alongX, hit.sign))) {
      return null;
    }
    const normal = rotateY(hit.alongX ? hit.sign : 0, hit.alongX ? 0 : hit.sign, hit.ladder.yaw);
    return { ladder: hit.ladder, x: normal.x, z: normal.z };
  }
}

/** A world with no ladders, so a caller always has one to hold. */
export const NO_LADDERS = new LadderVolumes([]);
