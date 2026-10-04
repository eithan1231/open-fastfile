// A player's classes: the five they always have, and what a stored one means
// now.
//
// The reconciliation is the part worth guarding, because everything it protects
// against is silent. A class is written once and read back across re-imports and
// catalogue rebuilds, and the failure modes are a weapon that no longer exists
// (a player spawns holding nothing, or worse, holding whatever took its index)
// and an attachment its weapon no longer offers. Both must read as *gone*, never
// as something else.

import { describe, expect, it } from "vitest";
import { LOADOUT_COUNT, type Loadout } from "@3d/shared/sim/loadout.js";
import type { WeaponEntry } from "@3d/shared/sim/weaponRegistry.js";
import { WeaponRegistry } from "@3d/shared/sim/weaponRegistry.js";
import { Catalog } from "../src/catalog.js";
import { Clock } from "../src/clock.js";
import { Sqlite } from "../src/db/database.js";
import { loadouts as loadoutRows } from "../src/db/schema.js";
import { Loadouts } from "../src/loadouts.js";
import { testApp } from "../testing/app.js";

/** A catalogue holding one rifle that takes an ACOG, and one pistol that takes nothing. */
function catalogue(entries: WeaponEntry[] = CATALOGUED): Catalog {
  return { registry: () => Promise.resolve(new WeaponRegistry(entries)) } as unknown as Catalog;
}

const def = (weapon: string) =>
  ({
    game: "iw5",
    weapon,
    gun: weapon,
    roles: {},
    clips: {},
    times: {},
    clipSize: 30,
    fireType: "Full Auto",
    boltAction: false,
    roundsPerLoad: 0,
    adsZoomFov: 50,
    adsOverlay: null,
    motion: {},
    hideBones: [],
  }) as WeaponEntry["def"];

const CATALOGUED: WeaponEntry[] = [
  { id: "m4", game: "iw5", slot: "primary", class: "rifle", def: def("m4"), attachments: [{ id: "acog", type: "scope" }] },
  { id: "usp", game: "iw5", slot: "secondary", class: "pistol", def: def("usp"), attachments: [] },
];

/**
 * Built by hand rather than resolved, so the catalogue can be a stub: `Loadouts`
 * is a root singleton and a child container's override would not reach the
 * dependency the root already holds. The container wiring has its own guard
 * (tests/container.test.ts).
 */
function serviceWith(app: ReturnType<typeof testApp>, entries?: WeaponEntry[]): Loadouts {
  return new Loadouts(app.container.resolve(Sqlite), app.container.resolve(Clock), catalogue(entries));
}

function serviceFor(entries?: WeaponEntry[]) {
  const app = testApp();
  return { loadouts: serviceWith(app, entries), users: app.users };
}

const assault: Loadout = {
  name: "Assault",
  game: "iw5",
  primary: { weapon: "iw5/m4", attachments: ["acog"] },
  secondary: { weapon: "iw5/usp", attachments: [] },
};

describe("a player's classes", () => {
  it("gives every player five, whether or not they have ever saved one", async () => {
    const { loadouts, users } = serviceFor();
    const player = await users.create("nobody", "hunter2hunter2");
    const classes = await loadouts.forUser(player.id);
    expect(classes).toHaveLength(LOADOUT_COUNT);
    expect(classes.map((c) => c.name)).toEqual(["Class 1", "Class 2", "Class 3", "Class 4", "Class 5"]);
    expect(classes[0]!.primary.weapon).toBeNull();
  });

  it("saves one and leaves the others alone", async () => {
    const { loadouts, users } = serviceFor();
    const player = await users.create("saver", "hunter2hunter2");
    await loadouts.save(player.id, 2, assault);

    const classes = await loadouts.forUser(player.id);
    expect(classes[2]).toEqual(assault);
    expect(classes[1]!.name).toBe("Class 2");
  });

  it("overwrites rather than adding a second row for the same class", async () => {
    const { loadouts, users } = serviceFor();
    const player = await users.create("editor", "hunter2hunter2");
    await loadouts.save(player.id, 0, assault);
    await loadouts.save(player.id, 0, { ...assault, name: "Silenced" });
    expect((await loadouts.forUser(player.id))[0]!.name).toBe("Silenced");
  });

  /** The answer to a save is what will read back, so the menu shows the truth without a second call. */
  it("answers a save with the class as it will read back", async () => {
    const { loadouts, users } = serviceFor();
    const player = await users.create("hopeful", "hunter2hunter2");
    const saved = await loadouts.save(player.id, 0, { ...assault, primary: { weapon: "iw5/m4", attachments: ["thermal"] } });
    expect(saved.primary).toEqual({ weapon: "iw5/m4", attachments: [] });
  });

  it("refuses to store an attachment the weapon does not offer", async () => {
    const { loadouts, users } = serviceFor();
    const player = await users.create("fitter", "hunter2hunter2");
    await loadouts.save(player.id, 0, { ...assault, secondary: { weapon: "iw5/usp", attachments: ["acog"] } });
    expect((await loadouts.forUser(player.id))[0]!.secondary).toEqual({ weapon: "iw5/usp", attachments: [] });
  });

  it("empties a slot whose weapon the catalogue does not hold", async () => {
    const { loadouts, users } = serviceFor();
    const player = await users.create("dreamer", "hunter2hunter2");
    await loadouts.save(player.id, 0, { ...assault, primary: { weapon: "iw5/imaginary", attachments: [] } });
    expect((await loadouts.forUser(player.id))[0]!.primary.weapon).toBeNull();
  });

  /**
   * The one that cannot be caught any other way: the class was saved when the
   * catalogue held the weapon, and a rebuild since has dropped it. It has to
   * read as an empty slot — a substitution would arm a player with something
   * they never chose and nothing would say so.
   */
  it("empties a slot whose weapon has gone since it was saved", async () => {
    const app = testApp();
    const player = await app.users.create("veteran", "hunter2hunter2");

    await serviceWith(app).save(player.id, 0, assault);

    const classes = await serviceWith(app, [CATALOGUED[1]!]).forUser(player.id);
    expect(classes[0]!.primary).toEqual({ weapon: null, attachments: [] });
    expect(classes[0]!.secondary.weapon).toBe("iw5/usp");
  });

  /**
   * What a game order carries is the row, not this process's reading of it: the
   * instance hosting the game has its own catalogue and reconciles against that.
   */
  it("hands a game order every class as stored, with no catalogue consulted", async () => {
    const app = testApp();
    const player = await app.users.create("player", "hunter2hunter2");

    await serviceWith(app).save(player.id, 3, assault);

    const stored = serviceWith(app, []).stored(player.id);
    expect(stored).toHaveLength(LOADOUT_COUNT);
    expect(stored[3]).toEqual(assault);
    expect(stored[0]!.name).toBe("Class 1");
  });
});

describe("a class's game", () => {
  it("refuses another game's weapon, and a weapon in the other slot's category", async () => {
    const { loadouts, users } = serviceFor();
    const player = await users.create("mixer", "hunter2hunter2");
    const mixed = await loadouts.save(player.id, 0, { ...assault, game: "iw4" });
    expect([mixed.primary.weapon, mixed.secondary.weapon]).toEqual([null, null]);

    const crossed = await loadouts.save(player.id, 1, {
      ...assault,
      primary: { weapon: "iw5/usp", attachments: [] },
      secondary: { weapon: "iw5/m4", attachments: [] },
    });
    expect([crossed.primary.weapon, crossed.secondary.weapon]).toEqual([null, null]);
  });

  it("stores nothing for a class whose game is not chosen yet", async () => {
    const { loadouts, users } = serviceFor();
    const player = await users.create("undecided", "hunter2hunter2");
    const saved = await loadouts.save(player.id, 0, { ...assault, game: null });
    expect(saved).toMatchObject({ game: null, primary: { weapon: null }, secondary: { weapon: null } });
  });

  /** Rows written before a class had a game are read as the game their weapons are from, so nobody's class empties on upgrade. */
  it("reads a row saved before classes had a game as its weapons' game", async () => {
    const app = testApp();
    const player = await app.users.create("oldtimer", "hunter2hunter2");
    await serviceWith(app).save(player.id, 0, assault);
    app.container.resolve(Sqlite).db.update(loadoutRows).set({ game: null }).run();

    expect((await serviceWith(app).forUser(player.id))[0]).toEqual(assault);
  });
});

describe("choosing a class", () => {
  it("starts on the first and remembers a choice", async () => {
    const { loadouts, users } = serviceFor();
    const player = await users.create("chooser", "hunter2hunter2");
    expect(loadouts.selected(player.id)).toBe(0);
    loadouts.select(player.id, 4);
    expect(loadouts.selected(player.id)).toBe(4);
  });

  /** A class count that shrinks would otherwise leave a player pointing past the end of their own list. */
  it("falls back to the first when the stored choice is out of range", async () => {
    const { loadouts, users } = serviceFor();
    const player = await users.create("stale", "hunter2hunter2");
    loadouts.select(player.id, LOADOUT_COUNT + 3);
    expect(loadouts.selected(player.id)).toBe(0);
  });
});
