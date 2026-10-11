// What the HUD shows, and where each number is allowed to come from.
//
// The rule this file exists to keep: **health, death and ammunition are the
// server's answer, and a hit marker is the server's answer about a shot it
// traced itself.** The client predicts its own movement and its own weapon, and
// a HUD built from that prediction would be a display of what this browser hopes
// happened — a full health bar for a player being shot at, until the correction
// arrived. So `snapshot` is the way in, `local` is refused while a match is
// running, and nothing here can reach the predicted `Player` at all.
//
// Plain data out, signals only: this writes `UiState` and the UI reads it
// (app/uiBridge.ts).

import type { DeathEvent, GameEvent } from "@3d/shared/net/messages/events.js";
import { isSuicide, type DamageCause } from "@3d/shared/game/damage.js";
import type { JoinedMessage } from "@3d/shared/net/messages/session.js";
import type { PlayerId } from "@3d/shared/net/messages/fields.js";
import type { PlayerState } from "@3d/shared/sim/player.js";
import { DEFAULT_COMBAT_RULES } from "@3d/shared/game/rules.js";
import type { WeaponRegistry } from "@3d/shared/sim/weaponRegistry.js";
import type { GametypeDecl } from "@3d/shared/game/gametypes/declaration.js";
import type { HudCounter, HudPlayerInfo, KillFeedEntry, UiState } from "./uiBridge.js";

/** Lines the feed keeps, and how long one stays. The games' own figures, near enough. */
const FEED_LINES = 5;
const FEED_SECONDS = 7;

export class Hud {
  /** Until `joined` says otherwise: an offline world plays by the defaults too. */
  private maxHealth = DEFAULT_COMBAT_RULES.maxHealth;
  /** Who this player is on the wire, so their own kills read differently. Undefined offline. */
  private me: PlayerId | undefined;
  /** The gametype brings the dead back itself: no countdown to show (`CombatRules.respawnDelay`). */
  private noCountdown = false;
  /** What the gametype keeps that the HUD shows: its counters' names, and whether there are points. */
  private counterNames: readonly string[] = [];
  private keepsPoints = false;
  /**
   * A game server is answering. While it is, `local` is ignored — that is the
   * whole of "the server decides", and it is one flag rather than a rule each
   * caller has to remember.
   */
  private connected = false;
  /** In the world on foot. Outside it there is no HUD at all, whatever the wire says. */
  private walking = false;
  /** The feed, newest first, with the moment each line arrived: the signal carries lines and not clocks. */
  private readonly lines: { line: KillFeedEntry; at: number }[] = [];

  constructor(
    private readonly ui: UiState,
    /** Asked each time: the catalogue arrives after boot, and a weapon index means nothing before it. */
    private readonly weapons: () => WeaponRegistry,
  ) {}

  /** Whether a game server is answering, and so whose numbers these are. */
  get live(): boolean {
    return this.connected;
  }

  /**
   * In a match: the rules give the bar its denominator, `you` says which feed
   * lines are ours, and the gametype — undefined for one this build does not
   * know — says which of the match's numbers there are to show.
   */
  joined(message: JoinedMessage, you: PlayerId, gametype?: GametypeDecl): void {
    this.maxHealth = message.rules.maxHealth;
    this.noCountdown = !message.rules.timedRespawn;
    this.me = you;
    this.connected = true;
    this.counterNames = gametype?.counters ?? [];
    this.keepsPoints = gametype?.points === true;
    this.ui.hud.counters.value = this.counterNames.map((name) => ({ name, value: 0 }));
  }

  /**
   * The gametype's counters as the snapshot carries them — values in the
   * declaration's order — written only when one has changed.
   */
  counters(values: readonly number[]): void {
    const next: HudCounter[] = this.counterNames.map((name, i) => ({ name, value: values[i] ?? 0 }));
    const last = this.ui.hud.counters.value;
    if (next.length !== last.length || next.some((counter, i) => counter.value !== last[i]!.value || counter.name !== last[i]!.name)) {
      this.ui.hud.counters.value = next;
    }
  }

  /** Whether the player is on foot in the world. The HUD is nothing in the dollhouse or between worlds. */
  setWalking(walking: boolean): void {
    if (this.walking !== walking) {
      this.walking = walking;
      if (!walking) {
        this.ui.hud.player.value = null;
      }
    }
  }

  /**
   * One authoritative tick: the player's own state as the server has it, and
   * what has happened that they have not been told yet.
   *
   * `events` is already de-duplicated (net/connection.ts), so this appends
   * blindly. De-duplicating here as well would hide the day that stops being
   * true, and a kill feed that silently swallows a repeat looks exactly like one
   * that never had a repeat to swallow.
   */
  snapshot(self: PlayerState | undefined, events: readonly GameEvent[], now: number): void {
    if (self) {
      this.publish(self);
      const points = this.keepsPoints ? self.points : null;
      if (this.ui.hud.points.value !== points) {
        this.ui.hud.points.value = points;
      }
    }
    for (const event of events) {
      // Named rather than defaulted: the tail carries physics spawns now, and an
      // `else` here would have put a corpse in the kill feed. A fifth kind is a
      // compile error in this switch, which is where it should be noticed.
      switch (event.kind) {
        case "hit":
          this.ui.hud.hit.value = { id: event.id, lethal: event.lethal };
          break;
        case "death":
          this.addKill(event, now);
          break;
        case "spawn":
          break; // the HUD has nothing to say about a body on the floor
      }
    }
    this.expire(now);
  }

  /**
   * The local player's own state, for a world with no match behind it.
   *
   * Refused outright while connected. Offline there is nobody to ask and the
   * numbers are nobody's but this browser's; in a match they are the server's,
   * and a prediction arriving here would overwrite the correction sixty times a
   * second.
   */
  local(state: PlayerState): void {
    if (!this.connected) {
      this.publish(state);
    }
  }

  /** Out of the world, or out of the match: the HUD holds nothing over. */
  clear(): void {
    this.connected = false;
    this.walking = false;
    this.me = undefined;
    this.maxHealth = DEFAULT_COMBAT_RULES.maxHealth;
    this.noCountdown = false;
    this.counterNames = [];
    this.keepsPoints = false;
    this.ui.hud.points.value = null;
    this.ui.hud.counters.value = [];
    this.lines.length = 0;
    this.ui.hud.player.value = null;
    // Written by `App` rather than here (it is predicted, not the server's), but
    // cleared here with the rest: "the HUD holds nothing over" is one place.
    this.ui.hud.cone.value = 0;
    this.ui.hud.ads.value = 0;
    this.ui.hud.hit.value = null;
    this.ui.hud.feed.value = [];
  }

  /**
   * Write the player signal, and only when something a player could see has
   * changed: this runs every tick, and a fresh object each time re-renders the
   * health and ammunition widgets at 60 Hz for nothing.
   */
  private publish(state: PlayerState): void {
    if (!this.walking) {
      return;
    }
    const next = this.describe(state);
    if (!same(this.ui.hud.player.value, next)) {
      this.ui.hud.player.value = next;
    }
  }

  private describe(state: PlayerState): HudPlayerInfo {
    const entry = this.weapons().entry(this.weapons().idAt(state.weaponIndex));
    return {
      health: state.health,
      maxHealth: this.maxHealth,
      dead: state.dead,
      // A tenth of a second: the countdown is drawn to one decimal, so this is
      // what makes the comparison above true on the other fifty-odd ticks.
      respawnIn: this.noCountdown ? null : Math.round(state.respawnIn * 10) / 10,
      weapon:
        state.weapon === null || entry === undefined
          ? null
          : { name: entry.display ?? entry.id, ammo: state.weapon.ammo, reloading: state.weapon.state === "reloading" },
    };
  }

  private addKill(event: DeathEvent, now: number): void {
    const suicide = isSuicide(event.victim, event.killer);
    const line: KillFeedEntry = {
      id: event.id,
      killer: suicide || event.killer === null ? null : this.nameOf(event.killer),
      victim: this.nameOf(event.victim),
      how: suicide ? (event.killer === null ? BY_THE_WORLD : BY_THEMSELVES)[event.cause] : null,
      mine: this.me !== undefined && (event.killer === this.me || event.victim === this.me),
    };
    this.lines.unshift({ line, at: now });
    this.lines.length = Math.min(this.lines.length, FEED_LINES);
    this.ui.hud.feed.value = this.lines.map((held) => held.line);
  }

  private expire(now: number): void {
    const before = this.lines.length;
    while (this.lines.length > 0 && now - this.lines[this.lines.length - 1]!.at > FEED_SECONDS * 1000) {
      this.lines.pop();
    }
    if (this.lines.length !== before) {
      this.ui.hud.feed.value = this.lines.map((held) => held.line);
    }
  }

  /**
   * A player's name as the lobby gave it. The wire carries ids and nothing else —
   * they are what a snapshot is keyed by — and the lobby the player came from is
   * the only place a browser has ever been told a name.
   */
  private nameOf(id: PlayerId): string {
    return this.ui.lobby.value?.players.find((player) => player.id === id)?.username ?? id;
  }
}

/**
 * A suicide's line in words, by cause: the world's doing, or their own. A line
 * with a killer names them instead and needs none of this.
 */
const BY_THE_WORLD: Record<DamageCause, string> = {
  bullet: "was shot",
  outOfWorld: "fell out of the world",
  fall: "fell to their death",
  explosion: "was blown up",
  script: "died",
  melee: "was mauled",
};
const BY_THEMSELVES: Record<DamageCause, string> = {
  bullet: "shot themselves",
  outOfWorld: "fell out of the world",
  fall: "fell to their death",
  explosion: "blew themselves up",
  script: "killed themselves",
  melee: "beat themselves to death",
};

function same(a: HudPlayerInfo | null, b: HudPlayerInfo): boolean {
  return (
    a !== null &&
    a.health === b.health &&
    a.maxHealth === b.maxHealth &&
    a.dead === b.dead &&
    a.respawnIn === b.respawnIn &&
    a.weapon?.name === b.weapon?.name &&
    a.weapon?.ammo === b.weapon?.ammo &&
    a.weapon?.reloading === b.weapon?.reloading
  );
}
