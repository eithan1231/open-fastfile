// A player's classes, as handlers behind their declarations:
//
//   GET  /api/loadouts                 -> all five, and which they spawn with
//   POST /api/loadouts/<i>             -> save one
//   POST /api/loadouts/<i>/select      -> spawn with that one
//
// All three answer with the whole set, because all three change what the menu
// shows: a save is reconciled against the catalogue and can come back without
// the attachment it was sent with, and there is no second call to discover that.
//
// No policy here — src/loadouts.ts decides what a stored class means, and the
// route declaration decides what a body may contain. What is left is the index
// in the path, which is a string on the way in (protocol/route.ts keeps params
// strings) and is bounded by the declaration before it gets here.

import type { Hono } from "hono";
import { inject, singleton } from "tsyringe";
import { loadoutSaveRoute, loadoutSelectRoute, loadoutsRoute } from "@3d/shared/protocol/routes/loadouts.js";
import { Loadouts } from "../loadouts.js";
import { Mount, type RouteGroup } from "./mount.js";

@singleton()
export class LoadoutRoutes implements RouteGroup {
  constructor(
    @inject(Mount) private readonly mount: Mount,
    @inject(Loadouts) private readonly loadouts: Loadouts,
  ) {}

  register(app: Hono): void {
    this.mount.route(app, loadoutsRoute, ({ user }) => this.all(user!.id));

    this.mount.route(app, loadoutSaveRoute, async ({ user, params, body }) => {
      await this.loadouts.save(user!.id, Number(params.index), body);
      return this.all(user!.id);
    });

    this.mount.route(app, loadoutSelectRoute, ({ user, params }) => {
      this.loadouts.select(user!.id, Number(params.index));
      return this.all(user!.id);
    });
  }

  private async all(userId: string) {
    return { loadouts: await this.loadouts.forUser(userId), selected: this.loadouts.selected(userId) };
  }
}
