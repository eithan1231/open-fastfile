// One ragdoll table, twenty-six bodies, three games — and whatever is exported next.
//
// `sim/ragdollBones.ts` claims that sixteen bones are enough to describe any body
// the importer produces, that every hit box any of them carries folds onto one of
// those sixteen, and that the joint tree it writes down is the tree the skeletons
// actually have. None of that is a thing to reason about: 265 distinct joints exist
// across the corpus and only 87 are common to all of them.
//
// So it is measured, the way `poseEnvelope.test.ts` measures the broad phase, and
// it skips the same way where no catalogue has been built in this checkout. A
// failure names the body and the bone, because the moment anybody is thinking about
// `j_thumb_le` is the moment a new export adds one — not a count of how many went
// wrong.

import "reflect-metadata";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { testApp } from "@3d/api/testing/app.js";
import type { GameKey } from "@3d/shared/dsl/resolved.js";
import { catalogueViewOf, type CatalogueView } from "@3d/shared/game/catalogueView.js";
import { createApiClient, type ApiClient } from "@3d/shared/protocol/api.js";
import type { HttpFetch } from "@3d/shared/protocol/http.js";
import { readHitboxes, type Hitbox } from "@3d/shared/rig/hitboxes.js";
import { initPhysics, createPhysicsWorld } from "@3d/shared/physics/engine.js";
import { buildRagdoll, poseRagdoll, ragdollShape, type RagdollShape } from "@3d/shared/physics/ragdoll.js";
import { poseFromRig } from "@3d/shared/rig/ragdollPose.js";
import {
  RAGDOLL_MASS,
  RAGDOLL_SEGMENTS,
  SEGMENT_BONES,
  SEGMENT_JOINTS,
  MAX_SEGMENT_HALF_EXTENT,
  SEGMENT_FOR_LOCATION,
  SEGMENT_MASS,
  segmentOf,
  type RagdollSegment,
} from "@3d/shared/sim/ragdollBones.js";
import { TICK_DT } from "@3d/shared/net/messages/fields.js";
import { HIT_LOCATIONS } from "@3d/shared/sim/hitLocations.js";
import { createMovement } from "@3d/shared/sim/movement.js";
import { WeaponRegistry, type WeaponEntry } from "@3d/shared/sim/weaponRegistry.js";
import type { Api } from "../src/api.js";
import { Bodies, type LoadedBody } from "../src/bodies.js";
import type { Weapons } from "../src/weapons.js";

const GAMES: GameKey[] = ["iw4", "iw5", "iw6", "t5", "s1"];

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

/** The sidecar the boxes came from: `BoundHitboxes` keeps them and does not hand them back. */
async function sidecar(client: ApiClient, game: GameKey, id: string): Promise<Hitbox[]> {
  const bytes = await client.catalogFile({ kind: "characters", game, id, rest: `${id}.hitboxes.json` });
  return readHitboxes(JSON.parse(new TextDecoder().decode(bytes)));
}

/** Every body the catalogue holds, with its sidecar beside it. */
async function corpus(real: Loaded): Promise<{ id: string; body: LoadedBody; boxes: Hitbox[] }[]> {
  const out: { id: string; body: LoadedBody; boxes: Hitbox[] }[] = [];
  for (const game of GAMES) {
    for (const character of real.catalogue.charactersFor(game)) {
      const body = real.bodies.get(game, character.id);
      if (!body) {
        continue; // bodies.test.ts owns the one whose sidecar will not parse
      }
      out.push({ id: `${game}/${character.id}`, body, boxes: await sidecar(real.client, game, character.id) });
    }
  }
  return out;
}

describe("the ragdoll table", () => {
  it("is internally consistent", () => {
    expect(new Set(RAGDOLL_SEGMENTS).size).toBe(RAGDOLL_SEGMENTS.length);
    expect(new Set(Object.values(SEGMENT_BONES)).size).toBe(RAGDOLL_SEGMENTS.length);

    const mass = RAGDOLL_SEGMENTS.reduce((sum, segment) => sum + SEGMENT_MASS[segment], 0);
    expect(mass).toBeCloseTo(RAGDOLL_MASS, 5);

    // A tree: one root, and every other segment reaching it without a cycle.
    const roots = RAGDOLL_SEGMENTS.filter((segment) => SEGMENT_JOINTS[segment] === null);
    expect(roots).toEqual(["pelvis"]);
    for (const segment of RAGDOLL_SEGMENTS) {
      const seen = new Set<RagdollSegment>([segment]);
      let at: RagdollSegment | undefined = segment;
      while (at !== undefined) {
        const joint: { parent: RagdollSegment } | null = SEGMENT_JOINTS[at];
        at = joint?.parent;
        if (at !== undefined) {
          expect(seen.has(at), `${segment} loops through ${at}`).toBe(false);
          seen.add(at);
        }
      }
      expect(seen.has("pelvis"), `${segment} does not reach the pelvis`).toBe(true);
    }
  });

  it("gives every hit location a segment to push", () => {
    // The impulse lands where the round did, so a location mapping nowhere would be
    // a shot that moves nothing — silently, and only on one part of a body.
    const segments = new Set<RagdollSegment>(RAGDOLL_SEGMENTS);
    for (const location of HIT_LOCATIONS) {
      const segment = SEGMENT_FOR_LOCATION[location];
      expect(segment, `${location} pushes nothing`).toBeDefined();
      expect(segments.has(segment), `${location} pushes ${segment}, which is not a segment`).toBe(true);
    }

    // Thirteen of the nineteen locations are spelled exactly like the segment they
    // push, and keeping it that way is what makes the lookup readable rather than a
    // mapping to check. The six that are not are the trunk, which collapses four
    // locations into three bodies, the two the skull swallows, and `gun` — a round
    // stopped by somebody's rifle pushes the hand holding it.
    const renamed = HIT_LOCATIONS.filter((location) => String(location) !== String(SEGMENT_FOR_LOCATION[location]));
    expect([...renamed].sort()).toEqual(["gun", "helmet", "neck", "none", "torsoLower", "torsoUpper"]);
  });

  it("describes every body the catalogue holds", async () => {
    const real = await everything();
    if (!real) {
      return; // no catalogue built in this checkout
    }
    await initPhysics();
    const bodies = await corpus(real);
    expect(bodies.length).toBeGreaterThan(0);

    const problems: string[] = [];
    const shapes: { id: string; shape: RagdollShape }[] = [];

    for (const { id, body, boxes } of bodies) {
      const bind = body.rig.bind;

      // 1. Every segment's bone exists, so nothing has to merge into its parent.
      for (const segment of RAGDOLL_SEGMENTS) {
        if (!bind.worldOf(SEGMENT_BONES[segment])) {
          problems.push(`${id}: no bone ${SEGMENT_BONES[segment]} for its ${segment}`);
        }
      }

      // 2. Every box lands on a segment. A box that folds nowhere is a piece of a
      //    body with no mass — and the body still falls over, just wrongly.
      for (const box of boxes) {
        if (segmentOf(box.bone, (bone) => bind.parentOf(bone)) === undefined) {
          problems.push(`${id}: box on ${box.bone} folds onto no segment`);
        }
      }

      // 3. The table's joint tree is the skeleton's. Each segment's bone must
      //    reach its table parent's bone before any other segment's.
      for (const segment of RAGDOLL_SEGMENTS) {
        const spec = SEGMENT_JOINTS[segment];
        if (spec === null) {
          continue;
        }
        const above = bind.parentOf(SEGMENT_BONES[segment]);
        const found = above === undefined ? undefined : segmentOf(above, (bone) => bind.parentOf(bone));
        if (found !== spec.parent) {
          problems.push(`${id}: ${segment} hangs off ${String(found)} in the skeleton, ${spec.parent} in the table`);
        }
      }

      // 4. It measures into sixteen boxes with real volume.
      try {
        shapes.push({ id, shape: ragdollShape(body.rig, boxes) });
      } catch (error) {
        problems.push(`${id}: ${String(error)}`);
      }
    }

    expect(problems).toEqual([]);
    expect(shapes).toHaveLength(bodies.length);

    for (const { id, shape } of shapes) {
      expect(shape.segments, id).toHaveLength(RAGDOLL_SEGMENTS.length);
      for (const part of shape.segments) {
        const where = `${id} ${part.segment}`;
        expect(part.halfExtents.x, where).toBeGreaterThan(0);
        expect(part.halfExtents.y, where).toBeGreaterThan(0);
        expect(part.halfExtents.z, where).toBeGreaterThan(0);
        // Nothing on a person is two metres across. Loose on purpose: the only
        // segment with an argument for a real cap is the head, below, and capping
        // the rest is what turned every shin in the game into a stump.
        expect(Math.max(part.halfExtents.x, part.halfExtents.y, part.halfExtents.z), where).toBeLessThan(1);
      }

      // The head *is* capped, and this is the three ghillie bodies' 0.49 m hood
      // being held to it (MAX_SEGMENT_HALF_EXTENT).
      const head = shape.segments[RAGDOLL_SEGMENTS.indexOf("head")]!;
      for (const axis of [head.halfExtents.x, head.halfExtents.y, head.halfExtents.z]) {
        expect(axis, `${id} head`).toBeLessThanOrEqual(MAX_SEGMENT_HALF_EXTENT.head!);
      }

      // The negative: sixteen boxes that all measured 1 cm would pass everything
      // above and be a point, not a body. A corpse is person-sized or the table is
      // describing something else.
      let low = Infinity;
      let high = -Infinity;
      for (let i = 0; i < shape.segments.length; i++) {
        const y = shape.rest[i]!.position.y;
        low = Math.min(low, y);
        high = Math.max(high, y);
      }
      expect(high - low, `${id} is ${(high - low).toFixed(2)} m from foot to head`).toBeGreaterThan(1.4);
      expect(high - low, `${id} is ${(high - low).toFixed(2)} m from foot to head`).toBeLessThan(2.2);
    }
  }, 120_000);

  it("builds a corpse the joints hold together", async () => {
    const real = await everything();
    if (!real) {
      return;
    }
    await initPhysics();
    const bodies = await corpus(real);
    const first = bodies[0]!;
    const shape = ragdollShape(first.body.rig, first.boxes);

    const world = createPhysicsWorld(TICK_DT);
    try {
      const ragdoll = buildRagdoll(world, shape, shape.rest);
      expect(ragdoll.bodies).toHaveLength(RAGDOLL_SEGMENTS.length);
      // Fifteen joints for sixteen segments: the pelvis hangs off nothing.
      expect(ragdoll.joints).toHaveLength(RAGDOLL_SEGMENTS.length - 1);

      // Nothing to land on yet — terrain is a physics world's own concern and not
      // a ragdoll's. What can be asked here is the half that *is* this file's: that
      // fifteen joints hold sixteen bodies together through a hard kick. A joint
      // that failed to bind leaves its segment behind, and free fall alone would
      // not notice, because everything falls at the same rate.
      const spread = () => {
        const pelvis = ragdoll.bodies[0]!.translation();
        let worst = 0;
        for (const part of ragdoll.bodies) {
          const at = part.translation();
          worst = Math.max(worst, Math.hypot(at.x - pelvis.x, at.y - pelvis.y, at.z - pelvis.z));
        }
        return worst;
      };
      const assembled = spread();
      expect(assembled, "a body is about a metre from pelvis to fingertip").toBeGreaterThan(0.4);

      ragdoll.bodies[RAGDOLL_SEGMENTS.indexOf("rightHand")]!.applyImpulse({ x: 120, y: 60, z: 40 }, true);
      for (let i = 0; i < 180; i++) {
        world.step();
      }
      expect(spread(), "the corpse came apart").toBeLessThan(assembled * 1.6);

      // And the negative: it must actually have moved, or the assertion above is
      // satisfied by a corpse frozen in its bind pose — which is exactly what a
      // joint with contacts left enabled produces.
      const hand = ragdoll.bodies[RAGDOLL_SEGMENTS.indexOf("rightHand")]!.translation();
      const rest = shape.rest[RAGDOLL_SEGMENTS.indexOf("rightHand")]!.position;
      expect(Math.hypot(hand.x - rest.x, hand.y - rest.y, hand.z - rest.z)).toBeGreaterThan(0.1);
    } finally {
      world.free();
    }
  }, 120_000);

  it("puts a corpse back on the skeleton it was read off", async () => {
    const real = await everything();
    if (!real) {
      return;
    }
    await initPhysics();
    const bodies = await corpus(real);
    const { body, boxes } = bodies[0]!;
    const shape = ragdollShape(body.rig, boxes);

    // Stand the body somewhere that is not the origin and pose it, which is what
    // the server has already done by the time anybody dies.
    body.rig.root.position.set(3, 1.5, -2);
    body.rig.root.rotation.y = 0.9;
    body.poser.update(createMovement({ x: 3, y: 1.5, z: -2 }, 0.4, 0.2), null, 0);
    body.rig.root.updateMatrixWorld(true);

    const before = RAGDOLL_SEGMENTS.map((segment) => body.rig.root.getObjectByName(SEGMENT_BONES[segment])!.matrixWorld.clone());
    const pose = poseFromRig(body.rig);
    expect(pose, "a catalogue body must always describe a corpse").toBeDefined();

    const world = createPhysicsWorld(TICK_DT);
    try {
      // Built and written straight back, with **no step in between**: the round trip
      // is the thing being measured, so any difference is the maths rather than the
      // physics. This is what makes a corpse appear exactly where the living body
      // was rather than a hand's width away, which is the failure that reads as a
      // netcode bug and is not one.
      const ragdoll = buildRagdoll(world, shape, pose!);
      poseRagdoll(body.rig, shape, ragdoll);

      const after = new THREE.Vector3();
      const expected = new THREE.Vector3();
      for (let i = 0; i < RAGDOLL_SEGMENTS.length; i++) {
        const bone = body.rig.root.getObjectByName(SEGMENT_BONES[RAGDOLL_SEGMENTS[i]!])!;
        after.setFromMatrixPosition(bone.matrixWorld);
        expected.setFromMatrixPosition(before[i]!);
        expect(after.distanceTo(expected), `${RAGDOLL_SEGMENTS[i]} moved`).toBeLessThan(1e-4);
      }

      // And the negative, or a `poseRagdoll` that did nothing at all would pass:
      // one step of gravity has to move it.
      world.step();
      poseRagdoll(body.rig, shape, ragdoll);
      const moved = new THREE.Vector3().setFromMatrixPosition(body.rig.root.getObjectByName(SEGMENT_BONES.pelvis)!.matrixWorld);
      expect(moved.distanceTo(new THREE.Vector3().setFromMatrixPosition(before[0]!))).toBeGreaterThan(0);
    } finally {
      world.free();
    }
  }, 120_000);
});
