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

export interface CapsuleResolution {
  /** New feet (bottom-of-capsule) position after resolving penetrations. */
  position: Vec3;
  /** True if the capsule ended up resting on a roughly-upward-facing surface. */
  grounded: boolean;
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
   * The height of the first standable surface straight down from `from`, no
   * further than `distance` below it, or null. Standable as `resolveCapsule`
   * means it: nothing steeper than its ground slope.
   */
  groundBelow(from: Vec3, distance: number): number | null;
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
