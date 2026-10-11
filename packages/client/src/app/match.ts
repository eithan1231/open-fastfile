// The match this player is in, while there is one: the connection to its game
// server, who is in it, and what each snapshot means for everything that draws
// or sounds it. With no match, nothing here runs and the world plays offline.

import type { GameEvent } from "@3d/shared/net/messages/events.js";
import { isBotId } from "@3d/shared/net/messages/fields.js";
import type { PlayerSnapshot } from "@3d/shared/net/messages/snapshot.js";
import type { PlayerView } from "@3d/shared/game/context.js";
import { gametype } from "@3d/shared/game/gametypes/registry.js";
import { hashString } from "@3d/shared/game/random.js";
import type { PlayerState } from "@3d/shared/sim/player.js";
import { worldHash } from "@3d/shared/worlds/hash.js";
import { Connection, type Correction, type MatchTicket } from "../net/connection.js";
import { dropBody } from "../net/corpses.js";
import type { ClassChoice } from "./classChoice.js";
import type { GameContent } from "./content.js";
import type { CurrentWorld } from "./currentWorld.js";
import type { DevTools } from "./dev/devTools.js";
import type { Hud } from "./hud.js";
import type { PauseController } from "./pause.js";
import type { ScreenRouter } from "./screens.js";
import type { ClientScripts, ScriptSurroundings } from "./scripts.js";
import type { PlayerSession } from "./session.js";
import type { Systems } from "./systems.js";
import type { Toaster } from "./toaster.js";
import type { UiState } from "./uiBridge.js";
import type { WorldLoader } from "./worldLoader.js";
import { NO_MATCH_VALUES, type MatchValues, type WorldSession } from "./WorldSession.js";

/** The match as of the newest snapshot, as a script's view is built from it. */
interface Roster {
  players: PlayerView[];
  tick: number;
  values: MatchValues;
}

const EMPTY_ROSTER: Roster = { players: [], tick: 0, values: NO_MATCH_VALUES };

/** What a match reaches beyond the engine: the app's own pieces. */
export interface MatchParts {
  readonly content: GameContent;
  readonly current: CurrentWorld;
  readonly worlds: WorldLoader;
  readonly pause: PauseController;
  readonly screens: ScreenRouter;
  readonly hud: Hud;
  readonly classes: ClassChoice;
  readonly scripts: ClientScripts;
  readonly session: PlayerSession;
  readonly toaster: Toaster;
  readonly dev: DevTools;
  readonly ui: UiState;
}

export class MatchController {
  /** The match this player was sent to, while there is one. Survives a hot reload. */
  private ticket: MatchTicket | undefined;
  private connection: Connection | undefined;
  /**
   * Who is in the match, the tick it was and the match's own numbers, as of the
   * newest snapshot: what a script's view is built from between announcements.
   * Empty offline.
   */
  private roster: Roster = EMPTY_ROSTER;
  /**
   * The server's tick rate, from `joined`, and what turns a snapshot's tick into
   * the clock a script reads. Zero until a match says otherwise.
   */
  private tickRate = 0;

  constructor(
    private readonly systems: Systems,
    private readonly parts: MatchParts,
  ) {
    // The moment this client last drew other players at, so the server can judge a
    // shot against what the shooter actually saw rather than against the present.
    // Peers first; with none, the actors, which are drawn at the same moment.
    const { firstPerson, remotes, actors } = systems;
    firstPerson.onTick = (input, dt, feet) => this.connection?.send(input, dt, feet, remotes.renderTick() ?? actors.renderTick());
  }

  /** Whether this player holds a ticket to a match, connected or not. */
  get inMatch(): boolean {
    return this.ticket !== undefined;
  }

  /**
   * A game is standing and this player is on its roster: load the map, then
   * connect. The world comes first because it is playable whatever happens to
   * the connection, and nothing about a match may take that away.
   */
  async enter(ticket: MatchTicket, map: string): Promise<void> {
    this.ticket = ticket;
    this.parts.pause.awaitSpawn();
    await this.parts.worlds.enter(map);
    // The round can end while its map is loading — a host ending it, a game
    // nobody else reached — and the world can fail to load at all. Either way
    // there is no match left to join, and a channel opened now would sit
    // connected to a game that has gone, behind whatever screen is up instead.
    if (this.ticket !== ticket || this.parts.screens.current !== "world") {
      return;
    }
    this.join(ticket);
  }

  /**
   * The world was re-entered after an edit. A hot reload rebuilds the scene, not
   * the match: dropping the channel and rejoining on every file save would make
   * the player flicker for everyone else. One that has dropped is rejoined; the
   * ticket is the api's, and a reload does not invalidate it.
   */
  afterReload(): void {
    if (this.ticket && !this.connection) {
      this.join(this.ticket);
    }
  }

  /** Done with the match: the ticket, the channel and everything they put in the world. */
  end(): void {
    this.ticket = undefined;
    this.disconnect();
  }

  /** A class, clicked in the class menu. See `ClassChoice` for who decides what. */
  chooseClass(index: number): void {
    const { ui, classes, session, pause } = this.parts;
    const loadout = ui.loadouts.value[index];
    if (!loadout || !this.connection || ui.classChoice.value === null) {
      return;
    }
    this.connection.chooseClass(index);
    // Remembered as the last chosen, which is what the menu offers first next time.
    session.selectLoadout(index);
    if (classes.chose(index)) {
      // Spawning. The weapons arrive with the server's state; this only lets the
      // player into the world, and the click that chose is also the gesture
      // pointer lock wants.
      pause.spawned();
      ui.canChooseClass.value = true;
      pause.resume();
    }
  }

  /** The scripts' view of the match as of the newest snapshot: the clock, the roster and which of them is us. */
  surroundings(session: WorldSession, world: NonNullable<WorldSession["world"]>): ScriptSurroundings {
    const { players, tick, values } = this.roster;
    const me = this.ticket?.playerId;
    return {
      view: session.gameView(world, this.tickRate === 0 ? 0 : tick / this.tickRate, players, values),
      self: me === undefined ? undefined : players.find((player) => player.id === me),
    };
  }

  /**
   * Open the channel the ticket names. Fire and forget: the world is already up,
   * and nothing here may surface an error.
   */
  private join(ticket: MatchTicket): void {
    this.disconnect();
    const { firstPerson, footsteps, weaponAudio, remotes, actors } = this.systems;
    const { hud, classes, dev, toaster, ui, content, pause, current } = this.parts;
    const connection = new Connection(
      {
        onJoined: (joined) => {
          const { tickRate, gametype: id } = joined;
          this.tickRate = tickRate;
          firstPerson.setTickRate(tickRate);
          // The stream this player's recoil draws from. The same hash of the same
          // id the game server uses, so the kick this client predicts is the one
          // the server judges its shots with (@3d/shared/sim/recoil.ts).
          firstPerson.player.setSeed(hashString(ticket.playerId));
          // The same stream, so a replay of this player reproduces their boots
          // as well as their recoil.
          footsteps.setSeed(hashString(ticket.playerId));
          // And the same one again for the weapon: a round's spread cone is drawn
          // from it, so an impact this end predicts lands where the server's does.
          weaponAudio.setSeed(hashString(ticket.playerId));
          // Snapshots arrive at that rate, so it is also how far back peers are drawn.
          remotes.setTickRate(tickRate);
          actors.setTickRate(tickRate);
          // From here the HUD is the server's: its rules give the health bar a
          // denominator, and its id says which feed lines are this player's.
          hud.joined(joined, ticket.playerId, gametype(id));
          // A gametype this build does not know is *not* a reason to refuse the
          // match: the server has already admitted us, and the default's cast is a
          // better answer than no players at all. It is worth saying out loud,
          // because everyone wearing the wrong faction is otherwise unaccountable.
          const decl = gametype(id);
          const mode = this.systems.world.presence.mode;
          if (decl && decl.mode !== mode) {
            // The world was built for another mode's models; its solids follow the snapshot anyway.
            console.warn(`[net] the world was built for mode "${mode ?? "none"}" and ${decl.display} plays "${decl.mode ?? "none"}"`);
          }
          if (decl) {
            content.gametype = decl;
          } else {
            console.warn(`[net] the server is running gametype "${id}", which this build does not know; using ${content.gametype.id}`);
          }
          console.info(`[net] joined game ${ticket.gameId} at ${tickRate} Hz, playing ${content.gametype.display}`);
          classes.clear();
          // Passing the kill plane is a death now, which the server deals: held
          // where they fell on this end too, so the prediction stops where the
          // server's replay does (`FallOut`).
          firstPerson.player.setFallOut("die");
          if (joined.spawned) {
            // In already: a reconnect after a hot reload, or a gametype with no
            // classes to choose. Nothing left to wait for.
            pause.spawned();
            ui.canChooseClass.value = joined.classes;
            // The server kept our class; the last one chosen is the best guess at which it was.
            ui.playingClass.value = joined.classes ? ui.selectedLoadout.value : null;
          } else {
            // Seated, not spawned: nothing happens in this game until a class is
            // chosen, so the class menu goes up over everything else.
            ui.classChoice.value = "spawn";
            pause.holdForClass();
          }
        },
        onSnapshot: (snapshot) => this.snapshot(snapshot),
        // SHOTTRACE (docs/engine/diagnostics-shottrace.md): the server's own
        // account of a round this player fired, drawn beside this client's.
        onShotTrace: (trace) => dev.serverShotTrace(trace),
        onClassChosen: (index, timing) => {
          console.info(`[net] class ${index + 1}: ${timing}`);
          const said = classes.answered(index, timing, ui.loadouts.value[index]?.name ?? `Class ${index + 1}`);
          if (said !== null) {
            toaster.show(said);
          }
        },
        // The world stays, offline, as it would with no game server at all: so
        // nobody is waiting to be spawned any more, and the world can be played.
        // The channel is let go of too, so a hot reload tries again and no input
        // is sent into it meanwhile.
        onOffline: () => this.playOffline(),
        onClosed: () => this.playOffline(),
      },
      content.weapons.hash,
      current.world ? worldHash(current.world) : "",
    );
    this.connection = connection;
    if (!connection.connect(ticket)) {
      this.disconnect();
    }
  }

  /** The match could not be joined, or went away: the world plays on offline, as a world with no server does. */
  private playOffline(): void {
    this.disconnect();
    this.parts.pause.spawned();
  }

  /**
   * Let go of the channel and of everything it put in the world. The one
   * teardown, whether this end left or the match did: the HUD back to what this
   * browser knows about itself rather than the last numbers a dead channel gave
   * it, and the prediction back to respawning at the kill plane.
   */
  private disconnect(): void {
    const { firstPerson, remotes, actors, actorVoices, corpses, footsteps, weaponAudio } = this.systems;
    this.connection?.close();
    this.connection = undefined;
    this.parts.classes.clear();
    firstPerson.player.setFallOut("respawn");
    remotes.clear();
    actors.clear();
    actorVoices.clear();
    corpses.clear();
    footsteps.clear();
    weaponAudio.clear();
    this.parts.hud.clear();
    this.roster = EMPTY_ROSTER;
  }

  private snapshot({ tick, self, others, actors, pending, events, presence, counters }: Correction): void {
    const { firstPerson, remotes, corpses, footsteps, weaponAudio, actorVoices } = this.systems;
    const { hud, classes, current, content } = this.parts;
    // Before `apply`, which is what would otherwise go on posing a body that
    // has stopped being sent inputs — a corpse standing up, idling and
    // aiming, which is what a dead player looks like today.
    this.dropTheDead(events);
    // Before the corpses step: a part leaves at the tick it left on the server.
    current.session?.applyPresence(presence, tick);
    remotes.apply(others, tick, performance.now());
    // Every body's hit boxes fetched before its first death, not at it.
    corpses.prepare(remotes.drawnBodies());
    this.systems.actors.apply(actors, tick, performance.now());
    actorVoices.apply(actors, performance.now() / 1000);
    // Off the snapshot and not off a frame: these are the server's own tick
    // states, so every client hears the same step at the same place.
    footsteps.remote(others, tick);
    weaponAudio.remote(others, content);
    // After `others` is in hand: a death needs the feet of whoever fell,
    // and a hit marker is this player's own answer about their own round.
    this.soundEvents(events, self, others);
    this.roster = this.rosterOf(tick, self, others, counters);
    // The gametype's own, and the only events this engine does not know the
    // meaning of: a script published them and a script is what reads them.
    this.scriptEvents(events);
    // Once per server tick, never per frame: a corpse's step count is
    // `tick - spawnTick` and every end has to arrive at the same number.
    corpses.step(tick);
    hud.snapshot(self, events, performance.now());
    hud.counters(counters);
    // The menu's marks: a waiting class is the one in hand once they are up.
    // The weapons themselves arrive in `self` (`PlayerState.armed`).
    classes.snapshot(self?.dead);
    // The correction. Before the server was authoritative there was nothing
    // to apply — it believed whatever this client claimed — so the local
    // player was filtered out of every snapshot and only peers arrived.
    if (self) {
      firstPerson.reconcile(self, pending);
    }
  }

  /**
   * The two sounds the event tail raises: a hit marker for this player, and a
   * body arriving for whoever fell.
   *
   * `events` is already de-duplicated by `SeenEvents`, which is what makes
   * this safe to raise on: a death is repeated for thirty datagrams and a marker
   * is sent once, and neither is heard twice. A `hit` names nobody — the marker
   * is only ever this player's own — and a `death` names the victim, whose feet
   * are wherever the same snapshot already put them.
   */
  private soundEvents(events: readonly GameEvent[], self: PlayerState | undefined, others: readonly PlayerSnapshot[]): void {
    const { weaponAudio } = this.systems;
    for (const event of events) {
      if (event.kind === "hit") {
        weaponAudio.hitMarker();
      } else if (event.kind === "death") {
        const fell = event.victim === this.ticket?.playerId ? self : others.find((p) => p.id === event.victim)?.state;
        if (fell) {
          weaponAudio.death(fell.movement.feet);
        }
      }
    }
  }

  /**
   * The announcements in one tail, handed to the gametype's client scripts.
   *
   * De-duplicated by `SeenEvents` before it gets here, which is what makes a
   * kind that is repeated for a second safe to act on: the countdown is heard
   * once however many datagrams carried it.
   *
   * The view is built once per tail and only when there is something to hear —
   * `indexWorld` is memoised by the session, but the roster is not, and most ticks
   * announce nothing at all. Nothing happens before a world is mounted or before
   * `joined` named a tick rate, because there is no clock to read then.
   */
  private scriptEvents(events: readonly GameEvent[]): void {
    const announcements = events.filter((event) => event.kind === "announce");
    const session = this.parts.current.session;
    const world = session?.world;
    if (announcements.length === 0 || !session || !world || this.tickRate === 0) {
      return;
    }
    const where = this.surroundings(session, world);
    for (const event of announcements) {
      this.parts.scripts.hear(event, where);
    }
  }

  /** The players in one snapshot, as a script sees them: sides resolved to names. */
  private rosterOf(tick: number, self: PlayerState | undefined, others: readonly PlayerSnapshot[], counters: readonly number[]): Roster {
    const sideOf = (team: number | null): string | undefined => (team === null ? undefined : this.parts.content.gametype.teams[team]);
    const me = this.ticket?.playerId;
    // `since` is left undefined on every one of them: this browser is told
    // nobody's join time, and inventing one would put a different number in front
    // of a hook than the server read (@3d/shared/game/context.ts).
    const players = [
      ...(self && me !== undefined ? [{ id: me, team: sideOf(self.team), bot: false, points: self.points }] : []),
      ...others.map((peer) => ({ id: peer.id, team: sideOf(peer.state.team), bot: isBotId(peer.id), points: peer.state.points })),
    ];
    return { players, tick, values: { counters } };
  }

  /**
   * Turn a spawn the server sent into a body on the floor.
   *
   * Driven off the event rather than off `dead` in the snapshot, and the difference
   * is the whole point: `dead` would tell this client *that* somebody fell, and
   * every client would then invent its own answer to *how*. The event carries the
   * pose, the velocity and the round's own push, quantised, so sixteen jointed
   * boxes start from the same numbers everywhere.
   *
   * The body is **handed over, not rebuilt**: the rig `RemotePlayers` is drawing is
   * already the one `bodyIndex` chose from this player's id, which is the body the
   * server traced the killing round against. A hand-over that cannot be completed —
   * no physics in this world, or a body whose hit boxes have not arrived yet —
   * puts nothing on the floor and lets `apply` go on drawing them standing, which
   * is what a build with no physics does anyway.
   *
   * Repeats cost nothing: `Corpses.spawn` is a no-op for an entity it holds, and so
   * is `PhysicsWorld.spawn` underneath it. That matters because a spawn is repeated
   * for half a second, exactly as a death is.
   */
  private dropTheDead(events: readonly GameEvent[]): void {
    for (const event of events) {
      if (event.kind === "spawn") {
        dropBody(this.systems.remotes, this.systems.corpses, event);
      }
    }
  }
}
