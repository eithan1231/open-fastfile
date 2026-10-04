// Being inside a volume: a `trigger`'s box, cylinder or sphere, or a solid's
// bounds. Pure arithmetic over plain data, so a game server's occupancy and both
// ends' use focus (focus.ts) answer the same question the same way.
//
// The shapes are the world file's (worlds/AUTHORING.md, `trigger`): a box and a
// sphere are centred on `position`; a cylinder stands on it, rising `height`,
// which is where Call of Duty's `trigger_radius` puts its origin and so what an
// imported one's `at` already means. Only yaw turns a box: it is all a trigger
// keeps of `rotate`.

import type { ResolvedTrigger } from "../dsl/resolved.js";
import type { Vec3 } from "../sim/capsule.js";

/** A volume's shape: a trigger's own fields. A solid's bounds are a box with no yaw. */
export type VolumeShape = Pick<ResolvedTrigger, "position" | "yaw" | "size" | "radius" | "height">;

/** An axis-aligned box, world space: what a broad phase compares. */
export interface Bounds {
  readonly min: Vec3;
  readonly max: Vec3;
}

/** Whether `point` is inside `volume`. On a face counts as inside. */
export function inside(volume: VolumeShape, point: Vec3): boolean {
  const dx = point.x - volume.position.x;
  const dy = point.y - volume.position.y;
  const dz = point.z - volume.position.z;
  if (volume.size) {
    const s = Math.sin(volume.yaw);
    const c = Math.cos(volume.yaw);
    // Into the box's own frame: the inverse of resolve's `rotateY(local, yaw)`.
    const lx = dx * c - dz * s;
    const lz = dx * s + dz * c;
    return Math.abs(lx) <= volume.size.x / 2 && Math.abs(dy) <= volume.size.y / 2 && Math.abs(lz) <= volume.size.z / 2;
  }
  const r = volume.radius ?? 0;
  if (volume.height !== undefined) {
    return dy >= 0 && dy <= volume.height && dx * dx + dz * dz <= r * r;
  }
  return dx * dx + dy * dy + dz * dz <= r * r;
}

/**
 * The centre of a volume's bounds: what `near` measures a reach to. A cylinder's
 * is half its height above where it stands.
 */
export function volumeCentre(volume: VolumeShape): Vec3 {
  const { x, y, z } = volume.position;
  return !volume.size && volume.height !== undefined ? { x, y: y + volume.height / 2, z } : { x, y, z };
}

/** The axis-aligned bounds of a volume, turned boxes included. */
export function volumeBounds(volume: VolumeShape): Bounds {
  const { x, y, z } = volume.position;
  if (volume.size) {
    const c = Math.abs(Math.cos(volume.yaw));
    const s = Math.abs(Math.sin(volume.yaw));
    const hx = (volume.size.x / 2) * c + (volume.size.z / 2) * s;
    const hz = (volume.size.x / 2) * s + (volume.size.z / 2) * c;
    const hy = volume.size.y / 2;
    return { min: { x: x - hx, y: y - hy, z: z - hz }, max: { x: x + hx, y: y + hy, z: z + hz } };
  }
  const r = volume.radius ?? 0;
  if (volume.height !== undefined) {
    return { min: { x: x - r, y, z: z - r }, max: { x: x + r, y: y + volume.height, z: z + r } };
  }
  return { min: { x: x - r, y: y - r, z: z - r }, max: { x: x + r, y: y + r, z: z + r } };
}

/** A box volume over `bounds`: how a solid is used, since its part has no shape but its extent. */
export function boundsVolume(bounds: Bounds): VolumeShape {
  const { min, max } = bounds;
  return {
    position: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
    yaw: 0,
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
  };
}

/**
 * Whether an upright cylinder standing at `feet` (a player's body: `radius`
 * round, `height` tall) overlaps `volume`. Touching counts.
 */
export function touches(volume: VolumeShape, feet: Vec3, radius: number, height: number): boolean {
  const dx = feet.x - volume.position.x;
  const dz = feet.z - volume.position.z;
  // The body's span relative to the volume's origin.
  const bottom = feet.y - volume.position.y;
  const top = bottom + height;
  if (volume.size) {
    const hy = volume.size.y / 2;
    if (top < -hy || bottom > hy) {
      return false;
    }
    const s = Math.sin(volume.yaw);
    const c = Math.cos(volume.yaw);
    const lx = dx * c - dz * s;
    const lz = dx * s + dz * c;
    // Nearest point of the rectangle to the body's axis, in the box's frame.
    const ox = Math.max(Math.abs(lx) - volume.size.x / 2, 0);
    const oz = Math.max(Math.abs(lz) - volume.size.z / 2, 0);
    return ox * ox + oz * oz <= radius * radius;
  }
  const r = volume.radius ?? 0;
  if (volume.height !== undefined) {
    if (top < 0 || bottom > volume.height) {
      return false;
    }
    const reach = r + radius;
    return dx * dx + dz * dz <= reach * reach;
  }
  // A sphere against the cylinder: the nearest point of the body to its centre.
  const oy = bottom > 0 ? bottom : top < 0 ? -top : 0;
  const flat = Math.max(Math.hypot(dx, dz) - radius, 0);
  return flat * flat + oy * oy <= r * r;
}
