// Where a line meets a body: the two shapes a bullet is tested against.
//
// Plain numbers, no three.js, so it is tier one and a test can write its inputs as
// literals. The three.js side — posing a skeleton and handing over each bone's world
// matrix — is `@3d/shared/rig/`, which is the subtree allowed to do that.
//
// Both tests answer with a **fraction along the segment** rather than a distance in
// metres, and that is the one thing to understand here. A bone's matrix carries the
// rig's `unit-scale` root (0.0254 — a CoD skeleton is in inches), so a length
// measured inside a bone's frame is not a length in the world. A fraction is
// scale-free: it means the same thing in both frames, and the caller multiplies by
// the length it already knows. Returning box-space distances is the version of this
// that looks right and is wrong for every scaled thing.

/** Plain x/y/z, as `sim/capsule.ts` means it. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * A 4x4, column-major, exactly as three.js's `Matrix4.elements` holds one — so a
 * bone's `matrixWorld.elements` can be handed over untouched.
 */
export type Mat4 = readonly number[];

/** Nothing is closer than this to being a hit; guards the degenerate cases. */
const EPSILON = 1e-9;

/**
 * Whether the segment `from` → `to` passes within `radius` of the segment `a` → `b`,
 * answered as the fraction at their **closest approach**, or null.
 *
 * The broad phase: a player's movement capsule, which is cheap and rejects almost
 * everybody. Only what survives this is worth posing a skeleton for.
 *
 * Closest approach, **not** the point of entry, and the difference is up to a
 * radius. That is deliberate and it is safe here for one reason: nothing decides a
 * hit from this. It says which players are worth posing and roughly in what order,
 * and the box tests behind it return real entry fractions that the caller takes the
 * minimum of. Ordering two overlapping candidates the wrong way round costs one
 * extra pose, not a wrong answer — where a true ray-capsule entry is a quadratic
 * plus two sphere caps, and every one of those is a chance to be subtly wrong in a
 * way that only shows at an angle.
 */
export function nearCapsule(from: Vec3, to: Vec3, a: Vec3, b: Vec3, radius: number): number | null {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const ex = b.x - a.x;
  const ey = b.y - a.y;
  const ez = b.z - a.z;
  const fx = from.x - a.x;
  const fy = from.y - a.y;
  const fz = from.z - a.z;

  const dd = dx * dx + dy * dy + dz * dz;
  const ee = ex * ex + ey * ey + ez * ez;
  if (dd < EPSILON) {
    return null;
  }
  const de = dx * ex + dy * ey + dz * ez;
  const df = dx * fx + dy * fy + dz * fz;
  const ef = ex * fx + ey * fy + ez * fz;

  // The two parameters of closest approach, each clamped to its own segment. One
  // clamped pass is not exact for skew segments, but the error is below the radius
  // of a limb and this is a broad phase — the box test behind it is the answer.
  const denominator = dd * ee - de * de;
  let s = denominator > EPSILON ? (de * ef - df * ee) / denominator : 0;
  s = s < 0 ? 0 : s > 1 ? 1 : s;
  let t = ee > EPSILON ? (de * s + ef) / ee : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  s = dd > EPSILON ? (de * t - df) / dd : 0;
  s = s < 0 ? 0 : s > 1 ? 1 : s;

  const cx = from.x + dx * s - (a.x + ex * t);
  const cy = from.y + dy * s - (a.y + ey * t);
  const cz = from.z + dz * s - (a.z + ez * t);
  return cx * cx + cy * cy + cz * cz <= radius * radius ? s : null;
}

/**
 * Where the segment `from` → `to` enters the box `min`..`max`, as a fraction of the
 * segment, or null.
 *
 * `inverse` takes world space into the box's own — a bone's inverted world matrix —
 * so the box stays an axis-aligned pair of corners and the ray is what moves. That
 * is the usual slab test, and it is why a hitbox can be stored once per bone and
 * posed by whatever the skeleton is doing.
 *
 * Returns the *entry* fraction, and zero when the segment starts inside: a shot
 * fired from within someone's head has already hit them.
 */
export function rayBox(from: Vec3, to: Vec3, inverse: Mat4, min: Vec3, max: Vec3): number | null {
  const ox = apply(inverse, from, 0);
  const oy = apply(inverse, from, 1);
  const oz = apply(inverse, from, 2);
  const tx = apply(inverse, to, 0);
  const ty = apply(inverse, to, 1);
  const tz = apply(inverse, to, 2);

  let near = 0;
  let far = 1;
  // One slab per axis, in the box's own frame. `near` ends up the fraction at which
  // the segment is inside all three.
  for (const [o, d, lo, hi] of [
    [ox, tx - ox, min.x, max.x],
    [oy, ty - oy, min.y, max.y],
    [oz, tz - oz, min.z, max.z],
  ] as const) {
    if (Math.abs(d) < EPSILON) {
      // Parallel to this slab: either inside it for the whole segment, or never.
      if (o < lo || o > hi) {
        return null;
      }
      continue;
    }
    const first = (lo - o) / d;
    const second = (hi - o) / d;
    const enter = Math.min(first, second);
    const exit = Math.max(first, second);
    if (enter > near) {
      near = enter;
    }
    if (exit < far) {
      far = exit;
    }
    if (near > far) {
      return null;
    }
  }
  return near;
}

/** One coordinate of `p` through the column-major 4x4 `m`. */
function apply(m: Mat4, p: Vec3, axis: 0 | 1 | 2): number {
  return m[axis]! * p.x + m[axis + 4]! * p.y + m[axis + 8]! * p.z + m[axis + 12]!;
}
