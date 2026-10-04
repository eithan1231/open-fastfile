// The event streams: what arrives, and what happens when nobody is listening.
//
// Through `app.request()`, reading the response body as a real stream, because
// the things worth testing here are exactly the ones a unit test of the hub
// would miss — whether the bytes actually reach the socket, and whether a
// deliberate close loses the event it was closing over.

import { describe, expect, it } from "vitest";
import { TEST_OTHER_WORLD, TEST_TOKEN, testApp } from "../testing/app.js";

/** Read frames off a live stream until `wanted` have arrived, then hang up. */
async function read(res: Response, wanted: number, timeoutMs = 2000): Promise<unknown[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: unknown[] = [];
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (events.length < wanted && Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      for (const line of buffer.split("\n")) {
        if (line.startsWith("data: ")) {
          events.push(JSON.parse(line.slice(6)));
        }
      }
      buffer = "";
    }
  } finally {
    await reader.cancel();
  }
  return events;
}

describe("a player's stream", () => {
  it("says so in-band when there is no session, rather than answering 401", async () => {
    const { app } = testApp();
    const res = await app.request("/api/events");

    // 401 would be invisible to EventSource, which reports it as an ordinary
    // error and then reconnects into it forever.
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    // And the event has to survive the close that follows it immediately.
    expect(await read(res, 1)).toEqual([{ type: "unauthenticated" }]);
  });

  it("opens with the whole state, not a delta", async () => {
    const { app, users, sessions, matchmaking } = testApp();
    const user = await users.create("ana", "hunter2hunter2");
    const cookie = `sid=${sessions.create(user.id)}`;

    // Already in a lobby before the stream opens: a reconnecting browser must
    // be told everything, because nothing here replays what it missed.
    await matchmaking.createLobby(user, TEST_OTHER_WORLD);

    const res = await app.request("/api/events", { headers: { Cookie: cookie } });
    const [first] = await read(res, 1);
    expect(first).toMatchObject({ type: "lobby", visibility: "private", map: TEST_OTHER_WORLD, players: [{ username: "ana", host: true }] });
  });

  it("carries what happens next", async () => {
    const { app, users, sessions, matchmaking } = testApp();
    const user = await users.create("ana", "hunter2hunter2");
    const cookie = `sid=${sessions.create(user.id)}`;

    const res = await app.request("/api/events", { headers: { Cookie: cookie } });
    const reading = read(res, 2);
    // Give the handler its turn to subscribe before anything is published.
    await new Promise((resolve) => setTimeout(resolve, 10));
    matchmaking.enqueue(user);

    const events = await reading;
    expect(events[0]).toEqual({ type: "left" });
    expect(events[1]).toMatchObject({ type: "searching" });
  });

  it("is one stream per player: a second tab displaces the first, which is told and let go", async () => {
    const { app, users, sessions, matchmaking } = testApp();
    const user = await users.create("ana", "hunter2hunter2");
    const cookie = `sid=${sessions.create(user.id)}`;

    const first = await app.request("/api/events", { headers: { Cookie: cookie } });
    // Reads to the end of the stream: the displacement has to close it, or this
    // times out holding one event.
    const firstEvents = read(first, 3);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const second = await app.request("/api/events", { headers: { Cookie: cookie } });
    expect(await firstEvents).toEqual([{ type: "left" }, { type: "displaced" }]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(matchmaking.userEvents.listeners(user.id)).toBe(1);

    const secondEvents = read(second, 2);
    await new Promise((resolve) => setTimeout(resolve, 10));
    matchmaking.enqueue(user);
    expect(await secondEvents).toEqual([{ type: "left" }, expect.objectContaining({ type: "searching" })]);
  });

  it("stops listening once the browser goes", async () => {
    const { app, users, sessions, matchmaking } = testApp();
    const user = await users.create("ana", "hunter2hunter2");
    const cookie = `sid=${sessions.create(user.id)}`;

    const res = await app.request("/api/events", { headers: { Cookie: cookie } });
    await read(res, 1); // reads the snapshot, then cancels
    // Cancelling is what reaches onAbort; without the teardown it runs, every
    // closed tab would leave a subscription and an interval behind it.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(matchmaking.userEvents.listeners(user.id)).toBe(0);
  });
});

describe("an instance's stream", () => {
  it("opens with everything it should be running, and needs the service token", async () => {
    const { app } = testApp();
    expect((await app.request("/internal/game-servers/gs-1/events")).status).toBe(401);

    const res = await app.request("/internal/game-servers/gs-1/events", { headers: { Authorization: `Bearer ${TEST_TOKEN}` } });
    expect(res.status).toBe(200);
    expect(await read(res, 1)).toEqual([{ type: "hello", games: [] }]);
  });

  it("opens for an id the registry has never seen", async () => {
    // The token authenticates the caller; the id is a routing label. An instance
    // that heartbeats and subscribes in the same breath must not race itself
    // into a 404.
    const { app } = testApp();
    const res = await app.request("/internal/game-servers/gs-never-heard-of/events", { headers: { Authorization: `Bearer ${TEST_TOKEN}` } });
    expect(res.status).toBe(200);
    expect(await read(res, 1)).toEqual([{ type: "hello", games: [] }]);
  });
});
