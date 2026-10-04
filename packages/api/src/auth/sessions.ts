// A signed-in browser: the row that says so, and the cookie that carries it.
//
// A row in SQLite rather than a signed token, so that signing out and revoking a
// session are the same operation.
//
// A cookie and not a bearer token for one concrete reason: the browser's
// EventSource can send no headers, and the event stream is the whole point of
// being signed in. Same-origin fetch sends the cookie with no help, so the
// shared client needed no changes either. The cookie is therefore part of what a
// session *is*, which is why setting and clearing it live here and not in a
// middleware of their own.

import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { inject, singleton } from "tsyringe";
import type { SessionUser } from "@3d/shared/protocol/routes/auth.js";
import { Clock } from "../clock.js";
import { Config } from "../config.js";
import { Sqlite } from "../db/database.js";
import { sessions } from "../db/schema.js";
import { Users } from "./users.js";

/** The cookie a signed-in browser carries. */
export const SESSION_COOKIE = "sid";

@singleton()
export class Sessions {
  constructor(
    @inject(Sqlite) private readonly sqlite: Sqlite,
    @inject(Clock) private readonly clock: Clock,
    @inject(Config) private readonly config: Config,
    @inject(Users) private readonly users: Users,
  ) {}

  create(userId: string): string {
    const id = randomBytes(32).toString("base64url");
    const seconds = this.clock.seconds();
    this.sqlite.db
      .insert(sessions)
      .values({ id, userId, createdAt: seconds, expiresAt: seconds + this.config.sessionTtlSeconds })
      .run();
    return id;
  }

  destroy(id: string): void {
    this.sqlite.db.delete(sessions).where(eq(sessions.id, id)).run();
  }

  /**
   * Who this request is, by its cookie. Sweeps the session away when it has
   * expired rather than leaving a row that can never authenticate again — the
   * cheapest place to do it is the one read that already found it.
   */
  user(c: Context): SessionUser | undefined {
    const id = this.idFrom(c);
    if (!id) {
      return undefined;
    }
    const session = this.sqlite.db.select().from(sessions).where(eq(sessions.id, id)).get();
    if (!session) {
      return undefined;
    }
    if (session.expiresAt <= this.clock.seconds()) {
      this.destroy(id);
      return undefined;
    }
    const user = this.users.byId(session.userId);
    if (!user) {
      return undefined;
    }
    this.users.seen(user.id);
    return user;
  }

  idFrom(c: Context): string | undefined {
    return getCookie(c, SESSION_COOKIE);
  }

  /**
   * HttpOnly so script cannot read it, and SameSite=Lax so a third-party page
   * cannot POST as this player — which is the whole CSRF story for these routes,
   * since none of them is a cross-site GET with an effect.
   */
  attach(c: Context, id: string): void {
    setCookie(c, SESSION_COOKIE, id, {
      httpOnly: true,
      sameSite: "Lax",
      secure: this.config.secureCookies,
      path: "/",
      maxAge: this.config.sessionTtlSeconds,
    });
  }

  clear(c: Context): void {
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
  }
}
