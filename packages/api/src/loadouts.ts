// A player's classes: reading the five, writing one, and remembering which they
// last chose.
//
// The rows only — what a class *is* is `@3d/shared/sim/loadout.ts`, and turning
// one into a weapon in a player's hands is `Player.equipLoadout`. What lives
// here is the one thing neither of those can do: decide what a stored class
// means now, against the catalogue as it stands today.
//
// That is the whole job. A class is written by a player and read back months
// later, across a re-import that renamed weapons and a rebuild that renumbered
// attachments, so every read is a reconciliation: a weapon the catalogue no
// longer holds becomes an empty slot, and an attachment the weapon no longer
// offers is dropped. Never a substitution — a player who saved an ACOG and gets
// a thermal would have no way to tell that anything had happened.
//
// A class is also built from one game (`Loadout.game`), and a weapon it may not
// carry — another game's, or the wrong slot's category — is refused by the same
// rule a game server equips by (`mayCarry`).

import { eq } from "drizzle-orm";
import { inject, singleton } from "tsyringe";
import { defaultLoadout, LOADOUT_COUNT, MAX_LOADOUT_ATTACHMENTS, type Loadout, type LoadoutSlot, type LoadoutWeapon } from "@3d/shared/sim/loadout.js";
import { mayCarry } from "@3d/shared/sim/weaponCategory.js";
import { splitWeaponKey, type WeaponEntry } from "@3d/shared/sim/weaponRegistry.js";
import { Clock } from "./clock.js";
import { Sqlite } from "./db/database.js";
import { loadouts, users, type LoadoutRow } from "./db/schema.js";
import { Catalog } from "./catalog.js";

@singleton()
export class Loadouts {
  constructor(
    @inject(Sqlite) private readonly sqlite: Sqlite,
    @inject(Clock) private readonly clock: Clock,
    @inject(Catalog) private readonly catalog: Catalog,
  ) {}

  /**
   * All five of a player's classes, in order, against the catalogue as it stands.
   *
   * Always `LOADOUT_COUNT` of them: a class a player has never touched has no
   * row, and a player is not short a class because of it.
   */
  async forUser(userId: string): Promise<Loadout[]> {
    const rows = this.sqlite.db.select().from(loadouts).where(eq(loadouts.userId, userId)).all();
    const byIndex = new Map(rows.map((row) => [row.index, row]));
    const registry = await this.catalog.registry();
    return Array.from({ length: LOADOUT_COUNT }, (_, index) => {
      const row = byIndex.get(index);
      return row ? cutDown(asLoadout(row), registry) : defaultLoadout(index);
    });
  }

  /**
   * All five classes exactly as they are stored, with no catalogue consulted.
   *
   * What a game order carries, so that a player can choose any of them in the
   * match. The instance hosting the game has its own catalogue and reconciles
   * against that when it equips the player (`Player.equipLoadout`), and that is
   * the reconciliation that decides what is actually in their hands — so doing it
   * here as well would only be this process's opinion about another's catalogue.
   */
  stored(userId: string): Loadout[] {
    const rows = this.sqlite.db.select().from(loadouts).where(eq(loadouts.userId, userId)).all();
    const byIndex = new Map(rows.map((row) => [row.index, row]));
    return Array.from({ length: LOADOUT_COUNT }, (_, index) => {
      const row = byIndex.get(index);
      return row ? asLoadout(row) : defaultLoadout(index);
    });
  }

  /**
   * Write one class. Returns it as it will read back — which is not always what
   * was sent: a weapon the catalogue does not hold is stored as nothing, so a
   * class can never name a gun no game server could give out.
   */
  async save(userId: string, index: number, loadout: Loadout): Promise<Loadout> {
    const registry = await this.catalog.registry();
    const [first, second] = [keep(loadout.primary, "primary", loadout.game, registry), keep(loadout.secondary, "secondary", loadout.game, registry)];
    const row: LoadoutRow = {
      userId,
      index,
      name: loadout.name,
      game: loadout.game,
      primaryWeapon: first.weapon,
      primaryAttachment: first.attachments[0] ?? null,
      secondaryWeapon: second.weapon,
      secondaryAttachment: second.attachments[0] ?? null,
      modifiedAt: this.clock.seconds(),
    };
    this.sqlite.db
      .insert(loadouts)
      .values(row)
      .onConflictDoUpdate({ target: [loadouts.userId, loadouts.index], set: row })
      .run();
    return cutDown(asLoadout(row), registry);
  }

  /**
   * The class this player last chose. Not what they spawn with — that is chosen
   * in the match, by index, and enforced by the game server — but what the
   * in-match picker offers first.
   */
  selected(userId: string): number {
    const row = this.sqlite.db.select({ at: users.selectedLoadout }).from(users).where(eq(users.id, userId)).get();
    const at = row?.at ?? 0;
    return at >= 0 && at < LOADOUT_COUNT ? at : 0;
  }

  select(userId: string, index: number): void {
    this.sqlite.db.update(users).set({ selectedLoadout: index, modifiedAt: this.clock.seconds() }).where(eq(users.id, userId)).run();
  }

  /** Forget a player's classes. Not used yet; here so deleting a user is one call away from complete. */
  forget(userId: string): void {
    this.sqlite.db.delete(loadouts).where(eq(loadouts.userId, userId)).run();
  }
}

/** What a catalogue can be asked about a stored class. The registry, narrowed to what this module uses. */
interface Catalogue {
  entry(id: string | null | undefined): Pick<WeaponEntry, "game" | "id" | "class" | "def" | "attachments"> | undefined;
}

/** A stored weapon choice, cut down to what the catalogue still offers and what this class may carry there. */
function keep(choice: LoadoutWeapon, slot: LoadoutSlot, game: string | null, registry: Catalogue): LoadoutWeapon {
  const entry = registry.entry(choice.weapon);
  if (!entry || !mayCarry(entry, slot, game)) {
    return { weapon: null, attachments: [] };
  }
  const offered = new Set(entry.attachments.map((a) => a.id));
  return { weapon: choice.weapon, attachments: choice.attachments.filter((id) => offered.has(id)).slice(0, MAX_LOADOUT_ATTACHMENTS) };
}

/** One row as a class, verbatim. The `_attachment` columns are single because a class carries one (MAX_LOADOUT_ATTACHMENTS). */
function asLoadout(row: LoadoutRow): Loadout {
  const weapon = (id: string | null, attachment: string | null): LoadoutWeapon => ({
    weapon: id,
    attachments: attachment === null ? [] : [attachment],
  });
  return {
    name: row.name,
    // A row saved before classes had a game is read as the game its weapons are
    // from — the only one it can have been built from, since the menu listed
    // every game's weapons together and a player who mixed two loses one of them.
    game: row.game ?? gameOf(row.primaryWeapon) ?? gameOf(row.secondaryWeapon),
    primary: weapon(row.primaryWeapon, row.primaryAttachment),
    secondary: weapon(row.secondaryWeapon, row.secondaryAttachment),
  };
}

/** The game a stored weapon id is from, or null for none. */
function gameOf(weapon: string | null): string | null {
  return weapon === null ? null : (splitWeaponKey(weapon)?.game ?? null);
}

/** A class cut down to what the catalogue still offers: an empty slot where a weapon has gone, never a substitute. */
function cutDown(loadout: Loadout, registry: Catalogue): Loadout {
  return {
    name: loadout.name,
    game: loadout.game,
    primary: keep(loadout.primary, "primary", loadout.game, registry),
    secondary: keep(loadout.secondary, "secondary", loadout.game, registry),
  };
}
