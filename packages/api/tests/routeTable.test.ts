// Every declared route reaches a handler, at the URL its own builder spells.
//
// This is the guard on the one place the two ends could still come apart. The
// paths in @3d/shared/protocol/routes/ are registered with Hono as they are
// written, but Hono captures neither a param with a literal suffix (`:slug.json`)
// nor `*`, so src/routes/mount.ts parses them itself — and a pattern Hono matched
// *narrowly* would 404 a URL the contract says is valid. Nothing in a type can
// catch that; one request each can.
//
// CASES is keyed by the route table, so a route added to API_ROUTES and not
// mounted fails to compile here rather than 404ing in a browser.

import { DEFAULT_GAMETYPE } from "@3d/shared/game/gametypes/registry.js";
import { describe, expect, it } from "vitest";
import { API_ROUTES, type ApiRoutes } from "@3d/shared/protocol/api.js";
import { routePath } from "@3d/shared/protocol/route.js";
import { loginRoute, logoutRoute, meRoute, registerRoute } from "@3d/shared/protocol/routes/auth.js";
import { gameReadyRoute, gameReportRoute, gameServerEventsRoute } from "@3d/shared/protocol/routes/games.js";
import { healthRoute } from "@3d/shared/protocol/routes/health.js";
import {
  lobbyCreateRoute,
  lobbyEndRoute,
  lobbyJoinRoute,
  lobbyLeaveRoute,
  lobbyGametypeRoute,
  lobbyMapRoute,
  lobbyStartRoute,
  queueJoinRoute,
  queueLeaveRoute,
  userEventsRoute,
} from "@3d/shared/protocol/routes/matchmaking.js";
import { loadoutSaveRoute, loadoutSelectRoute, loadoutsRoute } from "@3d/shared/protocol/routes/loadouts.js";
import { heartbeatRoute, serverListRoute } from "@3d/shared/protocol/routes/servers.js";
import { worldAssetRoute, worldManifestRoute, worldPayloadRoute } from "@3d/shared/protocol/routes/worlds.js";
import { catalogFileRoute, catalogIndexRoute } from "@3d/shared/protocol/routes/catalog.js";
import { TEST_CATALOG_FILE, TEST_TOKEN, TEST_WORLD, TEST_WORLD_FILE, testApp } from "../testing/app.js";

const { app, registry, matchmaking, users, sessions } = testApp();

const service = { headers: { Authorization: `Bearer ${TEST_TOKEN}` } };

const heartbeat = { id: "gs-1", url: "http://localhost:9300", worlds: [TEST_WORLD], players: 0, maxPlayers: 12, maxGames: 4, games: 0 };

const post = (extra: RequestInit = {}): RequestInit => ({ method: "POST", ...extra });

const cookie = (userId: string): RequestInit => ({ headers: { Cookie: `sid=${sessions.create(userId)}` } });

// Each case gets its own user or session, because they run in table order and
// several would otherwise quietly depend on that: logout destroys a session, and
// both creating a lobby and leaving the queue take their caller out of the lobby
// a later case names.
const player = await users.create("routetable", "hunter2hunter2");
const creator = await users.create("routecreator", "hunter2hunter2");
const queuer = await users.create("routequeuer", "hunter2hunter2");
const session = cookie(player.id);
const doomed = cookie(player.id);
const creating = cookie(creator.id);
const queueing = cookie(queuer.id);

// A live instance, so the start case can find a server without depending on the
// heartbeat case having already run.
registry.heartbeat(heartbeat);

// The lobby the two code-taking routes name. `player` hosts it, so joining is
// idempotent and starting is allowed.
const hosted = await matchmaking.createLobby(player, TEST_WORLD);
const code = hosted.ok ? hosted.code : "AAAAAA";

const CASES: { [K in keyof ApiRoutes]: { url: string; init?: RequestInit } } = {
  health: { url: routePath(healthRoute) },
  servers: { url: routePath(serverListRoute), init: service },
  heartbeat: {
    url: routePath(heartbeatRoute),
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TEST_TOKEN}` },
      body: JSON.stringify(heartbeat),
    },
  },
  worldManifest: { url: routePath(worldManifestRoute) },
  worldPayload: { url: routePath(worldPayloadRoute, { slug: TEST_WORLD }) },
  worldAsset: { url: routePath(worldAssetRoute, { slug: TEST_WORLD, rest: TEST_WORLD_FILE }) },
  catalogIndex: { url: routePath(catalogIndexRoute) },
  catalogFile: { url: routePath(catalogFileRoute, TEST_CATALOG_FILE) },

  register: {
    url: routePath(registerRoute),
    init: post({ headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "routecase", password: "hunter2hunter2" }) }),
  },
  login: {
    url: routePath(loginRoute),
    init: post({ headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "routetable", password: "hunter2hunter2" }) }),
  },
  logout: { url: routePath(logoutRoute), init: post(doomed) },
  me: { url: routePath(meRoute), init: session },

  loadouts: { url: routePath(loadoutsRoute), init: session },
  saveLoadout: {
    url: routePath(loadoutSaveRoute, { index: "1" }),
    init: post({
      headers: { "Content-Type": "application/json", ...session.headers },
      body: JSON.stringify({ name: "Assault", game: null, primary: { weapon: null, attachments: [] }, secondary: { weapon: null, attachments: [] } }),
    }),
  },
  selectLoadout: { url: routePath(loadoutSelectRoute, { index: "1" }), init: post(session) },

  userEvents: { url: routePath(userEventsRoute) },
  queueJoin: { url: routePath(queueJoinRoute), init: post(queueing) },
  queueLeave: { url: routePath(queueLeaveRoute), init: post(queueing) },
  lobbyCreate: {
    url: routePath(lobbyCreateRoute),
    init: post({ headers: { "Content-Type": "application/json", ...creating.headers }, body: JSON.stringify({}) }),
  },
  lobbyJoin: { url: routePath(lobbyJoinRoute, { code }), init: post(session) },
  lobbyMap: {
    url: routePath(lobbyMapRoute, { code }),
    init: post({ headers: { "Content-Type": "application/json", ...session.headers }, body: JSON.stringify({ map: TEST_WORLD }) }),
  },
  lobbyGametype: {
    url: routePath(lobbyGametypeRoute, { code }),
    init: post({ headers: { "Content-Type": "application/json", ...session.headers }, body: JSON.stringify({ gametype: DEFAULT_GAMETYPE }) }),
  },
  lobbyStart: { url: routePath(lobbyStartRoute, { code }), init: post(session) },
  // After lobbyStart, which is what gives it a countdown to stop.
  lobbyEnd: { url: routePath(lobbyEndRoute, { code }), init: post(session) },
  lobbyLeave: { url: routePath(lobbyLeaveRoute), init: post(session) },

  gameServerEvents: { url: routePath(gameServerEventsRoute, { serverId: "gs-1" }), init: service },
  gameReady: { url: routePath(gameReadyRoute, { gameId: "no-such-game" }), init: post(service) },
  gameReport: {
    url: routePath(gameReportRoute, { gameId: "no-such-game" }),
    init: post({ headers: { "Content-Type": "application/json", ...service.headers }, body: JSON.stringify({ status: "ended" }) }),
  },
};

describe("the route table", () => {
  for (const [name, route] of Object.entries(API_ROUTES)) {
    const { url, init } = CASES[name as keyof ApiRoutes];

    it(`mounts ${name} at ${route.path}`, async () => {
      const res = await app.request(url, init);
      expect(res.status).toBe(200);
      if (route.result.kind === "events") {
        expect(res.headers.get("Content-Type")).toContain("text/event-stream");
      }
      // An events route's stream never ends on its own, and cancelling is what
      // reaches the handler's onAbort. Without it the heartbeat interval behind
      // each open stream holds the whole run open.
      await res.body?.cancel();
    });
  }
});

// The other half of the same guard, and the reason routes/mount.ts no longer has
// a token to be handed or forgotten: it takes the one ServiceAuth holds, so a
// `service` route cannot be mounted open. Keyed by the route table too, so a new
// one declared `service` is covered the day it is added.
describe("a service route", () => {
  for (const [name, route] of Object.entries(API_ROUTES)) {
    if (route.auth !== "service") {
      continue;
    }
    const { url, init } = CASES[name as keyof ApiRoutes];

    it(`refuses ${name} without the service token`, async () => {
      const { headers, ...rest } = init ?? {};
      const anonymous = { ...rest, headers: Object.fromEntries(Object.entries(headers ?? {}).filter(([key]) => key !== "Authorization")) };
      const res = await app.request(url, anonymous);
      expect(res.status).toBe(401);
      await res.body?.cancel();
    });
  }
});
