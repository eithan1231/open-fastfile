// `POSE_MARGIN` and `PRONE_REACH`: the numbers the broad phase is only as good as.
//
// `Match.traceShot` rejects most players on `couldHitBody` — the capsule the
// simulation moves, widened by `POSE_MARGIN` and dropped by it, or a ball of
// `PRONE_REACH` about a lying body — because posing a skeleton is the expensive
// half of judging a shot. A margin short of where the boxes actually go is not a
// slow server; it is a bullet that passes through somebody with nothing to say
// about it — the broad phase never reports why it said no.
//
// Corpses are not in here and must not be. A ragdoll leaves both envelopes — a
// sprawl reaches further than any pose a player can be in — and widening either to
// cover one would slow the broad phase for every living player on every shot to fix
// a case it does not answer for. A corpse stops no bullets today; when one does, it
// will be rejected against its own world AABB.
//
// So the margin is measured rather than chosen, and this is the measurement: every
// body the catalogue holds, posed through every clip a player can be in, with every
// corner of every box required to lie inside the envelope. It skips where no
// catalogue has been built, like the other tests that need real bodies.

import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { couldHitBody, POSE_MARGIN, PRONE_REACH, type Hitbox } from "@3d/shared/rig/hitboxes.js";
import { CROUCHING, createMovement, EYE_PATHS, RADIUS, type MovementState, type Stance } from "@3d/shared/sim/movement.js";
import { MANTLE_ROWS } from "@3d/shared/sim/moves/mantle.js";
import { eyePathEnds, eyePathSeconds } from "@3d/shared/sim/stance.js";
import { poseBody, type LoadedBody } from "../src/bodies.js";
import { catalogueBodies, GAMES, sidecar } from "./catalogueBodies.js";

/** A millimetre of segment through a point, which is how a *point* is asked of `couldHitBody`. */
const PROBE = 0.0005;

/**
 * Every state a body can be posed in, sampled.
 *
 * Not a walk of the clip list: what matters is the states `poseLayers` branches on
 * — a run's four directions through a stride, a jump, both climbs, and the aim
 * pitch that turns the spine — because each puts the limbs somewhere else.
 */
function poses(): { name: string; movement: MovementState }[] {
  const out: { name: string; movement: MovementState }[] = [];
  const standing = (): MovementState => {
    const m = createMovement({ x: 0, y: 0, z: 0 }, 0, 0);
    m.grounded = true;
    return m;
  };

  out.push({ name: "idle", movement: standing() });

  for (const [dx, dz, way] of [
    [0, -1, "forward"],
    [0, 1, "back"],
    [1, 0, "right"],
    [-1, 0, "left"],
  ] as const) {
    for (const stride of [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875]) {
      const movement = standing();
      movement.gait = 1;
      movement.stride = stride;
      movement.velocity = { x: dx * 5.8, y: 0, z: dz * 5.8 };
      out.push({ name: `run ${way} ${stride}`, movement });
    }
  }

  for (const since of [0, 0.1, 0.2, 0.3, 0.4, 0.5]) {
    const movement = createMovement({ x: 0, y: 0, z: 0 }, 0, 0);
    movement.airborne = 1;
    movement.sinceJump = since;
    movement.velocity = { x: 0, y: 3, z: -5 };
    out.push({ name: `jump ${since}`, movement });
  }

  // Both of a mantle's clips, start to end: the way onto the ledge, and a vault's part after it.
  for (const row of [0, 3, 6]) {
    for (const through of [0, 0.2, 0.4, 0.6, 0.8, 1]) {
      for (const over of [false, true]) {
        const movement = createMovement({ x: 0, y: 0, z: 0 }, 0, 0);
        const part = over ? MANTLE_ROWS[row]!.over.seconds : MANTLE_ROWS[row]!.up;
        movement.move = { kind: "mantle", ledge: { x: 0, y: MANTLE_ROWS[row]!.height, z: -0.4 }, yaw: 0, row, over, left: part * (1 - through) };
        out.push({ name: `${over ? "vault" : "mantle"} ${row} ${through}`, movement });
      }
    }
  }

  for (const up of [true, false]) {
    for (const height of [0, 0.2, 0.4, 0.6, 0.8]) {
      const movement = createMovement({ x: 0, y: height, z: 0 }, 0, 0);
      movement.velocity = { x: 0, y: up ? 1 : -1, z: 0 };
      movement.move = { kind: "ladder", facing: 0 };
      out.push({ name: `ladder ${up ? "up" : "down"} ${height}`, movement });
    }
  }

  for (const pitch of [-1.4, -0.7, 0.7, 1.4]) {
    const movement = standing();
    movement.pitch = pitch;
    out.push({ name: `aim ${pitch}`, movement });
  }

  // Crouched and lying, at rest and moving each way through a stride. A lying
  // body is turned and tipped as far as the simulation lets one be.
  const low: [string, () => Stance][] = [
    ["crouch", () => CROUCHING],
    ["prone", () => ({ kind: "prone", heading: 0, torso: 0 })],
    ["prone uphill", () => ({ kind: "prone", heading: 2.4, torso: Math.PI / 4 })],
    ["prone downhill", () => ({ kind: "prone", heading: -1.1, torso: -Math.PI / 4 })],
  ];
  for (const [stance, make] of low) {
    for (const pitch of [-1.4, 0, 1.4]) {
      const movement = standing();
      movement.stance = make();
      movement.pitch = pitch;
      out.push({ name: `${stance} aim ${pitch}`, movement });
    }
    for (const [forward, right, way] of [
      [1, 0, "forward"],
      [-1, 0, "back"],
      [0, 1, "right"],
      [0, -1, "left"],
    ] as const) {
      for (const stride of [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875]) {
        const movement = standing();
        movement.stance = make();
        movement.gait = 1;
        movement.stride = stride;
        movement.travelForward = forward;
        movement.travelRight = right;
        out.push({ name: `${stance} ${way} ${stride}`, movement });
      }
    }
  }

  // Every way between two stances, through it.
  for (const path of EYE_PATHS) {
    for (const through of [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1]) {
      const movement = standing();
      const to = eyePathEnds(path).to;
      movement.stance = to === "prone" ? { kind: "prone", heading: 0.6, torso: 0.3 } : to === "crouch" ? CROUCHING : movement.stance;
      movement.eyeShift = { path, elapsed: through * eyePathSeconds(path) };
      out.push({ name: `${path} ${through}`, movement });
    }
  }
  return out;
}

/** Whether a body in `movement` is one the broad phase takes for lying: `couldHitBody`'s own test. */
function lying(movement: MovementState): boolean {
  return movement.stance.kind === "prone" || movement.eyeShift?.path === "crouchToProne" || movement.eyeShift?.path === "proneToCrouch";
}

/** Whether a single point is inside the broad phase's envelope for that state — a millimetre of segment through it. */
function inside(point: THREE.Vector3, movement: MovementState): boolean {
  const from = { x: point.x - PROBE, y: point.y, z: point.z };
  const to = { x: point.x + PROBE, y: point.y, z: point.z };
  return couldHitBody(from, to, movement) !== null;
}

/** Every corner of every box of one body in one pose, in world space. */
function corners(body: LoadedBody, boxes: readonly Hitbox[], movement: MovementState): THREE.Vector3[] {
  const root = body.rig.root;
  poseBody(body, movement, null);

  const out: THREE.Vector3[] = [];
  for (const box of boxes) {
    const bone = root.getObjectByName(box.bone);
    if (!bone) {
      continue; // `BoundHitboxes` drops these too; bodies.test.ts is where that is counted
    }
    for (const x of [box.min.x, box.max.x]) {
      for (const y of [box.min.y, box.max.y]) {
        for (const z of [box.min.z, box.max.z]) {
          out.push(new THREE.Vector3(x, y, z).applyMatrix4(bone.matrixWorld));
        }
      }
    }
  }
  return out;
}

describe("the envelope a posed body may occupy", () => {
  it("holds every box of every body, through every pose", async () => {
    const real = await catalogueBodies();
    if (!real) {
      return; // no catalogue built in this checkout
    }

    const escaped: string[] = [];
    /** How far outside the *bare* capsule anything reached, which is what the margin is for. */
    let beyondCapsule = 0;
    /** How far from the feet a lying body reached, which is what PRONE_REACH is for. */
    let lyingReach = 0;
    let checked = 0;

    for (const game of GAMES) {
      for (const entry of real.catalogue.charactersFor(game)) {
        const body = real.bodies.get(game, entry.id);
        if (!body) {
          continue;
        }
        const boxes = await sidecar(real.client, game, entry.id);
        for (const { name, movement } of poses()) {
          for (const corner of corners(body, boxes, movement)) {
            checked++;
            if (!inside(corner, movement)) {
              escaped.push(
                `${entry.id} ${name} at ${corner
                  .toArray()
                  .map((v) => v.toFixed(2))
                  .join(", ")}`,
              );
            }
            const radial = Math.hypot(corner.x - movement.feet.x, corner.z - movement.feet.z);
            if (lying(movement)) {
              lyingReach = Math.max(lyingReach, Math.hypot(radial, corner.y - movement.feet.y));
            } else {
              beyondCapsule = Math.max(beyondCapsule, radial - RADIUS, movement.feet.y - corner.y);
            }
          }
        }
      }
    }

    expect(checked).toBeGreaterThan(100_000);
    // Named rather than counted: a margin that is short is short *somewhere*, and
    // which body in which pose is the whole of what has to be looked at.
    expect(escaped.slice(0, 5)).toEqual([]);

    // The other half of the claim: the boxes really do leave the capsule, so this
    // is not a test that would pass against a body collapsed to a point. A vault
    // is the extreme — it carries the drawn body a metre past its own feet.
    expect(beyondCapsule).toBeGreaterThan(0.5);
    expect(beyondCapsule).toBeLessThan(POSE_MARGIN);
    // A lying body likewise: it lies well outside the capsule's margin, and inside its own reach.
    expect(lyingReach).toBeGreaterThan(RADIUS + POSE_MARGIN);
    expect(lyingReach).toBeLessThan(PRONE_REACH);
  }, 300_000);
});
