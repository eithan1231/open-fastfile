// Server-sent events: the api pushing, rather than a client asking.
//
// The mechanism only, knowing no event of this game — the shapes are declared in
// @3d/shared/protocol/events/ and the two typed hubs over this are the
// matchmaker's. It is the same split as routes/mount.ts and the route
// declarations.
//
// Two things here are load-bearing and neither is obvious:
//
//   - `StreamingApi.write` swallows every error, so a write to a client that has
//     gone silently succeeds forever. `onAbort` is the only thing that says a
//     connection has ended, which is why every subscription is torn down there
//     rather than on a failed write.
//   - The callback closes the stream when it returns, so it awaits a promise
//     that nothing resolves until the connection ends or `sink.close()` is
//     called. That is what holds a stream open.
//   - `writeSSE` is async before it touches the writer, so a write and a close
//     issued in the same turn race, and the write loses. Writes are therefore
//     chained and the chain is drained before returning — without which the one
//     event that is always followed immediately by a close, `unauthenticated`,
//     never arrived at all.

import type { Context } from "hono";
import { streamSSE } from "hono/streaming";

/**
 * A comment line, often enough that an idle stream is never mistaken for a dead
 * one. Proxies and load balancers close a connection that has said nothing for a
 * minute, and a client that has to reconnect is a client whose events went
 * nowhere in between.
 */
const HEARTBEAT_MS = 15_000;

export interface EventSink<E> {
  /** Write one event. A no-op once the connection has gone. */
  send(event: E): void;
  /** End the stream deliberately — the answer to a subscriber we will not serve. */
  close(): void;
}

/**
 * Hold an SSE stream open. `attach` is handed the sink to write to and returns
 * the cleanup to run when the connection ends, however it ends.
 */
export function eventStream<E>(c: Context, attach: (sink: EventSink<E>) => (() => void) | void): Response {
  return streamSSE(c, async (stream) => {
    let ended = false;
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });

    /** Every write, in order, so that closing can wait for them. */
    let writes: Promise<unknown> = Promise.resolve();

    const sink: EventSink<E> = {
      send(event) {
        if (!ended) {
          writes = writes.then(() => stream.writeSSE({ data: JSON.stringify(event) }));
        }
      },
      close() {
        end();
      },
    };

    const beat = setInterval(() => {
      if (!ended) {
        void stream.write(": ping\n\n");
      }
    }, HEARTBEAT_MS);

    // Set by `attach` below; read by `end`, which may run before it is.
    const detachers: (() => void)[] = [];

    function end(): void {
      if (ended) {
        return;
      }
      ended = true;
      clearInterval(beat);
      for (const detach of detachers.splice(0)) {
        detach();
      }
      finish();
    }

    stream.onAbort(end);
    const detach = attach(sink);
    if (detach) {
      detachers.push(detach);
    }
    // `attach` may have closed the stream itself, or the client may have gone
    // while it ran — in which case `end` has already been and this subscription
    // would otherwise never be torn down.
    if (ended) {
      for (const gone of detachers.splice(0)) {
        gone();
      }
    } else {
      await finished;
    }
    // Returning closes the stream, so anything still queued has to land first.
    await writes;
  });
}

/**
 * Who is listening, keyed by whatever the caller identifies a listener by.
 *
 * Constructed rather than injected: it is a value the matchmaker owns two of —
 * one for players, one for instances — and each is typed by the events that go
 * through it. The container has nothing to say about which is which.
 */
export class Subscribers<E> {
  private readonly byKey = new Map<string, Set<EventSink<E>>>();

  /** Returns the unsubscribe. A key may have several: two tabs, or a reconnect racing its own teardown. */
  subscribe(key: string, sink: EventSink<E>): () => void {
    const sinks = this.byKey.get(key) ?? new Set<EventSink<E>>();
    sinks.add(sink);
    this.byKey.set(key, sinks);
    return () => {
      sinks.delete(sink);
      if (sinks.size === 0) {
        this.byKey.delete(key);
      }
    };
  }

  /**
   * Say `farewell` to every sink under `key` and close them — the answer to a
   * listener that has been replaced. Closing is what unsubscribes them, so this
   * walks a copy of the set it empties.
   */
  displace(key: string, farewell: E): void {
    for (const sink of [...(this.byKey.get(key) ?? [])]) {
      sink.send(farewell);
      sink.close();
    }
  }

  publish(key: string, event: E): void {
    for (const sink of this.byKey.get(key) ?? []) {
      sink.send(event);
    }
  }

  listeners(key: string): number {
    return this.byKey.get(key)?.size ?? 0;
  }
}
