// What an actor sounds like: the roles two snapshots of it mean (`actorSoundsBetween`),
// its own noise between them, and — where the catalogue is built — that every kind's
// roles name aliases its own game's bank holds.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ActorState } from "../../src/game/actors/actor.js";
import { ACTOR_KINDS, TRANSIT_ZOMBIE_KIND, ZOMBIE_KIND } from "../../src/game/actors/kinds.js";
import { actorSoundsBetween, VOCAL_GAP, vocalGap, vocalRole } from "../../src/game/actors/sounds.js";

function state(over: Partial<ActorState> = {}): ActorState {
  return {
    id: 7,
    kind: 0,
    feet: { x: 0, y: 0, z: 0 },
    yaw: 0,
    speed: 1,
    gait: "walk",
    action: "move",
    phase: 0.2,
    traversal: 0,
    ...over,
  };
}

describe("an actor's sounds, from its snapshots", () => {
  it("sounds a spawn only when the caller says it arrived, and not for one already dead", () => {
    expect(actorSoundsBetween(undefined, state(), true)).toEqual(["spawn"]);
    expect(actorSoundsBetween(undefined, state())).toEqual([]);
    expect(actorSoundsBetween(undefined, state({ action: "die" }), true)).toEqual([]);
  });

  it("voices and swings as an attack begins, and again when a second swing starts over", () => {
    expect(actorSoundsBetween(state(), state({ action: "attack", phase: 0 }))).toEqual(["attack", "swing"]);
    expect(actorSoundsBetween(state({ action: "attack", phase: 0.3 }), state({ action: "attack", phase: 0.6 }))).toEqual([]);
    expect(actorSoundsBetween(state({ action: "attack", phase: 0.9 }), state({ action: "attack", phase: 0.05 }))).toEqual(["attack", "swing"]);
  });

  it("dies once, as it starts to fall", () => {
    const falling = state({ action: "die", phase: 0.1 });
    expect(actorSoundsBetween(state(), falling)).toEqual(["death"]);
    expect(actorSoundsBetween(falling, { ...falling, phase: 0.5 })).toEqual([]);
  });

  it("moans as a walker, screams as a runner or sprinter, and is quiet dead", () => {
    expect(vocalRole(state())).toBe("ambient");
    expect(vocalRole(state({ gait: "run" }))).toBe("sprint");
    expect(vocalRole(state({ gait: "sprint" }))).toBe("sprint");
    expect(vocalRole(state({ action: "die" }))).toBeUndefined();
  });

  it("spaces one actor's noises inside the gap, differently per actor and per noise, the same every time", () => {
    const gaps = Array.from({ length: 40 }, (_, id) => vocalGap(id + 1, 0));
    for (const gap of gaps) {
      expect(gap).toBeGreaterThanOrEqual(VOCAL_GAP[0]);
      expect(gap).toBeLessThan(VOCAL_GAP[1]);
    }
    expect(new Set(gaps.map((g) => g.toFixed(3))).size).toBeGreaterThan(30);
    expect(vocalGap(3, 2)).toBe(vocalGap(3, 2));
    expect(vocalGap(3, 2)).not.toBe(vocalGap(3, 3));
  });
});

describe("the zombie kinds' sounds", () => {
  it("are each game's own: Kino's in Black Ops' bank, TranZit's in Black Ops II's", () => {
    expect(ZOMBIE_KIND.sounds?.game).toBe("t5");
    expect(TRANSIT_ZOMBIE_KIND.sounds?.game).toBe("t6");
    expect(TRANSIT_ZOMBIE_KIND.body).toEqual({ game: "t6", id: "zm_transit_basic" });
  });

  // `pnpm catalog` refuses the same thing; this says so in the test run too.
  const root = path.resolve(import.meta.dirname, "../../../../worlds/catalog/sounds");
  for (const kind of ACTOR_KINDS) {
    const sounds = kind.sounds;
    const bank = sounds && path.join(root, sounds.game, "mp", "sounds.json");
    it.runIf(bank !== undefined && fs.existsSync(bank))(`${kind.id}: every role names an alias its own game's bank holds`, () => {
      const held = new Set(Object.keys((JSON.parse(fs.readFileSync(bank!, "utf8")) as { aliases: Record<string, unknown> }).aliases));
      const roles = Object.entries(sounds!.aliases);
      expect(roles.length).toBeGreaterThan(0);
      expect(roles.filter(([, alias]) => !held.has(alias))).toEqual([]);
    });
  }
});
