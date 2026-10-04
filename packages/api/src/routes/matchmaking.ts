// The matchmaking surface: what a player may ask for, and the stream that says
// what came of it.
//
// Every command here answers `{ ok: true }` and nothing else. What actually
// happened — which lobby, who is in it, when it starts, where to connect —
// arrives on the asker's event stream, so a lobby is described once rather than
// once in a response body and again in an event that has to agree with it.

import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { inject, singleton } from "tsyringe";
import type { UserEvent } from "@3d/shared/protocol/events/user.js";
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
import { Sessions } from "../auth/sessions.js";
import { eventStream } from "../events.js";
import { Matchmaker, type Refusal } from "../matchmaking/matchmaker.js";
import { Mount, type RouteGroup } from "./mount.js";

/** What a refusal means over HTTP. The matchmaker says why; this says what that is worth. */
const STATUS: Record<Refusal, 403 | 404 | 409 | 503> = {
  "no such lobby": 404,
  "lobby is full": 409,
  "game in progress": 409,
  "not the host": 403,
  "no server for that map": 503,
  "not in a lobby": 409,
  "no map chosen": 409,
  "no such map": 404,
  "the match is already starting": 409,
  // A name that is not in the table, against a name that is but does not belong
  // on this map: the first is a client asking for something that does not exist,
  // the second a conflict with the lobby as it stands.
  "no such gametype": 404,
  "that gametype is not played on that map": 409,
  "not a private lobby": 409,
  "nothing to end": 409,
};

const refuse = (why: Refusal): never => {
  throw new HTTPException(STATUS[why], { message: why });
};

const ok = { ok: true as const };

@singleton()
export class MatchmakingRoutes implements RouteGroup {
  constructor(
    @inject(Mount) private readonly mount: Mount,
    @inject(Matchmaker) private readonly matchmaker: Matchmaker,
    @inject(Sessions) private readonly sessions: Sessions,
  ) {}

  register(app: Hono): void {
    /**
     * Public, and signed out on purpose. EventSource cannot tell a 401 from a
     * dropped connection and reconnects on its own forever, so an expired session
     * would become a 401 flood nobody could see. Say so in-band and hang up; the
     * client's reader closes on that event instead of retrying into a wall.
     */
    this.mount.route(app, userEventsRoute, ({ c }) => {
      const user = this.sessions.user(c);

      if (!user) {
        return eventStream<UserEvent>(c, (sink) => {
          sink.send({ type: "unauthenticated" });
          sink.close();
        });
      }

      return eventStream<UserEvent>(c, (sink) => {
        // One stream per player: this one is theirs now, and whichever tab held
        // the last is told so and let go. Two tabs acting as one player would
        // each follow every matchReady into the same seat and take it from the
        // other, which the game server cannot tell from a reconnect.
        this.matchmaker.userEvents.displace(user.id, { type: "displaced" });
        // The whole state first, never a delta: EventSource reconnects by itself
        // and nothing here replays what was missed.
        for (const event of this.matchmaker.snapshotFor(user.id)) {
          sink.send(event);
        }
        return this.matchmaker.userEvents.subscribe(user.id, sink);
      });
    });

    this.mount.route(app, queueJoinRoute, ({ user }) => {
      this.matchmaker.enqueue(user!);
      return ok;
    });

    this.mount.route(app, queueLeaveRoute, ({ user }) => {
      this.matchmaker.leave(user!.id);
      return ok;
    });

    this.mount.route(app, lobbyCreateRoute, async ({ user, body }) => {
      const placed = await this.matchmaker.createLobby(user!, body.map ?? null);
      return placed.ok ? { code: placed.code } : refuse(placed.why);
    });

    this.mount.route(app, lobbyJoinRoute, ({ user, params: { code } }) => {
      const placed = this.matchmaker.joinLobby(user!, code);
      return placed.ok ? { code: placed.code } : refuse(placed.why);
    });

    this.mount.route(app, lobbyMapRoute, async ({ user, params: { code }, body }) => {
      const done = await this.matchmaker.setLobbyMap(user!, code, body.map);
      return done.ok ? ok : refuse(done.why);
    });

    this.mount.route(app, lobbyGametypeRoute, ({ user, params: { code }, body }) => {
      const done = this.matchmaker.setLobbyGametype(user!, code, body.gametype);
      return done.ok ? ok : refuse(done.why);
    });

    this.mount.route(app, lobbyStartRoute, ({ user, params: { code } }) => {
      const done = this.matchmaker.startLobby(user!, code);
      return done.ok ? ok : refuse(done.why);
    });

    this.mount.route(app, lobbyEndRoute, ({ user, params: { code } }) => {
      const done = this.matchmaker.endLobby(user!, code);
      return done.ok ? ok : refuse(done.why);
    });

    this.mount.route(app, lobbyLeaveRoute, ({ user }) => {
      this.matchmaker.leave(user!.id);
      return ok;
    });
  }
}
