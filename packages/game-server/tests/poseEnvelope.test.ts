// `POSE_MARGIN`: the number the broad phase is only as good as.
//
// `Match.traceShot` rejects most players on the capsule the simulation moves,
// widened by `POSE_MARGIN` and dropped by it, because posing a skeleton is the
// expensive half of judging a shot. A margin short of where the boxes actually go
// is not a slow server; it is a bullet that passes through somebody with nothing to
// say about it — the broad phase never reports why it said no.
//
// Corpses are not in here and must not be. A ragdoll leaves this envelope entirely —
// a body lying flat reaches further from its pelvis than any pose a player can be in
// — and widening `POSE_MARGIN` to cover a sprawl would slow the broad phase for every
// living player on every shot to fix a case it does not answer for. A corpse stops no
// bullets today; when one does, it will be rejected against its own world AABB.
//
// So the margin is measured rather than chosen, and this is the measurement: every
// body the catalogue holds, posed through every clip a player can be in, with every
// corner of every box required to lie inside the envelope. It skips where no
// catalogue has been built, like the other tests that need real bodies.

import "reflect-metadata";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { testApp } from "@3d/api/testing/app.js";
import type { GameKey } from "@3d/shared/dsl/resolved.js";
import { catalogueViewOf, type CatalogueView } from "@3d/shared/game/catalogueView.js";
import { createApiClient, type ApiClient } from "@3d/shared/protocol/api.js";
import type { HttpFetch } from "@3d/shared/protocol/http.js";
import { MODEL_FACING } from "@3d/shared/rig/character.js";
import { couldHit, POSE_MARGIN, readHitboxes, type Hitbox } from "@3d/shared/rig/hitboxes.js";
import type { Vec3 } from "@3d/shared/sim/capsule.js";
import { createMovement, HEIGHT, RADIUS, type MovementState } from "@3d/shared/sim/movement.js";
import { mantleDuration } from "@3d/shared/sim/moves/mantle.js";
import { bodyYaw } from "@3d/shared/sim/pose.js";
import { WeaponRegistry, type WeaponEntry } from "@3d/shared/sim/weaponRegistry.js";
import type { Api } from "../src/api.js";
import { Bodies, type LoadedBody } from "../src/bodies.js";
import type { Weapons } from "../src/weapons.js";

const GAMES: GameKey[] = ["iw4", "iw5", "iw6", "t5", "s1"];
/** A millimetre of segment through a point, which is how a *point* is asked of `couldHit`. */
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

  for (const rise of [0.5, 1, 1.5]) {
    for (const through of [0, 0.2, 0.4, 0.6, 0.8, 1]) {
      for (const over of [false, true]) {
        const movement = createMovement({ x: 0, y: 0, z: 0 }, 0, 0);
        movement.move = { kind: "mantle", target: { x: 0, y: rise, z: -1 }, left: mantleDuration(rise) * (1 - through), rise, over };
        out.push({ name: `${over ? "vault" : "mantle"} ${rise} ${through}`, movement });
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
  return out;
}

/** Where the broad phase says a posed body may be: the walking capsule, dropped and widened. */
function envelope(feet: Vec3): Vec3 {
  return { x: feet.x, y: feet.y - POSE_MARGIN, z: feet.z };
}

/** Whether a single point is inside that envelope — a millimetre of segment through it. */
function inside(point: THREE.Vector3, feet: Vec3): boolean {
  const from = { x: point.x - PROBE, y: point.y, z: point.z };
  const to = { x: point.x + PROBE, y: point.y, z: point.z };
  return couldHit(from, to, envelope(feet), RADIUS, HEIGHT + POSE_MARGIN, POSE_MARGIN) !== null;
}

interface Loaded {
  bodies: Bodies;
  catalogue: CatalogueView;
  client: ApiClient;
}

async function everything(): Promise<Loaded | null> {
  const { app } = testApp();
  const client = createApiClient({ fetch: app.request.bind(app) as HttpFetch });
  const index = await client.catalogIndex();
  const catalogue = catalogueViewOf(index, new WeaponRegistry(index.weapons as WeaponEntry[]));
  if (GAMES.every((game) => catalogue.charactersFor(game).length === 0)) {
    return null;
  }
  const bodies = new Bodies({ client } as unknown as Api, { catalogue } as unknown as Weapons);
  await bodies.load();
  return { bodies, catalogue, client };
}

/** The sidecar the boxes came from: `BoundHitboxes` keeps them, and does not hand them back. */
async function sidecar(client: ApiClient, game: GameKey, id: string): Promise<Hitbox[]> {
  const bytes = await client.catalogFile({ kind: "characters", game, id, rest: `${id}.hitboxes.json` });
  return readHitboxes(JSON.parse(new TextDecoder().decode(bytes)));
}

/** Every corner of every box of one body in one pose, in world space. */
function corners(body: LoadedBody, boxes: readonly Hitbox[], movement: MovementState): THREE.Vector3[] {
  const root = body.rig.root;
  root.position.set(movement.feet.x, movement.feet.y, movement.feet.z);
  root.rotation.y = bodyYaw(movement) + MODEL_FACING;
  body.poser.update(movement, null, 0);
  root.updateMatrixWorld(true);

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
    const real = await everything();
    if (!real) {
      return; // no catalogue built in this checkout
    }

    const escaped: string[] = [];
    /** How far outside the *bare* capsule anything reached, which is what the margin is for. */
    let beyondCapsule = 0;
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
            if (!inside(corner, movement.feet)) {
              escaped.push(
                `${entry.id} ${name} at ${corner
                  .toArray()
                  .map((v) => v.toFixed(2))
                  .join(", ")}`,
              );
            }
            const radial = Math.hypot(corner.x - movement.feet.x, corner.z - movement.feet.z);
            beyondCapsule = Math.max(beyondCapsule, radial - RADIUS, movement.feet.y - corner.y);
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
  }, 300_000);
});
