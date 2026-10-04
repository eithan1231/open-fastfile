// The zombies script's pure half: Black Ops' numbers (reverse/t5-zombies/README.md
// § 5), what a door costs and whether it can be bought, and which of a world's
// points a zone wakes. A match playing them is game-server/tests/zombies.test.ts.

import { describe, expect, it } from "vitest";
import type { ResolvedPoint, ResolvedSolid, ResolvedTrigger, ResolvedWorld } from "../../src/dsl/resolved.js";
import type { GameView } from "../../src/game/context.js";
import type { UsableThing } from "../../src/game/focus.js";
import { seeded } from "../../src/game/random.js";
import {
  DEFAULT_DOOR_PRICE,
  gaitFor,
  hordeKind,
  killReward,
  priceOf,
  spawnDelay,
  spawnersOf,
  windowClips,
  zombieHealth,
  zombiesInRound,
  zombiesScript,
  zonesIn,
} from "../../src/game/scripts/zombies.js";
import { indexWorld } from "../../src/worlds/worldIndex.js";

describe("Black Ops' round numbers", () => {
  it("counts a round's zombies by round and players, as round_spawning does", () => {
    // The README's own table: rounds 1, 10 and 20 for one to four players.
    expect([1, 2, 3, 4].map((n) => zombiesInRound(1, n))).toEqual([6, 7, 9, 10]);
    expect([1, 2, 3, 4].map((n) => zombiesInRound(10, n))).toEqual([33, 42, 60, 78]);
    expect([1, 2, 3, 4].map((n) => zombiesInRound(20, n))).toEqual([60, 96, 168, 240]);
    // The early rounds' shares: 0.3, 0.5, 0.7, 0.9 of 27 alone, then all of
    // round 6's 24 + int(3 × 1.2).
    expect([2, 3, 4, 5, 6].map((r) => zombiesInRound(r, 1))).toEqual([8, 13, 18, 24, 27]);
  });

  it("prices a zombie's health: 150, +100 a round to 950, then +10 % a round", () => {
    expect(zombieHealth(1)).toBe(150);
    expect(zombieHealth(9)).toBe(950);
    expect(zombieHealth(10)).toBe(1045);
    expect(zombieHealth(11)).toBe(1149);
    expect(zombieHealth(20)).toBe(2701);
  });

  it("shortens the spawn delay by 5 % a round, to no less than 0.08 s", () => {
    expect(spawnDelay(1)).toBe(2);
    expect(spawnDelay(10)).toBeCloseTo(2 * 0.95 ** 9, 12);
    expect(spawnDelay(10)).toBeCloseTo(1.26, 2);
    expect(spawnDelay(20)).toBeCloseTo(0.75, 2);
    // It goes below the floor once, as the GSC does, and is then held at it.
    const late = spawnDelay(200);
    expect(late).toBe(0.08);
  });

  it("walks round 1, mixes walkers and runners in round 5, and only sprints from round 10", () => {
    const rng = seeded(7);
    const draw = (round: number) => Array.from({ length: 400 }, () => gaitFor(round, rng));
    expect(new Set(draw(1))).toEqual(new Set(["walk"]));
    const five = draw(5);
    // speed 32: a draw in [32, 67), so 4 in 35 walk and the rest run.
    expect(five.filter((g) => g === "walk").length / five.length).toBeCloseTo(4 / 35, 1);
    expect(five).not.toContain("sprint");
    expect(draw(6)).not.toContain("walk");
    expect(new Set(draw(10))).toEqual(new Set(["sprint"]));
  });

  it("pays a kill 50 and a bonus by where the killing hit landed, or 130 for a blow", () => {
    expect(killReward("bullet", "head")).toBe(100);
    expect(killReward("bullet", "helmet")).toBe(100);
    expect(killReward("bullet", "neck")).toBe(70);
    expect(killReward("bullet", "torsoUpper")).toBe(60);
    expect(killReward("bullet", "torsoLower")).toBe(60);
    expect(killReward("bullet", "leftLegUpper")).toBe(50);
    expect(killReward("script", undefined)).toBe(50);
    expect(killReward("melee", "head")).toBe(130);
  });
});

function trigger(over: Partial<ResolvedTrigger>): ResolvedTrigger {
  return { id: 0, tags: [], position: { x: 0, y: 0, z: 0 }, yaw: 0, size: { x: 1, y: 1, z: 1 }, ...over };
}

function point(tags: string[], over: Partial<ResolvedPoint> = {}): ResolvedPoint {
  return { id: 0, tags, position: { x: 0, y: 0, z: 0 }, look: { x: 0, y: 0, z: -1 }, ...over };
}

function door(tags: string[], target: string): UsableThing {
  return { kind: "trigger", index: 0, id: 0, tags, target, use: "near", centre: { x: 0, y: 0, z: 0 }, volume: trigger({}) };
}

/** Two zones, one volume of which carries an extra tag; their spawners of every kind; two windows. */
function world(): ResolvedWorld {
  const triggers = [
    trigger({ tags: ["foyer_zone", "player_volume"], target: "foyer_spawners" }),
    trigger({ tags: ["foyer_zone", "player_volume"], target: "foyer_spawners" }),
    trigger({ tags: ["stage_zone", "player_volume"], target: "stage_spawners" }),
    // Not a zone: a volume that merely overlaps one.
    trigger({ tags: ["ambient_package"] }),
  ];
  const points = [
    point(["foyer_spawners", "zombie_spawner"], { name: "walker" }),
    point(["foyer_spawners", "zombie_spawner", "zombie_chaser"], { name: "chaser" }),
    point(["foyer_spawners", "zombie_spawner", "riser"], { name: "riser" }),
    point(["foyer_spawners", "quad_zombie_spawner", "zombie_chaser"], { name: "quad" }),
    point(["foyer_spawners_dog", "find_flesh"], { name: "dog" }),
    point(["foyer_spawners_rise", "find_flesh"], { name: "rise" }),
    point(["stage_spawners", "zombie_spawner"], { name: "stage" }),
    point(["exterior_goal"], { target: "pf1_auto1" }),
    point(["exterior_goal"], { target: "pf2_auto1" }),
    point(["exterior_goal"], { target: "pf2_auto1" }),
  ];
  const solids: ResolvedSolid[] = [
    { id: 0, part: "*1", tags: ["pf1_auto1", "clip"] },
    { id: 1, part: "*2", tags: ["pf2_auto1", "clip"] },
    // A window whose boards are parts too: only its clip may go, and it cannot alone.
    { id: 2, part: "*3", tags: ["pf2_auto1"] },
    { id: 3, part: "*4", tags: ["backstage_door"] },
  ];
  return { triggers, points, solids, topLevelObjects: [] } as unknown as ResolvedWorld;
}

describe("zones and their spawners", () => {
  const index = indexWorld(world());

  it("finds the zones a player's trigger tags name, and nothing else they stand in", () => {
    expect(zonesIn(index, ["foyer_zone", "player_volume", "ambient_package"])).toEqual(["foyer_zone"]);
    expect(zonesIn(index, ["ambient_package"])).toEqual([]);
  });

  it("wakes the walkers a zone targets, and no riser, dog or quad", () => {
    expect(spawnersOf(index, "foyer_zone").map((p) => p.name)).toEqual(["walker", "chaser"]);
    expect(spawnersOf(index, "stage_zone").map((p) => p.name)).toEqual(["stage"]);
    expect(spawnersOf(index, "nowhere")).toEqual([]);
  });

  it("opens only the windows whose every part is a clip", () => {
    expect(windowClips(index)).toEqual(["pf1_auto1"]);
  });
});

describe("doors", () => {
  it("costs what the map's table says, and the default where it says nothing", () => {
    expect(priceOf(door(["zombie_door"], "backstage_door"), "theater-bo1")).toBe(1250);
    expect(priceOf(door(["zombie_door"], "foyer_top_door"), "theater-bo1")).toBe(750);
    expect(priceOf(door(["zombie_door"], "vip_top_door"), "theater-bo1")).toBe(1000);
    expect(priceOf(door(["zombie_door"], "anything"), "theater-bo1")).toBe(DEFAULT_DOOR_PRICE);
    expect(priceOf(door(["zombie_door"], "backstage_door"), "elsewhere")).toBe(DEFAULT_DOOR_PRICE);
  });

  it("is not for sale where the power opens it, and nothing else is", () => {
    expect(priceOf(door(["zombie_door", "electric_door"], "theater_to_foyer_door"), "theater-bo1")).toBeNull();
    expect(priceOf(door(["weapon_upgrade"], "x"), "theater-bo1")).toBeNull();
  });

  it("is usable from any angle while its part is there, and not once it is gone", () => {
    const index = indexWorld(world());
    const view = (present: boolean) => ({ map: "theater-bo1", world: index, isPresent: () => present }) as unknown as GameView;
    const player = { id: "a", bot: false, points: 0 };
    const buy = door(["zombie_door"], "backstage_door");
    expect(zombiesScript.usable!(view(true), buy, player)).toEqual({ look: false });
    expect(zombiesScript.usable!(view(false), buy, player)).toBeNull();
    // A door whose target no solid carries, and anything that is not a door, is not usable.
    expect(zombiesScript.usable!(view(true), door(["zombie_door"], "no_such_door"), player)).toBeNull();
    expect(zombiesScript.usable!(view(true), door(["weapon_upgrade"], "backstage_door"), player)).toBeNull();
  });

  it("prompts with the price the server charges", () => {
    const ctx = { map: "theater-bo1" } as never;
    expect(zombiesScript.client!.prompt!(ctx, door(["zombie_door"], "backstage_door"))).toBe("Press {key} to open door [Cost: 1250]");
    expect(zombiesScript.client!.prompt!(ctx, door(["zombie_door", "electric_door"], "theater_to_foyer_door"))).toBeNull();
  });
});

describe("what it sounds like", () => {
  /** A client context that records what it was asked to say, as the player `self`. */
  function listening(self: string | undefined) {
    const said: { alias: string; channel?: string }[] = [];
    const ctx = {
      self: self === undefined ? undefined : { id: self },
      say: (alias: string, options?: { channel?: string }) => said.push({ alias, channel: options?.channel }),
    };
    return { ctx: ctx as never, said };
  }

  it("plays a round's start and end to everybody", () => {
    const { ctx, said } = listening("a");
    zombiesScript.client!.event!(ctx, { what: "round", value: 3 });
    zombiesScript.client!.event!(ctx, { what: "roundOver", value: 3 });
    expect(said).toEqual([
      { alias: "mus_zombie_round_start", channel: "voice" },
      { alias: "mus_zombie_round_over", channel: "voice" },
    ]);
  });

  it("plays a purchase or a refusal to the one who pressed, and to nobody else", () => {
    const buyer = listening("a");
    const other = listening("b");
    for (const { ctx } of [buyer, other]) {
      zombiesScript.client!.event!(ctx, { what: "purchase", player: "a", value: 750 });
      zombiesScript.client!.event!(ctx, { what: "deny", player: "a", value: 1000 });
    }
    expect(buyer.said.map((s) => s.alias)).toEqual(["zmb_cha_ching", "zmb_no_cha_ching"]);
    expect(other.said).toEqual([]);
  });

  it("declares every alias it says, and says nothing for another script's words", () => {
    const { ctx, said } = listening("a");
    zombiesScript.client!.event!(ctx, { what: "gameOver", value: 3 });
    zombiesScript.client!.event!(ctx, { what: "toString" });
    expect(said).toEqual([]);
    expect([...zombiesScript.sounds!].sort()).toEqual(["mus_zombie_round_over", "mus_zombie_round_start", "zmb_cha_ching", "zmb_no_cha_ching"]);
  });
});

describe("the horde", () => {
  const view = (game: GameView["game"], gametype = "zombies") => ({ game, gametype: { id: gametype } }) as Pick<GameView, "game" | "gametype">;

  it("is each game's own, Black Ops' where a game has none, and TranZit's in the preview", () => {
    expect(hordeKind(view("t5"))).toBe("zombie");
    expect(hordeKind(view("t6"))).toBe("zombie_transit");
    expect(hordeKind(view(undefined))).toBe("zombie");
    expect(hordeKind(view("t5", "zombies_bo2"))).toBe("zombie_transit");
  });

  // A browser loads creatures for the kinds a script declares, so one it spawns
  // and does not declare is drawn as a capsule.
  it("is declared in the script's actors, every kind of it", () => {
    for (const [game, gametype] of [
      ["t5", "zombies"],
      ["t6", "zombies"],
      ["t5", "zombies_bo2"],
    ] as const) {
      expect(zombiesScript.actors).toContain(hordeKind(view(game, gametype)));
    }
  });
});
