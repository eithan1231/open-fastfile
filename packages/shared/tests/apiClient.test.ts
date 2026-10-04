// The api client's parse step.
//
// The reason the wrappers exist rather than bare fetch calls: a response that has
// drifted from the contract fails here, naming the field, instead of arriving as
// an undefined three layers deeper in whatever read it.

import { describe, expect, it } from "vitest";
import { createApiClient } from "../src/protocol/api.js";
import type { HttpFetch } from "../src/protocol/http.js";

function replying(status: number, body: unknown): HttpFetch {
  return () =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? "OK" : "Error",
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    });
}

const HEALTH = { ok: true, worlds: 52, uptimeSeconds: 3 };

describe("createApiClient", () => {
  it("returns a parsed response", async () => {
    const api = createApiClient({ fetch: replying(200, HEALTH) });
    expect(await api.health()).toEqual(HEALTH);
  });

  it("names the field when the response has drifted", async () => {
    const { worlds: _dropped, ...missingWorlds } = HEALTH;
    const api = createApiClient({ fetch: replying(200, missingWorlds) });
    await expect(api.health()).rejects.toThrow(/worlds/);
  });

  it("rejects a field of the wrong type", async () => {
    const api = createApiClient({ fetch: replying(200, { ...HEALTH, worlds: "52" }) });
    await expect(api.health()).rejects.toThrow(/unexpected response/);
  });

  it("rejects a reply that is not an object at all", async () => {
    const api = createApiClient({ fetch: replying(200, "down for maintenance") });
    await expect(api.health()).rejects.toThrow(/unexpected response/);
  });

  it("reports a failed status before trying to parse it", async () => {
    const api = createApiClient({ baseUrl: "http://api", fetch: replying(401, { error: "unauthorized" }) });
    await expect(api.servers()).rejects.toThrow(/http:\/\/api\/api\/servers: 401/);
  });

  it("posts a heartbeat with the token, as JSON", async () => {
    const calls: { url: string; init?: { method?: string; headers?: Record<string, string>; body?: string } }[] = [];
    const fetch: HttpFetch = (url, init) => {
      calls.push({ url, ...(init ? { init } : {}) });
      return replying(200, { ok: true, expiresInSeconds: 30 })(url, init);
    };

    const api = createApiClient({ fetch, token: "s3cret" });
    const info = { id: "gs-1", url: "http://localhost:9300", worlds: ["rust-mw2"], players: 2, maxPlayers: 12, maxGames: 4, games: 0 };
    expect(await api.heartbeat(info)).toEqual({ ok: true, expiresInSeconds: 30 });

    expect(calls[0]!.url).toBe("/internal/game-servers/heartbeat");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.init?.headers?.Authorization).toBe("Bearer s3cret");
    expect(JSON.parse(calls[0]!.init?.body ?? "{}")).toEqual(info);
  });

  // A generated method for a stream would buffer until the stream closed, which
  // is never. The keys are gone from the type as well as from the object, so
  // calling one is a compile error and not only a runtime one.
  it("builds no method for an events route", () => {
    const api = createApiClient({ fetch: replying(200, HEALTH) }) as Record<string, unknown>;
    expect(api.userEvents).toBeUndefined();
    expect(api.gameServerEvents).toBeUndefined();
    expect(api.health).toBeTypeOf("function");
  });
});
