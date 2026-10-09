// The zombies script on Kino der Toten itself: its zones, its spawners and its
// door triggers, as exported, over its own collision.
//
// Two questions the made-up map in zombies.test.ts cannot answer. Does a player
// on the start spawns stand in the zone whose spawners round 1 uses? And can each
// door's buy trigger — a slab a few centimetres thick, against the door it opens
// — be reached by the use key from a metre in front of it, facing it, through
// the match's own collision? No navigation: nothing here walks.
//
// Skips a world that has not been exported, as the other imported-map tests do.

import "reflect-metadata";
import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { ResolvedSpawn, ResolvedTrigger, ResolvedWorld } from "@3d/shared/dsl/resolved.js";
import type { CollisionWorld } from "@3d/shared/collision/world.js";
import { catalogueViewOf } from "@3d/shared/game/catalogueView.js";
import type { ServerContext } from "@3d/shared/game/context.js";
import { volumeCentre } from "@3d/shared/game/volumes.js";
import type { UsableThing } from "@3d/shared/game/focus.js";
import { zombiesGametype } from "@3d/shared/game/gametypes/zombies.js";
import type { Script } from "@3d/shared/game/hooks.js";
import { FIRST_ROUND_DELAY, spawnersOf, zombiesScript } from "@3d/shared/game/scripts/zombies.js";
import type { InputMessage } from "@3d/shared/net/messages/input.js";
import { idleInput, type PlayerInput } from "@3d/shared/sim/input.js";
import { createMovement, EYE_HEIGHT } from "@3d/shared/sim/movement.js";
import { CATALOG_VERSION, WeaponRegistry } from "@3d/shared/sim/weaponRegistry.js";
import { loadResolvedWorld } from "@3d/shared/worlds/load.js";
import { presenceFor } from "@3d/shared/worlds/presence.js";
import type { WorldSource } from "@3d/shared/worlds/source.js";
import { indexWorld } from "@3d/shared/worlds/worldIndex.js";
import { NO_BODIES } from "../src/bodies.js";
import { buildServerCollision } from "../src/collision.js";
import { Match } from "../src/match.js";

const SLUG = "theater-bo1";
const TICK_RATE = 60;
const WORLDS = path.resolve(import.meta.dirname, "../../../worlds");
const DIR = path.join(WORLDS, SLUG);
const exported = ["assets/collision.glb", "volumes.world"].every((f) => fs.existsSync(path.join(DIR, f)));

function read(file: string): Promise<Uint8Array | undefined> {
  return Promise.resolve(fs.existsSync(file) ? new Uint8Array(fs.readFileSync(file)) : undefined);
}

const source: WorldSource = {
  describe: DIR,
  payload: () =>
    Promise.resolve({
      entryPath: "world.world",
      sources: Object.fromEntries(
        fs
          .readdirSync(DIR)
          .filter((f) => f.endsWith(".world"))
          .map((f) => [f, fs.readFileSync(path.join(DIR, f), "utf8")]),
      ),
    }),
  asset: (rel) => read(path.join(DIR, rel)),
};

let world: ResolvedWorld;
let collision: CollisionWorld;

/** A zombies match on theater, and a script that hands its context out and hears the use key. */
function theater(): { m: Match; ctx: () => ServerContext; used: UsableThing[] } {
  let held: ServerContext | undefined;
  const used: UsableThing[] = [];
  const listener: Script = { id: "listener", server: { matchStart: (ctx) => (held = ctx), interact: (_c, thing) => void used.push(thing) } };
  const presence = presenceFor(world, zombiesGametype.mode);
  const m = new Match(collision.view(presence), world, TICK_RATE, 4, new WeaponRegistry([]), {
    map: SLUG,
    gametype: zombiesGametype,
    catalogue: catalogueViewOf({ version: CATALOG_VERSION }, new WeaponRegistry([])),
    bodies: NO_BODIES,
    scripts: [zombiesScript, listener],
    presence,
    partView: (index) => collision.partView(index),
    partBounds: (index) => collision.partBounds(index),
  });
  m.step();
  return { m, ctx: () => held!, used };
}

let seq = 0;
function send(m: Match, input: Partial<PlayerInput> = {}): void {
  m.receive("a", {
    seq: ++seq & 0xffff,
    dt: 1 / TICK_RATE,
    input: { ...idleInput(0, 0), ...input },
    claim: createMovement({ x: 0, y: 0, z: 0 }, 0, 0),
    renderTick: 0,
    renderFrac: 0,
  } satisfies InputMessage);
  m.step();
}

describe.skipIf(!exported)("zombies on theater", () => {
  beforeAll(async () => {
    const loaded = await loadResolvedWorld(source);
    world = loaded.world!;
    const built = await buildServerCollision(world, source, (ref, rel) => read(path.join(WORLDS, "catalog", ref.kind, ref.game, ref.id, rel)));
    collision = built!.world;
  }, 120_000);

  it("spawns round 1 at the start zone's walkers, and only there", () => {
    const { m, ctx } = theater();
    m.join("a");
    for (let i = 0; i < (FIRST_ROUND_DELAY + 13) * TICK_RATE; i++) {
      send(m);
    }
    // The start spawns are in the foyer: that zone, and no other, is where round 1 comes from.
    const zones = ctx().zonesOf("a");
    expect(zones).toContain("foyer_zone");
    const index = indexWorld(world);
    const allowed = spawnersOf(index, "foyer_zone").map((p) => p.position);
    expect(allowed.length).toBeGreaterThan(0);
    const spawned = ctx()
      .actors.ids()
      .map((id) => ctx().actors.state(id)!.feet);
    expect(ctx().counter("round")).toBe(1);
    expect(spawned).toHaveLength(6);
    // Where each one was put: a zombie with no graph stands, give or take settling onto the floor
    // and being pushed out of another put on the same walker.
    for (const feet of spawned) {
      expect(allowed.some((p) => Math.hypot(p.x - feet.x, p.z - feet.z) < 1)).toBe(true);
    }
    console.log(
      `theater round 1: zones ${zones.join(" ")}; ${spawned.length} spawned over ${allowed.length} walkers: ` +
        allowed.map((p) => `(${p.x.toFixed(2)} ${p.y.toFixed(2)} ${p.z.toFixed(2)})`).join(" "),
    );
  });

  // A door is bought through any of its triggers, so the question is per door: can
  // one of them be focused? A trigger whose centre sits on or behind the door it
  // opens fails the use rule's line of sight from both sides; the log names each.
  it("can buy every door from a metre in front of one of its triggers, facing it", () => {
    const triggers = world.triggers.filter((t) => t.tags.includes("zombie_door") && !t.tags.includes("electric_door"));
    expect(triggers.length).toBeGreaterThan(0);
    const reached = new Map<string, number>();
    const report: string[] = [];
    for (const door of triggers) {
      const sides = frontOf(door).filter((side) => focusFrom(door, side)).length;
      reached.set(door.target!, (reached.get(door.target!) ?? 0) + sides);
      report.push(`${door.target} t${door.id}@(${door.position.x.toFixed(1)} ${door.position.z.toFixed(1)}): ${sides}`);
    }
    console.log(`theater door triggers, sides that focus: ${report.join("; ")}`);
    expect([...reached].filter(([, sides]) => sides === 0).map(([target]) => target)).toEqual([]);
  });
});

/**
 * Where to stand a metre in front of a door's trigger, on either side of its
 * thinnest horizontal axis, with the floor under it: feet, for each side that has one.
 */
function frontOf(door: ResolvedTrigger): { x: number; y: number; z: number }[] {
  const centre = volumeCentre(door);
  const size = door.size!;
  const turn = door.yaw;
  // The slab's normal: its thinner horizontal side, turned by its yaw.
  const local = size.x < size.z ? { x: 1, z: 0 } : { x: 0, z: 1 };
  const normal = { x: local.x * Math.cos(turn) + local.z * Math.sin(turn), z: -local.x * Math.sin(turn) + local.z * Math.cos(turn) };
  const out: { x: number; y: number; z: number }[] = [];
  for (const sign of [1, -1]) {
    const x = centre.x + normal.x * sign;
    const z = centre.z + normal.z * sign;
    const floor = collision.groundBelow({ x, y: centre.y + 1, z }, 4);
    if (floor !== null) {
      out.push({ x, y: floor, z });
    }
  }
  return out;
}

/** Whether a player standing at `feet`, facing the door's centre, has it in the server's focus. */
function focusFrom(door: ResolvedTrigger, feet: { x: number; y: number; z: number }): boolean {
  const { m, ctx, used } = theater();
  m.join("a");
  const centre = volumeCentre(door);
  ctx().spawn("a", { position: { x: feet.x, y: feet.y + EYE_HEIGHT, z: feet.z }, look: centre } as ResolvedSpawn);
  const eye = { x: feet.x, y: feet.y + EYE_HEIGHT, z: feet.z };
  const dx = centre.x - eye.x;
  const dy = centre.y - eye.y;
  const dz = centre.z - eye.z;
  const yaw = Math.atan2(-dx, -dz);
  const pitch = Math.atan2(dy, Math.hypot(dx, dz));
  for (let i = 0; i < 10; i++) {
    send(m, { yaw, pitch });
  }
  send(m, { yaw, pitch, use: true });
  return used.some((thing) => thing.kind === "trigger" && thing.id === door.id);
}
