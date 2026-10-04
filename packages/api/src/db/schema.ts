// The server's persistent state.
//
// Deliberately thin: who a player is, and the little that must outlive a
// process. Anything that changes every tick — position, velocity, held weapon —
// is simulation state and belongs in memory, not in SQLite.
//
// Note what is *not* here: lobbies, the queue, and which game servers are alive.
// Those are true only while this process is running, and a restart *should*
// forget them — a lobby whose players all disconnected an hour ago is not state
// worth recovering. They live in src/matchmaking/ and src/registry.ts.
//
// Keep this file free of @3d/shared value imports: drizzle-kit loads it through
// its own bundler, which externalizes bare specifiers the same way Vite's
// config loader does.

import { sqliteTable, text, integer, index, primaryKey } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  username: text("username").notNull().unique(),
  /** argon2id, as its own encoded string. Never what the player typed. See src/auth/passwords.ts. */
  password: text("password").notNull(),
  /** Unix seconds, here and below. */
  createdAt: integer("created_at").notNull(),
  modifiedAt: integer("modified_at").notNull(),
  lastSeenAt: integer("last_seen_at").notNull(),
  /** Which of their classes they spawn with. An index into `loadouts`, not a row id. */
  selectedLoadout: integer("selected_loadout").notNull().default(0),
});

/**
 * A signed-in browser. Rows rather than a signed token so that signing out, and
 * revoking a session server-side, are the same one operation.
 */
export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [index("sessions_user_id").on(table.userId)],
);

/**
 * A match that was played. The row is written when the api commits to a game and
 * updated as it goes, so an abandoned one is still visible as `starting` that
 * never started rather than as nothing at all.
 */
export const games = sqliteTable("games", {
  id: text("id").primaryKey(),
  /** The lobby it came out of. In memory, so this may name one that no longer exists. */
  lobbyId: text("lobby_id").notNull(),
  serverId: text("server_id").notNull(),
  map: text("map").notNull(),
  /** `starting` | `started` | `ending` | `ended`. */
  status: text("status").notNull(),
  createdAt: integer("created_at").notNull(),
  startedAt: integer("started_at"),
  endedAt: integer("ended_at"),
});

/**
 * A player's classes: what they spawn carrying. Five of them, one row each.
 *
 * Keyed by (user, index) rather than by an id of its own, because a class is a
 * slot a player edits rather than a thing that is created and destroyed — there
 * are exactly as many as `LOADOUT_COUNT` says, always, and a row simply may not
 * have been written yet.
 *
 * **Weapons and attachments are stored by name.** A snapshot carries them as
 * indices into the catalogue, which is rebuilt whenever a game is re-imported —
 * and the day those indices move, a stored index would silently rearm every
 * player who had saved one. What a name that no longer exists means is decided
 * when the class is read (src/loadouts.ts), not here.
 */
export const loadouts = sqliteTable(
  "loadouts",
  {
    userId: text("user_id").notNull(),
    /** 0 to LOADOUT_COUNT - 1. Which class, in the order the player sees them. */
    index: integer("idx").notNull(),
    name: text("name").notNull(),
    /** The game the class is built from (`iw4`). Null on a row written before classes had one; see src/loadouts.ts. */
    game: text("game"),
    primaryWeapon: text("primary_weapon"),
    primaryAttachment: text("primary_attachment"),
    secondaryWeapon: text("secondary_weapon"),
    secondaryAttachment: text("secondary_attachment"),
    modifiedAt: integer("modified_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.index] })],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type Game = typeof games.$inferSelect;
export type NewGame = typeof games.$inferInsert;
export type LoadoutRow = typeof loadouts.$inferSelect;
