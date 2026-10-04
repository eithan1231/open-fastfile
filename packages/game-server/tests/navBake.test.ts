// Baking a real map's navigation graph against its real collision.
//
// The unit tests bake boxes. This bakes the nav.bin an export wrote against the
// clipmap and props the same export wrote, because what a bake costs and what
// it keeps are both properties of the real data: how far MW3's entity nodes sit
// above our floor, how many of the candidate pairs survive a wall, and how long
// the simulation of thousands of links takes. The numbers are pinned so a change
// to movement, collision or the follower that moves them shows in review, and
// docs/engine/navigation.md quotes them.
//
// Skips a world that has not been exported, as the other imported-map tests do.
// Ghosts' and AW's, whose files carry the game's own walk links, are
// navBakeGhosts.test.ts and navBakeAw.test.ts, beside this.

import { describe, expect, it } from "vitest";
import { bake, exported, heavyBake, pinned, report, spawnConnectivity } from "./navBakeWorld.js";

describe.skipIf(!exported("dome-mw3"))("dome-mw3's navigation bake", () => {
  it("snaps, derives, validates and connects its spawns", async () => {
    const { summary, graph, world, collision } = await bake("dome-mw3");
    const spawns = spawnConnectivity(world, graph, collision);
    report("dome-mw3", summary, spawns);
    expect(summary.nodes).toBe(511);
    expect(pinned(summary)).toEqual({
      usable: 508,
      // Two jump-down ends float 3.7 m over nothing our collision has.
      unusable: { INSIDE: 1, NO_GROUND: 2 },
      derived: { pairs: 3471, candidates: 6940, probed: 4147, valid: 4144 },
      valid: 4148,
      reasons: { BLOCKED: 2774, RISE: 8, GAP: 11, TIMEOUT: 1, FELL: 2, NODE: 2 },
      traversals: { JUMP_DOWN: { valid: 1, invalid: 2 }, LADDER_UP: { valid: 2, invalid: 0 }, STEP_UP: { valid: 1, invalid: 0 } },
    });
    expect(spawns.inLargest).toBe(spawns.spawns);
  }, 600_000);
});

describe.skipIf(!heavyBake("mogadishu-mw3"))("mogadishu-mw3's navigation bake", () => {
  it("snaps, derives, validates and connects its spawns", async () => {
    const { summary, graph, world, collision } = await bake("mogadishu-mw3");
    const spawns = spawnConnectivity(world, graph, collision);
    report("mogadishu-mw3", summary, spawns);
    expect(summary.nodes).toBe(1323);
    expect(pinned(summary)).toEqual({
      usable: 1319,
      unusable: { INSIDE: 4 },
      derived: { pairs: 12148, candidates: 24295, probed: 14062, valid: 14023 },
      valid: 14026,
      reasons: { BLOCKED: 9944, GAP: 208, STUCK: 39, RISE: 40, LEVEL: 41 },
      traversals: { STEP_UP: { valid: 1, invalid: 0 }, JUMP_DOWN: { valid: 2, invalid: 0 } },
    });
    expect(spawns.inLargest).toBe(spawns.spawns);
  }, 600_000);
});
