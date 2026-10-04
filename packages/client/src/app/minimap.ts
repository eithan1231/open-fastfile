// The HUD map: a world's `minimap` image, and where the player stands on it,
// as the plain numbers the UI lays out (ui/hud/Minimap.tsx).

import type { ResolvedMinimap } from "@3d/shared/dsl/resolved.js";
import type { MinimapInfo, MinimapPose } from "./uiBridge.js";

/** The image, and its size as a fraction of the HUD map, which spans twice `range`. */
export function minimapInfo(map: ResolvedMinimap, baseUrl: string): MinimapInfo {
  return { image: baseUrl + map.source, width: map.width / (2 * map.range), height: map.depth / (2 * map.range) };
}

/**
 * The player at ground point (x, z), looking along `yaw`, on `map`'s image.
 * The image's right and top are rotateY of east (1, 0) and north (0, -1) by
 * its rotation; turning the image by yaw minus that rotation puts the
 * player's heading at the top.
 */
export function minimapPose(map: ResolvedMinimap, x: number, z: number, yaw: number): MinimapPose {
  const dx = x - map.center.x;
  const dz = z - map.center.z;
  const s = Math.sin(map.rotation);
  const c = Math.cos(map.rotation);
  const right = dx * c - dz * s;
  const up = -dx * s - dz * c;
  return { u: 0.5 + right / map.width, v: 0.5 - up / map.depth, rotation: yaw - map.rotation };
}
