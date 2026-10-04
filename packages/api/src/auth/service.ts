// The fleet's credential: a shared secret a game server presents, and the
// middleware that refuses anything without it.
//
// A shared secret is all it needs to be while the fleet is trusted
// infrastructure rather than anything a user can run. It is never a player's
// credential — that is a session cookie (auth/sessions.ts), because the two
// answer different questions.
//
// The token itself comes from Config, which is also what makes it impossible to
// mount a `service` route unguarded: there is always a token to check against,
// the dev fallback included, and the process refuses to start in production
// without a real one.

import { createHash, timingSafeEqual } from "node:crypto";
import { createMiddleware } from "hono/factory";
import type { MiddlewareHandler } from "hono";
import { inject, singleton } from "tsyringe";
import { Config } from "../config.js";

/**
 * Compare digests, not the tokens themselves: timingSafeEqual throws a RangeError
 * on buffers of different lengths, so comparing raw tokens turns a wrong-length
 * one into a 500 and tells the sender how long the real one is. Hashing first
 * makes every comparison the same size.
 */
function tokenMatches(presented: string, expected: string): boolean {
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

@singleton()
export class ServiceAuth {
  private readonly expected: string;

  constructor(@inject(Config) config: Config) {
    this.expected = config.serviceToken;
  }

  /** Whether this is the fleet. `Bearer <token>`, and nothing else counts. */
  presents(authorization: string | undefined): boolean {
    const header = authorization ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    return presented !== "" && tokenMatches(presented, this.expected);
  }

  /** Applied to every `service` route, and never to a route a browser calls. */
  middleware(): MiddlewareHandler {
    return createMiddleware(async (c, next) => {
      if (!this.presents(c.req.header("Authorization"))) {
        return c.json({ error: "unauthorized" }, 401);
      }

      await next();
    });
  }
}
