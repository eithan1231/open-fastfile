// Registering, signing in, signing out, and who am I.
//
// Four routes and no policy: what a password is worth is auth/passwords.ts, what
// a session is is auth/sessions.ts, and this is only the HTTP shape over them.

import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { inject, singleton } from "tsyringe";
import { loginRoute, logoutRoute, meRoute, registerRoute } from "@3d/shared/protocol/routes/auth.js";
import { Sessions } from "../auth/sessions.js";
import { Users } from "../auth/users.js";
import { Mount, type RouteGroup } from "./mount.js";

@singleton()
export class AuthRoutes implements RouteGroup {
  constructor(
    @inject(Mount) private readonly mount: Mount,
    @inject(Users) private readonly users: Users,
    @inject(Sessions) private readonly sessions: Sessions,
  ) {}

  register(app: Hono): void {
    this.mount.route(app, registerRoute, async ({ body, c }) => {
      const created = await this.users.create(body.username, body.password);
      if (created.taken) {
        throw new HTTPException(409, { message: "name is taken" });
      }
      this.sessions.attach(c, this.sessions.create(created.id));
      return { id: created.id, username: created.username };
    });

    this.mount.route(app, loginRoute, async ({ body, c }) => {
      const user = await this.users.authenticate(body.username, body.password);
      // One answer for a wrong name and a wrong password, so this cannot be used
      // to learn which names exist.
      if (!user) {
        throw new HTTPException(401, { message: "wrong username or password" });
      }
      this.sessions.attach(c, this.sessions.create(user.id));
      return user;
    });

    this.mount.route(app, logoutRoute, ({ c }) => {
      const id = this.sessions.idFrom(c);
      if (id) {
        this.sessions.destroy(id);
      }
      this.sessions.clear(c);
      return { ok: true as const };
    });

    this.mount.route(app, meRoute, ({ user }) => user!);
  }
}
