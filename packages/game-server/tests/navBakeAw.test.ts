// Baking prison-aw's navigation graph: AW's own compiled links, from its
// `<map>_path.ff`, walked against our collision (navBakeWorld.ts).
//
// The densest graph imported (46,000 links), so the slowest bake: it has a file
// of its own so that vitest runs it beside the others. What it measures is as
// navBakeGhosts.test.ts says; AW adds exo `boost_*` traversals, SPECIAL moves our
// player has none for. Pinned so a change to movement, collision or the follower
// that moves them shows in review; docs/cod/navigation.md quotes them.

import { describe, expect, it } from "vitest";
import { bake, GAME_LINK_FLOOR, gameWalkLinks, heavyBake, pinned, report, spawnConnectivity } from "./navBakeWorld.js";

describe.skipIf(!heavyBake("prison-aw"))("prison-aw's navigation bake", () => {
  it("validates the game's own links and connects its spawns", async () => {
    const { summary, graph, world, collision } = await bake("prison-aw");
    const spawns = spawnConnectivity(world, graph, collision);
    report("prison-aw", summary, spawns);
    const game = gameWalkLinks(graph);
    expect(summary.nodes).toBe(2726);
    expect(game.all).toBe(45341);
    expect(game.valid / game.all).toBeGreaterThan(GAME_LINK_FLOOR);
    expect(game.validBetweenUsable / game.betweenUsable).toBeGreaterThan(GAME_LINK_FLOOR);
    expect(pinned(summary)).toEqual({
      usable: 2690,
      unusable: { NO_GROUND: 34, INSIDE: 2 },
      derived: { pairs: 0, candidates: 0, probed: 0, valid: 0 },
      valid: 44307,
      // NO_MOVE is the 179 exo traversals: SPECIAL, which no follower move matches.
      reasons: { STUCK: 239, NODE: 601, NO_MOVE: 179, FELL: 322, TIMEOUT: 38 },
      traversals: {
        JUMP_UP: { valid: 13, invalid: 43 },
        MANTLE_OVER: { valid: 26, invalid: 4 },
        JUMP_DOWN: { valid: 72, invalid: 6 },
        SPECIAL: { valid: 0, invalid: 179 },
        LADDER_UP: { valid: 2, invalid: 0 },
      },
    });
    expect(spawns.inLargest).toBe(spawns.spawns);
  }, 900_000);
});
