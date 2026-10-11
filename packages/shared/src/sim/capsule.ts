// What a movement step collides with, as plain data.
//
// The simulation runs on both a client and a server, so it may not depend on
// three.js — but the collision world it queries is built on three-mesh-bvh and
// hands back THREE.Vector3s. This interface is the seam: it names only `x/y/z`,
// and engine/collision.ts's CollisionWorld satisfies it structurally, because
// TypeScript method parameters are bivariant. Anything implementing it must
// write `out.position` field by field rather than calling `.set()`, so a plain
// object works as the scratch buffer.

import type { SurfaceType } from "./surfaces.js";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * The least a surface's normal may point up (its y) and still be ground: about
 * 45.6° from level. Anything steeper is not stood on, and a body on it slides.
 * reverse/iw5-pmove has where the number comes from.
 */
export const WALKABLE_NORMAL_Y = 0.7;
/**
 * The least a contact may point up and still be under a capsule rather than
 * beside it. Between this and WALKABLE_NORMAL_Y a surface is a slope to slide on.
 */
export const SLOPE_NORMAL_Y = 0.3;

export interface CapsuleResolution {
  /** New feet (bottom-of-capsule) position after resolving penetrations. */
  position: Vec3;
  /** True if the capsule was pushed out of ground: something walkable under it. */
  grounded: boolean;
  /**
   * Where the capsule's bottom is held up from: the unit direction from the
   * most level thing it was pushed out of to its axis. A face's normal on a
   * face; on a corner, the way from the corner — so `radius * (1 - normal.y)`
   * is how far above the feet the contact is. Zero when nothing under it was
   * touched.
   *
   * `grounded` is not `normal.y >= WALKABLE_NORMAL_Y`: the corner of a walkable
   * face is ground however far round the bottom it is, down to SLOPE_NORMAL_Y,
   * because a box would be standing on the face (docs/engine/collision.md).
   */
  normal: Vec3;
}

/**
 * What a trace is looking for. A bullet and a line of sight want different sets,
 * and asking for one by name is what keeps the callers from having to know which
 * geometry means what.
 *
 * Only `shots` is built. `sight` is named because the distinction is real in the
 * source games — `ai_nosight` brushes stop a line of sight and nothing else — and
 * naming it now costs a union member, where retrofitting a parameter costs every
 * call site.
 */
export type TraceChannel = "shots" | "sight";

/** What a trace found, and where. */
export interface RayHit {
  /** Metres along the ray from its origin. */
  distance: number;
  /** The surface normal at the hit, world space. Either winding: imported soup is not reliably outward-facing. */
  normal: Vec3;
  /** Which tree answered. For the debug view, and for surface effects later. */
  kind: "map" | "prop";
  /**
   * What the triangle is made of, for the sound a round makes arriving.
   *
   * `default` and never null, for the reason `surfaceAt` answers `default` to a
   * hand-written world: the trace found *something*, and a bullet hitting it
   * makes a noise whether or not the map said what it was. A prop hull carries
   * no surface at all — the exporter writes them for a map's own clipmap only —
   * so every prop is `default` too.
   */
  surface: SurfaceType;
}

/** What a step collides with, and what a shot travels through. */
export interface CapsuleWorld {
  readonly ready: boolean;
  resolveCapsule(position: Vec3, radius: number, height: number, out?: CapsuleResolution): CapsuleResolution;
  /**
   * Whether a capsule with its feet at `position` sinks into anything. Touching
   * is not overlapping: a capsule resting where `resolveCapsule` left it is
   * clear, float error and the resolver's millimetres of residue included.
   */
  overlapsCapsule(position: Vec3, radius: number, height: number): boolean;
  /**
   * Whether a ball of `radius` carried in a straight line from `from` to `to`
   * sinks into anything on the way, both ends included: `overlapsCapsule` for a
   * capsule that need not stand upright. What a lying body's legs are asked with.
   */
  overlapsSweep(from: Vec3, to: Vec3, radius: number): boolean;
  /**
   * The height of the first standable surface straight down from `from`, no
   * further than `distance` below it, or null. Standable is WALKABLE_NORMAL_Y.
   * Writes the surface's unit normal, pointing up, into `normal` when given.
   */
  groundBelow(from: Vec3, distance: number, normal?: Vec3): number | null;
  /**
   * The first thing along `direction` (a unit vector) from `from`, no further than
   * `distance`, or null.
   *
   * Not the same geometry a capsule collides with, which is the whole reason this
   * takes a `channel`: a map is full of invisible `clip_player` brushes over
   * windows and railings, and a bullet that stopped at those would die in mid-air
   * in front of the shooter. See `blocksShots` in collision/source.ts.
   *
   * Writes into `out` when given, so a server firing a shotgun allocates nothing.
   */
  traceRay(from: Vec3, direction: Vec3, distance: number, channel: TraceChannel, out?: RayHit): RayHit | null;
  /**
   * What the first standable surface straight down from `from` is made of, no
   * further than `distance` below it — the same hit `groundBelow` measures, so
   * the two can never name different triangles.
   *
   * Three answers, and they are not the same answer:
   * - a name, which is what a footstep is spelled with;
   * - `"default"`, for something that is there but says nothing — a hand-written
   *   world, a map exported before surfaces existed, or (on an imported map) a
   *   `caulk` face, which is a brush side nothing was ever meant to see;
   * - `null`, for nothing under the point at all.
   *
   * Straight down and nothing else: this answers "what am I standing on". What a
   * bullet hit is a question for `traceRay`, which already has the triangle.
   */
  surfaceAt(from: Vec3, distance: number): SurfaceType | null;
}
