// Everything the api reads from its environment, in one place.
//
// A singleton rather than a module-level object, because every service below it
// takes it from the container — which is what lets a test resolve the whole
// graph against an in-memory database and a token of its own without any of
// those services knowing a test exists.
//
// worlds/ is deliberately a path rather than a bundled asset: the deployment
// plan is an image that carries no worlds and a volume mounted over this path,
// so a map can be re-exported without rebuilding the api. This is the only
// process that has it — a game server fetches worlds from here.

import path from "node:path";
import { singleton } from "tsyringe";

const repoRoot = path.resolve(import.meta.dirname, "../../..");

const num = (value: string | undefined, fallback: number): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const production = process.env.NODE_ENV === "production";

/** Both servers fall back to this in dev, so a fresh clone runs with no setup. Never reachable in production. */
export const DEV_SERVICE_TOKEN = "dev-insecure-token";

function serviceToken(): string {
  const token = process.env.SERVICE_TOKEN;
  if (token) {
    return token;
  }
  if (production) {
    console.error("SERVICE_TOKEN is required in production: without it no game server can register.");
    process.exit(1);
  }
  console.warn("SERVICE_TOKEN unset — accepting the shared dev token. Set one in .env.local before this is reachable.");
  return DEV_SERVICE_TOKEN;
}

/** What the matchmaker is allowed to decide. Its own interface, because a test drives it with a much shorter countdown. */
export interface MatchmakingConfig {
  /** The playlist. A map nobody hosts is simply never chosen. */
  readonly maps: readonly string[];
  readonly lobbySize: number;
  /** Below this a lobby waits; at it, the countdown arms. */
  readonly minPlayers: number;
  /** The window players spend looking at each other and at the map before a round. */
  readonly countdownSeconds: number;
  /** How long a game runs. The api owns the playlist, so the api owns this too. */
  readonly gameDurationSeconds: number;
  /**
   * How long a committed game may take to report ready before its lobby gives up
   * on it. `gameReady` is what releases the players, so until it arrives they are
   * standing in a closed lobby with nothing to do — and an instance that crashed,
   * restarted under a new id, or could not load the map never sends it at all.
   */
  readonly readyTimeoutMs: number;
  /**
   * How long a player may have no event stream before they are dropped from a
   * lobby. That stream is the only liveness signal a browser gives us, so this
   * is what stops a closed tab standing in the roster forever.
   */
  readonly presenceTimeoutMs: number;
}

@singleton()
export class Config {
  /** Not PORT: two servers run side by side in dev out of one env file, so each names its own. */
  readonly port = num(process.env.API_PORT, 9208);

  readonly worldsRoot = process.env.WORLDS_ROOT === undefined ? path.join(repoRoot, "worlds") : path.resolve(repoRoot, process.env.WORLDS_ROOT);

  /** Users, sessions and the games that were played. Migrated on open; see src/db/database.ts. */
  readonly dbPath = process.env.DB_PATH === undefined ? path.join(repoRoot, ".data", "server.sqlite") : path.resolve(repoRoot, process.env.DB_PATH);

  /**
   * The built client, served at `/`. Unset in dev, where Vite serves the client
   * and proxies the routes here — so this process is the only origin in
   * production and there is no CORS to get wrong.
   *
   * Resolved against the repo root rather than the working directory: `pnpm
   * --filter @3d/api start` runs in packages/api, where a sensible-looking
   * CLIENT_DIST=packages/client/dist would otherwise resolve to nothing and 404
   * the whole bundle in silence.
   */
  readonly clientDist = process.env.CLIENT_DIST === undefined ? undefined : path.resolve(repoRoot, process.env.CLIENT_DIST);

  /** What a game server presents. Compared, and turned into middleware, by auth/service.ts. */
  readonly serviceToken = serviceToken();

  /** How long a session lives without being seen again. */
  readonly sessionTtlSeconds = Number(process.env.SESSION_TTL_DAYS ?? 30) * 24 * 60 * 60;

  /** `Secure` on the session cookie. Off in dev, where there is no TLS to carry it. */
  readonly secureCookies = production;

  /** How often the matchmaker looks at the queue. Well under the countdown, since this is what notices it has run out. */
  readonly matchmakingIntervalMs = num(process.env.MATCHMAKING_INTERVAL_MS, 1000);

  readonly matchmaking: MatchmakingConfig = {
    /**
     * The playlist a matchmade game is drawn from, narrowed to what live
     * instances are actually hosting. A map's `.world` text is committed but its
     * `assets/` is not, so a fresh clone can name this map without being able to
     * host it: a game server needs the export to have been run.
     */
    maps: (process.env.MATCHMAKING_MAPS ?? "dome-mw3")
      .split(",")
      .map((map) => map.trim())
      .filter(Boolean),
    lobbySize: num(process.env.LOBBY_SIZE, 12),
    minPlayers: num(process.env.LOBBY_MIN_PLAYERS, 2),
    countdownSeconds: num(process.env.LOBBY_COUNTDOWN_SECONDS, 5),
    gameDurationSeconds: num(process.env.GAME_DURATION_SECONDS, 600),
    readyTimeoutMs: num(process.env.GAME_READY_TIMEOUT_SECONDS, 30) * 1000,
    presenceTimeoutMs: num(process.env.LOBBY_PRESENCE_TIMEOUT_MS, 30_000),
  };
}
