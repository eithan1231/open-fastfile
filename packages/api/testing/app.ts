// A whole api, in process, for a test to drive.
//
// Here rather than in each test file because @3d/game-server's integration test
// stands one up too, and the two must agree about what a real api is: a test
// against a hand-assembled subset of the dependencies would only agree with
// itself. This resolves the same container the process does, so a service that
// forgot an `@inject` fails here as loudly as it would at boot.
//
// -- Why the instances are cleared -------------------------------------------
//
// `@singleton()` registers a class on tsyringe's root container, and a child
// container shares that registration — so the *first* app built would otherwise
// hand its in-memory database and its matchmaker to every app built after it.
// Clearing first makes each call a fresh process; the overrides then go on a
// child, so nothing a test registers outlives it. An app already handed out
// keeps working: it holds its services by reference, not by token.

// Before anything decorated is imported: tsyringe's @inject writes its metadata
// at class-definition time, which is a TypeError without the polyfill.
import "reflect-metadata";

import fs from "node:fs";
import path from "node:path";
import { container, type DependencyContainer } from "tsyringe";
import type { Hono } from "hono";
import { App } from "../src/app.js";
import { Sessions } from "../src/auth/sessions.js";
import { Users } from "../src/auth/users.js";
import { Clock } from "../src/clock.js";
import { Config, type MatchmakingConfig } from "../src/config.js";
import { Sqlite, type Db } from "../src/db/database.js";
import { Matchmaker } from "../src/matchmaking/matchmaker.js";
import { Registry } from "../src/registry.js";

// The repo's own worlds/ where its imported maps are checked out, because the
// thing worth testing is that an actual exported map loads; otherwise (the public
// mirror carries none) two hand-written worlds beside this file stand in.
const REPO_WORLDS = path.resolve(import.meta.dirname, "../../../worlds");
const REPO_CATALOG_FILE = { kind: "weapons", game: "iw5", id: "iw5_m4_mp", rest: "iw5_m4_mp.glb" };
// Both, or neither: a map's text is committed and the catalogue is built, so a
// fresh checkout has the first without the second and must use the stand-ins.
const IMPORTED =
  fs.existsSync(path.join(REPO_WORLDS, "dome-mw3", "world.world")) &&
  fs.existsSync(path.join(REPO_WORLDS, "catalog", REPO_CATALOG_FILE.kind, REPO_CATALOG_FILE.game, REPO_CATALOG_FILE.id, REPO_CATALOG_FILE.rest));

export const TEST_WORLDS = IMPORTED ? REPO_WORLDS : path.resolve(import.meta.dirname, "worlds");
export const TEST_TOKEN = "test-token";
/** A world with spawns, an `include` and a `collision`: an imported map's text is committed even though its assets are not. */
export const TEST_WORLD = IMPORTED ? "dome-mw3" : "test-arena";
/** A second world in TEST_WORLDS, for a lobby that changes map. */
export const TEST_OTHER_WORLD = IMPORTED ? "rust-mw2" : "test-yard";
/**
 * A committed JSON file inside TEST_WORLD, for the asset route. An imported
 * map's `assets/` is gitignored, so the servable file has to be one of its own
 * sources — this route serves any file in the folder, not only `assets/`.
 */
export const TEST_WORLD_FILE = IMPORTED ? "export_metadata.json" : "meta.json";
/** A file in TEST_WORLDS' catalogue, for the catalogue's file route. The repo's catalogue is gitignored and built. */
export const TEST_CATALOG_FILE = IMPORTED ? REPO_CATALOG_FILE : { kind: "weapons", game: "iw5", id: "test_gun", rest: "test_gun.json" };

/** Short where the real defaults are long, so a countdown can be driven in a few ticks. */
export const TEST_MATCHMAKING: MatchmakingConfig = {
  maps: [TEST_WORLD],
  lobbySize: 4,
  minPlayers: 2,
  countdownSeconds: 30,
  gameDurationSeconds: 600,
  readyTimeoutMs: 30_000,
  presenceTimeoutMs: 30_000,
};

export interface TestAppOptions {
  /** The clock every service reads. A countdown is then three lines rather than thirty seconds. */
  now?: () => number;
  /** A built client to serve at `/`. Unset is what dev looks like: no bundle, no fallback. */
  clientDist?: string;
  matchmaking?: Partial<MatchmakingConfig>;
  /** A worlds root of the test's own, for a catalogue the repo's `worlds/` may not have built. */
  worldsRoot?: string;
}

export interface TestApp {
  app: Hono;
  db: Db;
  registry: Registry;
  matchmaking: Matchmaker;
  users: Users;
  sessions: Sessions;
  /** For a test that wants a service this one does not name. */
  container: DependencyContainer;
}

/** Every field of the real Config, with a private database and a token of this test's own. */
function testConfig({ clientDist, matchmaking, worldsRoot }: TestAppOptions): Config {
  return {
    port: 0,
    worldsRoot: worldsRoot ?? TEST_WORLDS,
    dbPath: ":memory:",
    clientDist,
    serviceToken: TEST_TOKEN,
    sessionTtlSeconds: 30 * 24 * 60 * 60,
    secureCookies: false,
    matchmakingIntervalMs: 1000,
    matchmaking: { ...TEST_MATCHMAKING, ...matchmaking },
  };
}

/** A clock a test moves by hand. */
class TestClock extends Clock {
  constructor(private readonly at: () => number) {
    super();
  }
  override now(): number {
    return this.at();
  }
}

export function testApp(options: TestAppOptions = {}): TestApp {
  container.clearInstances();

  const scope = container.createChildContainer();
  scope.registerInstance(Config, testConfig(options));
  if (options.now) {
    scope.registerInstance(Clock, new TestClock(options.now));
  }

  return {
    app: scope.resolve(App).hono,
    db: scope.resolve(Sqlite).db,
    registry: scope.resolve(Registry),
    matchmaking: scope.resolve(Matchmaker),
    users: scope.resolve(Users),
    sessions: scope.resolve(Sessions),
    container: scope,
  };
}
