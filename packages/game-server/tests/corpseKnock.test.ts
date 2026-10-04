// What a round does to a body, measured rather than admired.
//
// "The head throws back, then the body, then the arms, and it falls the way it was
// shot" is a sentence about a sequence, and a sequence is something a test can hold.
// Every number in `sim/ragdollBones.ts` that decides it — the two knocks, the height
// weighting, the per-segment damping, the joint limits — is a feel number, and feel
// numbers get changed. This is what says whether a change made it better or merely
// different.
//
// Two of these were real faults rather than taste:
//
//  - The impulse was applied **before** `setLinvel`, which assigns rather than adds,
//    so every shot's push was wiped off the only segment it was meant for and no
//    round moved anything at all.
//  - The knock was given to every segment equally, which slides a body backwards
//    feet and all; which way it then fell was decided by whatever lean the last
//    animation frame happened to have, and a hand shot measured a metre *toward*
//    the shooter.

import "reflect-metadata";
import * as THREE from "three";
import { beforeAll, describe, expect, it } from "vitest";
import { testApp } from "@3d/api/testing/app.js";
import type { GameKey } from "@3d/shared/dsl/resolved.js";
import { catalogueViewOf } from "@3d/shared/game/catalogueView.js";
import { createApiClient, type ApiClient } from "@3d/shared/protocol/api.js";
import type { HttpFetch } from "@3d/shared/protocol/http.js";
import { readHitboxes } from "@3d/shared/rig/hitboxes.js";
import { poseFromRig, type SegmentPose } from "@3d/shared/rig/ragdollPose.js";
import { initPhysics, createPhysicsWorld } from "@3d/shared/physics/engine.js";
import { buildRagdoll, knockWeights, poseFromSpawn, ragdollShape, startRagdoll, type RagdollShape } from "@3d/shared/physics/ragdoll.js";
import { buildTerrain } from "@3d/shared/physics/terrain.js";
import { bodyKnock, localKnock, RAGDOLL_SEGMENTS, SEGMENT_BONES, type RagdollSegment } from "@3d/shared/sim/ragdollBones.js";
import { WeaponRegistry, type WeaponEntry } from "@3d/shared/sim/weaponRegistry.js";
import { TICK_DT, TICK_RATE } from "@3d/shared/net/messages/fields.js";
import { createMovement } from "@3d/shared/sim/movement.js";
import type { Api } from "../src/api.js";
import { Bodies } from "../src/bodies.js";
import type { Weapons } from "../src/weapons.js";

const GAMES: GameKey[] = ["iw4", "iw5", "iw6", "t5", "s1"];
/** Straight at them, level, along -Z. A corpse should end up further along it. */
const ALONG = { x: 0, y: 0.08, z: -1 };

async function standing(): Promise<{ shape: RagdollShape; pose: ReturnType<typeof poseFromRig> } | null> {
  const { app } = testApp();
  const client: ApiClient = createApiClient({ fetch: app.request.bind(app) as HttpFetch });
  const index = await client.catalogIndex();
  const catalogue = catalogueViewOf(index, new WeaponRegistry(index.weapons as WeaponEntry[]));
  if (GAMES.every((game) => catalogue.charactersFor(game).length === 0)) {
    return null;
  }
  const bodies = new Bodies({ client } as unknown as Api, { catalogue } as unknown as Weapons);
  await bodies.load();
  for (const game of GAMES) {
    for (const character of catalogue.charactersFor(game)) {
      const body = bodies.get(game, character.id);
      if (!body) {
        continue;
      }
      const bytes = await client.catalogFile({ kind: "characters", game, id: character.id, rest: `${character.id}.hitboxes.json` });
      const shape = ragdollShape(body.rig, readHitboxes(JSON.parse(new TextDecoder().decode(bytes))));
      // Stood at the origin, idle, facing +Z — shot from in front.
      const movement = createMovement({ x: 0, y: 0, z: 0 }, 0, 0);
      movement.grounded = true;
      body.rig.root.position.set(0, 0, 0);
      body.rig.root.rotation.y = 0;
      body.poser.update(movement, null, 0);
      body.rig.root.updateMatrixWorld(true);
      return { shape, pose: poseFromRig(body.rig) };
    }
  }
  return null;
}

const index = (segment: RagdollSegment) => RAGDOLL_SEGMENTS.indexOf(segment);

beforeAll(async () => {
  await initPhysics();
});

/** Shoot a standing body and follow every segment. */
function shoot(shape: RagdollShape, rest: SegmentPose[], hit: RagdollSegment, damage: number, seconds: number) {
  const world = createPhysicsWorld(TICK_DT);
  const ground = new THREE.BoxGeometry(100, 1, 100).translate(0, -0.5, 0).toNonIndexed();
  buildTerrain(world, { mapSurfaces: () => ({ shots: ground }) } as never);

  // Through the same derivation a client uses, so the spawn lift and everything
  // else about how a corpse is placed is the thing being measured.
  const pose = poseFromSpawn(shape, { origin: rest[0]!.position, rotations: rest.map((one) => one.rotation) });
  const ragdoll = buildRagdoll(world, shape, pose);
  const push = localKnock(damage, hit);
  const carry = bodyKnock(damage);
  startRagdoll(ragdoll, shape, {
    velocity: { x: 0, y: 0, z: 0 },
    knock: { x: ALONG.x * carry, y: ALONG.y * carry, z: ALONG.z * carry },
    segment: index(hit),
    impulse: { x: ALONG.x * push, y: ALONG.y * push, z: ALONG.z * push },
  });

  const start = pose.map((p) => ({ ...p.position }));
  const restRotation = pose.map((p) => ({ ...p.rotation }));
  const moved = (segment: RagdollSegment): number => {
    const at = ragdoll.bodies[index(segment)]!.translation();
    const was = start[index(segment)]!;
    return Math.hypot(at.x - was.x, at.y - was.y, at.z - was.z);
  };
  const step = (ticks: number) => {
    for (let i = 0; i < ticks; i++) {
      world.step();
    }
  };
  const at = (segment: RagdollSegment) => ragdoll.bodies[index(segment)]!.translation();

  /**
   * How far a limb has swung away from where it hangs, **in the hips' own frame**.
   *
   * Two things have to be taken out to measure articulation rather than motion: the
   * corpse's travel, and — less obviously and much more importantly — the corpse's
   * *rotation*. A perfectly rigid body rolling through ninety degrees moves a foot
   * most of a metre relative to its pelvis in world axes, so measuring there says a
   * rigid leg is flailing. Said in the pelvis's frame, a rigid body scores zero
   * however it tumbles, and what is left is the joints actually opening.
   *
   * This rather than displacement because a limb that swings out and comes back has
   * almost no net displacement and has still windmilled the whole way.
   */
  const hipFrame = new THREE.Quaternion();
  const restFrame = new THREE.Quaternion();
  const offset = new THREE.Vector3();
  const restOffset = new THREE.Vector3();
  const excursion = (segment: RagdollSegment, against: RagdollSegment = "pelvis"): number => {
    const hipsBody = ragdoll.bodies[index(against)]!;
    const hips = hipsBody.translation();
    const turn = hipsBody.rotation();
    const limb = ragdoll.bodies[index(segment)]!.translation();
    const hipsRest = start[index(against)]!;
    const limbRest = start[index(segment)]!;

    hipFrame.set(turn.x, turn.y, turn.z, turn.w).invert();
    offset.set(limb.x - hips.x, limb.y - hips.y, limb.z - hips.z).applyQuaternion(hipFrame);

    const bind = restRotation[index(against)]!;
    restFrame.set(bind.x, bind.y, bind.z, bind.w).invert();
    restOffset.set(limbRest.x - hipsRest.x, limbRest.y - hipsRest.y, limbRest.z - hipsRest.z).applyQuaternion(restFrame);

    return offset.distanceTo(restOffset);
  };

  /** The worst that gets over a whole fall, which is what anybody would notice. */
  const peakExcursion = (segments: [RagdollSegment, RagdollSegment][], ticks: number): Record<string, number> => {
    const worst: Record<string, number> = Object.fromEntries(segments.map(([one]) => [one, 0]));
    for (let i = 0; i < ticks; i++) {
      world.step();
      for (const [one, against] of segments) {
        worst[one] = Math.max(worst[one]!, excursion(one, against));
      }
    }
    return worst;
  };

  return { world, moved, step, at, excursion, peakExcursion, seconds };
}

describe("what a round does to a body", () => {
  it("throws the head first, then the body, and the legs least", async () => {
    const real = await standing();
    if (!real?.pose) {
      return; // no catalogue built in this checkout
    }
    const shot = shoot(real.shape, real.pose, "head", 110, 1.5);
    try {
      // A fifth of a second in: the sequence, while it is still a sequence. The head
      // took the round, the chest is being dragged after it through the neck, and
      // the feet have barely been asked to move.
      shot.step(Math.round(TICK_RATE * 0.2));
      expect(shot.moved("head"), "the head should lead").toBeGreaterThan(shot.moved("chest"));
      expect(shot.moved("chest"), "the chest should follow the head").toBeGreaterThan(shot.moved("pelvis"));
      expect(shot.moved("rightFoot"), "the feet should be the last to go").toBeLessThan(shot.moved("chest"));

      // And a couple of seconds later it is on the floor, well along the way the
      // round went.
      shot.step(Math.round(TICK_RATE * 2.3));
      const pelvis = shot.at("pelvis");
      expect(pelvis.z, "it fell towards the shooter").toBeLessThan(-0.8);
      // Hips below the height they stood at: it is down, not merely leaning.
      expect(pelvis.y, "it never went down").toBeLessThan(0.7);
      // Over its own feet, not out from under them: the body rolled back rather
      // than sliding away whole.
      expect(shot.at("rightFoot").z, "the feet travelled as far as the hips").toBeGreaterThan(pelvis.z);
    } finally {
      shot.world.free();
    }
  }, 120_000);

  it("keeps the legs tighter than the arms", async () => {
    const real = await standing();
    if (!real?.pose) {
      return;
    }
    const shot = shoot(real.shape, real.pose, "chest", 40, 1.5);
    try {
      // **Each limb against the bone it hangs off**, not against the hips. An arm
      // measured against the pelvis is really the spine plus the shoulder plus the
      // arm, and a chest that leans thirty degrees moves a hand a long way without
      // the arm having done anything at all.
      const peak = shot.peakExcursion(
        [
          ["rightHand", "chest"],
          ["rightArmLower", "chest"],
          ["rightFoot", "pelvis"],
          ["rightLegLower", "pelvis"],
        ],
        Math.round(TICK_RATE * 1.5),
      );

      // An arm is meant to trail, so it is allowed the larger swing — but a limb
      // that leaves its shoulder by most of a metre is a limb nobody believes.
      expect(peak.rightHand!, "the arms are barely moving").toBeGreaterThan(0.1);
      expect(peak.rightHand!, "the arms are windmilling").toBeLessThan(0.75);

      // A leg is meant to be dragged, and **this is the assertion that says the legs
      // are the rigid half of the body**. It is the one that would fail first if
      // `SEGMENT_ANGULAR_DAMPING` or the hip limits were loosened again.
      expect(peak.rightFoot!, "the legs are being thrown around").toBeLessThan(peak.rightHand!);
      // A leg is about 0.85 m from hip to sole, so this holds the foot to under half
      // an unfolded leg's reach away from where it hangs.
      expect(peak.rightFoot!, "the legs are being thrown around").toBeLessThan(0.45);
    } finally {
      shot.world.free();
    }
  }, 120_000);

  it("shares the knock out by height, so a body topples rather than slides", async () => {
    const real = await standing();
    if (!real?.pose) {
      return;
    }
    const weights = knockWeights(real.shape);
    // The head takes several times what the soles do, and that difference *is* the
    // topple. Equal weights here would be the bug this replaced.
    expect(weights[index("head")]!).toBeGreaterThan(weights[index("rightFoot")]! * 3);
    expect(weights[index("chest")]!).toBeGreaterThan(weights[index("pelvis")]!);
    expect(Math.min(...weights), "nothing may be pushed backwards").toBeGreaterThan(0);

    // Every segment has one, and they are ordered by how high the bone sits.
    expect(weights).toHaveLength(RAGDOLL_SEGMENTS.length);
    expect(Object.keys(SEGMENT_BONES)).toHaveLength(RAGDOLL_SEGMENTS.length);
  }, 120_000);

  it("scales the snap by what it hits, so no limb is launched", () => {
    // The same round into a 0.44 kg hand and a 16 kg chest. A fixed impulse would
    // give the hand thirty-six times the speed; a fixed *speed* is the same visible
    // whip on both, which is what `localKnock` is for.
    const hand = localKnock(100, "rightHand");
    const chest = localKnock(100, "chest");
    expect(chest).toBeGreaterThan(hand);
    // Equal speeds, to the cap.
    expect(chest / 16.0).toBeCloseTo(hand / 0.44, 5);

    // And a heavier round cannot keep buying speed for ever.
    expect(localKnock(1000, "head")).toBe(localKnock(100, "head"));
    expect(bodyKnock(1000)).toBe(bodyKnock(100));
  });
});
