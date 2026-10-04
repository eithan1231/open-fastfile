import { TICK_RATE } from "@3d/shared/net/messages/fields.js";

const num = (value: string | undefined, fallback: number): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const production = process.env.NODE_ENV === "production";

/** Comma-separated urls, so one env var covers a stun, a turn, or neither. */
function iceServers(): { urls: string }[] {
  return (process.env.ICE_SERVERS ?? "")
    .split(",")
    .map((url) => url.trim())
    .filter((url) => url.length > 0)
    .map((urls) => ({ urls }));
}

/**
 * A shared secret in dev so a fresh clone runs with no setup. The api falls back
 * to the same string, and both of them say so loudly; in production a missing
 * token is fatal on both ends rather than a 401 nobody can explain.
 */
export const DEV_SERVICE_TOKEN = "dev-insecure-token";

function serviceToken(): string {
  const token = process.env.SERVICE_TOKEN;
  if (token) {
    return token;
  }
  if (production) {
    console.error("SERVICE_TOKEN is required in production: the api will refuse every request without it.");
    process.exit(1);
  }
  console.warn(`SERVICE_TOKEN unset — using the shared dev token. Set one in .env.local before this is reachable.`);
  return DEV_SERVICE_TOKEN;
}

export const config = {
  /**
   * HTTP: geckos' signalling handshake and /healthz. Not the same port as the api, because dev reads one env file.
   */
  port: num(process.env.GAME_PORT, 9300),

  /**
   * The UDP port the browser's DataChannel talks over, and the one to forward.
   * A range, but it has to name one port: geckos multiplexes every connection
   * onto a single socket and picks its port from the range at random, so a range
   * and a forwarded port agree by luck. Two instances on a host need different
   * ones, and sharing fails as a silent ICE timeout rather than an error.
   */
  udpPortRange: { min: num(process.env.UDP_PORT_MIN, 20000), max: num(process.env.UDP_PORT_MAX, 20000) },

  /**
   * Where a player reaches this process, as an address rather than a name. What
   * it gathers for itself is one candidate per interface, every one of them
   * private behind a NAT, so the forwarded address has to be **declared** here
   * or no browser is ever told it. Unset means "do not advertise", which is what
   * dev wants and what a host whose own interface already carries its public
   * address wants too. Never inferred from `publicUrl`: a name that resolves to
   * a proxy or a CDN would hand every player an address nothing is listening
   * behind, silently. See net/advertise.ts and docs/server/README.md, which is
   * also why the udp range above must name one port.
   */
  publicIp: process.env.PUBLIC_IP,

  /**
   * Optional, and off: discovering the address above instead of declaring it.
   * Worth setting on a cone NAT, where a `srflx` candidate is valid for anyone;
   * useless on a symmetric one, where it is valid only for the stun server that
   * answered. A turn url belongs here too. See docs/server/README.md.
   */
  iceServers: iceServers(),

  /**
   * Where the client is served from; geckos' signalling is cross-origin from it.
   */
  clientOrigin: process.env.CLIENT_ORIGIN ?? "http://localhost:5173",

  /** The authority. Every world, and every fact this process does not own, comes from here. */
  apiUrl: process.env.API_URL ?? "http://localhost:9208",
  serviceToken: serviceToken(),

  /**
   * How a browser reaches this process — a whole URL, not a host and a port,
   * because whether that ends up being https://gs-7.example or
   * https://example/gs/7 is a deployment question this process cannot answer.
   * See docs/server/README.md.
   */
  publicUrl: process.env.PUBLIC_URL ?? `http://localhost:${num(process.env.GAME_PORT, 9300)}`,

  /**
   * Players this instance will admit across *all* its games and maps. Advertised to the
   * api so a loaded instance stops being handed work. A single game's cap is not
   * this: it arrives with the order, because the api owns lobby sizes.
   */
  maxPlayers: num(process.env.MAX_PLAYERS, 48),

  /**
   * Games this instance will host at once.
   */
  maxGames: num(process.env.MAX_GAMES, 4),

  /**
   * How long a game may stand empty before it is over. Players are told about a
   * game before they have loaded the world, so one is legitimately empty for a
   * few seconds at the start; with no window, "empty ends it" would end every
   * game the instant it was created.
   */
  joinGraceMs: num(process.env.GAME_JOIN_GRACE_SECONDS, 60) * 1000,

  /**
   * The fixed tick, hertz. The server decides it and every client is told in its
   * `joined` and accumulates to match, so this is the one place it is set.
   */
  tickRate: num(process.env.TICK_RATE, TICK_RATE),

  /**
   * Metres between a client's claim and our replay of that *one step* before it
   * is worth a log line. A running player covers ~0.1 m in a 60 Hz tick, so half
   * of that is already a step the two ends disagree about badly. Nothing is
   * corrected at this drift or any other yet.
   */
  driftWarnMetres: num(process.env.DRIFT_WARN_METRES, 0.05),

  /**
   * The longest the navigation bake may hold the event loop before yielding,
   * ms (nav.ts). Kept well under a tick: the tick waits behind a slice, and one
   * longer than a tick makes the fixed-rate loop drop a pass. What it does not
   * change is the bake's wall time, which is its CPU time either way.
   */
  navSliceMs: num(process.env.NAV_SLICE_MS, 5),

  /**
   * SHOTTRACE — a temporary diagnostic (docs/engine/diagnostics-shottrace.md).
   *
   * Off unless it is set to `1` or `true`. With it unset nothing extra is sent
   * and the branch that would send it never runs, so a production fleet pays
   * one boolean read per tick and no bytes at all.
   */
  shotTrace: process.env.SHOT_TRACE === "1" || process.env.SHOT_TRACE === "true",
} as const;
