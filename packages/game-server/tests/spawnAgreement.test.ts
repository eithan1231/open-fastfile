// Both ends, the real bytes, and the same corpse.
//
// This is the claim the whole design rests on and the only test that can make it:
// **a server and a client, given one spawn, arrive at the same pile of bodies.**
// Everything else is a piece of it — the engine is deterministic
// (`shared/tests/physicsDeterminism.test.ts`), the table describes every body
// (`ragdollTable.test.ts`), a quaternion survives the wire
// (`shared/tests/netQuat.test.ts`) — and none of them says the pieces fit.
//
// `packages/game-server/tests/` is the one place CLAUDE.md allows both ends to be
// stood up, and `apiIntegration.test.ts` is the precedent. It still does **not**
// import `@3d/client`, and does not need to: the browser's corpse is
// `@3d/shared/physics` driven from a decoded packet, so playing the client's part
// means decoding the real bytes and calling the same functions a browser calls. A
// test against a mock of the wire would only agree with itself.

import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { testApp } from "@3d/api/testing/app.js";
import type { GameKey } from "@3d/shared/dsl/resolved.js";
import { catalogueViewOf } from "@3d/shared/game/catalogueView.js";
import { createApiClient, type ApiClient } from "@3d/shared/protocol/api.js";
import type { HttpFetch } from "@3d/shared/protocol/http.js";
import { readHitboxes, type Hitbox } from "@3d/shared/rig/hitboxes.js";
import { poseFromRig } from "@3d/shared/rig/ragdollPose.js";
import { initPhysics, createPhysicsWorld } from "@3d/shared/physics/engine.js";
import { buildRagdoll, poseFromSpawn, ragdollShape, startRagdoll } from "@3d/shared/physics/ragdoll.js";
import { RAGDOLL_SEGMENTS, bodyKnock, localKnock } from "@3d/shared/sim/ragdollBones.js";
import { roundRagdollSpawn, type RagdollSpawn } from "@3d/shared/net/messages/entities.js";
import { gameEvents } from "@3d/shared/net/messages/events.js";
import type { SpawnEvent } from "@3d/shared/net/messages/events.js";
import { BitReader, BitWriter } from "@3d/shared/net/codec/bits.js";
import { TICK_DT } from "@3d/shared/net/messages/fields.js";
import { createMovement } from "@3d/shared/sim/movement.js";
import { WeaponRegistry, type WeaponEntry } from "@3d/shared/sim/weaponRegistry.js";
import type { Api } from "../src/api.js";
import { Bodies, type LoadedBody } from "../src/bodies.js";
import type { Weapons } from "../src/weapons.js";

const GAMES: GameKey[] = ["iw4", "iw5", "iw6", "t5", "s1"];

async function anyBody(): Promise<{ body: LoadedBody; boxes: Hitbox[] } | null> {
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
      return { body, boxes: readHitboxes(JSON.parse(new TextDecoder().decode(bytes))) };
    }
  }
  return null;
}

/** Where every segment ended up, to the millimetre, as one string. */
function resting(
  bodies: readonly { translation(): { x: number; y: number; z: number }; rotation(): { x: number; y: number; z: number; w: number } }[],
): string {
  return bodies
    .map((b) => {
      const t = b.translation();
      const r = b.rotation();
      return `${t.x.toFixed(6)},${t.y.toFixed(6)},${t.z.toFixed(6)},${r.x.toFixed(6)},${r.y.toFixed(6)},${r.z.toFixed(6)},${r.w.toFixed(6)}`;
    })
    .join("|");
}

describe("a corpse, described once and built twice", () => {
  it("lands in the same place on both ends", async () => {
    const chosen = await anyBody();
    if (!chosen) {
      return; // no catalogue built in this checkout
    }
    await initPhysics();
    const { body, boxes } = chosen;
    const shape = ragdollShape(body.rig, boxes);

    // --- the server's side -------------------------------------------------
    // A body posed mid-stride and somewhere that is not the origin, because a
    // corpse that only agrees at rest at the origin agrees about nothing.
    const movement = createMovement({ x: 4.25, y: 2.5, z: -1.75 }, 1.1, -0.3);
    movement.gait = 1;
    movement.stride = 0.375;
    movement.velocity = { x: 2.5, y: 0, z: -4.5 };
    body.rig.root.position.set(movement.feet.x, movement.feet.y, movement.feet.z);
    body.rig.root.rotation.y = 1.1;
    body.poser.update(movement, null, 0);
    body.rig.root.updateMatrixWorld(true);

    const posed = poseFromRig(body.rig)!;
    expect(posed).toBeDefined();
    // Both halves of a round, exactly as `Damage.announceCorpse` builds them: the
    // body knock folded into the velocity, and the local knock left as an impulse.
    const along = { x: 0.6, y: 0.2, z: -0.77 };
    const carry = bodyKnock(34);
    const push = localKnock(34, "rightHand");
    const spawn: RagdollSpawn = {
      victim: "abc12345",
      origin: posed[0]!.position,
      rotations: posed.map((at) => at.rotation),
      velocity: movement.velocity,
      knock: { x: along.x * carry, y: along.y * carry, z: along.z * carry },
      segment: RAGDOLL_SEGMENTS.indexOf("rightHand"),
      impulse: { x: along.x * push, y: along.y * push, z: along.z * push },
    };

    // --- the wire ----------------------------------------------------------
    const event: SpawnEvent = { kind: "spawn", id: 1, entity: 9, what: "ragdoll", tick: 1, ragdoll: spawn };
    const writer = new BitWriter();
    gameEvents.write(writer, [event]);
    const bytes = writer.finish();
    const decoded = gameEvents.read(new BitReader(bytes))[0] as SpawnEvent;

    // The server simulates **the value it decoded**, not the value it meant. That
    // is the rule `roundInput` already states for a player's input, and it is the
    // whole reason the two ends can agree at all.
    expect(roundRagdollSpawn(spawn)).toEqual(decoded.ragdoll);

    // --- both ends ---------------------------------------------------------
    const run = (from: RagdollSpawn): string => {
      const world = createPhysicsWorld(TICK_DT);
      try {
        const pose = poseFromSpawn(shape, from);
        const ragdoll = buildRagdoll(world, shape, pose);
        // The same call `net/corpses.ts` makes — momentum, height-weighted knock,
        // and the round's snap, in the one order that does not wipe the impulse.
        startRagdoll(ragdoll, shape, from);
        for (let i = 0; i < 300; i++) {
          world.step();
        }
        return resting(ragdoll.bodies);
      } finally {
        world.free();
      }
    };

    const server = run(roundRagdollSpawn(spawn));
    const client = run(decoded.ragdoll);
    expect(createHash("sha256").update(client).digest("hex")).toBe(createHash("sha256").update(server).digest("hex"));

    // And the negative, or the two above would pass on a corpse that never moved:
    // one quantisation step of difference has to produce a different answer after
    // five seconds, which is what says the agreement is earned rather than trivial.
    const nudged: RagdollSpawn = { ...spawn, origin: { ...spawn.origin, x: spawn.origin.x + 0.01 } };
    expect(run(roundRagdollSpawn(nudged))).not.toBe(server);
  }, 180_000);
});
