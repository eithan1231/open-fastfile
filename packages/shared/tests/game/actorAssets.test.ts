// An actor kind's catalogue creature, read (`readActorAssets`), and one actor's
// look drawn from it (`actorLook`): the same body, head and clips on both ends
// from the seed and the id alone, weighted as the game weights them.

import { describe, expect, it } from "vitest";
import {
  actorAssetsFor,
  actorLook,
  gaitRole,
  readActorAssets,
  rootAt,
  type ActorClipSetEntry,
  type ActorEntry,
  type RootKey,
} from "../../src/game/actors/assets.js";
import { catalogueViewOf } from "../../src/game/catalogueView.js";
import { WeaponRegistry } from "../../src/sim/weaponRegistry.js";

const info = (duration: number, speed: number | null, notes: [string, number][] = []) => ({
  duration,
  looped: true,
  notes,
  rootMotion: speed === null ? null : { forward: 0, left: 0, up: 0, yaw: 0, speed },
});

const SET: ActorClipSetEntry = {
  id: "zombie",
  game: "t5",
  actor: true,
  version: 1,
  clips: "animations.glb",
  roles: { idle: ["i"], walk: ["w1", "w2", "w3"], attack: ["a1", "a2"], walkAttack: ["wa"], runAttack: ["ra"], death: ["d1"], windowClimb: ["t"] },
  clipTable: {
    i: info(2, null),
    w1: info(4, 0.9),
    w2: info(3, 1.2),
    w3: info(3, 0.6),
    w8: info(3.5, 0.7),
    a1: info(1, null, [
      ["sndnt#whoosh", 0.1],
      ["fire", 0.3],
      ["fire", 0.7],
    ]),
    a2: info(2, 0.2, [["fire", 0.5]]),
    d1: info(2.5, 0.4),
    t: info(1.5, 0.8),
    wa: info(1.2, 1.2, [["fire", 0.4]]),
    ra: info(0.7, 2.4, [["fire", 0.1]]),
  },
};

const ENTRY: ActorEntry = {
  id: "zombie_ger",
  game: "t5",
  kind: "zombie",
  version: 1,
  bodies: ["b1.glb", "b2.glb"],
  heads: ["h1.glb", "h2.glb", "h3.glb", "h4.glb"],
  bodyWeights: [1, 3],
  animations: "zombie",
  roles: { walk: ["w1", "w8"] },
  hitboxes: "zombie_ger.hitboxes.json",
};

describe("readActorAssets", () => {
  const assets = readActorAssets(ENTRY, SET);

  it("names each file as a catalogue ref", () => {
    expect(assets.bodies.map((b) => b.file)).toEqual(ENTRY.bodies);
    expect(assets.bodies[0]).toEqual({ kind: "actors", game: "t5", id: "zombie_ger", file: "b1.glb" });
    expect(assets.clips).toEqual({ kind: "animations", game: "t5", id: "zombie", file: "animations.glb" });
    expect(assets.hitboxes.file).toBe("zombie_ger.hitboxes.json");
  });

  it("takes the map's roles over the set's, `death` as `die`, and each clip's speed and blows", () => {
    expect(assets.roles.walk?.map((c) => c.name)).toEqual(["w1", "w8"]);
    expect(assets.roles.die?.map((c) => c.name)).toEqual(["d1"]);
    expect(assets.roles.run).toBeUndefined();
    // The window climb is the engine's `climb`.
    expect(assets.roles.climb).toEqual([{ name: "t", duration: 1.5, speed: 0.8, hits: [] }]);
    expect(assets.roles.climbRun).toBeUndefined();
    expect(assets.roles.attack).toEqual([
      { name: "a1", duration: 1, speed: 0, hits: [0.3, 0.7] },
      { name: "a2", duration: 2, speed: 0.2, hits: [0.5] },
    ]);
  });

  it("refuses a role naming a clip the set does not hold", () => {
    expect(() => readActorAssets({ ...ENTRY, roles: { walk: ["nope"] } }, SET)).toThrow(/nope/);
  });

  it("is found through the catalogue, and is undefined where the catalogue has no such creature", () => {
    const catalogue = catalogueViewOf({ version: 1, actors: [ENTRY], animations: [{ ...SET, animType: "zombie" }] }, new WeaponRegistry([]));
    expect(actorAssetsFor({ game: "t5", id: "zombie_ger" }, catalogue)?.entry).toBe(ENTRY);
    expect(actorAssetsFor({ game: "t5", id: "zombie_dog" }, catalogue)).toBeUndefined();
    const noClips = catalogueViewOf({ version: 1, actors: [ENTRY] }, new WeaponRegistry([]));
    expect(() => actorAssetsFor({ game: "t5", id: "zombie_ger" }, noClips)).toThrow(/clip set/);
  });
});

describe("actorLook", () => {
  const assets = readActorAssets(ENTRY, SET);

  it("is the same for the same seed and id, and not for another id", () => {
    expect(actorLook(assets, 7, 12, "walk")).toEqual(actorLook(assets, 7, 12, "walk"));
    const looks = Array.from({ length: 50 }, (_, i) => JSON.stringify(actorLook(assets, 7, i + 1, "walk")));
    expect(new Set(looks).size).toBeGreaterThan(10);
  });

  it("wears each body as often as its weight says, and every head and variant", () => {
    const counts = [0, 0];
    const heads = new Set<number | undefined>();
    const walks = new Set<string>();
    const n = 4000;
    for (let id = 1; id <= n; id++) {
      const look = actorLook(assets, 1234, id, "walk");
      counts[look.body]!++;
      heads.add(look.head);
      walks.add(look.clips.walk!.name);
    }
    expect(counts[1]! / n).toBeCloseTo(0.75, 1);
    expect([...heads].sort()).toEqual([0, 1, 2, 3]);
    expect([...walks].sort()).toEqual(["w1", "w8"]);
  });

  // Ids count up by one, and an unmixed seed draws neighbours alike (0.68 here, not 0.625).
  it("draws neighbouring ids independently", () => {
    for (const seed of [7, 99, 1234]) {
      const bodies = Array.from({ length: 4000 }, (_, i) => actorLook(assets, seed, i + 1, "walk").body);
      const same = bodies.slice(1).filter((body, i) => body === bodies[i]).length / (bodies.length - 1);
      expect(Math.abs(same - (0.75 ** 2 + 0.25 ** 2))).toBeLessThan(0.03);
    }
  });

  // `pick_zombie_melee_anim`: the standing swings, plus the walker's or the runner's own.
  it("swings among `attack` and its gait's own swings", () => {
    const names = (clips: readonly { name: string }[]) => clips.map((c) => c.name);
    expect(names(assets.swings.walk)).toEqual(["a1", "a2", "wa"]);
    expect(names(assets.swings.run)).toEqual(["a1", "a2", "ra"]);
    expect(names(assets.swings.sprint)).toEqual(["a1", "a2", "ra"]);
    const drawn = (gait: "walk" | "sprint") => new Set(Array.from({ length: 200 }, (_, i) => actorLook(assets, 5, i + 1, gait).clips.attack!.name));
    expect([...drawn("walk")].sort()).toEqual(["a1", "a2", "wa"]);
    expect([...drawn("sprint")].sort()).toEqual(["a1", "a2", "ra"]);
    // The gait changes the swing and nothing else.
    const { clips: walker, ...rest } = actorLook(assets, 5, 3, "walk");
    const { clips: sprinter, ...same } = actorLook(assets, 5, 3, "sprint");
    expect(same).toEqual(rest);
    expect({ ...sprinter, attack: undefined }).toEqual({ ...walker, attack: undefined });
  });

  it("has no head where the entry has none", () => {
    expect(actorLook(readActorAssets({ ...ENTRY, heads: undefined }, SET), 1, 1, "walk").head).toBeUndefined();
  });
});

describe("traversals", () => {
  const jump = (drop: number): RootKey[] => [
    [0, 0, 0, 0],
    [0.5, 1, 0, -0.1 * drop],
    [1, 1.4, 0, -drop],
  ];
  const withJumps: ActorClipSetEntry = {
    ...SET,
    traversals: { zombie_jump_down_190: "j190", zombie_jump_down_40: "j40", zombie_jump_down_72: "flat" },
    clipTable: { ...SET.clipTable, j190: { ...info(1.3, 1), rootPath: jump(4.8) }, j40: { ...info(1, 1), rootPath: jump(1) }, flat: info(1, 1) },
  };
  const assets = readActorAssets(ENTRY, withJumps);

  it("are read in animscript order; one with no path is left out", () => {
    expect(assets.traversals.map((t) => [t.animscript, t.name])).toEqual([
      ["zombie_jump_down_190", "j190"],
      ["zombie_jump_down_40", "j40"],
    ]);
    // Every actor wearing the set has the same list, whatever its seed.
    expect(actorLook(assets, 1, 1, "walk").traversals).toBe(assets.traversals);
    expect(readActorAssets(ENTRY, SET).traversals).toEqual([]);
  });

  it("refuse one naming a clip the set does not hold", () => {
    expect(() => readActorAssets(ENTRY, { ...SET, traversals: { zombie_jump_down_40: "nope" } })).toThrow(/nope/);
  });

  it("sample their path between keys, and hold at its ends", () => {
    const path = jump(2);
    expect(rootAt(path, 0.25)).toEqual({ forward: 0.5, up: -0.1 });
    expect(rootAt(path, 0.75).up).toBeCloseTo(-1.1, 9);
    expect(rootAt(path, -1)).toEqual({ forward: 0, up: 0 });
    expect(rootAt(path, 9)).toEqual({ forward: 1.4, up: -2 });
  });
});

describe("gaitRole", () => {
  it("falls back to the nearest gait the set has", () => {
    const has = (roles: string[]) => (role: string) => roles.includes(role);
    expect(gaitRole("sprint", has(["walk", "run", "sprint"]))).toBe("sprint");
    expect(gaitRole("sprint", has(["walk", "run"]))).toBe("run");
    expect(gaitRole("run", has(["walk", "sprint"]))).toBe("sprint");
    expect(gaitRole("walk", has(["run"]))).toBe("run");
    expect(gaitRole("walk", has(["idle"]))).toBeUndefined();
  });
});
