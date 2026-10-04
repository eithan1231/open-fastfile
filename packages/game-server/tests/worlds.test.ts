// Loading a map on demand, and letting go of it.
//
// The load itself is apiIntegration.test.ts's and collision.test.ts's job — real
// world text over the real routes. What this file is about is the bookkeeping
// around it: that one map loads once however many games want it, that the last
// game out unloads it, and that a map which would not load leaves nothing
// behind.
//
// The api is faked here precisely because the load is not what is under test: a
// counted `world()` is what lets a test see that two acquires cost one load.

import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import type { Api } from "../src/api.js";
import { WorldRegistry } from "../src/worlds.js";
import { NavBaker } from "../src/nav.js";

/** A world source that resolves nothing real, counting what was asked for. */
function fakeApi() {
  const loads: string[] = [];
  const api = {
    worlds: {
      world: (map: string) => {
        loads.push(map);
        return { describe: map, map } as never;
      },
    },
  } as unknown as Api;
  return { api, loads };
}

/**
 * `loadResolvedWorld` and `buildServerCollision` are the two things the registry
 * calls out to, and both want real files. Mocked at the module boundary so this
 * file can be about the refcount.
 */
vi.mock("@3d/shared/worlds/load.js", () => ({
  loadResolvedWorld: vi.fn(async (source: { map: string }) => {
    if (source.map === "broken") {
      return { error: "404", diagnostics: [], sources: [] };
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
    return {
      error: undefined,
      diagnostics: [],
      sources: [],
      world: { name: "", rooms: [], topLevelObjects: [], lights: [], triggers: [], mantles: [], ladders: [], effects: [], sounds: [], points: [], solids: [] },
    };
  }),
}));

vi.mock("../src/collision.js", () => ({
  // A mesh for every map but `uncollidable`, which is how a world with none is
  // exercised: the registry refuses it outright now, so the fake has to be able
  // to produce both answers.
  buildServerCollision: vi.fn(async (world: { map?: string }, source: { map: string }) => {
    void world;
    if (source.map === "uncollidable") {
      return undefined;
    }
    return {
      world: { ready: true },
      triangles: 1234,
      props: { assets: 0, placements: 0, missing: 0 },
    };
  }),
}));

describe("the worlds an instance is holding", () => {
  it("loads a map once however many games ask for it", async () => {
    const { api, loads } = fakeApi();
    const registry = new WorldRegistry(api, new NavBaker());

    const [a, b] = await Promise.all([registry.acquire("rust-mw2"), registry.acquire("rust-mw2")]);

    // Same world object, and one load: two orders in one `hello` must not both
    // parse the map and build a BVH, throwing one of the two away.
    expect(a).toBe(b);
    expect(loads).toEqual(["rust-mw2"]);
    expect(registry.loaded).toEqual(["rust-mw2"]);
  });

  it("unloads a map when the last game on it lets go, and not before", async () => {
    const { api } = fakeApi();
    const registry = new WorldRegistry(api, new NavBaker());

    await registry.acquire("rust-mw2");
    await registry.acquire("rust-mw2");

    registry.release("rust-mw2");
    expect(registry.loaded).toEqual(["rust-mw2"]);

    registry.release("rust-mw2");
    expect(registry.loaded).toEqual([]);
  });

  it("loads it again after it was unloaded, rather than serving a dropped one", async () => {
    const { api, loads } = fakeApi();
    const registry = new WorldRegistry(api, new NavBaker());

    await registry.acquire("rust-mw2");
    registry.release("rust-mw2");
    await registry.acquire("rust-mw2");

    expect(loads).toEqual(["rust-mw2", "rust-mw2"]);
  });

  it("holds several maps at once", async () => {
    const { api } = fakeApi();
    const registry = new WorldRegistry(api, new NavBaker());

    await registry.acquire("rust-mw2");
    await registry.acquire("dome-mw3");

    expect(new Set(registry.loaded)).toEqual(new Set(["rust-mw2", "dome-mw3"]));
  });

  it("keeps nothing for a map that would not load, so the next order retries it", async () => {
    const { api, loads } = fakeApi();
    const registry = new WorldRegistry(api, new NavBaker());

    await expect(registry.acquire("broken")).rejects.toThrow(/404/);
    expect(registry.loaded).toEqual([]);

    // A retry is a real second attempt, not a replay of the same rejection.
    await expect(registry.acquire("broken")).rejects.toThrow(/404/);
    expect(loads).toEqual(["broken", "broken"]);
  });
});

describe("a world this process cannot check", () => {
  it("is refused at load rather than hosted", async () => {
    const { api } = fakeApi();
    const registry = new WorldRegistry(api, new NavBaker());

    // This used to load, hand out a `NoCollisionWorld` and warn: nothing stopped a
    // capsule, so a simulated player fell forever and the drift figures meant
    // nothing. That was a fair trade while the server only *measured* — a loud
    // useless number beats a quiet wrong one. It stopped being fair when the
    // server started correcting: a correction computed against no geometry puts a
    // player under the map and keeps them there, so a world with no mesh is one
    // this process cannot host rather than one it hosts badly.
    await expect(registry.acquire("uncollidable")).rejects.toThrow(/no server collision mesh/);

    // And nothing is left holding it, so a later order retries the load instead of
    // being served a world that was never stood up.
    expect(registry.loaded).toEqual([]);
  });
});
