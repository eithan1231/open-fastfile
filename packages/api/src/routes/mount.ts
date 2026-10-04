// Mounting a shared route declaration on Hono.
//
// The declaration (@3d/shared/protocol/route.js) is the only place a path, a
// method, a schema or an audience is written down, and this is what turns one
// into a handler. What it does for every route, so that no handler has to
// remember to:
//
//   - requires the service token on a `service` route;
//   - parses the path params out of the URL and checks them against the route's
//     own schema, answering 404 when either fails — a URL the contract cannot
//     name names no resource, and saying so is better than saying which part of
//     it was wrong;
//   - resolves the session on a `user` route and 401s without one, handing the
//     handler the player rather than a cookie;
//   - validates the request body against the input schema, 400 on a mismatch;
//   - answers with `c.json` for a json route, and lets a `bytes` or `events`
//     route own its Response so it can stream a file, answer 304, or hold an
//     event stream open.
//
// Params come from matchRoutePath rather than from Hono, because Hono captures
// neither a param with a literal suffix (`:slug.json`) nor `*`. The pattern
// registered here is only wide enough to reach the handler; what a path *means*
// is the declaration's business, in one implementation rather than two that have
// to agree. tests/routeTable.test.ts is the guard on that: every declared route's
// own URL must reach its handler.

import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { inject, singleton } from "tsyringe";
import { describeIssues, matchRoutePath, type AnyRoute, type InputOf, type OutputOf, type ParamsOf } from "@3d/shared/protocol/route.js";
import type { SessionUser } from "@3d/shared/protocol/routes/auth.js";
import { ServiceAuth } from "../auth/service.js";
import { Sessions } from "../auth/sessions.js";

export interface RouteRequest<R extends AnyRoute> {
  /** Parsed out of the URL and past the route's params schema. */
  readonly params: ParamsOf<R["path"]>;
  /** Parsed out of the body and past the route's input schema. `undefined` for a route that declares none. */
  readonly body: InputOf<R>;
  /**
   * The signed-in player. Present exactly when the route declares `auth: "user"`
   * — such a route never reaches its handler without one — and absent otherwise,
   * which is why it is optional rather than typed off `R["auth"]`. Making the
   * type say that needs a fourth parameter on `Route` rippling through AnyRoute
   * and every annotation, to save a `!` in a handful of handlers.
   */
  readonly user?: SessionUser;
  /** The raw context, for the few routes that have headers of their own to set. */
  readonly c: Context;
}

/** A json route answers with its output; bytes and events own the Response they built. */
type Answer<R extends AnyRoute> = R["result"]["kind"] extends "json" ? OutputOf<R> : Response;

export type RouteHandler<R extends AnyRoute> = (req: RouteRequest<R>) => Answer<R> | Promise<Answer<R>>;

/**
 * A group of routes that knows how to put itself on the app.
 *
 * Implemented by everything in this directory, so app.ts names an order and
 * nothing else — which matters for exactly one of them: the client bundle
 * answers `/*` and must be last.
 */
export interface RouteGroup {
  register(app: Hono): void;
}

@singleton()
export class Mount {
  constructor(
    @inject(ServiceAuth) private readonly service: ServiceAuth,
    @inject(Sessions) private readonly sessions: Sessions,
  ) {}

  route<R extends AnyRoute>(app: Hono, route: R, handler: RouteHandler<R>): void {
    const handle = async (c: Context): Promise<Response> => {
      const matched = matchRoutePath(route, c.req.path);
      if (matched === undefined) {
        throw new HTTPException(404, { message: "not found" });
      }

      let params = matched;
      if (route.params !== undefined) {
        const parsed = route.params.safeParse(matched);
        if (!parsed.success) {
          throw new HTTPException(404, { message: "not found" });
        }
        params = parsed.data as ParamsOf<R["path"]>;
      }

      let user: SessionUser | undefined;
      if (route.auth === "user") {
        user = this.sessions.user(c);
        if (user === undefined) {
          return c.json({ error: "unauthorized" }, 401);
        }
      }

      let body: unknown;
      if (route.input !== undefined) {
        const parsed = route.input.safeParse(await c.req.json().catch(() => undefined));
        if (!parsed.success) {
          throw new HTTPException(400, { message: describeIssues(parsed.error.issues) });
        }
        body = parsed.data;
      }

      const answer = await handler({ params, body, user, c } as RouteRequest<R>);
      return route.result.kind === "json" ? c.json(answer) : (answer as Response);
    };

    if (route.auth === "service") {
      app.on(route.method, route.path, this.service.middleware(), handle);
      return;
    }
    app.on(route.method, route.path, handle);
  }
}
