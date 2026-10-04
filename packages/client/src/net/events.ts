// The player's stream of what the api has decided: which lobby they are in, who
// else is in it, when the round starts, and where to connect when it does.
//
// EventSource, so reconnection and frame parsing are the browser's problem
// rather than ours — which is also why the framing parser in the repo lives in
// @3d/game-server, where there is no EventSource to lean on. The session rides
// on the cookie, because this API can send no headers; that is the reason the
// api's sessions are cookies at all.
//
// Transport only. What to do about a `matchReady` is app/'s decision, and the UI
// is told nothing from here.

import { userEvent, type UserEvent } from "@3d/shared/protocol/events/user.js";
import { routePath } from "@3d/shared/protocol/route.js";
import { userEventsRoute } from "@3d/shared/protocol/routes/matchmaking.js";

export interface UserEventsHandlers {
  onEvent: (event: UserEvent) => void;
  /** The stream says there is no session. It has been closed; sign in again. */
  onUnauthenticated: () => void;
  /** Another tab took this player's stream. It has been closed, and stays closed until `start` again. */
  onDisplaced: () => void;
}

export class UserEvents {
  private source: EventSource | undefined;

  constructor(private readonly handlers: UserEventsHandlers) {}

  get open(): boolean {
    return this.source !== undefined;
  }

  /** Same-origin, so the session cookie rides along with no help. */
  start(): void {
    if (this.source) {
      return;
    }
    const source = new EventSource(routePath(userEventsRoute));
    this.source = source;

    source.onmessage = (message: MessageEvent<string>) => {
      let parsed;
      try {
        parsed = userEvent.safeParse(JSON.parse(message.data));
      } catch {
        return; // not JSON; there is nothing useful to say about it
      }
      if (!parsed.success) {
        console.warn("[events] an event this build does not understand; ignoring it");
        return;
      }
      if (parsed.data.type === "unauthenticated") {
        // The api closes the stream after this. Stopping here is what keeps
        // EventSource from reconnecting into the same answer forever.
        this.stop();
        this.handlers.onUnauthenticated();
        return;
      }
      if (parsed.data.type === "displaced") {
        // The same, for the same reason: reconnecting would displace the tab
        // that displaced this one, and the two would trade the player forever.
        this.stop();
        this.handlers.onDisplaced();
        return;
      }
      this.handlers.onEvent(parsed.data);
    };

    // EventSource retries by itself, and reports a 401 the same way it reports a
    // dropped connection — which is why the api says "unauthenticated" in-band
    // rather than answering 401. There is nothing to do here but note it.
    source.onerror = () => console.warn("[events] the stream dropped; the browser will retry");
  }

  stop(): void {
    this.source?.close();
    this.source = undefined;
  }
}
