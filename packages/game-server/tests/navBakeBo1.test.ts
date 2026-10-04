// Baking Black Ops worlds' navigation graphs: the game's own compiled links,
// from the map zone's GameWorldMp (GameWorldSp on the zombies maps), walked
// against our collision (navBakeWorld.ts).
//
// What it measures is as navBakeGhosts.test.ts says. Black Ops' bakes are quick
// (sparser graphs: 1.5 s on nuked, 3 s on cairo), so those two run whenever the
// world is exported; theater, a zombies map, is 20 s and runs with NAV_BAKE_ALL.
// Pinned so a change to movement, collision or the follower that moves them
// shows in review; docs/cod/navigation.md quotes them, and says why cairo's
// graph falls apart where the game's is whole.

import { describe, expect, it } from "vitest";
import { bake, exported, GAME_LINK_FLOOR, gameWalkLinks, heavyBake, pinned, report, spawnConnectivity } from "./navBakeWorld.js";

describe.skipIf(!exported("nuked-bo1"))("nuked-bo1's navigation bake", () => {
  it("validates the game's own links and connects its spawns", async () => {
    const { summary, graph, world, collision } = await bake("nuked-bo1");
    const spawns = spawnConnectivity(world, graph, collision);
    report("nuked-bo1", summary, spawns);
    const game = gameWalkLinks(graph);
    expect(summary.nodes).toBe(316);
    expect(game.all).toBe(1506);
    expect(game.valid / game.all).toBeGreaterThan(GAME_LINK_FLOOR);
    expect(game.validBetweenUsable / game.betweenUsable).toBeGreaterThan(GAME_LINK_FLOOR);
    expect(pinned(summary)).toEqual({
      usable: 314,
      unusable: { INSIDE: 2 },
      derived: { pairs: 0, candidates: 0, probed: 0, valid: 0 },
      valid: 1470,
      reasons: { STUCK: 22, NODE: 19, TIMEOUT: 5 },
      traversals: {
        JUMP_DOWN: { valid: 2, invalid: 2 },
        MANTLE_OVER: { valid: 0, invalid: 2 },
        MANTLE_ON: { valid: 4, invalid: 0 },
      },
    });
    // Every spawn that has a node within reach is in the largest component; the
    // rest (5) stand further than 8 m from any node of this sparse graph.
    expect(spawns.inLargest + spawns.noNode).toBe(spawns.spawns);
  }, 120_000);
});

describe.skipIf(!exported("cairo-bo1"))("cairo-bo1's navigation bake", () => {
  it("validates the game's own links, and is cut apart by the wager modes' barriers", async () => {
    const { summary, graph, world, collision } = await bake("cairo-bo1");
    const spawns = spawnConnectivity(world, graph, collision);
    report("cairo-bo1", summary, spawns);
    const game = gameWalkLinks(graph);
    expect(summary.nodes).toBe(655);
    expect(game.all).toBe(3289);
    expect(game.valid / game.all).toBeGreaterThan(GAME_LINK_FLOOR);
    expect(game.validBetweenUsable / game.betweenUsable).toBeGreaterThan(GAME_LINK_FLOOR);
    expect(pinned(summary)).toEqual({
      usable: 653,
      unusable: { INSIDE: 2 },
      derived: { pairs: 0, candidates: 0, probed: 0, valid: 0 },
      valid: 3116,
      reasons: { STUCK: 152, NODE: 26, TIMEOUT: 11 },
      traversals: { MANTLE_OVER: { valid: 4, invalid: 12 } },
    });
    // The game's graph is one strong component; ours is not, because the export
    // collides with script brush models TDM deletes (docs/cod/navigation.md).
    expect(spawns).toEqual({ spawns: 283, inLargest: 60, noNode: 23, largest: 294 });
  }, 120_000);
});

describe.skipIf(!heavyBake("theater-bo1"))("theater-bo1's navigation bake", () => {
  it("validates the game's own links", async () => {
    const { summary, graph, world, collision } = await bake("theater-bo1");
    report("theater-bo1", summary, spawnConnectivity(world, graph, collision));
    const game = gameWalkLinks(graph);
    expect(summary.nodes).toBe(1568);
    expect(game.all).toBe(15924);
    expect(game.valid / game.all).toBeGreaterThan(GAME_LINK_FLOOR);
    expect(game.validBetweenUsable / game.betweenUsable).toBeGreaterThan(GAME_LINK_FLOOR);
    expect(pinned(summary)).toMatchObject({
      // The one node over nothing is VIP's jump down, hanging past its roof's lip: stood on it.
      usable: 1565,
      unusable: { INSIDE: 3 },
      // Judged for a player: an actor goes by the game's verdict on these instead (nav/mover.ts).
      traversals: { JUMP_DOWN: { valid: 12, invalid: 15 }, MANTLE_OVER: { valid: 0, invalid: 27 } },
    });
  }, 600_000);
});
