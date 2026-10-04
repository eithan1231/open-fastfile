// The fleet, as the authority sees it: an instance saying it is alive, and the
// list of the ones that have said so recently.
//
// Both are the fleet's own — a browser is never handed the list, it is handed
// the one server its game is on, in a `matchReady` event.

import type { Hono } from "hono";
import { inject, singleton } from "tsyringe";
import { heartbeatRoute, serverListRoute } from "@3d/shared/protocol/routes/servers.js";
import { Registry } from "../registry.js";
import { Mount, type RouteGroup } from "./mount.js";

@singleton()
export class ServerRoutes implements RouteGroup {
  constructor(
    @inject(Mount) private readonly mount: Mount,
    @inject(Registry) private readonly registry: Registry,
  ) {}

  register(app: Hono): void {
    this.mount.route(app, serverListRoute, () => ({
      servers: this.registry.live(),
    }));

    this.mount.route(app, heartbeatRoute, ({ body }) => ({
      ok: true as const,
      expiresInSeconds: this.registry.heartbeat(body),
    }));
  }
}
