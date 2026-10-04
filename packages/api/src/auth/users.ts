// The player behind a name: creating one, and deciding whether these are their
// credentials.
//
// The rows only. What a signed-in browser carries is a session (auth/sessions.ts)
// and how a password is stored is auth/passwords.ts; this is the table in
// between and nothing else.

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { inject, singleton } from "tsyringe";
import type { SessionUser } from "@3d/shared/protocol/routes/auth.js";
import { Clock } from "../clock.js";
import { Sqlite } from "../db/database.js";
import { users } from "../db/schema.js";
import { Passwords } from "./passwords.js";

export interface CreatedUser extends SessionUser {
  /** Distinguishes "that name is taken" from a user that was made. */
  taken?: true;
}

@singleton()
export class Users {
  constructor(
    @inject(Sqlite) private readonly sqlite: Sqlite,
    @inject(Clock) private readonly clock: Clock,
    @inject(Passwords) private readonly passwords: Passwords,
  ) {}

  async create(username: string, password: string): Promise<CreatedUser> {
    const existing = this.sqlite.db.select().from(users).where(eq(users.username, username)).get();
    if (existing) {
      return { id: existing.id, username: existing.username, taken: true };
    }
    const seconds = this.clock.seconds();
    const user = {
      id: randomUUID(),
      username,
      password: await this.passwords.hash(password),
      createdAt: seconds,
      modifiedAt: seconds,
      lastSeenAt: seconds,
    };
    this.sqlite.db.insert(users).values(user).run();
    return { id: user.id, username: user.username };
  }

  /** The user behind these credentials, or undefined. One answer for both failures, on purpose. */
  async authenticate(username: string, password: string): Promise<SessionUser | undefined> {
    const user = this.sqlite.db.select().from(users).where(eq(users.username, username)).get();
    if (!user || !(await this.passwords.verify(password, user.password))) {
      return undefined;
    }
    // The one moment the plaintext is in hand: retire a hash written by an older
    // scheme rather than leaving the row on it forever. See Passwords.outdated.
    if (this.passwords.outdated(user.password)) {
      const rehashed = await this.passwords.hash(password);
      this.sqlite.db.update(users).set({ password: rehashed, modifiedAt: this.clock.seconds() }).where(eq(users.id, user.id)).run();
    }
    return { id: user.id, username: user.username };
  }

  byId(id: string): SessionUser | undefined {
    const user = this.sqlite.db.select().from(users).where(eq(users.id, id)).get();
    return user && { id: user.id, username: user.username };
  }

  /** They were here. Cheapest at the one read that already found them. */
  seen(id: string): void {
    this.sqlite.db.update(users).set({ lastSeenAt: this.clock.seconds() }).where(eq(users.id, id)).run();
  }
}
