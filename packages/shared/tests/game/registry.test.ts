// The tables: which gametypes exist, which scripts a game runs, and what a
// gametype will run on.
//
// A table rather than anything loaded, which is the point — `NODE_TYPES` and
// `API_ROUTES` are the same shape, and a game server reads nothing off disk.

import { describe, expect, it } from "vitest";
import { admits, DEFAULT_GAMETYPE, GAMETYPES, gametype, SCRIPTS, scriptsFor } from "../../src/game/registry.js";
import type { GametypeDecl } from "../../src/game/gametypes/declaration.js";

const decl = (over: Partial<GametypeDecl> = {}): GametypeDecl => ({
  id: "t",
  display: "T",
  teams: [],
  ...over,
});

describe("GAMETYPES", () => {
  it("holds the default, which is the one a world is played with today", () => {
    expect(gametype(DEFAULT_GAMETYPE)?.id).toBe(DEFAULT_GAMETYPE);
    // No `spawnMode`, so `spawnPoints` widens to the `{ start: true }`
    // `Match.spawnFor` already asks — this changes no behaviour.
    expect(gametype(DEFAULT_GAMETYPE)?.spawnMode).toBeUndefined();
  });

  it("names the sides the maps name, so nothing has to be translated", () => {
    expect(gametype(DEFAULT_GAMETYPE)?.teams).toEqual(["allies", "axis"]);
  });

  it("holds chase, which only MW3 has the navigation for", () => {
    const chase = gametype("chase")!;
    expect(chase.teams).toEqual(["survivors", "horde"]);
    expect(admits(chase, "dome-mw3", "iw5")).toBe(true);
    expect(admits(chase, "rust-mw2", "iw4")).toBe(false);
  });

  it("answers undefined for a name nobody declared", () => {
    expect(gametype("headquarters")).toBeUndefined();
    // Not a way to reach Object.prototype.
    expect(gametype("toString")).toBeUndefined();
    expect(gametype("__proto__")).toBeUndefined();
  });

  it("keys every entry by its own id", () => {
    for (const [id, entry] of Object.entries(GAMETYPES)) {
      expect(entry.id).toBe(id);
    }
  });
});

describe("admits", () => {
  it("lets an unrestricted gametype run anywhere", () => {
    expect(admits(decl(), "dome-mw3", "iw5")).toBe(true);
    expect(admits(decl(), "handmade", undefined)).toBe(true);
  });

  it("refuses a map the gametype does not list", () => {
    const d = decl({ maps: ["rust-mw2"] });
    expect(admits(d, "rust-mw2", "iw4")).toBe(true);
    expect(admits(d, "dome-mw3", "iw5")).toBe(false);
  });

  it("refuses a game the gametype does not list", () => {
    const d = decl({ games: ["iw5"] });
    expect(admits(d, "dome-mw3", "iw5")).toBe(true);
    expect(admits(d, "rust-mw2", "iw4")).toBe(false);
    // A world with no `game:` cannot satisfy a game restriction.
    expect(admits(d, "handmade", undefined)).toBe(false);
  });

  // An empty restriction is "no restriction", not "nothing" — the answer a
  // declaration that does not care should give.
  it("treats an empty list as no restriction", () => {
    expect(admits(decl({ maps: [], games: [] }), "anything", undefined)).toBe(true);
  });
});

describe("scriptsFor", () => {
  // Neither ships a restriction: what a player wears and a match beginning are
  // not one mode's questions.
  it("runs the unrestricted scripts on every gametype and map", () => {
    expect(scriptsFor(DEFAULT_GAMETYPE, "dome-mw3").map((s) => s.id)).toEqual(["cast", "countdown"]);
    expect(scriptsFor("anything", "handmade").map((s) => s.id)).toEqual(["cast", "countdown"]);
  });

  it("keeps SCRIPTS order, which is the order two scripts talk in", () => {
    const order = SCRIPTS.map((s) => s.id);
    expect(scriptsFor("chase", "dome-mw3").map((s) => s.id)).toEqual(order.filter((id) => id !== "zombies"));
    expect(scriptsFor("zombies", "theater-bo1").map((s) => s.id)).toEqual(order.filter((id) => id !== "chase"));
    // A gametype's own script goes first, so its `playerSpawn` is asked before `cast`'s.
    expect(order.indexOf("chase")).toBeLessThan(order.indexOf("cast"));
    expect(order.indexOf("zombies")).toBeLessThan(order.indexOf("cast"));
  });

  it("runs a gametype's own script only in that gametype", () => {
    expect(scriptsFor(DEFAULT_GAMETYPE, "dome-mw3").map((s) => s.id)).not.toContain("chase");
    expect(scriptsFor("chase", "dome-mw3").map((s) => s.id)).toContain("chase");
  });

  it("gives every script a unique id, since one addresses another by it", () => {
    expect(new Set(SCRIPTS.map((s) => s.id)).size).toBe(SCRIPTS.length);
  });

  it("only implements the hooks this stage built", () => {
    const cast = SCRIPTS.find((s) => s.id === "cast")!;
    expect(Object.keys(cast.client ?? {})).toEqual(["cast"]);
    expect(Object.keys(cast.server ?? {})).toEqual(["playerSpawn"]);
  });
});
