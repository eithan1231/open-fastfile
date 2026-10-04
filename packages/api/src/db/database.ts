// The SQLite handle. better-sqlite3 rather than an async driver on purpose: a
// tick loop that has to await its own database is a tick loop that stutters.
//
// Migrations run on open, not as a separate deploy step. They are idempotent, a
// fresh clone then needs no setup beyond `pnpm dev`, and — the reason it matters
// most — a `dbPath` of `:memory:` hands a test a database that already has its
// tables, instead of one that looks fine until the first query.

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { inject, singleton } from "tsyringe";
import { Config } from "../config.js";
import * as schema from "./schema.js";

export type Db = ReturnType<typeof drizzle<typeof schema>>;

/** Resolved against this package, not the working directory: `pnpm --filter` runs elsewhere. */
const MIGRATIONS = path.resolve(import.meta.dirname, "../../drizzle");

@singleton()
export class Sqlite {
  /** The drizzle handle every service queries through. */
  readonly db: Db;

  constructor(@inject(Config) config: Config) {
    const file = config.dbPath;
    if (file !== ":memory:") {
      fs.mkdirSync(path.dirname(file), { recursive: true });
    }
    const sqlite = new Database(file);
    // Write-ahead logging: a reader never blocks the tick that is writing.
    sqlite.pragma("journal_mode = WAL");
    this.db = drizzle(sqlite, { schema });
    migrate(this.db, { migrationsFolder: MIGRATIONS });
  }
}
