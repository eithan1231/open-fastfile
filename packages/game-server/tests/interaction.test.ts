// Occupancy and the use key in a match: which triggers each player's feet are in
// (`triggerEnter`, `triggerLeave`, `ctx.zonesOf`, `ctx.occupants`), and what a
// press of the use key reaches (`interact`) — the server's own focus from the
// input, never the client's word.
//
// On a real `CollisionWorld`: a floor, a door across the way that is a removable
// part, a zone around the spawn and one past the door, and a trigger in front of
// the door that can be used from near it.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import type { ResolvedTrigger, ResolvedWorld } from "@3d/shared/dsl/resolved.js";
import { CollisionWorld } from "@3d/shared/collision/world.js";
import { catalogueViewOf } from "@3d/shared/game/catalogueView.js";
import type { ServerContext } from "@3d/shared/game/context.js";
import type { UsableThing } from "@3d/shared/game/focus.js";
import { defaultGametype } from "@3d/shared/game/gametypes/default.js";
import type { Script } from "@3d/shared/game/hooks.js";
import type { InputMessage } from "@3d/shared/net/messages/input.js";
import { idleInput, type PlayerInput } from "@3d/shared/sim/input.js";
import { EYE_HEIGHT } from "@3d/shared/sim/movement.js";
import { CATALOG_VERSION, WeaponRegistry } from "@3d/shared/sim/weaponRegistry.js";
import { presenceFor } from "@3d/shared/worlds/presence.js";
import { NO_BODIES } from "../src/bodies.js";
import { Match } from "../src/match/match.js";

const TICK_RATE = 60;

function trigger(id: number, over: Partial<ResolvedTrigger>): ResolvedTrigger {
  return { id, tags: [], position: { x: 0, y: 0, z: 0 }, yaw: 0, size: { x: 1, y: 1, z: 1 }, ...over };
}

/** The spawn at the origin facing -Z; the door two metres ahead; a zone either side of it; its buy trigger in front. */
function world(): ResolvedWorld {
  return {
    name: "doorway",
    spawn: { position: { x: 0, y: EYE_HEIGHT, z: 0 }, look: { x: 0, y: EYE_HEIGHT, z: -1 } },
    spawnPoints: [],
    triggers: [
      trigger(10, { tags: ["start_zone", "player_area"], position: { x: 0, y: 1, z: 0 }, size: { x: 4, y: 3, z: 4 } }),
      trigger(11, { tags: ["far_zone", "player_area"], position: { x: 0, y: 1, z: -8 }, size: { x: 4, y: 3, z: 4 } }),
      trigger(12, { tags: ["door_buy"], target: "door", use: "near", position: { x: 0, y: 1.25, z: -1.5 }, size: { x: 2, y: 2.5, z: 0.2 } }),
      // Only in a mode nobody here plays: it does not exist, so nobody is ever in it.
      trigger(13, { tags: ["flag"], modes: ["dom"], position: { x: 0, y: 1, z: 0 }, size: { x: 4, y: 3, z: 4 } }),
    ],
    mantles: [],
    ladders: [],
    effects: [],
    sounds: [],
    points: [],
    solids: [{ id: 0, name: "front", part: "*1", tags: ["door"] }],
    rooms: [],
    topLevelObjects: [],
  } as unknown as ResolvedWorld;
}

let shared: CollisionWorld | undefined;
function collision(): CollisionWorld {
  if (!shared) {
    const root = new THREE.Group();
    const floor = new THREE.Mesh(new THREE.BoxGeometry(60, 1, 60).translate(0, -0.5, 0));
    const door = new THREE.Mesh(new THREE.BoxGeometry(10, 3, 0.4).translate(0, 1.5, -2));
    for (const mesh of [floor, door]) {
      mesh.userData.collide = true;
    }
    door.userData.part = "*1";
    root.add(floor, door);
    root.updateMatrixWorld(true);
    shared = new CollisionWorld();
    shared.rebuild(root, ["*1"]);
  }
  return shared;
}

interface Heard {
  entered: string[];
  left: string[];
  /** Who left the match, and whether a hook could still look them up as it heard so. */
  gone: { id: string; known: boolean; zones: readonly string[] }[];
  used: { thing: UsableThing; player: string }[];
}

/** A match with one script that records what it hears, and whatever else a test gives it. */
function match(extra: Partial<Script> & { server?: Script["server"] } = {}): { m: Match; heard: Heard; ctx: () => ServerContext } {
  const heard: Heard = { entered: [], left: [], gone: [], used: [] };
  let context: ServerContext | undefined;
  const recorder: Script = {
    id: "recorder",
    ...extra,
    server: {
      matchStart: (ctx) => (context = ctx),
      triggerEnter: (_ctx, t, id) => heard.entered.push(`${id}:${t.tags[0]}`),
      triggerLeave: (_ctx, t, id) => heard.left.push(`${id}:${t.tags[0]}`),
      playerLeave: (ctx, id) => heard.gone.push({ id, known: ctx.player(id) !== undefined, zones: ctx.zonesOf(id) }),
      interact: (ctx, thing, player) => {
        heard.used.push({ thing, player });
        extra.server?.interact?.(ctx, thing, player);
      },
    },
  };
  const presence = presenceFor(world(), defaultGametype.mode);
  const m = new Match(collision().view(presence), world(), TICK_RATE, 4, new WeaponRegistry([]), {
    map: "doorway",
    gametype: defaultGametype,
    catalogue: catalogueViewOf({ version: CATALOG_VERSION }, new WeaponRegistry([])),
    bodies: NO_BODIES,
    scripts: [recorder],
    presence,
    partView: (index) => collision().partView(index),
    partBounds: (index) => collision().partBounds(index),
  });
  m.step();
  return { m, heard, ctx: () => context! };
}

let seq = 0;
/** One input from `id`, then one tick. */
function send(m: Match, id: string, input: Partial<PlayerInput> = {}): void {
  m.receive(id, {
    seq: ++seq & 0xffff,
    dt: 1 / TICK_RATE,
    input: { ...idleInput(0, 0), ...input },
    claim: { x: 0, y: 0, z: 0 },
    drawn: { tick: 0, frac: 0 },
  } satisfies InputMessage);
  m.step();
}

/** Stand still until settled on the floor. */
function settle(m: Match, id = "a"): void {
  for (let i = 0; i < 10; i++) {
    send(m, id);
  }
}

describe("occupancy", () => {
  it("hears an entry once, however long they stand in it, and nothing of a trigger outside the mode", () => {
    const { m, heard, ctx } = match();
    m.join("a");
    settle(m);
    expect(heard.entered).toEqual(["a:start_zone"]);
    expect(heard.left).toEqual([]);
    expect(ctx().zonesOf("a")).toEqual(["start_zone", "player_area"]);
    expect(ctx().occupants("player_area")).toEqual(["a"]);
    expect(ctx().occupants("far_zone")).toEqual([]);
    expect(ctx().occupants("flag")).toEqual([]);
    expect(ctx().zonesOf("nobody")).toEqual([]);
  });

  it("hears the leaving and the next entry once each as they walk from one area to the next", () => {
    const { m, heard, ctx } = match();
    m.join("a");
    settle(m);
    ctx().world.setPresent("door", false);
    for (let i = 0; i < 150; i++) {
      send(m, "a", { forward: 1 });
    }
    // Every trigger is occupied, usable or not: the door's buy volume on the way.
    expect(heard.entered).toEqual(["a:start_zone", "a:door_buy", "a:far_zone"]);
    expect(heard.left).toEqual(["a:door_buy", "a:start_zone"]);
    expect(ctx().zonesOf("a")).toEqual(["far_zone", "player_area"]);
    expect(ctx().occupants("far_zone")).toEqual(["a"]);
  });

  it("takes the dead out of everything they were in", () => {
    const { m, heard, ctx } = match();
    m.join("a");
    settle(m);
    ctx().damage("a", 1000, null);
    send(m, "a");
    expect(heard.left).toEqual(["a:start_zone"]);
    expect(ctx().zonesOf("a")).toEqual([]);
    expect(ctx().occupants("start_zone")).toEqual([]);
  });

  it("takes a player who leaves the match out of what they were in, then says they left", () => {
    const { m, heard, ctx } = match();
    m.join("a");
    settle(m);
    m.leave("a");
    // A script counting who is in a zone hears the leaving it would otherwise
    // wait for for the rest of the match.
    expect(heard.left).toEqual(["a:start_zone"]);
    // Still in the roster as the hook is asked, and already out of every zone.
    expect(heard.gone).toEqual([{ id: "a", known: true, zones: [] }]);
    expect(m.has("a")).toBe(false);
    m.step();
    expect(heard.left).toEqual(["a:start_zone"]);
    expect(ctx().occupants("start_zone")).toEqual([]);
  });

  it("says nothing of somebody who was never in the match", () => {
    const { m, heard } = match();
    m.leave("nobody");
    expect(heard.gone).toEqual([]);
  });
});

describe("the use key", () => {
  it("asks interact once per press, on the rising edge, however long it is held", () => {
    const { m, heard } = match();
    m.join("a");
    settle(m);
    for (let i = 0; i < 5; i++) {
      send(m, "a", { use: true });
    }
    expect(heard.used).toHaveLength(1);
    expect(heard.used[0]!.player).toBe("a");
    expect(heard.used[0]!.thing).toMatchObject({ kind: "trigger", index: 2, tags: ["door_buy"], target: "door" });
    send(m, "a");
    send(m, "a", { use: true });
    expect(heard.used).toHaveLength(2);
  });

  it("presses nothing with nothing in the server's focus", () => {
    // The script wants the door buy looked at, and the player has their back to it.
    const { m, heard } = match({ usable: () => ({ look: true }) });
    m.join("a");
    settle(m);
    send(m, "a", { yaw: Math.PI, use: true });
    expect(heard.used).toHaveLength(0);
    // Turned round, the next press reaches it.
    send(m, "a", { yaw: 0 });
    send(m, "a", { yaw: 0, use: true });
    expect(heard.used).toHaveLength(1);
  });

  it("presses nothing the script says is not usable now", () => {
    const { m, heard } = match({ usable: () => null });
    m.join("a");
    settle(m);
    send(m, "a", { use: true });
    expect(heard.used).toHaveLength(0);
  });

  it("presses nothing for a dead player", () => {
    const { m, heard, ctx } = match();
    m.join("a");
    settle(m);
    ctx().damage("a", 1000, null);
    send(m, "a", { use: true });
    expect(heard.used).toHaveLength(0);
  });

  it("opens the door end to end: interact removes the solid, and the player walks through", () => {
    const { m, heard } = match({
      server: { interact: (ctx, thing) => ctx.world.setPresent(thing.target!, false) },
    });
    m.join("a");
    settle(m);
    expect(m.presence.has(0)).toBe(true);
    send(m, "a", { use: true });
    expect(heard.used).toHaveLength(1);
    expect(m.presence.has(0)).toBe(false);
    for (let i = 0; i < 150; i++) {
      send(m, "a", { forward: 1 });
    }
    expect(heard.entered).toContain("a:far_zone");
  });
});
