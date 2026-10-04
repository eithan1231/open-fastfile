// Matchmaking: turning people who pressed a button into a game on an instance.
//
// Everything here is a decision the authority makes, and every one of them is
// published rather than returned — a route only ever says "I asked", and what
// came of it arrives on the caller's event stream. That is why a lobby is
// described in exactly one place (protocol/events/user.ts) instead of once in a
// response body and again in an event that has to agree with it.
//
// -- The lobby's three states ------------------------------------------------
//
//   open, no startsAt    waiting for enough people
//   open, startsAt       counting down; the map is settled and on screen
//   closed               its game is running
//
// A game ending puts the lobby back to `open` with the same people in it, so the
// countdown arms again on the next tick. A lobby is a room, not a queue artifact
// that is consumed. So does a game the fleet never stood up: a refusal reopens
// it at once, silence is waited out for `readyTimeoutMs`, or its players have
// nowhere to go — and a running game whose instance has stopped heartbeating is
// over too, for the same reason.
//
// `tick()` owns no timer: MatchmakingLoop (matchmaking/loop.ts) drives it, and a
// test drives it by hand. Nothing in here can hold a process open.

import { admitsMap, DEFAULT_GAMETYPE, gametype } from "@3d/shared/game/gametypes/registry.js";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { inject, singleton } from "tsyringe";
import type { GameOrder, ServerEvent } from "@3d/shared/protocol/events/server.js";
import type { LobbyPlayer, UserEvent } from "@3d/shared/protocol/events/user.js";
import type { SessionUser } from "@3d/shared/protocol/routes/auth.js";
import { Clock } from "../clock.js";
import { Config, type MatchmakingConfig } from "../config.js";
import { Sqlite } from "../db/database.js";
import { games } from "../db/schema.js";
import { Subscribers } from "../events.js";
import { Loadouts } from "../loadouts.js";
import { Registry } from "../registry.js";
import { ManifestCache } from "../worlds/manifestCache.js";
import { Lobbies, type Lobby, type LobbyUser } from "./lobbies.js";
import { Placement } from "./placement.js";
import { Queue } from "./queue.js";

/** Why a command could not be carried out. The handler turns these into status codes. */
export type Refusal =
  | "no such lobby"
  | "lobby is full"
  | "game in progress"
  | "not the host"
  | "no server for that map"
  | "not in a lobby"
  | "no map chosen"
  | "no such map"
  | "the match is already starting"
  | "no such gametype"
  | "that gametype is not played on that map"
  | "not a private lobby"
  | "nothing to end";

export type Placed = { ok: true; code: string } | { ok: false; why: Refusal };
export type Done = { ok: true } | { ok: false; why: Refusal };

@singleton()
export class Matchmaker {
  /** What a player hears. The leading event is always a whole state, never a delta. */
  readonly userEvents = new Subscribers<UserEvent>();
  /** What an instance is told to do. */
  readonly serverEvents = new Subscribers<ServerEvent>();

  private readonly config: MatchmakingConfig;

  constructor(
    @inject(Sqlite) private readonly sqlite: Sqlite,
    @inject(Registry) private readonly registry: Registry,
    @inject(Clock) private readonly clock: Clock,
    @inject(Lobbies) private readonly lobbies: Lobbies,
    @inject(Queue) private readonly queue: Queue,
    @inject(Loadouts) private readonly loadouts: Loadouts,
    @inject(Placement) private readonly placement: Placement,
    @inject(ManifestCache) private readonly manifest: ManifestCache,
    @inject(Config) config: Config,
  ) {
    this.config = config.matchmaking;
  }

  // -- What a route asks for -------------------------------------------------

  /**
   * The leading events on a player's stream: everything, never a delta.
   *
   * A running game's `matchReady` is part of "everything". Without it a browser
   * that reloads mid-match is told it is in a closed lobby and nothing else, and
   * sits on the menu while the api counts it as playing. Every member of a
   * closed lobby is on its game's roster, because a closed lobby cannot be
   * joined, so the ticket is always one the instance will admit.
   */
  snapshotFor(userId: string): UserEvent[] {
    const lobby = this.lobbies.byUser(userId);
    if (lobby) {
      const member = lobby.users.find((user) => user.userId === userId)!;
      return this.running(lobby) ? [this.view(lobby), this.ticketFor(lobby, member)] : [this.view(lobby)];
    }
    const since = this.queue.since(userId);
    return [since === undefined ? { type: "left" } : { type: "searching", since }];
  }

  /** The leading event on an instance's stream: everything it should be running. */
  helloFor(serverId: string): ServerEvent {
    const running = this.lobbies.all().filter((lobby) => lobby.status === "closed" && lobby.serverId === serverId && lobby.gameId !== null);
    return { type: "hello", games: running.map((lobby) => this.orderFor(lobby)) };
  }

  enqueue(user: SessionUser): void {
    const already = this.lobbies.byUser(user.id);
    if (already) {
      // Already standing in one. Said again rather than ignored, so a client that
      // lost track of its lobby is put back in step by asking.
      this.userEvents.publish(user.id, this.view(already));
      return;
    }
    this.queue.add(user, this.clock.now());
    this.userEvents.publish(user.id, { type: "searching", since: this.queue.since(user.id)! });
  }

  /**
   * A private lobby, with or without a map. Without one it stands open until its
   * host picks one — which is where a private match chooses its map, so that
   * everybody already in the lobby can see the choice being made.
   */
  async createLobby(user: SessionUser, map: string | null): Promise<Placed> {
    if (map !== null) {
      if (!(await this.knownMap(map))) {
        return { ok: false, why: "no such map" };
      }
      if (!admitsMap(gametype(DEFAULT_GAMETYPE)!, map)) {
        return { ok: false, why: "that gametype is not played on that map" };
      }
    }
    this.depart(user.id);
    const lobby = this.lobbies.open("private", user, map, this.clock.now());
    this.lobbies.add(lobby, user, this.clock.now(), this.config.lobbySize);
    this.publishLobby(lobby);
    return { ok: true, code: lobby.code };
  }

  joinLobby(user: SessionUser, code: string): Placed {
    const lobby = this.lobbies.get(code);
    if (!lobby) {
      return { ok: false, why: "no such lobby" };
    }
    if (lobby.status === "closed") {
      return { ok: false, why: "game in progress" };
    }
    const already = this.lobbies.byUser(user.id);
    if (already && already.code !== code) {
      this.depart(user.id);
    }
    if (!this.lobbies.add(lobby, user, this.clock.now(), this.config.lobbySize)) {
      return { ok: false, why: "lobby is full" };
    }
    this.queue.remove(user.id);
    this.publishLobby(lobby);
    return { ok: true, code: lobby.code };
  }

  /**
   * Choose the map. Checked against the worlds on disk before the lobby is, so
   * the await is behind us before any lobby state is read.
   */
  async setLobbyMap(user: SessionUser, code: string, map: string): Promise<Done> {
    if (!(await this.knownMap(map))) {
      return { ok: false, why: "no such map" };
    }
    return this.hostCommand(user, code, (lobby) => {
      if (!admitsMap(gametype(lobby.gametype)!, map)) {
        return { ok: false, why: "that gametype is not played on that map" };
      }
      lobby.map = map;
      this.publishLobby(lobby);
      return { ok: true };
    });
  }

  /**
   * Choose the rules.
   *
   * Only half the admission check happens here, and deliberately: a gametype may
   * restrict itself to certain source games, and which game a world came from is
   * in its text rather than in the manifest — so the authority checks the name and
   * the map, and the instance, which has the resolved world, checks the rest. See
   * `admitsMap`.
   */
  setLobbyGametype(user: SessionUser, code: string, id: string): Done {
    return this.hostCommand(user, code, (lobby) => {
      const decl = gametype(id);
      if (!decl) {
        return { ok: false, why: "no such gametype" };
      }
      if (lobby.map !== null && !admitsMap(decl, lobby.map)) {
        return { ok: false, why: "that gametype is not played on that map" };
      }
      lobby.gametype = decl.id;
      this.publishLobby(lobby);
      return { ok: true };
    });
  }

  /**
   * A private lobby starts when its host says so, however few people are in it —
   * that is the difference between an invite and a queue.
   */
  startLobby(user: SessionUser, code: string): Done {
    return this.hostCommand(user, code, (lobby) => {
      if (lobby.map === null) {
        return { ok: false, why: "no map chosen" };
      }
      return this.arm(lobby) ? { ok: true } : { ok: false, why: "no server for that map" };
    });
  }

  /**
   * Stop what a private lobby is doing, so that its host can change it: a
   * countdown goes back to waiting, and a running game ends for everyone in it.
   *
   * Ending a game is the same reopening an instance's report gets, with the
   * instance told to drop it — so the players land back in the lobby by the one
   * path that already takes them there, and the report the instance would have
   * sent is not needed.
   */
  endLobby(user: SessionUser, code: string): Done {
    return this.hostCommand(
      user,
      code,
      (lobby) => {
        if (lobby.status === "closed" && lobby.gameId !== null) {
          console.log(`game ${lobby.gameId} ended by the host of lobby ${lobby.code}`);
          this.serverEvents.publish(lobby.serverId!, { type: "gameEnd", gameId: lobby.gameId });
          this.gameEnded(lobby.gameId);
          return { ok: true };
        }
        if (lobby.startsAt !== null) {
          this.disarm(lobby);
          return { ok: true };
        }
        return { ok: false, why: "nothing to end" };
      },
      "any",
    );
  }

  /** Out of the queue and out of any lobby. */
  leave(userId: string): void {
    this.depart(userId);
    this.userEvents.publish(userId, { type: "left" });
  }

  // -- What an instance reports ----------------------------------------------

  /** An instance has the game standing. Its players are told where to go. */
  gameReady(gameId: string): boolean {
    const lobby = this.lobbies.byGame(gameId);
    if (!lobby) {
      return false;
    }
    this.sqlite.db.update(games).set({ status: "started", startedAt: this.clock.seconds() }).where(eq(games.id, gameId)).run();
    // It answered, so the ready timeout has nothing left to watch for.
    lobby.committedAt = null;
    for (const member of lobby.users) {
      this.userEvents.publish(member.userId, this.ticketFor(lobby, member));
    }
    return true;
  }

  /** A game is over. Its lobby reopens with the same people in it. */
  gameEnded(gameId: string): boolean {
    return this.reopen(gameId, "ended");
  }

  /**
   * An instance would not host a game, or could not keep it. Its lobby reopens
   * now rather than at the ready timeout, and its next game is placed elsewhere:
   * the same instance would most likely refuse it again.
   */
  gameRefused(gameId: string, reason: string | undefined): boolean {
    const lobby = this.lobbies.byGame(gameId);
    if (lobby) {
      console.warn(`game ${gameId} refused by ${lobby.serverId}${reason ? `: ${reason}` : ""}; reopening lobby ${lobby.code}`);
      this.placement.refused(lobby, lobby.serverId!);
    }
    return this.reopen(gameId, "refused");
  }

  private reopen(gameId: string, status: "ended" | "refused"): boolean {
    this.sqlite.db.update(games).set({ status, endedAt: this.clock.seconds() }).where(eq(games.id, gameId)).run();
    const lobby = this.lobbies.byGame(gameId);
    if (!lobby) {
      return false;
    }
    // Back to the room they came from, with the same people in it. The next
    // tick arms the next round.
    lobby.status = "open";
    lobby.gameId = null;
    lobby.committedAt = null;
    lobby.startsAt = null;
    lobby.serverId = null;
    lobby.serverUrl = null;
    if (lobby.visibility === "public") {
      lobby.map = null;
    }
    if (lobby.users.length === 0) {
      this.lobbies.drop(lobby);
      return true;
    }
    this.publishLobby(lobby);
    return true;
  }

  // -- The pass --------------------------------------------------------------

  tick(): void {
    this.sweepPresence();
    this.place();

    const at = this.clock.now();
    const live = new Set(this.registry.live().map((server) => server.id));
    for (const lobby of this.lobbies.all()) {
      if (lobby.status !== "open") {
        this.abandonIfStillborn(lobby, at);
        this.abandonIfOrphaned(lobby, live);
        continue;
      }

      if (lobby.users.length === 0) {
        this.lobbies.drop(lobby);
        continue;
      }

      const enough = lobby.users.length >= this.config.minPlayers;

      if (lobby.startsAt === null) {
        // A private lobby waits for its host, however full it is.
        if (enough && lobby.visibility === "public") {
          this.arm(lobby);
        }
        continue;
      }

      if (!enough && lobby.visibility === "public") {
        this.disarm(lobby);
        continue;
      }

      if (lobby.startsAt <= at) {
        this.commit(lobby);
      }
    }
  }

  /** What the matchmaker is holding. Asserted on by tests; nothing serves it yet. */
  describe(): { queued: number; lobbies: number } {
    return { queued: this.queue.waiting().length, lobbies: this.lobbies.all().length };
  }

  // -- Inside ----------------------------------------------------------------

  /**
   * The prelude every host command shares. Private only: a public lobby's host is
   * whoever the queue put there first, and its map, rules and start are the
   * playlist's. `waiting` is everything but `endLobby`: once the countdown runs,
   * everyone has seen what they are about to play, and swapping it is worse than
   * making them wait.
   */
  private hostCommand(user: SessionUser, code: string, command: (lobby: Lobby) => Done, when: "waiting" | "any" = "waiting"): Done {
    const lobby = this.lobbies.get(code);
    if (!lobby) {
      return { ok: false, why: "no such lobby" };
    }
    if (lobby.hostUserId !== user.id) {
      return { ok: false, why: "not the host" };
    }
    if (lobby.visibility !== "private") {
      return { ok: false, why: "not a private lobby" };
    }
    if (when === "waiting" && lobby.status === "closed") {
      return { ok: false, why: "game in progress" };
    }
    if (when === "waiting" && lobby.startsAt !== null) {
      return { ok: false, why: "the match is already starting" };
    }
    return command(lobby);
  }

  /** A world on disk. The route has already checked it is shaped like a slug. */
  private async knownMap(map: string): Promise<boolean> {
    return (await this.manifest.get()).some((entry) => entry.slug === map);
  }

  private view(lobby: Lobby): UserEvent {
    return {
      type: "lobby",
      code: lobby.code,
      visibility: lobby.visibility,
      map: lobby.map,
      gametype: lobby.gametype,
      status: lobby.status,
      startsAt: lobby.startsAt,
      players: lobby.users.map((member): LobbyPlayer => ({ id: member.id, username: member.username, host: member.userId === lobby.hostUserId })),
    };
  }

  /** Its game is standing: ordered, and reported ready by its instance. */
  private running(lobby: Lobby): boolean {
    return lobby.status === "closed" && lobby.gameId !== null && lobby.committedAt === null;
  }

  /** Where one member goes to play their lobby's game, and who to say they are. */
  private ticketFor(lobby: Lobby, member: LobbyUser): UserEvent {
    return {
      type: "matchReady",
      gameId: lobby.gameId!,
      playerId: member.id,
      authorizationKey: member.authorizationKey,
      serverUrl: lobby.serverUrl!,
      map: lobby.map!,
      gametype: lobby.gametype,
    };
  }

  /** Out of the queue and out of any lobby, telling whoever is left — but not the player, who is going somewhere. */
  private depart(userId: string): void {
    this.queue.remove(userId);
    const lobby = this.lobbies.remove(userId);
    if (lobby && this.lobbies.get(lobby.code)) {
      this.publishLobby(lobby);
    }
  }

  /** Everyone in a lobby sees the same lobby, so it is built once and sent to each. */
  private publishLobby(lobby: Lobby): void {
    const event = this.view(lobby);
    for (const member of lobby.users) {
      this.userEvents.publish(member.userId, event);
    }
  }

  private orderFor(lobby: Lobby): GameOrder {
    return {
      gameId: lobby.gameId!,
      map: lobby.map!,
      gametype: lobby.gametype,
      maxPlayers: this.config.lobbySize,
      durationSeconds: this.config.gameDurationSeconds,
      players: lobby.users.map((member) => ({
        id: member.id,
        authorizationKey: member.authorizationKey,
        loadouts: this.loadouts.stored(member.userId),
      })),
    };
  }

  /**
   * The map and the instance, settled together. A public lobby picks from the
   * playlist; a private one was told its map when it was made. Either way what
   * can block this is capacity — an instance with room — and not which maps the
   * fleet happens to have loaded.
   */
  private reserve(lobby: Lobby): boolean {
    // The playlist is the whole playlist: any instance can host any of it.
    const map = lobby.map ?? this.config.maps[Math.floor(Math.random() * this.config.maps.length)];
    const server = map === undefined ? undefined : this.placement.pick(lobby, map);
    if (!server) {
      return false;
    }
    lobby.map = map!;
    lobby.serverId = server.id;
    lobby.serverUrl = server.url;
    return true;
  }

  /** Settle the map and the server, and put the countdown on everyone's screen. */
  private arm(lobby: Lobby): boolean {
    if (!this.reserve(lobby)) {
      return false;
    }
    lobby.startsAt = this.clock.now() + this.config.countdownSeconds * 1000;
    this.publishLobby(lobby);
    return true;
  }

  /**
   * A game the fleet was ordered to stand up and never did.
   *
   * `gameReady` is the only thing that releases a lobby's players, so until it
   * arrives they are standing in a `closed` lobby that shows a match in progress
   * they were never sent to. Giving up is bounded here rather than reported by
   * the instance because the failures that matter are the ones it cannot report:
   * it crashed, it restarted under a new id — and `hello` is per-instance, so
   * nothing reclaims the game — or it never received the order at all.
   */
  private abandonIfStillborn(lobby: Lobby, at: number): void {
    if (lobby.committedAt === null || at - lobby.committedAt < this.config.readyTimeoutMs) {
      return;
    }
    console.warn(`game ${lobby.gameId} on ${lobby.serverId} never reported ready; reopening lobby ${lobby.code}`);
    // Told to drop it in case it is alive after all and merely slow, so that an
    // instance is not left holding a world for a game nobody will be sent to.
    this.serverEvents.publish(lobby.serverId!, { type: "gameEnd", gameId: lobby.gameId! });
    // The same reopening a finished game gets: the lobby is a room, and the
    // people in it are still in it. The row records a game that never started.
    this.gameEnded(lobby.gameId!);
  }

  /**
   * A running game whose instance has stopped heartbeating. It crashed or was
   * shut down, and nothing will ever report the game over — so without this its
   * lobby stays closed for good, and a closed lobby can be neither joined nor
   * started. Ready games only: one still starting is `abandonIfStillborn`'s.
   */
  private abandonIfOrphaned(lobby: Lobby, live: ReadonlySet<string>): void {
    if (!this.running(lobby) || live.has(lobby.serverId!)) {
      return;
    }
    console.warn(`game ${lobby.gameId} was on ${lobby.serverId}, which has stopped heartbeating; reopening lobby ${lobby.code}`);
    this.gameEnded(lobby.gameId!);
  }

  private disarm(lobby: Lobby): void {
    lobby.startsAt = null;
    lobby.serverId = null;
    lobby.serverUrl = null;
    if (lobby.visibility === "public") {
      lobby.map = null;
    }
    this.publishLobby(lobby);
  }

  /** The countdown has run out: commit to a game and tell the instance to stand it up. */
  private commit(lobby: Lobby): void {
    // Thirty seconds is long enough for the reserved instance to have gone, or to
    // have filled with games this api did not order.
    if (!this.placement.holds(lobby) && !this.reserve(lobby)) {
      this.disarm(lobby);
      return;
    }
    const gameId = randomUUID();
    this.sqlite.db
      .insert(games)
      .values({
        id: gameId,
        lobbyId: lobby.code,
        serverId: lobby.serverId!,
        map: lobby.map!,
        status: "starting",
        createdAt: this.clock.seconds(),
      })
      .run();
    lobby.gameId = gameId;
    lobby.status = "closed";
    lobby.committedAt = this.clock.now();
    lobby.startsAt = null;
    this.publishLobby(lobby);
    this.serverEvents.publish(lobby.serverId!, { type: "gameCreate", game: this.orderFor(lobby) });
  }

  /**
   * Drop anyone who has had no event stream for a while. A closed tab is the
   * common case and there is nothing else that would ever remove them — the
   * stream is the only liveness signal a browser gives us.
   */
  private sweepPresence(): void {
    const now = this.clock.now();
    const cutoff = now - this.config.presenceTimeoutMs;
    for (const entry of this.queue.waiting()) {
      if (this.userEvents.listeners(entry.userId) > 0) {
        this.queue.touch(entry.userId, now);
      } else if (entry.seenAt < cutoff) {
        this.queue.remove(entry.userId);
      }
    }
    for (const lobby of this.lobbies.all()) {
      for (const member of [...lobby.users]) {
        if (this.userEvents.listeners(member.userId) > 0) {
          member.seenAt = now;
        } else if (member.seenAt < cutoff) {
          this.lobbies.remove(member.userId);
          if (this.lobbies.get(lobby.code)) {
            this.publishLobby(lobby);
          }
        }
      }
    }
  }

  /** Everyone waiting, into a public lobby with room — the oldest first. */
  private place(): void {
    for (const entry of this.queue.waiting()) {
      if (this.lobbies.byUser(entry.userId)) {
        this.queue.remove(entry.userId);
        continue;
      }

      const open = this.lobbies.all().find((lobby) => lobby.visibility === "public" && lobby.status === "open" && lobby.users.length < this.config.lobbySize);

      const user = { id: entry.userId, username: entry.username };
      const lobby = open ?? this.lobbies.open("public", user, null, this.clock.now());

      if (!this.lobbies.add(lobby, user, this.clock.now(), this.config.lobbySize)) {
        continue;
      }

      this.queue.remove(entry.userId);

      this.publishLobby(lobby);
    }
  }
}
