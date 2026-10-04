// This process's link to the authority.
//
// A game server owns no worlds and no user facts; it asks @3d/api for them and
// presents a service token doing it. Everything that goes over the wire from
// here goes through this class, so there is one place that knows the token
// exists and one place that sets a timeout.
//
// A singleton, injected rather than imported: the heartbeat and the orders
// stream used to be handed an `ApiClient` and a callback describing this
// instance, which is a context passed around to say what the container can say
// once. See index.ts.

import { singleton } from "tsyringe";
import { createApiClient, type ApiClient } from "@3d/shared/protocol/api.js";
import type { HttpFetch } from "@3d/shared/protocol/http.js";
import { httpWorldSource, type HttpWorldSource } from "@3d/shared/worlds/source.js";
import { config } from "./config.js";
import { timeout } from "@3d/shared/lifecycle/timeout.js";

/**
 * Every request gets a deadline. Without one, an api that accepts a connection
 * and then never answers wedges this process at boot with no diagnostic at all —
 * which is the failure mode that wastes the most time to diagnose.
 */
const TIMEOUT_MS = 30_000;

/**
 * @3d/shared is typechecked with no DOM and no @types/node, so it takes the
 * host's fetch rather than reaching for a global it cannot see. This is that
 * host. See @3d/shared/protocol/http.ts.
 */
export const serviceFetch: HttpFetch = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });

@singleton()
export class Api {
  readonly client: ApiClient;
  readonly worlds: HttpWorldSource;

  constructor() {
    const link = { baseUrl: config.apiUrl, fetch: serviceFetch, token: config.serviceToken };
    this.client = createApiClient(link);
    this.worlds = httpWorldSource(link);
  }

  /**
   * Wait for the authority to answer. A game server that cannot reach the api
   * cannot host anything, so it retries — a fleet usually starts alongside the
   * api rather than after it — and then gives up rather than sitting there
   * looking healthy.
   */
  async awaitReady(attempts = 10): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        const { worlds: count } = await this.client.health();

        console.log(`api ready at ${config.apiUrl} (${count} worlds)`);

        return;
      } catch (e) {
        if (attempt >= attempts) {
          throw new Error(`${config.apiUrl} unreachable after ${attempts} attempts: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
        }
        const delay = Math.min(1000 * 2 ** (attempt - 1), 10_000);
        console.warn(`api not ready (attempt ${attempt}/${attempts}), retrying in ${delay}ms`);
        await timeout(delay);
      }
    }
  }
}
