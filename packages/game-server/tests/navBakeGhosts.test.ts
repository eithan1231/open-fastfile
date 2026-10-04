// Baking prisonbreak-ghosts' navigation graph: Ghosts' own compiled links, from
// its `<map>_path.ff`, walked against our collision (navBakeWorld.ts).
//
// Where MW3's walk links are derived at load, these are the game's, so the bake
// validates each by simulation and derives nothing. What it measures is how much
// of the game's graph our player can walk — and, through the guard below, that
// the follower is not the reason when it cannot. Pinned so a change to movement,
// collision or the follower that moves them shows in review; docs/cod/navigation.md
// quotes them.

import { describe, expect, it } from "vitest";
import { bake, GAME_LINK_FLOOR, gameWalkLinks, heavyBake, pinned, report, spawnConnectivity } from "./navBakeWorld.js";

describe.skipIf(!heavyBake("prisonbreak-ghosts"))("prisonbreak-ghosts' navigation bake", () => {
  it("validates the game's own links", async () => {
    const { summary, graph, world, collision } = await bake("prisonbreak-ghosts");
    report("prisonbreak-ghosts", summary, spawnConnectivity(world, graph, collision));
    const game = gameWalkLinks(graph);
    expect(summary.nodes).toBe(1392);
    expect(game.all).toBe(13589);
    expect(game.valid / game.all).toBeGreaterThan(GAME_LINK_FLOOR);
    expect(game.validBetweenUsable / game.betweenUsable).toBeGreaterThan(GAME_LINK_FLOOR);
    expect(pinned(summary)).toEqual({
      usable: 1368,
      // 21 nodes float over nothing our collision has; 3 are inside it.
      unusable: { INSIDE: 3, NO_GROUND: 21 },
      derived: { pairs: 0, candidates: 0, probed: 0, valid: 0 },
      valid: 13373,
      reasons: { STUCK: 87, NODE: 276, TIMEOUT: 15, FELL: 3 },
      traversals: {
        JUMP_DOWN: { valid: 80, invalid: 5 },
        MANTLE_OVER: { valid: 7, invalid: 4 },
        JUMP_UP: { valid: 25, invalid: 21 },
        JUMP_ACROSS: { valid: 6, invalid: 2 },
        STEP_UP: { valid: 10, invalid: 1 },
        LADDER_UP: { valid: 4, invalid: 0 },
      },
    });
    // Ghosts' MP spawns are not in its entity lump (docs/cod/games.md), so the world
    // has only its placeholder spawn and there is no spawn connectivity to check.
    expect(world.spawnPoints.length).toBe(1);
  }, 600_000);
});
