// A real body, on a real map, in a real physics world.
//
// Everything up to here was measured in pieces: `ragdollTable.test.ts` says the
// sixteen segments describe every body the catalogue holds, and
// `shared/tests/physicsWorld.test.ts` says the world steps and orders and retires
// the way replication needs. This is the two of them at once, which is the first
// point at which anything could be said to work.
//
// It also carries **the number nobody should have to guess at**: what a map costs
// to put into Rapier. `three-mesh-bvh` cannot be handed to a physics engine, so the
// triangles go in a second time as a trimesh with a QBVH over them — and it is paid
// per physics world rather than per map, so two games on one map pay it twice. It
// lands inside `Games.create`, a window players are already waiting in, which is
// why it is worth seconds rather than adjectives.
//
// Runs against the repo's real `worlds/` and skips where the map has not been
// exported, exactly as collision.test.ts does. Nothing here imports Rapier: a
// builder is handed the world it builds into, so its type is inferred and the
// engine stays inside `@3d/shared/physics` where `eslint.config.js` keeps it.

import "reflect-metadata";
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { testApp } from "@3d/api/testing/app.js";
import type { GameKey } from "@3d/shared/dsl/resolved.js";
import { catalogueViewOf } from "@3d/shared/game/catalogueView.js";
import { createApiClient, type ApiClient } from "@3d/shared/protocol/api.js";
import type { HttpFetch } from "@3d/shared/protocol/http.js";
import { readHitboxes, type Hitbox } from "@3d/shared/rig/hitboxes.js";
import { initPhysics } from "@3d/shared/physics/engine.js";
import { PhysicsWorld } from "@3d/shared/physics/world.js";
import { buildRagdoll, ragdollShape } from "@3d/shared/physics/ragdoll.js";
import { RAGDOLL_SEGMENTS } from "@3d/shared/sim/ragdollBones.js";
import { WeaponRegistry, type WeaponEntry } from "@3d/shared/sim/weaponRegistry.js";
import { TICK_RATE } from "@3d/shared/net/messages/fields.js";
import { loadResolvedWorld } from "@3d/shared/worlds/load.js";
import type { WorldSource } from "@3d/shared/worlds/source.js";
import { buildServerCollision } from "../src/collision.js";
import type { Api } from "../src/api.js";
import { Bodies } from "../src/bodies.js";
import type { Weapons } from "../src/weapons.js";

const WORLDS = path.resolve(import.meta.dirname, "../../../worlds");
const IMPORTED = "dome-mw3";
const GAMES: GameKey[] = ["iw4", "iw5", "iw6", "t5", "s1"];

const exported = fs.existsSync(path.join(WORLDS, IMPORTED, "assets/collision.glb"));

function dirSource(slug: string): WorldSource {
  const dir = path.join(WORLDS, slug);
  return {
    describe: dir,
    payload: () =>
      Promise.resolve({
        entryPath: "world.world",
        sources: Object.fromEntries(
          fs
            .readdirSync(dir)
            .filter((f) => f.endsWith(".world"))
            .map((f) => [f, fs.readFileSync(path.join(dir, f), "utf8")]),
        ),
      }),
    asset: (relPath) => {
      const file = path.join(dir, relPath);
      return Promise.resolve(fs.existsSync(file) ? new Uint8Array(fs.readFileSync(file)) : undefined);
    },
  };
}

const catalogFile = (ref: { kind: string; game: string; id: string }, rel: string): Promise<Uint8Array | undefined> => {
  const file = path.join(WORLDS, "catalog", ref.kind, ref.game, ref.id, rel);
  return Promise.resolve(fs.existsSync(file) ? new Uint8Array(fs.readFileSync(file)) : undefined);
};

/** The first body the catalogue holds, with the boxes its ragdoll is made of. */
async function anyBody(): Promise<{ id: string; shape: ReturnType<typeof ragdollShape> } | null> {
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
      const boxes: Hitbox[] = readHitboxes(JSON.parse(new TextDecoder().decode(bytes)));
      return { id: `${game}/${character.id}`, shape: ragdollShape(body.rig, boxes) };
    }
  }
  return null;
}

describe("a corpse on an exported map", () => {
  it("falls, lands on the map, and settles in one piece", async () => {
    if (!exported) {
      return; // dome-mw3 has not been exported in this checkout
    }
    const chosen = await anyBody();
    if (!chosen) {
      return; // no catalogue built in this checkout
    }
    await initPhysics();

    const source = dirSource(IMPORTED);
    const loaded = await loadResolvedWorld(source);
    const collision = await buildServerCollision(loaded.world!, source, catalogFile);
    expect(collision).toBeDefined();

    const world = new PhysicsWorld(TICK_RATE);
    try {
      const cost = world.loadTerrain(collision!.world);
      console.log(`  ${IMPORTED}: ${cost.triangles.toLocaleString()} triangles into Rapier in ${cost.ms}ms`);
      // Loosely bounded on purpose: this is here to report a number and to catch a
      // map arriving empty, not to pin an export. dome's shots tree is 88,168 of
      // its 118,704 triangles (docs/engine/collision.md).
      expect(cost.triangles).toBeGreaterThan(10_000);

      // Dropped where a corpse is actually made — a little above whatever the map's
      // surface is here — rather than from thirty metres up. Thirty metres is 33 m/s
      // by the time it arrives, which is over half a metre per step and further than
      // most floors are thick; that tests Rapier's continuous collision rather than
      // anything about a body. `groundBelow` is the same query the player's own step
      // uses, so this lands on the floor a player would be standing on.
      const surface = collision!.world.groundBelow({ x: 0, y: 60, z: 0 }, 120);
      expect(surface, `${IMPORTED} has no floor under its origin`).not.toBeNull();
      const drop = surface! + 1.5;
      const pose = chosen.shape.rest.map((at) => ({ position: { ...at.position, y: at.position.y + drop }, rotation: at.rotation }));
      world.spawn(1, "ragdoll", 1, (raw) => buildRagdoll(raw, chosen.shape, pose));
      world.step(1);

      const ragdoll = world.entity(1)!;
      expect(ragdoll.bodies).toHaveLength(RAGDOLL_SEGMENTS.length);
      const startY = ragdoll.bodies[0]!.translation().y;

      // Four seconds, **one tick at a time**, which is the only way a real caller
      // ever advances it: `PhysicsWorld.step` gives up rather than stalling when it
      // is asked to cover more than a second at once, so a jump of 240 ticks would
      // quietly simulate the last 60 of them and this would be a test of the
      // catch-up bound instead (shared/tests/physicsWorld.test.ts owns that).
      for (let tick = 2; tick <= 1 + TICK_RATE * 4; tick++) {
        world.step(tick);
      }

      const pelvis = ragdoll.bodies[0]!.translation();
      expect(pelvis.y, "it never fell").toBeLessThan(startY - 0.4);
      expect(pelvis.y, "it fell through the map").toBeGreaterThan(surface! - 0.5);

      // Still a body: fifteen joints holding sixteen segments within arm's reach.
      for (const part of ragdoll.bodies) {
        const at = part.translation();
        expect(Math.hypot(at.x - pelvis.x, at.y - pelvis.y, at.z - pelvis.z), "the corpse came apart").toBeLessThan(1.5);
      }

      // And it has stopped, which is what the settle-and-freeze phase will key on.
      const speed = Math.hypot(ragdoll.bodies[0]!.linvel().x, ragdoll.bodies[0]!.linvel().y, ragdoll.bodies[0]!.linvel().z);
      expect(speed, "still moving after four seconds").toBeLessThan(0.5);
    } finally {
      world.free();
    }
  }, 180_000);
});
