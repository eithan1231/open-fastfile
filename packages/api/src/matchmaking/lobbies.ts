// A lobby: the room players stand in between games.
//
// In memory, and so true only of this process — deliberately. A lobby whose
// players all disconnected while the api was restarting is not state worth
// recovering, and the alternative is a table that has to be swept for corpses.
// What *does* outlive the process is the games that were played (db/schema.ts).
//
// A lobby outlives its games. It is `open` while it waits or counts down and
// `closed` while its game runs, and the game ending puts it back to `open` with
// the same people in it. That is why membership is not cleared anywhere in here
// except by someone leaving.

import { DEFAULT_GAMETYPE } from "@3d/shared/game/gametypes/registry.js";
import type { GametypeId } from "@3d/shared/game/gametypes/declaration.js";
import { singleton } from "tsyringe";
import { newAuthorizationKey, newLobbyCode, newPlayerId } from "./ids.js";

export type LobbyVisibility = "public" | "private";
export type LobbyStatus = "open" | "closed";

export interface LobbyUser {
  /** This player's id on the wire, for as long as they stay in this lobby. */
  readonly id: string;
  readonly userId: string;
  readonly username: string;
  readonly authorizationKey: string;
  /**
   * When this player was last known to be connected — they have an open event
   * stream, or did recently. Someone who closed the tab is dropped rather than
   * standing in the roster forever; see the matchmaker's presence sweep.
   */
  seenAt: number;
}

export interface Lobby {
  readonly code: string;
  readonly visibility: LobbyVisibility;
  /** Handed to whoever has been here longest when the host leaves; see `remove`. */
  hostUserId: string;
  readonly openedAt: number;
  /** Settled when the countdown arms — or at creation, for a private lobby. */
  map: string | null;
  /**
   * The rules this lobby's next game is played by.
   *
   * Always set, unlike `map`: there is a sensible default and no such thing as a
   * game with no rules, so this is `DEFAULT_GAMETYPE` from the moment the lobby
   * opens rather than null until someone chooses.
   */
  gametype: GametypeId;
  status: LobbyStatus;
  /** Absolute unix ms. Set means counting down. */
  startsAt: number | null;
  /** The instance this lobby's next (or current) game is on. */
  serverId: string | null;
  serverUrl: string | null;
  /** The game running now, while `closed`. */
  gameId: string | null;
  /**
   * When that game was ordered, until the instance reports it ready. Set means
   * the lobby is waiting on an instance that may never answer, which is what the
   * matchmaker's ready timeout is watching.
   */
  committedAt: number | null;
  users: LobbyUser[];
}

@singleton()
export class Lobbies {
  private readonly byCode = new Map<string, Lobby>();
  private readonly userLobby = new Map<string, string>();

  open(visibility: LobbyVisibility, host: { id: string; username: string }, map: string | null, now: number): Lobby {
    let code = newLobbyCode();
    while (this.byCode.has(code)) {
      code = newLobbyCode();
    }
    const lobby: Lobby = {
      code,
      visibility,
      hostUserId: host.id,
      openedAt: now,
      map,
      gametype: DEFAULT_GAMETYPE,
      status: "open",
      startsAt: null,
      serverId: null,
      serverUrl: null,
      gameId: null,
      committedAt: null,
      users: [],
    };
    this.byCode.set(code, lobby);
    return lobby;
  }

  get(code: string): Lobby | undefined {
    return this.byCode.get(code);
  }

  byUser(userId: string): Lobby | undefined {
    const code = this.userLobby.get(userId);
    return code === undefined ? undefined : this.byCode.get(code);
  }

  byGame(gameId: string): Lobby | undefined {
    return [...this.byCode.values()].find((lobby) => lobby.gameId === gameId);
  }

  all(): Lobby[] {
    return [...this.byCode.values()];
  }

  /** Adds the player and mints their wire identity. Returns the lobby, or undefined if it had no room. */
  add(lobby: Lobby, user: { id: string; username: string }, now: number, size: number): Lobby | undefined {
    const already = lobby.users.find((member) => member.userId === user.id);
    if (already) {
      already.seenAt = now;
      return lobby;
    }

    if (lobby.users.length >= size) {
      return undefined;
    }

    lobby.users.push({
      id: newPlayerId(),
      userId: user.id,
      username: user.username,
      authorizationKey: newAuthorizationKey(),
      seenAt: now,
    });

    this.userLobby.set(user.id, lobby.code);
    return lobby;
  }

  /**
   * Removes a player, and the lobby too once the last one goes.
   *
   * A host who leaves hands the lobby to whoever has been in it longest: only a
   * host can start a private lobby, so one whose host has gone would otherwise be
   * a room nobody can do anything in but leave.
   */
  remove(userId: string): Lobby | undefined {
    const code = this.userLobby.get(userId);
    if (code === undefined) {
      return undefined;
    }
    this.userLobby.delete(userId);
    const lobby = this.byCode.get(code);
    if (!lobby) {
      return undefined;
    }
    lobby.users = lobby.users.filter((member) => member.userId !== userId);
    if (lobby.users.length === 0) {
      this.drop(lobby);
    } else if (lobby.hostUserId === userId) {
      lobby.hostUserId = lobby.users[0]!.userId;
    }
    return lobby;
  }

  drop(lobby: Lobby): void {
    this.byCode.delete(lobby.code);
    for (const member of lobby.users) {
      this.userLobby.delete(member.userId);
    }
  }
}
