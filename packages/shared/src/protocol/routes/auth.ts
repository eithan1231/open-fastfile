// Who a player is. Registering, signing in, and the two routes that answer "am I
// still signed in" and "stop being".
//
// The session itself never appears here: it lives in an HttpOnly cookie the
// provider sets, which is what lets the browser's EventSource carry it — that
// API can send no headers, so a bearer token would have left the event stream
// with no way to say who was listening.

import * as z from "zod/mini";
import { defineRoute, json } from "../route.js";

export const username = z.string().check(z.minLength(3), z.maxLength(24), z.regex(/^[A-Za-z0-9_]+$/, { error: "letters, digits and underscores only" }));

/**
 * Checked here so the answer is the same at both ends, and long rather than
 * clever: a rule a password manager cannot satisfy is a rule that produces worse
 * passwords. The provider hashes it; nothing stores what arrives.
 */
export const password = z.string().check(z.minLength(8), z.maxLength(200));

export const credentials = z.object({ username, password });
export type Credentials = z.infer<typeof credentials>;

/** A signed-in player, as both ends know them. Never carries the password column. */
export const sessionUser = z.object({
  id: z.string().check(z.minLength(1)),
  username: z.string().check(z.minLength(1)),
});
export type SessionUser = z.infer<typeof sessionUser>;

export const registerRoute = defineRoute({
  method: "POST",
  path: "/api/auth/register",
  auth: "public",
  input: credentials,
  result: json(sessionUser),
});

export const loginRoute = defineRoute({
  method: "POST",
  path: "/api/auth/login",
  auth: "public",
  input: credentials,
  result: json(sessionUser),
});

export const logoutRoute = defineRoute({
  method: "POST",
  path: "/api/auth/logout",
  auth: "user",
  result: json(z.object({ ok: z.literal(true) })),
});

/** The client's first call: 401 means show the sign-in screen. */
export const meRoute = defineRoute({
  method: "GET",
  path: "/api/auth/me",
  auth: "user",
  result: json(sessionUser),
  revalidate: true,
});

export const AUTH_ROUTES = {
  register: registerRoute,
  login: loginRoute,
  logout: logoutRoute,
  me: meRoute,
} as const;
