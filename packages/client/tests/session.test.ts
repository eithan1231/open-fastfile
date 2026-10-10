// @vitest-environment happy-dom
//
// What the player's session does with what the api tells it — which is where a
// browser and the api come apart if anything does. The stream is a stand-in
// EventSource driven by hand, and every request is recorded rather than sent.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UserEvent } from "@3d/shared/protocol/events/user.js";
import { inviteUrl, takeInviteCode } from "../src/app/invite.js";
import { PlayerSession, type PlayerSessionHandlers } from "../src/app/session.js";
import { createUiState } from "../src/app/uiBridge.js";

class FakeEventSource {
  static opened: FakeEventSource[] = [];
  onmessage: ((message: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    FakeEventSource.opened.push(this);
  }
  close(): void {
    this.closed = true;
  }
  emit(event: UserEvent): void {
    this.onmessage?.({ data: JSON.stringify(event) } as MessageEvent<string>);
  }
}

const requests: string[] = [];

beforeEach(() => {
  FakeEventSource.opened = [];
  requests.length = 0;
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      requests.push(`${init?.method ?? "GET"} ${url}`);
      const body = url.endsWith("/api/auth/me") ? { id: "u-ana", username: "ana" } : url.endsWith("/api/loadouts") ? null : { ok: true };
      return new Response(JSON.stringify(body), { status: body === null ? 500 : 200, headers: { "Content-Type": "application/json" } });
    }),
  );
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function signedIn() {
  const ui = createUiState();
  const handlers: PlayerSessionHandlers = {
    onMatchReady: vi.fn(),
    onRoundOver: vi.fn(),
    onLobby: vi.fn(),
    onLeft: vi.fn(),
    onDisplaced: vi.fn(),
    onSignedOut: vi.fn(),
  };
  const session = new PlayerSession(ui, handlers);
  expect(await session.restore()).toBe(true);
  const stream = () => FakeEventSource.opened.at(-1)!;
  return { ui, handlers, session, stream };
}

const lobby = (overrides: Partial<Extract<UserEvent, { type: "lobby" }>> = {}): UserEvent => ({
  type: "lobby",
  code: "BRAVO7",
  visibility: "private",
  map: "rust-mw2",
  gametype: "tdm",
  status: "open",
  startsAt: null,
  players: [
    { id: "p-ana", username: "ana", host: true },
    { id: "p-bo", username: "bo", host: false },
  ],
  ...overrides,
});

const ticket: UserEvent = {
  type: "matchReady",
  gameId: "g-1",
  playerId: "p-ana",
  authorizationKey: "k",
  serverUrl: "http://gs:9300",
  map: "rust-mw2",
  gametype: "default",
};

describe("the lobby, as the api describes it", () => {
  it("is this player's to host, with a link to share, and App is told there is one", async () => {
    const { ui, handlers, stream } = await signedIn();
    stream().emit(lobby());
    expect(ui.lobby.value).toMatchObject({ code: "BRAVO7", host: true, private: true, invite: inviteUrl("BRAVO7") });
    expect(handlers.onLobby).toHaveBeenCalled();
  });

  it("has no link when it is public", async () => {
    const { ui, stream } = await signedIn();
    stream().emit(lobby({ visibility: "public" }));
    expect(ui.lobby.value?.invite).toBeNull();
  });

  it("sends the player into a match once, however often the api repeats it, and back when it ends", async () => {
    const { handlers, stream } = await signedIn();
    stream().emit(lobby({ status: "closed" }));
    // A reconnect's snapshot carries the ticket again, behind the lobby.
    stream().emit(ticket);
    stream().emit(lobby({ status: "closed" }));
    stream().emit(ticket);
    expect(handlers.onMatchReady).toHaveBeenCalledTimes(1);

    stream().emit(lobby({ status: "open" }));
    expect(handlers.onRoundOver).toHaveBeenCalledTimes(1);
  });
});

describe("being out of the lobby", () => {
  it("is news when the api says so unasked, and App is told", async () => {
    const { ui, handlers, stream } = await signedIn();
    stream().emit(lobby());
    stream().emit({ type: "left" });
    expect(ui.lobby.value).toBeNull();
    expect(handlers.onLeft).toHaveBeenCalledTimes(1);
  });

  it("is not news when it answers the player's own Leave", async () => {
    const { handlers, session, stream } = await signedIn();
    stream().emit(lobby());
    session.leave();
    stream().emit({ type: "left" });
    expect(handlers.onLeft).not.toHaveBeenCalled();
    expect(requests).toContain("POST /api/lobbies/leave");
  });

  it("is not news at sign-in, when the snapshot says there was nothing to be in", async () => {
    const { handlers, stream } = await signedIn();
    stream().emit({ type: "left" });
    expect(handlers.onLeft).not.toHaveBeenCalled();
  });
});

describe("another tab", () => {
  it("takes the stream: this one stops listening, forgets its lobby, and does not reconnect", async () => {
    const { ui, handlers, stream } = await signedIn();
    const first = stream();
    first.emit(lobby());
    first.emit({ type: "displaced" });
    expect(first.closed).toBe(true);
    expect(ui.lobby.value).toBeNull();
    expect(handlers.onDisplaced).toHaveBeenCalledTimes(1);
    expect(FakeEventSource.opened).toHaveLength(1);
  });

  it("gives it back on Play Here, and the match it was in is joined again", async () => {
    const { handlers, session, stream } = await signedIn();
    stream().emit(lobby({ status: "closed" }));
    stream().emit(ticket);
    stream().emit({ type: "displaced" });

    session.playHere();
    expect(FakeEventSource.opened).toHaveLength(2);
    stream().emit(lobby({ status: "closed" }));
    stream().emit(ticket);
    expect(handlers.onMatchReady).toHaveBeenCalledTimes(2);
  });
});

describe("the host's commands", () => {
  it("ends the match by the lobby's code", async () => {
    const { session, stream } = await signedIn();
    stream().emit(lobby({ status: "closed" }));
    session.endLobby();
    expect(requests).toContain("POST /api/lobbies/BRAVO7/end");
  });
});

describe("an invite link", () => {
  afterEach(() => history.replaceState(null, "", "/"));

  it("is read once, and taken off the address bar so a reload does not join again", () => {
    history.replaceState(null, "", "/?join=bravo7#dome-mw3@1,2,3,0,0");
    expect(takeInviteCode()).toBe("BRAVO7");
    // The pose link beside it is someone else's business, and stays.
    expect(location.search).toBe("");
    expect(location.hash).toBe("#dome-mw3@1,2,3,0,0");
    expect(takeInviteCode()).toBeUndefined();
  });

  it("round-trips through the link the lobby hands out", () => {
    history.replaceState(null, "", new URL(inviteUrl("BRAVO7")).pathname + new URL(inviteUrl("BRAVO7")).search);
    expect(takeInviteCode()).toBe("BRAVO7");
  });

  it("refuses a code that could not be one", () => {
    history.replaceState(null, "", "/?join=../../etc");
    expect(takeInviteCode()).toBeUndefined();
  });
});
