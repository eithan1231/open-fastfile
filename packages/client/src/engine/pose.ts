// A camera pose in the URL fragment (`#slug@x,y,z,yaw,pitch[,hold]`), so a
// spot survives a reload, can be shared as a link, and a headless screenshot
// can navigate straight to it. Angles are degrees here, radians elsewhere:
// this is the one place a person edits them by hand.

/** Where the camera stood and what it was looking at, plus whether physics was held. */
export interface Pose {
  slug: string;
  /** Feet position in world metres, as the debug stats report it. */
  x: number;
  y: number;
  z: number;
  /** Degrees. Yaw is around +Y, pitch is positive looking up. */
  yaw: number;
  pitch: number;
  /** Hold the player still (no gravity, input or collision) until a movement key, so a screenshot reproduces. */
  hold: boolean;
}

const DEG = 180 / Math.PI;

/** Round to 3dp without trailing zeros, so the fragment stays short and diffable. */
function n(v: number): string {
  return String(Number(v.toFixed(3)));
}

/** `#slug@x,y,z,yaw,pitch[,hold]` — paste-ready, and what `parsePose` reads back. */
export function formatPose(pose: Pose): string {
  const parts = [n(pose.x), n(pose.y), n(pose.z), n(pose.yaw), n(pose.pitch)];
  if (pose.hold) {
    parts.push("hold");
  }
  return `#${pose.slug}@${parts.join(",")}`;
}

/** Build a pose from the engine's own units (radians). */
export function poseFrom(slug: string, feet: { x: number; y: number; z: number }, orientation: { yaw: number; pitch: number }, hold: boolean): Pose {
  return { slug, x: feet.x, y: feet.y, z: feet.z, yaw: orientation.yaw * DEG, pitch: orientation.pitch * DEG, hold };
}

/** Radians, for the `yaw`/`pitch` of a `pose` Arrival (app/WorldSession.ts). */
export function poseOrientation(pose: Pose): { yaw: number; pitch: number } {
  return { yaw: pose.yaw / DEG, pitch: pose.pitch / DEG };
}

/** Parse `#slug@x,y,z,yaw,pitch[,hold]` (the `#` optional), or undefined: a bad fragment drops you at the menu. */
export function parsePose(hash: string): Pose | undefined {
  const raw = hash.trim().replace(/^#/, "");
  const at = raw.indexOf("@");
  if (at <= 0) {
    return undefined;
  }

  const slug = raw.slice(0, at);
  const fields = raw.slice(at + 1).split(",");
  const [x, y, z, yaw, pitch] = fields.slice(0, 5).map((f) => Number(f.trim()));
  if (x === undefined || y === undefined || z === undefined || yaw === undefined || pitch === undefined) {
    return undefined;
  }
  if (![x, y, z, yaw, pitch].every((v) => Number.isFinite(v))) {
    return undefined;
  }

  const hold = fields.slice(5).some((f) => f.trim().toLowerCase() === "hold");
  return { slug, x, y, z, yaw, pitch, hold };
}
