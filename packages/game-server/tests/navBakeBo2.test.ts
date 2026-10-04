// Baking Black Ops II worlds' navigation graphs: the game's own compiled links,
// from the map zone's GameWorldMp, less the redundant ones its search never
// takes, walked against our collision (navBakeWorld.ts).
//
// la (no redundant links) and carrier (58% of its links redundant, left out)
// are pinned and run whenever the world is exported: 4–5 s each. The other
// thirteen run with NAV_BAKE_ALL and hold only the guards, since
// docs/cod/navigation.md quotes their numbers rather than a test pinning them.

import { describe, expect, it } from "vitest";
import { bake, exported, GAME_LINK_FLOOR, gameWalkLinks, heavyBake, pinned, report, spawnConnectivity } from "./navBakeWorld.js";

describe.skipIf(!exported("la-bo2"))("la-bo2's navigation bake", () => {
  it("validates the game's own links and connects its spawns", async () => {
    const { summary, graph, world, collision } = await bake("la-bo2");
    const spawns = spawnConnectivity(world, graph, collision);
    report("la-bo2", summary, spawns);
    const game = gameWalkLinks(graph);
    expect(summary.nodes).toBe(1034);
    expect(game.all).toBe(2526);
    expect(game.valid / game.all).toBeGreaterThan(GAME_LINK_FLOOR);
    expect(game.validBetweenUsable / game.betweenUsable).toBeGreaterThan(GAME_LINK_FLOOR);
    expect(pinned(summary)).toEqual({
      usable: 993,
      unusable: { NO_GROUND: 40, INSIDE: 1 },
      derived: { pairs: 0, candidates: 0, probed: 0, valid: 0 },
      valid: 2407,
      reasons: { NODE: 109, STUCK: 20, TIMEOUT: 9 },
      traversals: {
        // mantle_over_40: an AI's vault over a 40-inch wall, where our player has no mantle.
        MANTLE_OVER: { valid: 0, invalid: 8 },
        JUMP_DOWN: { valid: 4, invalid: 0 },
        MANTLE_ON: { valid: 3, invalid: 3 },
        LADDER_UP: { valid: 0, invalid: 1 },
      },
    });
    expect(spawns).toEqual({ spawns: 285, inLargest: 282, noNode: 1, largest: 946 });
  }, 120_000);
});

describe.skipIf(!exported("carrier-bo2"))("carrier-bo2's navigation bake", () => {
  it("holds together without the redundant links the game's search never takes", async () => {
    const { summary, graph, world, collision } = await bake("carrier-bo2");
    const spawns = spawnConnectivity(world, graph, collision);
    report("carrier-bo2", summary, spawns);
    const game = gameWalkLinks(graph);
    expect(summary.nodes).toBe(734);
    // 4,533 in the zone, 2,629 of them flagged redundant (0x10) and left out.
    expect(game.all).toBe(1904);
    expect(game.valid / game.all).toBeGreaterThan(GAME_LINK_FLOOR);
    expect(pinned(summary)).toEqual({
      usable: 698,
      unusable: { NO_GROUND: 32, INSIDE: 4 },
      derived: { pairs: 0, candidates: 0, probed: 0, valid: 0 },
      valid: 1780,
      reasons: { NODE: 115, TIMEOUT: 11, STUCK: 20 },
      traversals: {
        MANTLE_OVER: { valid: 0, invalid: 11 },
        JUMP_DOWN: { valid: 8, invalid: 2 },
        LADDER_UP: { valid: 1, invalid: 0 },
      },
    });
    expect(spawns).toEqual({ spawns: 290, inLargest: 281, noNode: 8, largest: 652 });
  }, 120_000);
});

const REST = ["dockside", "drone", "express", "hijacked", "meltdown", "nightclub", "nuketown", "overflow", "raid", "slums", "socotra", "turbine", "village"];

describe.each(REST.map((m) => `${m}-bo2`).filter((slug) => heavyBake(slug)))("%s's navigation bake", (slug) => {
  it("validates the game's own links", async () => {
    const { summary, graph, world, collision } = await bake(slug);
    report(slug, summary, spawnConnectivity(world, graph, collision));
    const game = gameWalkLinks(graph);
    expect(game.valid / game.all).toBeGreaterThan(GAME_LINK_FLOOR);
    expect(game.validBetweenUsable / game.betweenUsable).toBeGreaterThan(GAME_LINK_FLOOR);
  }, 300_000);
});
