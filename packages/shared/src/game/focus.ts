// Which usable thing a player would use if they pressed the use key now: their
// focus. One pure function both ends run — a browser from its predicted view to
// show the prompt, a game server from the input's view angles on the key's
// rising edge — so the prompt a player reads names the thing the server uses.
//
// The world says only that a thing is usable and how it is reached (`use: near |
// touch`); whether it must also be looked at, and whether it is usable at all
// right now, is the gametype script's `usable` (hooks.ts). The rule itself is
// Call of Duty's: see `USE_RULE`.

import type { EntityId, ResolvedWorld, UseMode } from "../dsl/resolved.js";
import type { CapsuleWorld, RayHit, Vec3 } from "../sim/capsule.js";
import { EYE_HEIGHT, HEIGHT, RADIUS } from "../sim/movement.js";
import { aimDirection } from "../sim/recoil.js";
import { UNITS_PER_M } from "../sim/units.js";
import { presentIn } from "../sim/worldRules.js";
import type { GameView, PlayerView } from "./context.js";
import type { Script } from "./hooks.js";
import { boundsVolume, touches, volumeCentre, type Bounds, type VolumeShape } from "./volumes.js";

/**
 * Call of Duty's use rule, as Black Ops builds and sorts a player's use list
 * (reverse/t5-zombies/README.md § 4; docs/cod/reference.md#the-use-rule). The
 * score adds a distance in the game's inches to an angle term, so it is kept in
 * them rather than converted.
 */
export const USE_RULE = {
  /** Metres from the eye to a `near` thing's centre: 72 in. */
  reach: 72 / UNITS_PER_M,
  /** The look cone, as `dot(view, toCentre)`: about 40.5° off the crosshair. */
  lookDot: 0.76,
  /** Score = `angleWeight · (1 − dot) / 2 + inches + nearBias`; lowest wins. */
  angleWeight: 512,
  nearBias: -512,
  /** A `touch` thing's fixed score, whatever the angle and distance. */
  touchScore: -144,
} as const;

/** One thing in a world that can be used: a trigger or a solid with `use`. Plain data, the same on both ends. */
export interface UsableThing {
  readonly kind: "trigger" | "solid";
  /** Its place in `world.triggers` or `world.solids` — and so in `GameView.world.triggers.all` or `.solids.all`. */
  readonly index: number;
  readonly id: EntityId;
  readonly name?: string;
  readonly tags: readonly string[];
  /** The tag it points at: a door's trigger names the solids it opens. What that means is the script's. */
  readonly target?: string;
  readonly use: UseMode;
  /** The centre of its bounds, world space: what `near` measures to and traces at. */
  readonly centre: Vec3;
  /** What `touch` overlaps: the trigger's own shape, or a solid's bounds. */
  readonly volume: VolumeShape;
}

/** What a script says of a thing it lets be used: whether the player must be looking at it. */
export interface UseVerdict {
  readonly look: boolean;
}

/** What a thing no script has an opinion about is: usable, from any angle. */
export const DEFAULT_USE: UseVerdict = { look: false };

/** Where a player stands and looks from. `view` is a unit vector. */
export interface Viewer {
  readonly feet: Vec3;
  readonly eye: Vec3;
  readonly view: Vec3;
}

/** Which solids are present: a `Presence`, or anything else that can answer by index. */
export interface PresenceView {
  has(index: number): boolean;
}

/**
 * Every usable thing in a world, triggers first and then solids, each in
 * declaration order — which is also how a tie in score is broken. A trigger
 * outside `mode` does not exist here; a solid follows its live presence at
 * `focusOf` instead. A solid whose part has no bounds (nothing of it collides)
 * has nothing to reach and is left out.
 */
export function usableThings(
  world: Pick<ResolvedWorld, "triggers" | "solids">,
  mode: string | undefined,
  partBounds: (index: number) => Bounds | undefined,
): UsableThing[] {
  const things: UsableThing[] = [];
  world.triggers.forEach((trigger, index) => {
    if (trigger.use && presentIn(trigger.modes, mode)) {
      const { id, name, tags, target, use } = trigger;
      things.push({ kind: "trigger", index, id, name, tags, target, use, centre: volumeCentre(trigger), volume: trigger });
    }
  });
  world.solids.forEach((solid, index) => {
    const bounds = solid.use ? partBounds(index) : undefined;
    if (solid.use && bounds) {
      const volume = boundsVolume(bounds);
      const { id, name, tags, use } = solid;
      things.push({ kind: "solid", index, id, name, tags, use, centre: volume.position, volume });
    }
  });
  return things;
}

/** Where a player standing at `feet` looks from, facing `yaw`/`pitch` (sim/input.ts's angles). */
export function viewerAt(feet: Vec3, yaw: number, pitch: number): Viewer {
  return { feet, eye: { x: feet.x, y: feet.y + EYE_HEIGHT, z: feet.z }, view: aimDirection({ yaw, pitch }, { x: 0, y: 0, z: 0 }) };
}

/**
 * What the scripts say about one thing for one player: the first with an
 * opinion wins, null is "not usable now", and none at all is `DEFAULT_USE`.
 */
export function usableBy(scripts: readonly Script[], view: GameView, thing: UsableThing, player: PlayerView): UseVerdict | null {
  for (const script of scripts) {
    const said = script.usable?.(view, thing, player);
    if (said !== undefined) {
      return said;
    }
  }
  return DEFAULT_USE;
}

/**
 * The thing `viewer` would use now, or null.
 *
 * - `touch`: the player's upright body (the capsule's radius and height) overlaps
 *   its volume. No angle and no line of sight; it scores `touchScore`.
 * - `near`: the eye is within `reach` of its centre — inside is not needed — and
 *   a trace from the eye to the centre is clear. For a solid the trace stops
 *   where it enters the solid's bounds, since the thing is not in its own way.
 * - either, where `usable` says `look`: `dot(view, toCentre) ≥ lookDot`.
 *
 * Lowest score wins; a tie goes to the earlier thing. `world` is the match's
 * view (`CollisionWorld.view`), so a part a script removed no longer blocks.
 */
export function focusOf(
  world: CapsuleWorld,
  things: readonly UsableThing[],
  presence: PresenceView,
  viewer: Viewer,
  usable: (thing: UsableThing) => UseVerdict | null,
): UsableThing | null {
  const { eye, view, feet } = viewer;
  const ranked: { thing: UsableThing; score: number; distance: number }[] = [];
  for (const thing of things) {
    if (thing.kind === "solid" && !presence.has(thing.index)) {
      continue;
    }
    const dx = thing.centre.x - eye.x;
    const dy = thing.centre.y - eye.y;
    const dz = thing.centre.z - eye.z;
    const distance = Math.hypot(dx, dy, dz);
    // Standing on the centre is looking straight at it.
    const dot = distance > 0 ? (view.x * dx + view.y * dy + view.z * dz) / distance : 1;
    if (thing.use === "touch" ? !touches(thing.volume, feet, RADIUS, HEIGHT) : distance > USE_RULE.reach) {
      continue;
    }
    const verdict = usable(thing);
    if (!verdict || (verdict.look && dot < USE_RULE.lookDot)) {
      continue;
    }
    const score = thing.use === "touch" ? USE_RULE.touchScore : (USE_RULE.angleWeight * (1 - dot)) / 2 + distance * UNITS_PER_M + USE_RULE.nearBias;
    ranked.push({ thing, score, distance });
  }
  // Stable, so a tie keeps declaration order.
  ranked.sort((a, b) => a.score - b.score);
  for (const { thing, distance } of ranked) {
    if (thing.use === "touch" || clearTo(world, eye, thing, distance)) {
      return thing;
    }
  }
  return null;
}

const direction: Vec3 = { x: 0, y: 0, z: 0 };
const hit: RayHit = { distance: 0, normal: { x: 0, y: 0, z: 0 }, kind: "map", surface: "default" };

/** Whether nothing stands between the eye and `thing`'s centre, `distance` away. */
function clearTo(world: CapsuleWorld, eye: Vec3, thing: UsableThing, distance: number): boolean {
  if (distance === 0) {
    return true;
  }
  direction.x = (thing.centre.x - eye.x) / distance;
  direction.y = (thing.centre.y - eye.y) / distance;
  direction.z = (thing.centre.z - eye.z) / distance;
  const reach = thing.kind === "solid" ? entry(eye, direction, thing.volume) : distance;
  if (reach <= 0) {
    return true;
  }
  return world.traceRay(eye, direction, reach, "shots", hit) === null;
}

/**
 * Metres along the ray to where it enters an unturned box, 0 from inside it.
 * The ray is aimed at the box's centre, so it always does enter.
 */
function entry(from: Vec3, along: Vec3, box: VolumeShape): number {
  const size = box.size!;
  let near = 0;
  for (const axis of ["x", "y", "z"] as const) {
    const half = size[axis] / 2;
    const d = along[axis];
    if (Math.abs(d) < 1e-9) {
      continue;
    }
    const a = (box.position[axis] - half - from[axis]) / d;
    const b = (box.position[axis] + half - from[axis]) / d;
    near = Math.max(near, Math.min(a, b));
  }
  // A hair short of the face, so the part's own triangles are not what the ray meets.
  return Math.max(near - 1e-3, 0);
}
