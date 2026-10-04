// Who the player is, and what the api has decided for them.
//
// The signed-in player's lifetime, as WorldSession is a loaded world's — which
// is why this is not called Session: the two live side by side in App, and one
// outlives many of the other.
//
// Two things live here, because they are one story: signing in, and the event
// stream that a signed-in player listens to. `net/events.ts` is the transport;
// this is the policy — what a `matchReady` means, when to go back to the menu,
// what the UI is told.
//
// It owns no three.js and no world. Entering and leaving a world is App's, which
// is why the two events that need one are handed out as callbacks rather than
// acted on here.

import { admitsMap, gametype } from "@3d/shared/game/gametypes/registry.js";
import { createApiClient, type ApiClient } from "@3d/shared/protocol/api.js";
import { HttpError } from "@3d/shared/protocol/http.js";
import type { UserEvent } from "@3d/shared/protocol/events/user.js";
import type { LoadoutsBody } from "@3d/shared/protocol/routes/loadouts.js";
import type { Loadout } from "@3d/shared/sim/loadout.js";
import type { MatchTicket } from "../net/connection.js";
import { UserEvents } from "../net/events.js";
import { inviteUrl } from "./invite.js";
import type { LobbyInfo, UiState } from "./uiBridge.js";

export interface PlayerSessionHandlers {
  /** A game is standing and this player is on its roster. */
  onMatchReady: (ticket: MatchTicket, map: string, gametype: string) => void;
  /** The round is over: the lobby is open again and the player belongs back in it. */
  onRoundOver: () => void;
  /** The player is in a lobby, as the api sees it. Where they should be looking at it is App's call. */
  onLobby: () => void;
  /**
   * The api says this player is in no lobby, and this end thought otherwise —
   * dropped for being away too long, or an api that restarted. Whatever they
   * were waiting for or playing is gone.
   */
  onLeft: () => void;
  /** Another tab is this player now. Nothing here is listening any more. */
  onDisplaced: () => void;
}

export class PlayerSession {
  private readonly api: ApiClient;
  private readonly events: UserEvents;
  /** The lobby's own view of itself, kept so a `matchReady` can be told from a stale one. */
  private gameId: string | undefined;

  constructor(
    private readonly ui: UiState,
    private readonly handlers: PlayerSessionHandlers,
  ) {
    // Same-origin: Vite proxies /api to the api in dev, and the api serves the
    // bundle itself in production. The session cookie rides along either way.
    this.api = createApiClient({ baseUrl: "", fetch: (url, init) => fetch(url, init as RequestInit) });
    this.events = new UserEvents({
      onEvent: (event) => this.receive(event),
      onUnauthenticated: () => this.signedOut(),
      onDisplaced: () => this.displaced(),
    });
  }

  /** Whether there is a session already. Called once at boot, before anything else. */
  async restore(): Promise<boolean> {
    try {
      this.ui.user.value = await this.api.me();
      this.events.start();
      void this.loadLoadouts();
      return true;
    } catch {
      // Any failure is "not signed in": the api being down looks the same from
      // here, and the answer — show the sign-in screen — is the same too.
      this.ui.user.value = null;
      return false;
    }
  }

  async signIn(username: string, password: string): Promise<boolean> {
    return this.authenticate(() => this.api.login({ username, password }));
  }

  async register(username: string, password: string): Promise<boolean> {
    return this.authenticate(() => this.api.register({ username, password }));
  }

  async signOut(): Promise<void> {
    this.events.stop();
    this.clear();
    this.ui.user.value = null;
    try {
      await this.api.logout();
    } catch {
      // The cookie may already be gone. Either way the player is signed out here.
    }
  }

  /**
   * The player's classes, from the authority.
   *
   * Read rather than kept: the api reconciles a stored class against the
   * catalogue as it stands, so a weapon that has gone since it was saved comes
   * back as an empty slot. A client that decided that for itself would be
   * guessing at another process's catalogue.
   */
  async loadLoadouts(): Promise<void> {
    try {
      this.applyLoadouts(await this.api.loadouts());
    } catch (err: unknown) {
      // Not fatal: the menu shows five empty classes, and a world is still
      // walkable. Saving one will say so again, louder.
      console.warn("could not load this player's classes:", err);
    }
  }

  saveLoadout(index: number, loadout: Loadout): void {
    void this.api
      .saveLoadout({ index: String(index) }, loadout)
      .then((body) => this.applyLoadouts(body))
      .catch((err: unknown) => this.complain("could not save that class", err));
  }

  selectLoadout(index: number): void {
    // Written before the api answers: choosing a class is the one thing in this
    // menu that must feel instant, and the answer replaces it a moment later.
    this.ui.selectedLoadout.value = index;
    void this.api
      .selectLoadout({ index: String(index) })
      .then((body) => this.applyLoadouts(body))
      .catch((err: unknown) => this.complain("could not choose that class", err));
  }

  private applyLoadouts(body: LoadoutsBody): void {
    this.ui.loadouts.value = body.loadouts;
    this.ui.selectedLoadout.value = body.selected;
  }

  findGame(): void {
    this.attempt(this.api.queueJoin(), "could not join the queue");
  }

  createPrivateLobby(): void {
    // No map: a private match picks one *in* the lobby, so everyone already
    // there watches the host choose.
    this.attempt(this.api.lobbyCreate({}), "could not make a lobby");
  }

  setLobbyMap(map: string): void {
    const code = this.ui.lobby.value?.code;
    if (code === undefined) {
      return;
    }
    this.attempt(this.api.lobbyMap({ code }, { map }), "could not choose that map");
  }

  /**
   * Choose the gametype. The api checks it against the map, and the instance
   * against the map's game (a chase on a map with no navigation is refused
   * there). On a map it is not played on, the map is moved first — to the first
   * one it is — because the api refuses the gametype until it is.
   */
  setLobbyMode(id: string): void {
    const lobby = this.ui.lobby.value;
    const decl = gametype(id);
    if (!lobby || !decl) {
      return;
    }
    const code = lobby.code;
    const moveTo = lobby.map !== null && !admitsMap(decl, lobby.map) ? (decl.maps?.[0] ?? null) : null;
    const asked = (async () => {
      if (moveTo !== null) {
        await this.api.lobbyMap({ code }, { map: moveTo });
      }
      await this.api.lobbyGametype({ code }, { gametype: id });
    })();
    this.attempt(asked, "could not change the mode");
  }

  joinLobby(code: string): void {
    this.attempt(this.api.lobbyJoin({ code }), `could not join lobby ${code}`);
  }

  startLobby(): void {
    const code = this.ui.lobby.value?.code;
    if (code !== undefined) {
      this.attempt(this.api.lobbyStart({ code }), "could not start the round");
    }
  }

  /** Stop the countdown, or end the running match for everyone in it. The host's, in a private lobby. */
  endLobby(): void {
    const code = this.ui.lobby.value?.code;
    if (code !== undefined) {
      this.attempt(this.api.lobbyEnd({ code }), "could not end the match");
    }
  }

  leave(): void {
    this.attempt(this.api.lobbyLeave(), "could not leave");
    this.clear();
  }

  /** In a lobby or the queue, as far as this end has been told. */
  get inLobby(): boolean {
    return this.ui.lobby.value !== null || this.ui.searching.value;
  }

  /**
   * Take this player back from whichever tab has them. Opening the stream is the
   * whole of it: the api displaces the other, and the snapshot that leads the
   * new stream puts this one back in the lobby — or the match — it was in.
   */
  playHere(): void {
    this.events.start();
  }

  dispose(): void {
    this.events.stop();
  }

  private async authenticate(attempt: () => Promise<{ id: string; username: string }>): Promise<boolean> {
    this.ui.authBusy.value = true;
    this.ui.authError.value = null;
    try {
      this.ui.user.value = await attempt();
      this.events.start();
      return true;
    } catch (err) {
      this.ui.authError.value = reason(err);
      return false;
    } finally {
      this.ui.authBusy.value = false;
    }
  }

  private receive(event: UserEvent): void {
    switch (event.type) {
      case "searching":
        this.ui.searching.value = true;
        this.ui.lobby.value = null;
        return;

      case "lobby": {
        const playing = event.status === "closed";
        const me = this.ui.user.value;
        const lobby: LobbyInfo = {
          code: event.code,
          private: event.visibility === "private",
          map: event.map,
          mode: gametype(event.gametype)?.display ?? event.gametype,
          gametype: event.gametype,
          playing,
          startsAt: event.startsAt,
          players: event.players,
          // The host flag is per-player, and the event describes the lobby, so
          // it is read off this player's own row.
          host: event.players.some((player) => player.host && player.username === me?.username),
          invite: event.visibility === "private" ? inviteUrl(event.code) : null,
        };
        const wasPlaying = this.ui.lobby.value?.playing === true;
        this.ui.lobby.value = lobby;
        this.ui.searching.value = false;
        // An open lobby arriving while the round was running is how a game ends.
        // The api saying so is authoritative; a dropped data channel is not.
        if (wasPlaying && !playing) {
          this.gameId = undefined;
          this.handlers.onRoundOver();
        }
        this.handlers.onLobby();
        return;
      }

      case "matchReady": {
        // A repeat of the same game is ordinary — the api answers a re-ask — and
        // acting on it twice would reload the world under a player already in it.
        if (this.gameId === event.gameId) {
          return;
        }
        this.gameId = event.gameId;
        this.handlers.onMatchReady(
          {
            gameId: event.gameId,
            playerId: event.playerId,
            authorizationKey: event.authorizationKey,
            serverUrl: event.serverUrl,
          },
          event.map,
          event.gametype,
        );
        return;
      }

      case "left": {
        // Also the answer to this player's own Leave, which has already cleared
        // everything here — so only a `left` nobody here asked for is news.
        const news = this.inLobby;
        this.clear();
        if (news) {
          this.handlers.onLeft();
        }
        return;
      }

      case "unauthenticated":
      case "displaced":
        // Handled in net/events.ts, which closes the stream before this could run.
        return;
    }
  }

  private signedOut(): void {
    this.clear();
    this.ui.user.value = null;
    this.ui.screen.value = "auth";
  }

  private displaced(): void {
    this.clear();
    this.handlers.onDisplaced();
  }

  private clear(): void {
    this.ui.lobby.value = null;
    this.ui.lobbyError.value = null;
    this.ui.searching.value = false;
    this.gameId = undefined;
  }

  /**
   * Ask the api for something, and put a refusal in front of the player.
   *
   * Never an error screen: matchmaking failing leaves the rest of the game
   * exactly as it was. But it is not nothing either — the api refuses these in
   * words, and swallowing them is what makes "Start Match" with no game server
   * running look like a button that is not wired up.
   */
  private attempt(asked: Promise<unknown>, what: string): void {
    this.ui.lobbyError.value = null;
    void asked.catch((err: unknown) => {
      const why = refusal(err);
      console.warn(`[matchmaking] ${what}: ${why}`);
      this.ui.lobbyError.value = `${what}: ${why}`;
    });
  }

  private complain(what: string, err: unknown): void {
    // Never an error screen: a class that would not save leaves the rest of the
    // game exactly as it was.
    console.warn(`[loadouts] ${what}: ${reason(err)}`);
  }
}

/**
 * Why the api said no, in its own words where it gave any.
 *
 * The matchmaking routes refuse with an HTTPException, whose message Hono writes
 * as the body — so "no server for that map" survives all the way here. A json
 * body is the mechanism's own (mount.ts answers 401 with one) and is not a
 * sentence, so those fall back to the status.
 */
function refusal(err: unknown): string {
  if (err instanceof HttpError && err.detail && !err.detail.startsWith("{")) {
    return err.detail;
  }
  return err instanceof HttpError ? `the server said ${err.status}` : "could not reach the server";
}

/**
 * What to show a player about a sign-in failure. By status rather than by what
 * the api said: these are the answers a form needs ("that name is taken"), and
 * the refusal in the body names the field that failed, which is not one.
 */
function reason(err: unknown): string {
  if (err instanceof HttpError) {
    if (err.status === 401) {
      return "Wrong username or password.";
    }
    if (err.status === 409) {
      return "That name is taken.";
    }
    if (err.status === 400) {
      return "Names are 3-24 letters, digits or underscores; passwords are at least 8 characters.";
    }
    return `Something went wrong (${err.status}).`;
  }
  return "Could not reach the server.";
}
