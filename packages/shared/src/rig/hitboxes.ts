// A body's hit volumes: one box per bone, and where a shot that lands in each counts.
//
// The boxes come from `python3 -m scripts.cod hitboxes`, which derives them from the
// body's own skin weights — per vertex, the joint that influences it most, folded to
// its nearest boxed ancestor, accumulated in that bone's own space. See
// docs/engine/collision.md#a-bullet-hits-a-bone-not-a-capsule.
//
// **A box is in its bone's space and stays there.** A CoD rig hangs from a
// `unit-scale` root of 0.0254, so these numbers are inches; posing the skeleton and
// inverting the bone's world matrix is what puts them in the world, and doing it that
// way is what lets one box follow a bone through every clip. Converting them to
// metres here would be the mistake that looks like tidying up.

import * as THREE from "three";
import { nearCapsule, rayBox, type Vec3 } from "../sim/hit.js";
import { HIT_LOCATIONS, type HitLocation } from "../sim/hitLocations.js";
import { RADIUS, STAND_HEIGHT, type MovementState } from "../sim/movementState.js";
import type { CharacterRig } from "./character.js";

/** Bumped whenever the sidecar changes shape; scripts/cod/hitboxes.py writes it. */
export const HITBOX_FORMAT_VERSION = 1;

/** One bone's box, in that bone's own space. */
export interface Hitbox {
  bone: string;
  location: HitLocation;
  min: Vec3;
  max: Vec3;
}

/** What a shot found: which player, where on them, and how far along the ray. */
export interface BodyHit {
  bone: string;
  location: HitLocation;
  /** How far along the traced segment, 0..1. Metres is the caller's to work out. */
  fraction: number;
}

/**
 * Read a `<id>.hitboxes.json`. Throws on anything it does not understand, because a
 * body whose boxes will not load is one nobody can be shot on — which is worth a
 * failure at load rather than a silent immunity in a match.
 */
export function readHitboxes(raw: unknown): Hitbox[] {
  const data = raw as { version?: number; bones?: unknown[] } | null;
  if (!data || typeof data !== "object") {
    throw new Error("hitboxes: not an object");
  }
  if (data.version !== HITBOX_FORMAT_VERSION) {
    throw new Error(`hitbox format ${String(data.version)}; this build reads ${HITBOX_FORMAT_VERSION} (re-run scripts.cod hitboxes)`);
  }
  if (!Array.isArray(data.bones) || data.bones.length === 0) {
    throw new Error("hitboxes: no boxes");
  }
  const known = new Set<string>(HIT_LOCATIONS);
  return data.bones.map((entry) => {
    const box = entry as { bone?: unknown; location?: unknown; min?: unknown; max?: unknown };
    if (typeof box.bone !== "string" || typeof box.location !== "string" || !known.has(box.location)) {
      throw new Error(`hitboxes: bad entry ${JSON.stringify(entry)}`);
    }
    return { bone: box.bone, location: box.location as HitLocation, min: triple(box.min), max: triple(box.max) };
  });
}

function triple(raw: unknown): Vec3 {
  if (!Array.isArray(raw) || raw.length !== 3 || raw.some((v) => typeof v !== "number" || !Number.isFinite(v))) {
    throw new Error(`hitboxes: expected three numbers, got ${JSON.stringify(raw)}`);
  }
  return { x: raw[0] as number, y: raw[1] as number, z: raw[2] as number };
}

/**
 * A rig's boxes, bound to the bones they hang off.
 *
 * Bound once per rig rather than looked up per shot: a name lookup across 124 bones,
 * for 25 boxes, for every player a bullet passes near, is a cost paid on the hot path
 * for nothing. A box naming a bone this body does not have is dropped — bodies differ
 * in their cloth and head joints, and the *hit* bones are common to all of them, so
 * this is a belt to the braces rather than an expected case.
 */
export class BoundHitboxes {
  private readonly bound: { box: Hitbox; bone: THREE.Object3D }[] = [];
  private readonly inverse = new THREE.Matrix4();

  constructor(rig: CharacterRig, boxes: readonly Hitbox[]) {
    const bones = new Map<string, THREE.Object3D>();
    rig.root.traverse((node) => {
      if (node.name) {
        bones.set(node.name, node);
      }
    });
    for (const box of boxes) {
      const bone = bones.get(box.bone);
      if (bone) {
        this.bound.push({ box, bone });
      }
    }
  }

  /** How many boxes actually found a bone. Zero means this body cannot be hit. */
  get size(): number {
    return this.bound.length;
  }

  /**
   * The nearest box the segment `from` → `to` enters, or null.
   *
   * The rig must already be posed and its world matrices current — this reads them
   * and does not update them, because the caller poses once and may trace several
   * shots against the result.
   */
  trace(from: Vec3, to: Vec3): BodyHit | null {
    let best: BodyHit | null = null;
    for (const { box, bone } of this.bound) {
      this.inverse.copy(bone.matrixWorld).invert();
      const fraction = rayBox(from, to, this.inverse.elements, box.min, box.max);
      if (fraction !== null && (best === null || fraction < best.fraction)) {
        best = { bone: box.bone, location: box.location, fraction };
      }
    }
    return best;
  }
}

/**
 * How far a posed body's boxes reach outside the capsule the simulation moves, m.
 *
 * Measured, not guessed: over all 26 bodies, through every clip, the furthest box
 * corner sits 1.09 m from the capsule's axis (a vault), 2.04 m above the feet (a
 * jump) and 0.60 m *below* them (a vault again, where the legs hang under a capsule
 * already on its way up). `tests/poseEnvelope.test.ts` in @3d/game-server re-measures
 * it, because a margin short of the boxes is a shot that silently misses.
 */
export const POSE_MARGIN = 0.9;

/**
 * Whether a shot could reach this player at all, and roughly how far away they are.
 *
 * The broad phase, against the capsule the simulation actually moves — so it needs no
 * pose, which is the point: posing is the expensive half and almost nobody survives
 * this. `margin` widens the capsule by the furthest a limb reaches outside it.
 */
export function couldHit(from: Vec3, to: Vec3, feet: Vec3, radius: number, height: number, margin: number): number | null {
  const wide = radius + margin;
  const bottom = { x: feet.x, y: feet.y + wide, z: feet.z };
  const top = { x: feet.x, y: feet.y + Math.max(height + margin - wide, wide), z: feet.z };
  return nearCapsule(from, to, bottom, top, wide);
}

/**
 * How far a lying body's boxes reach from the point the simulation moves, m. It
 * lies behind that point along its heading, so the capsule's margin does not
 * hold it: a foot is 1.67 m away. Measured as POSE_MARGIN is, by the same test.
 */
export const PRONE_REACH = 1.9;

const dropped: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * `couldHit` for a player's body as `state` poses it: the standing capsule
 * dropped and widened by POSE_MARGIN, which holds a crouch too, or — lying, or
 * on the way down or up — a ball of PRONE_REACH about the feet.
 */
export function couldHitBody(from: Vec3, to: Vec3, state: Pick<MovementState, "feet" | "stance" | "eyeShift">): number | null {
  const { feet, stance, eyeShift } = state;
  if (stance.kind === "prone" || eyeShift?.path === "crouchToProne" || eyeShift?.path === "proneToCrouch") {
    return nearCapsule(from, to, feet, feet, PRONE_REACH);
  }
  dropped.x = feet.x;
  dropped.y = feet.y - POSE_MARGIN;
  dropped.z = feet.z;
  return couldHit(from, to, dropped, RADIUS, STAND_HEIGHT + POSE_MARGIN, POSE_MARGIN);
}
