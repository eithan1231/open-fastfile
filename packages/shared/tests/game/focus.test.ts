// A player's use focus (game/focus.ts): Call of Duty's rule, which both ends run
// — a browser for the prompt, a game server on the key's edge.
//
// On a real `CollisionWorld`: a floor, a wall that is always there, and a wall
// that is a removable part, so "a removed part no longer blocks" is the same
// trace a match makes.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { CollisionWorld } from "../../src/collision/world.js";
import type { ResolvedSolid, ResolvedTrigger } from "../../src/dsl/resolved.js";
import { DEFAULT_USE, focusOf, USE_RULE, usableBy, usableThings, viewerAt, type UsableThing, type UseVerdict } from "../../src/game/focus.js";
import type { GameView, PlayerView } from "../../src/game/context.js";
import type { Script } from "../../src/game/hooks.js";
import { EYE_HEIGHT } from "../../src/sim/movement.js";
import { Presence } from "../../src/worlds/presence.js";

const at = (x: number, y: number, z: number) => ({ x, y, z });
const EYE = EYE_HEIGHT;

function box(size: [number, number, number], centre: [number, number, number], part?: string): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size).translate(...centre));
  mesh.userData.collide = true;
  if (part) {
    mesh.userData.part = part;
  }
  return mesh;
}

/**
 * A floor; a base wall across x ∈ [3, 5] at z = -1; a removable wall (`*1`)
 * across x ∈ [-5, -3] at z = -1; and a crate that is a usable solid (`*2`) at
 * x = 8. The player stands at the origin looking along -z.
 */
function room(): { collision: CollisionWorld; presence: Presence } {
  const root = new THREE.Group();
  root.add(box([40, 1, 40], [0, -0.5, 0]), box([2, 3, 0.2], [4, 1.5, -1]), box([2, 3, 0.2], [-4, 1.5, -1], "*1"), box([1, 1, 1], [8, 0.5, -1], "*2"));
  root.updateMatrixWorld(true);
  const collision = new CollisionWorld();
  collision.rebuild(root, ["*1", "*2"]);
  return { collision, presence: new Presence(2) };
}

let nextId = 100;
function trigger(position: { x: number; y: number; z: number }, use: "near" | "touch", over: Partial<ResolvedTrigger> = {}): ResolvedTrigger {
  return { id: nextId++, tags: [], position, yaw: 0, size: at(0.2, 0.2, 0.2), use, ...over };
}

function thingsOf(triggers: ResolvedTrigger[], solids: ResolvedSolid[] = [], collision?: CollisionWorld): UsableThing[] {
  return usableThings({ triggers, solids }, undefined, (i) => collision?.partBounds(i));
}

const anyone = (): UseVerdict => DEFAULT_USE;
const looking = (): UseVerdict => ({ look: true });

/** Standing at `feet`, facing `yaw` (0 is -z). */
function focus(
  world: { collision: CollisionWorld; presence: Presence },
  things: UsableThing[],
  usable = anyone as (t: UsableThing) => UseVerdict | null,
  yaw = 0,
  feet = at(0, 0, 0),
) {
  return focusOf(world.collision.view(world.presence), things, world.presence, viewerAt(feet, yaw, 0), usable);
}

describe("focusOf", () => {
  it("keeps the rule's numbers in one place, in the game's inches", () => {
    expect(USE_RULE.reach).toBeCloseTo(1.8288, 4);
    expect(USE_RULE.lookDot).toBe(0.76);
  });

  it("offers a touch thing to a player standing in it, and not to one outside", () => {
    const world = room();
    const pad = trigger(at(0, 1, 0), "touch", { size: at(2, 2, 2) });
    expect(focus(world, thingsOf([pad]))?.id).toBe(pad.id);
    expect(focus(world, thingsOf([pad]), anyone, 0, at(1.5, 0, 0))).toBeNull();
    // A touch needs no line of sight and no facing: back turned, still in it.
    expect(focus(world, thingsOf([pad]), anyone, Math.PI)?.id).toBe(pad.id);
  });

  it("offers a near thing within reach of its centre, inside or not, and not one beyond", () => {
    const world = room();
    const close = trigger(at(0, EYE, -1.8), "near");
    const far = trigger(at(0, EYE, -1.9), "near");
    expect(focus(world, thingsOf([close]))?.id).toBe(close.id);
    expect(focus(world, thingsOf([far]))).toBeNull();
    // A thin volume the eye is nowhere near the inside of, measured to its centre.
    const plate = trigger(at(1, EYE + 0.5, -1), "near", { size: at(0.05, 3, 0.05) });
    expect(focus(world, thingsOf([plate]))?.id).toBe(plate.id);
  });

  it("is refused through a wall, and let through once the wall is a removed part", () => {
    const world = room();
    const behindBase = trigger(at(4, EYE, -1.5), "near");
    const behindPart = trigger(at(-4, EYE, -1.5), "near");
    // Facing each, 1.7 m from its centre, with the wall 0.9 m ahead.
    const toBase = Math.atan2(-0.8, 1.5);
    const toPart = Math.atan2(0.8, 1.5);
    expect(focus(world, thingsOf([behindBase]), anyone, toBase, at(3.2, 0, 0))).toBeNull();
    expect(focus(world, thingsOf([behindPart]), anyone, toPart, at(-3.2, 0, 0))).toBeNull();
    world.presence.set(0, false);
    expect(focus(world, thingsOf([behindPart]), anyone, toPart, at(-3.2, 0, 0))?.id).toBe(behindPart.id);
    expect(focus(world, thingsOf([behindBase]), anyone, toBase, at(3.2, 0, 0))).toBeNull();
  });

  it("wants a look only where the script says so", () => {
    const world = room();
    const buy = trigger(at(0, EYE, -1), "near");
    // Behind them: fine with no look, refused with one.
    expect(focus(world, thingsOf([buy]), anyone, Math.PI)?.id).toBe(buy.id);
    expect(focus(world, thingsOf([buy]), looking, Math.PI)).toBeNull();
    expect(focus(world, thingsOf([buy]), looking, 0)?.id).toBe(buy.id);
    // The cone is about 40° either side: 35° off is in, 45° out.
    expect(focus(world, thingsOf([buy]), looking, (35 * Math.PI) / 180)?.id).toBe(buy.id);
    expect(focus(world, thingsOf([buy]), looking, (45 * Math.PI) / 180)).toBeNull();
  });

  it("hides a thing the script says is not usable now", () => {
    const world = room();
    const door = trigger(at(0, EYE, -1), "near", { tags: ["door"] });
    const shut = (t: UsableThing) => (t.tags.includes("door") ? null : DEFAULT_USE);
    expect(focus(world, thingsOf([door]), shut)).toBeNull();
  });

  it("ranks two by the game's score: the one nearer the crosshair, then the nearer", () => {
    const world = room();
    // A dead ahead 1.5 m: 256(1 − 1) + 59 − 512 = −453. B at 45°, 1.41 m: 75 + 56 − 512 = −381.
    const a = trigger(at(0, EYE, -1.5), "near");
    const b = trigger(at(1, EYE, -1), "near");
    expect(focus(world, thingsOf([b, a]))?.id).toBe(a.id);
    // Turned to face B, it is A that is 45° off.
    expect(focus(world, thingsOf([a, b]), anyone, -Math.PI / 4)?.id).toBe(b.id);
  });

  it("puts a touch at −144: under a near behind the player, over one dead ahead", () => {
    const world = room();
    const pad = trigger(at(0, 1, 0), "touch", { size: at(2, 2, 2) });
    const behind = trigger(at(0, EYE, 1), "near");
    const ahead = trigger(at(0, EYE, -1), "near");
    // Behind: 256(1 − (−1)) + 39 − 512 = +39.
    expect(focus(world, thingsOf([behind, pad]))?.id).toBe(pad.id);
    // Ahead: 0 + 39 − 512 = −473.
    expect(focus(world, thingsOf([pad, ahead]))?.id).toBe(ahead.id);
  });

  it("uses a solid by its bounds, and its own triangles are not in its way", () => {
    const world = room();
    const crate: ResolvedSolid = { id: 7, part: "*2", tags: ["crate"], use: "near" };
    const things = thingsOf([], [{ id: 6, part: "*1", tags: [] }, crate], world.collision);
    expect(things).toHaveLength(1);
    expect(things[0]).toMatchObject({ kind: "solid", index: 1, centre: { x: 8, y: 0.5, z: -1 } });
    // Standing a metre off it and facing it: reached, although the trace to its centre runs through it.
    expect(focus(world, things, anyone, -Math.PI / 2, at(6.8, 0, -1))?.id).toBe(7);
    // Removed, there is nothing to use.
    world.presence.set(1, false);
    expect(focus(world, things, anyone, -Math.PI / 2, at(6.8, 0, -1))).toBeNull();
  });

  it("answers the same from the same inputs, wherever it runs", () => {
    const world = room();
    const things = thingsOf([trigger(at(0, EYE, -1.5), "near"), trigger(at(1, EYE, -1), "near"), trigger(at(0, 1, 0), "touch", { size: at(2, 2, 2) })]);
    for (let yaw = -Math.PI; yaw < Math.PI; yaw += 0.1) {
      expect(focus(world, things, anyone, yaw)).toBe(focus(world, things, anyone, yaw));
    }
  });
});

describe("usableBy", () => {
  const view = {} as GameView;
  const player: PlayerView = { id: "p", bot: false, points: 0 };
  const thing = { kind: "trigger", index: 0, tags: ["door"] } as unknown as UsableThing;

  it("is usable from any angle when no script has an opinion", () => {
    expect(usableBy([{ id: "quiet" }], view, thing, player)).toBe(DEFAULT_USE);
  });

  it("takes the first script with an opinion, null included", () => {
    const scripts: Script[] = [
      { id: "none", usable: () => undefined },
      { id: "shut", usable: () => null },
      { id: "look", usable: () => ({ look: true }) },
    ];
    expect(usableBy(scripts, view, thing, player)).toBeNull();
    expect(usableBy(scripts.slice(2), view, thing, player)).toEqual({ look: true });
  });
});
