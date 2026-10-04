// /api/* and /internal/*: what a client may ask, what only the fleet may.

import { describe, expect, it } from "vitest";
import { healthResponse } from "@3d/shared/protocol/routes/health.js";
import { heartbeatResponse, serverListResponse, type GameServerInfo } from "@3d/shared/protocol/routes/servers.js";
import { HEARTBEAT_TIMEOUT_MS } from "../src/registry.js";
import { TEST_TOKEN, testApp } from "../testing/app.js";

const server = (overrides: Partial<GameServerInfo> = {}): GameServerInfo => ({
  id: "gs-1",
  url: "http://localhost:9300",
  worlds: ["rust-mw2"],
  players: 0,
  maxPlayers: 12,
  maxGames: 4,
  games: 0,
  ...overrides,
});

function app(now?: () => number) {
  return testApp(now ? { now } : {}).app;
}

/** The fleet list is the fleet's own: the browser is handed its one server in a matchReady event. */
const list = (a: ReturnType<typeof app>, init: RequestInit = { headers: { Authorization: `Bearer ${TEST_TOKEN}` } }) => a.request("/api/servers", init);

const post = (a: ReturnType<typeof app>, body: unknown, token?: string) =>
  a.request("/internal/game-servers/heartbeat", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }) },
    body: JSON.stringify(body),
  });

describe("GET /api/health", () => {
  it("reports how many worlds the authority found", async () => {
    const res = await app().request("/api/health");
    expect(res.status).toBe(200);
    const body = healthResponse.parse(await res.json());
    expect(body.worlds).toBeGreaterThan(0);
  });
});

describe("GET /api/servers", () => {
  it("is empty until something heartbeats", async () => {
    const a = app();
    expect(serverListResponse.parse(await (await list(a)).json()).servers).toEqual([]);

    await post(a, server(), TEST_TOKEN);
    const { servers } = serverListResponse.parse(await (await list(a)).json());
    expect(servers).toEqual([server()]);
  });

  it("is the fleet's own, not a browser's", async () => {
    expect((await list(app(), {})).status).toBe(401);
    expect((await list(app(), { headers: { Authorization: "Bearer not-the-token" } })).status).toBe(401);
  });

  it("drops a server that stopped heartbeating", async () => {
    let clock = 1_000_000;
    const a = app(() => clock);
    await post(a, server(), TEST_TOKEN);

    clock += HEARTBEAT_TIMEOUT_MS - 1;
    expect(serverListResponse.parse(await (await list(a)).json()).servers).toHaveLength(1);

    clock += 2;
    expect(serverListResponse.parse(await (await list(a)).json()).servers).toEqual([]);
  });

  it("keeps one entry per server, however often it heartbeats", async () => {
    const a = app();
    await post(a, server({ players: 1 }), TEST_TOKEN);
    await post(a, server({ players: 5 }), TEST_TOKEN);

    const { servers } = serverListResponse.parse(await (await list(a)).json());
    expect(servers).toHaveLength(1);
    expect(servers[0]!.players).toBe(5);
  });
});

describe("POST /internal/game-servers/heartbeat", () => {
  it("accepts a heartbeat with the service token", async () => {
    const res = await post(app(), server(), TEST_TOKEN);
    expect(res.status).toBe(200);
    expect(heartbeatResponse.parse(await res.json()).expiresInSeconds).toBe(HEARTBEAT_TIMEOUT_MS / 1000);
  });

  it("refuses one with no token", async () => {
    expect((await post(app(), server())).status).toBe(401);
  });

  it("refuses a wrong token, and a wrong-length one", async () => {
    expect((await post(app(), server(), "nope")).status).toBe(401);
    // A regression guard: comparing raw tokens with timingSafeEqual throws a
    // RangeError on a length mismatch, which would make this a 500 and leak how
    // long the real token is. auth/service.ts compares digests for that reason.
    expect((await post(app(), server(), "x")).status).toBe(401);
    expect((await post(app(), server(), "x".repeat(4096))).status).toBe(401);
    expect((await post(app(), server(), "")).status).toBe(401);
  });

  it("refuses a body that is not a GameServerInfo", async () => {
    expect((await post(app(), { id: "gs-1" }, TEST_TOKEN)).status).toBe(400);
    expect((await post(app(), { ...server(), maxPlayers: 0 }, TEST_TOKEN)).status).toBe(400);
  });
});
