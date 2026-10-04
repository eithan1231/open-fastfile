// Registering, signing in, and the cookie that carries a session.
//
// Through `app.request()` rather than against src/auth/ directly, because the
// thing worth testing is the round trip: what a browser sends, what comes back
// in a Set-Cookie, and whether presenting it again is the same player.

import { randomBytes, scryptSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sessionUser } from "@3d/shared/protocol/routes/auth.js";
import { SESSION_COOKIE } from "../src/auth/sessions.js";
import { sessions, users } from "../src/db/schema.js";
import { testApp } from "../testing/app.js";

const CREDENTIALS = { username: "ana", password: "hunter2hunter2" };

const json = (body: unknown, cookie?: string): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
  body: JSON.stringify(body),
});

/** The cookie a browser would send back, out of the Set-Cookie it was given. */
const cookieFrom = (res: Response): string => (res.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";

describe("registering", () => {
  it("creates a player and signs them in", async () => {
    const { app } = testApp();
    const res = await app.request("/api/auth/register", json(CREDENTIALS));
    expect(res.status).toBe(200);
    expect(sessionUser.parse(await res.json()).username).toBe("ana");

    const cookie = res.headers.get("Set-Cookie") ?? "";
    expect(cookie).toContain(`${SESSION_COOKIE}=`);
    // Script must not be able to read it, and a third-party page must not be
    // able to POST as this player — which is the whole CSRF story here.
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
  });

  it("refuses a name that is taken", async () => {
    const { app } = testApp();
    await app.request("/api/auth/register", json(CREDENTIALS));
    const again = await app.request("/api/auth/register", json({ ...CREDENTIALS, password: "somethingelse" }));
    expect(again.status).toBe(409);
  });

  it("refuses a name or password the contract will not accept", async () => {
    const { app } = testApp();
    expect((await app.request("/api/auth/register", json({ username: "a b", password: "hunter2hunter2" }))).status).toBe(400);
    expect((await app.request("/api/auth/register", json({ username: "ok", password: "hunter2hunter2" }))).status).toBe(400);
    expect((await app.request("/api/auth/register", json({ username: "ana", password: "short" }))).status).toBe(400);
  });

  it("never stores what the player typed", async () => {
    const { app, db } = testApp();
    await app.request("/api/auth/register", json(CREDENTIALS));
    const stored = db.select().from(users).all()[0]!;
    expect(stored.password).not.toContain(CREDENTIALS.password);
    // argon2id, carrying the parameters it was hashed with, so raising them
    // later does not invalidate this row. See src/auth/passwords.ts.
    expect(stored.password).toMatch(/^\$argon2id\$v=19\$m=\d+,t=\d+,p=\d+\$/);
  });
});

describe("signing in", () => {
  it("gives a session that /api/auth/me recognises", async () => {
    const { app } = testApp();
    await app.request("/api/auth/register", json(CREDENTIALS));
    const login = await app.request("/api/auth/login", json(CREDENTIALS));
    expect(login.status).toBe(200);

    const me = await app.request("/api/auth/me", { headers: { Cookie: cookieFrom(login) } });
    expect(me.status).toBe(200);
    expect(sessionUser.parse(await me.json()).username).toBe("ana");
  });

  it("answers a wrong name and a wrong password identically", async () => {
    const { app } = testApp();
    await app.request("/api/auth/register", json(CREDENTIALS));
    const wrongPassword = await app.request("/api/auth/login", json({ ...CREDENTIALS, password: "notthepassword" }));
    const noSuchUser = await app.request("/api/auth/login", json({ username: "nobody", password: "hunter2hunter2" }));

    // Otherwise this route is a way to find out which names exist.
    expect(wrongPassword.status).toBe(401);
    expect(noSuchUser.status).toBe(401);
    expect(await wrongPassword.text()).toBe(await noSuchUser.text());
  });

  it("401s a route that needs a session when there is none, or a made-up one", async () => {
    const { app } = testApp();
    expect((await app.request("/api/auth/me")).status).toBe(401);
    expect((await app.request("/api/auth/me", { headers: { Cookie: `${SESSION_COOKIE}=not-a-session` } })).status).toBe(401);
  });
});

describe("a password stored by an older scheme", () => {
  it("still signs in, and is rewritten as argon2id", async () => {
    const { app, db } = testApp();
    // A row exactly as the scrypt version of this api wrote one: `salt:hash`,
    // both hex. There is no migration that could rehash these — a migration has
    // no passwords to hash — so the one moment it can happen is a sign-in.
    const salt = randomBytes(16).toString("hex");
    const seconds = Math.floor(Date.now() / 1000);
    db.insert(users)
      .values({
        id: "legacy-user",
        username: "legacy",
        password: `${salt}:${scryptSync("hunter2hunter2", salt, 64).toString("hex")}`,
        createdAt: seconds,
        modifiedAt: seconds,
        lastSeenAt: seconds,
      })
      .run();

    const login = await app.request("/api/auth/login", json({ username: "legacy", password: "hunter2hunter2" }));
    expect(login.status).toBe(200);
    expect(db.select().from(users).all()[0]!.password).toMatch(/^\$argon2id\$/);

    // And the rewritten row is still this player's password, not a new one.
    expect((await app.request("/api/auth/login", json({ username: "legacy", password: "hunter2hunter2" }))).status).toBe(200);
    expect((await app.request("/api/auth/login", json({ username: "legacy", password: "notthepassword" }))).status).toBe(401);
  });
});

describe("signing out", () => {
  it("revokes the session on the server, not only in the browser", async () => {
    const { app } = testApp();
    const login = await app.request("/api/auth/register", json(CREDENTIALS));
    const cookie = cookieFrom(login);
    expect((await app.request("/api/auth/me", { headers: { Cookie: cookie } })).status).toBe(200);

    const out = await app.request("/api/auth/logout", json(undefined, cookie));
    expect(out.status).toBe(200);

    // The same cookie again: a browser that kept it gets nothing for it.
    expect((await app.request("/api/auth/me", { headers: { Cookie: cookie } })).status).toBe(401);
  });
});

describe("an expired session", () => {
  it("stops working, and is swept away when it is found", async () => {
    let clock = 1_000_000;
    const { app, db } = testApp({ now: () => clock });
    const login = await app.request("/api/auth/register", json(CREDENTIALS));
    const cookie = cookieFrom(login);

    clock += 31 * 24 * 60 * 60 * 1000;
    expect((await app.request("/api/auth/me", { headers: { Cookie: cookie } })).status).toBe(401);
    expect(db.select().from(sessions).all()).toHaveLength(0);
  });
});
