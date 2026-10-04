// This instance's orders, as a stream from the authority.
//
// The real `fetch` rather than @3d/shared's injected HttpFetch, for two reasons
// that are both deliberate: `HttpResponse` has no `body`, because giving it one
// would force ReadableStream into @3d/shared's platform.d.ts; and the request
// carries the service token, which EventSource has no way to send.
//
// The URL still comes from the route declaration. Neither end of this api spells
// a path of its own.
//
// The reconnect is the loop, rather than a retry written inside one: a pass is
// one connection, held open until it ends, and `loopDuration` is the pause
// before the next. The backoff is the one thing added on top, so an api
// restarting does not become a stampede from the whole fleet.

import { inject, singleton } from "tsyringe";
import { routePath } from "@3d/shared/protocol/route.js";
import { serverEvent, type ServerEvent } from "@3d/shared/protocol/events/server.js";
import { gameServerEventsRoute } from "@3d/shared/protocol/routes/games.js";
import { config } from "../config.js";
import { Identity } from "../identity.js";
import { LoopBase } from "@3d/shared/lifecycle/loop.js";
import { createSseParser } from "./sse.js";

/** Reconnect delay, doubling to the ceiling. */
const RETRY_MS = 1000;
const RETRY_CEILING_MS = 30_000;

export type OrderHandler = (event: ServerEvent) => void | Promise<void>;

@singleton()
export class OrderStream extends LoopBase {
  protected loopDuration = RETRY_MS;

  private handler: OrderHandler = () => {};

  constructor(@inject(Identity) private readonly identity: Identity) {
    super();
  }

  /**
   * Who receives an order. Set by whoever is standing games up, which is not
   * this class: it owns the connection and the framing, and nothing about what
   * an order means.
   */
  onOrder(handler: OrderHandler): void {
    this.handler = handler;
  }

  protected async loopIteration(): Promise<void> {
    try {
      await this.read();
      // The stream ended without an error: the api closed it, so reconnect.
    } catch (err) {
      if (!this.started) {
        return; // our own abort, on the way down
      }

      console.warn(`[api] orders stream lost (${err instanceof Error ? err.message : String(err)}); retrying in ${this.loopDuration}ms`);
    }

    this.loopDuration = Math.min(this.loopDuration * 2, RETRY_CEILING_MS);
  }

  private async read(): Promise<void> {
    const url = config.apiUrl + routePath(gameServerEventsRoute, { serverId: this.identity.id });

    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${config.serviceToken}`,
        Accept: "text/event-stream",
      },
      signal: this.controller?.signal,
    });

    if (!res.ok || !res.body) {
      throw new Error(`${res.status} ${res.statusText}`);
    }

    // Connected, and it answered: whatever went wrong last time is over.
    this.loopDuration = RETRY_MS;
    console.log(`[api] subscribed to orders as ${this.identity.id}`);

    const parser = createSseParser();
    const decoder = new TextDecoder();

    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      for (const frame of parser.push(decoder.decode(chunk, { stream: true }))) {
        // Untrusted only in the sense that a drifted api is a bug worth naming
        // here rather than three layers deeper as an undefined.
        let parsed;

        try {
          parsed = serverEvent.safeParse(JSON.parse(frame.data));
        } catch {
          console.warn("[api] an event that was not JSON; ignoring it");
          continue;
        }

        if (!parsed.success) {
          console.warn(`[api] an event this build does not understand; ignoring it: ${frame.data.slice(0, 200)}`);
          continue;
        }

        // Awaited: standing a game up loads a world, and two orders in one
        // `hello` must not race each other through Games.create.
        await this.handler(parsed.data);
      }
    }
  }
}
