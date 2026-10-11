// Leaving a match whose channel never came up.
//
// geckos' `close` assumes a peer connection and throws without one, and a throw
// out of `Connection.close` aborts whatever was tearing the match down — which
// is how a round ending left a player standing in its world, found by driving
// two browsers against a game server whose handshake was refused.

import { describe, expect, it, vi } from "vitest";

vi.mock("@geckos.io/client", () => ({
  default: () => ({
    onConnect: () => {},
    close: () => {
      throw new TypeError("Cannot read properties of undefined (reading 'close')");
    },
  }),
}));

const { Connection } = await import("../src/net/connection.js");

describe("closing a connection", () => {
  it("survives a channel that never connected", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const closed = vi.fn();
    const connection = new Connection({ onJoined: vi.fn(), onSnapshot: vi.fn(), onShotTrace: vi.fn(), onClosed: closed }, "hash");
    expect(connection.connect({ gameId: "g-1", playerId: "p-1", authorizationKey: "k", serverUrl: "http://localhost:9300" })).toBe(true);
    expect(() => connection.close()).not.toThrow();
  });
});
