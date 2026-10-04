// Is the authority up, and did it find its worlds?
//
// A game server blocks on this at boot (@3d/game-server's src/api.ts), so the
// one number that matters is `worlds`: a process that answers with zero has
// started without its volume, which otherwise shows up much later as every world
// 404ing.

import * as z from "zod/mini";
import { defineRoute, json } from "../route.js";

export const healthResponse = z.object({
  ok: z.literal(true),
  /** Worlds the authority can serve. The one number that says it found its volume. */
  worlds: z.number().check(z.int(), z.nonnegative()),
  uptimeSeconds: z.number().check(z.nonnegative()),
});
export type HealthResponse = z.infer<typeof healthResponse>;

export const healthRoute = defineRoute({
  method: "GET",
  path: "/api/health",
  auth: "public",
  result: json(healthResponse),
});
