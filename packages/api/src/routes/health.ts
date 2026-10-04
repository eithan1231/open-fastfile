// Is this process up, and what does it have?
//
// Public and unauthenticated: a game server polls it at boot to decide the
// authority is reachable, and a load balancer reads it for the same reason.

import type { Hono } from "hono";
import { inject, singleton } from "tsyringe";
import { healthRoute } from "@3d/shared/protocol/routes/health.js";
import { Clock } from "../clock.js";
import { ManifestCache } from "../worlds/manifestCache.js";
import { Mount, type RouteGroup } from "./mount.js";

@singleton()
export class HealthRoutes implements RouteGroup {
  private readonly startedAt: number;

  constructor(
    @inject(Mount) private readonly mount: Mount,
    @inject(Clock) private readonly clock: Clock,
    @inject(ManifestCache) private readonly manifest: ManifestCache,
  ) {
    this.startedAt = clock.now();
  }

  register(app: Hono): void {
    this.mount.route(app, healthRoute, async () => ({
      ok: true as const,
      worlds: (await this.manifest.get()).length,
      uptimeSeconds: Math.round((this.clock.now() - this.startedAt) / 1000),
    }));
  }
}
