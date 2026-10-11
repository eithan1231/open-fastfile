// One match: the players in it, the tick that advances them, and the drift
// between what each client says happened and what actually would have.
//
// No transport. This takes no socket and no geckos type, so a test drives it
// directly — the same reason the api's `App` holds a Hono a test can mount.
// net/server.ts is the adapter that turns datagrams into these calls.
//
// **This server is the authority.** A client still predicts, so it never waits for
// us and never feels its own ping; but we re-simulate the same inputs through the
// same stepMovement against the same collision, and our answer is the one that
// goes in the snapshot. A client that disagrees is corrected, replays whatever it
// has sent since, and smooths the remainder into its camera. What a client claims
// is measured (`InputQueue.measure`) and never adopted: the figure is how far
// ahead of the correction it is predicting, which is a validator's input.
//
// Two consequences to know about. We own where a player spawns, so arriving
// through a pose link or keeping a position across a hot reload snaps you to our
// idea of you. And a world with no collision mesh cannot be hosted at all
// (worlds.ts): correcting a player against nothing is worse than not checking them.
//
// This file is the composition and the public surface. Each concern is a module
// beside it, and the tick is the phase list in phases.ts: a new step of the tick
// is a module and a slot there, not a field and three calls here.

import type { ResolvedWorld } from "@3d/shared/dsl/resolved.js";
import type { Announcement } from "@3d/shared/game/announcement.js";
import type { NavPlanner } from "@3d/shared/game/bots/planner.js";
import { catalogueViewOf } from "@3d/shared/game/catalogueView.js";
import type { ClassRules, ClassTiming } from "@3d/shared/game/classes.js";
import { defaultGametype } from "@3d/shared/game/gametypes/default.js";
import type { GametypeDecl, TeamId } from "@3d/shared/game/gametypes/declaration.js";
import { hashString } from "@3d/shared/game/random.js";
import { scriptsFor } from "@3d/shared/game/registry.js";
import type { CombatRules } from "@3d/shared/game/rules.js";
import type { PlayerId } from "@3d/shared/net/messages/fields.js";
import type { InputMessage } from "@3d/shared/net/messages/input.js";
import type { PlayerSnapshot, SnapshotMessage } from "@3d/shared/net/messages/snapshot.js";
import type { PhysicsWorld } from "@3d/shared/physics/world.js";
import type { CapsuleWorld, Vec3 } from "@3d/shared/sim/capsule.js";
import type { Loadout } from "@3d/shared/sim/loadout.js";
import type { MovementState } from "@3d/shared/sim/movement.js";
import { Player } from "@3d/shared/sim/player.js";
import { CATALOG_VERSION, WeaponRegistry } from "@3d/shared/sim/weaponRegistry.js";
import { presenceFor, type Presence } from "@3d/shared/worlds/presence.js";
import { indexWorld } from "@3d/shared/worlds/worldIndex.js";
import { Actors } from "../actors.js";
import { NO_BODIES } from "../bodies.js";
import type { BotOptions } from "../bots.js";
import { PlayerHistory } from "../history.js";
import { MatchParts } from "../parts.js";
import { ActorTick } from "./actorTick.js";
import { MatchBots, type BotState } from "./bots.js";
import { MatchCast } from "./cast.js";
import { Classes, newClassState } from "./classes.js";
import { MatchClock } from "./clock.js";
import { BrainContexts, gameView, serverContext } from "./context.js";
import { Damage } from "./damage.js";
import { InputDrain } from "./drain.js";
import { Dynamics } from "./dynamics.js";
import { InputQueue, UnspawnedInputs, type DriftReport } from "./inputs.js";
import { MatchNav } from "./nav.js";
import { Announcements, EventOutbox } from "./outbox.js";
import { TickPhases } from "./phases.js";
import type { Playing } from "./playing.js";
import { Rewinder, type RewindReport } from "./rewind.js";
import { Roster, type Member } from "./roster.js";
import { Scores } from "./scores.js";
import { ScriptHost } from "./scripts.js";
import { Shots, type FiredShot, type ShotResult } from "./shots.js";
import { Spawns } from "./spawns.js";
import { Interactions } from "./use.js";
import { serverVerbs } from "./verbs.js";
import { Zones } from "./zones.js";

export class Match {
  private readonly clock: MatchClock;
  private readonly roster: Roster;
  private readonly scripts: ScriptHost;
  private readonly outbox: EventOutbox;
  private readonly announcements: Announcements;
  private readonly tally: Scores;
  /** The world's removable parts: what is present, and what a script has asked to change. */
  private readonly parts: MatchParts;
  private readonly zones: Zones;
  private readonly nav: MatchNav;
  private readonly rewinder: Rewinder;
  private readonly damage: Damage;
  private readonly classes: Classes;
  private readonly spawns: Spawns;
  private readonly shots: Shots;
  private readonly bots: MatchBots;
  private readonly cast: MatchCast;
  private readonly actorTick: ActorTick;
  private readonly dynamics: Dynamics;
  private readonly phases = new TickPhases();
  /** What has been heard from players who are seated and not yet in the match. */
  private readonly unspawned = new UnspawnedInputs();
  /** Why a script ended the match (`ServerContext.endMatch`), once one has. `Games` stops hosting it. */
  private endedBy: string | undefined;
  private failure: string | undefined;

  constructor(
    private readonly collision: CapsuleWorld,
    world: ResolvedWorld,
    readonly tickRate: number,
    private readonly maxPlayers: number,
    /** Every weapon this instance can build. Empty means players here are unarmed. */
    private readonly weapons: WeaponRegistry = new WeaponRegistry([]),
    /**
     * What is being played: which map, which gametype, and the catalogue a cast
     * is chosen out of.
     *
     * The gametype defaults to the one a world is walked around with, which names
     * no mode and assigns no side — so a match that has not been told otherwise
     * behaves exactly as it did when the world decided all of this.
     */
    private readonly playing: Playing = {
      map: "",
      gametype: defaultGametype,
      catalogue: catalogueViewOf({ version: CATALOG_VERSION }, new WeaponRegistry([])),
      bodies: NO_BODIES,
    },
  ) {
    const { gametype, map, catalogue } = playing;
    // The world as a script addresses it, built once: it never changes for the life of a match.
    const index = indexWorld(world);
    const clock = (this.clock = new MatchClock(tickRate));
    const roster = (this.roster = new Roster(gametype));
    const scripts = (this.scripts = new ScriptHost(playing.scripts ?? scriptsFor(gametype.id, map)));
    const outbox = (this.outbox = new EventOutbox(clock));
    const announcements = (this.announcements = new Announcements(clock, gametype, outbox, (id) => roster.has(id)));
    const scores = (this.tally = new Scores(gametype, roster));
    const parts = (this.parts = new MatchParts(world, () => index, playing.presence ?? presenceFor(world, gametype.mode), playing.partView));
    const zones = (this.zones = new Zones(world.triggers, gametype.mode, roster, scripts));
    const actors = new Actors(playing.actorCollision ?? collision, world, tickRate, playing.bodies, { catalogue, seed: hashString(map) });
    const nav = (this.nav = new MatchNav(playing.nav, parts));
    const rewinder = (this.rewinder = new Rewinder(clock));
    const damage = (this.damage = new Damage(clock, roster, actors, scripts, outbox, scores, (member) => this.spawns.respawn(member)));
    const classes = (this.classes = new Classes(clock, weapons, scripts, () => this.cast.defaultWeapon()));
    const spawns = (this.spawns = new Spawns(world, scripts, classes, () => damage.rules));
    const shots = (this.shots = new Shots(clock, collision, roster, actors, rewinder, damage, outbox, () => damage.rules));
    const view = gameView({ world, index, map, gametype, catalogue, clock, roster, presence: parts.presence, scores });
    const brains = new BrainContexts(view, roster);
    this.cast = new MatchCast(scripts, view, playing.bodies, weapons);
    const actorTick = (this.actorTick = new ActorTick(clock, actors, roster, nav, damage, (planner) => brains.on(planner)));
    const dynamics = (this.dynamics = new Dynamics(clock));
    const bots = (this.bots = new MatchBots(
      clock,
      roster,
      nav,
      scripts,
      (planner) => brains.on(planner),
      (id, loadout, side, bot) => void this.admit(id, loadout, "bot", loadout === undefined ? undefined : 0, side, bot),
      (id) => this.leave(id),
    ));
    const use = new Interactions(world, gametype, collision, parts.presence, scripts, view, playing.partBounds);
    const drain = new InputDrain(clock, roster, use, shots);

    // Before any other hook, so the first `combatRules` already has its state.
    const end = (reason: string): void => void (this.endedBy ??= reason);
    const verbs = serverVerbs({ index, roster, parts, spawns, damage, classes, scores, announcements, bots, zones, actors, nav, end });
    scripts.start((memory) => serverContext(view, verbs, memory));
    damage.askRules();
    classes.askRules();

    // The tick, as phases.ts orders it.
    const phases = this.phases;
    phases.use("records", () => {
      shots.clear();
      announcements.clear();
      outbox.expire();
    });
    phases.use("nav", () => nav.poll());
    phases.use("start", () => {
      if (scripts.begin()) {
        scripts.each((hooks, ctx) => hooks.matchStart?.(ctx));
      }
    });
    phases.use("bots", () => bots.think());
    phases.use("inputs", () => drain.run());
    phases.use("interactions", () => use.flush());
    phases.use("fall out", () => damage.fallOut());
    phases.use("actors", () => actorTick.step());
    phases.use("health", () => damage.health());
    phases.use("occupancy", () => zones.step());
    phases.use("scripts", () => this.tickScripts());
    phases.use("physics", () => dynamics.step());
    phases.use("parts", () =>
      parts.flush(clock.tick, {
        physics: dynamics.current,
        nav: nav.planner?.state,
        actorNav: nav.actorPlanner?.state,
        occupied: (part) => roster.occupied(part),
      }),
    );
    phases.use("history", () => {
      for (const member of roster.values()) {
        member.history.record(clock.tick, member.player.movement as MovementState);
      }
    });
    phases.use("snapshot", () => actorTick.capture());
  }

  /** The phases a tick runs, in order: what a test pins. */
  get tickPhases(): readonly string[] {
    return this.phases.order;
  }

  /** Everyone in the match, bots included: everyone a snapshot carries. */
  get size(): number {
    return this.roster.size;
  }

  /**
   * The members who are people. What decides that a game is empty, what an
   * instance reports as its load and what fills a game's seats: a bot keeps no
   * game alive and takes nobody's place.
   */
  get humans(): number {
    return this.roster.humans;
  }

  get tick(): number {
    return this.clock.tick;
  }

  /** The api sized the lobby in people, so bots do not count against it. */
  get full(): boolean {
    return this.humans >= this.maxPlayers;
  }

  has(id: PlayerId): boolean {
    return this.roster.has(id);
  }

  /**
   * The rules this match is played by.
   *
   * Exposed because `joined` carries the id to the client: a browser cannot resolve
   * `PlayerState.team` into a name, or ask `castFor` what that side wears, without
   * knowing which gametype it is a side of.
   */
  get gametype(): GametypeDecl {
    return this.playing.gametype;
  }

  /** What combat costs here. The part a client acts on reaches it in `joined` (`JoinedRules`). */
  get rules(): CombatRules {
    return this.damage.rules;
  }

  /** The class rules this match plays by, as the wire carries `customClasses` in `joined`. */
  get classRules(): ClassRules {
    return this.classes.rules;
  }

  /** What each side has scored. Empty in a free-for-all: a score is keyed by side, and there are none. */
  get scores(): ReadonlyMap<TeamId, number> {
    return this.tally.byTeam;
  }

  /** Which of the world's solids are present now. */
  get presence(): Presence {
    return this.parts.presence;
  }

  /** The players' planner, or null until the world's bake is done (and for good on a world with none). */
  get navigation(): NavPlanner | null {
    return this.nav.planner;
  }

  /** Why a script ended this match, or undefined while it plays on. `Games.finished` reads it. */
  get ended(): string | undefined {
    return this.endedBy;
  }

  /**
   * Why this match threw on its tick, or undefined while it has not. A match that
   * threw is stepped no more: its state stopped halfway through a tick, and only
   * `Games.finished` should touch it after.
   */
  get failed(): string | undefined {
    return this.failure;
  }

  /** `GameTick`'s catch: end this match for `err`, and only this one. */
  fail(err: unknown): void {
    this.failure ??= err instanceof Error ? err.message : String(err);
  }

  /**
   * Spawn a player for the first time at one of the world's spawns, carrying
   * `loadout` — which is their `index`th class, when they chose one. Idempotent:
   * a re-sent join must not teleport anyone. Returns what became of the class:
   * `now`, or `refuse` where the gametype takes no classes or a script said no,
   * in which case they spawn anyway, armed as a player with no class is.
   *
   * The class is reconciled here, against **this** instance's catalogue: a
   * weapon it does not hold leaves that slot empty rather than putting a
   * different gun in their hands. A player with no class, or one naming nothing
   * this instance has, falls back to the gametype's default weapon.
   */
  join(id: PlayerId, loadout?: Loadout, engine = "", index?: number): ClassTiming {
    return this.admit(id, loadout, engine, index, undefined, undefined);
  }

  /** Add a bot, and return the id it was given (`MatchBots.add`). */
  addBot(spec: BotOptions): PlayerId {
    return this.bots.add(spec);
  }

  /** Take a bot out of the match. False for an id that is not a bot here. */
  removeBot(id: PlayerId): boolean {
    return this.bots.remove(id);
  }

  /** A player's `index`th class, chosen mid-game: when it takes effect (`Classes.choose`). */
  chooseLoadout(id: PlayerId, loadout: Loadout, index: number): ClassTiming {
    const member = this.roster.get(id);
    return member ? this.classes.choose(member, loadout, index) : "refuse";
  }

  /**
   * Somebody leaves: out of every trigger they were in, which each script hears
   * as a `triggerLeave`, then `playerLeave` — both while they are still in the
   * roster, so a hook can still look them up — and then gone.
   */
  leave(id: PlayerId): void {
    if (!this.roster.has(id)) {
      return;
    }
    this.zones.leave(id);
    this.scripts.each((hooks, ctx) => hooks.playerLeave?.(ctx, id));
    this.roster.remove(id);
  }

  /** `join`, for a player or a bot: `side` overrides the balancing default, and `bot` makes it one. */
  private admit(
    id: PlayerId,
    loadout: Loadout | undefined,
    engine: string,
    index: number | undefined,
    side: number | undefined,
    bot: BotState | undefined,
  ): ClassTiming {
    if (this.roster.has(id)) {
      return "now";
    }
    const player = new Player(this.collision, this.weapons);
    // The stream this player's recoil draws from. Their id, hashed — the browser
    // hashes the same id the moment it is told it, so the kick this server gives
    // a shot is the kick that client already predicted (sim/recoil.ts).
    player.setSeed(hashString(id));
    // Before the spawn, which a gametype chooses by side.
    player.setTeam(side ?? this.roster.sideFor());
    // Held under the kill plane rather than put back on a spawn: here passing it
    // is a death (`Damage.fallOut`), and the client predicts the same hold.
    player.setFallOut("die");
    const member: Member = {
      id,
      player,
      inputs: new InputQueue(this.unspawned.take(id)),
      history: new PlayerHistory(this.rewinder.historyLength),
      sentTick: -1,
      engine,
      since: this.clock.now,
      body: this.cast.bodyOf(id),
      kit: newClassState(this.clock.tick),
      bot,
    };
    // In the roster and on a side, not yet placed, before a script is asked about
    // them: a hook sees them, anything it calls on them lands, and a side it
    // changes here is the side the spawn it is asked for next follows.
    this.roster.add(member);
    this.scripts.each((hooks, ctx) => hooks.playerJoin?.(ctx, id));
    this.spawns.place(member);
    const timing = this.classes.join(member, loadout, index);
    player.respawn();
    player.revive(this.damage.rules.maxHealth);
    return timing;
  }

  /**
   * The gametype's own clock: every script's `tick`, once, in `SCRIPTS` order.
   *
   * Skipped entirely while nobody is playing. An empty game is still stepped —
   * the tick counter is the clock and a player joining must not see it restart —
   * but there is nobody to tell anything to, and an announcement raised into an
   * empty room would only expire out of the outbox unheard. Bots hear nothing,
   * so a room of them is empty.
   */
  private tickScripts(): void {
    if (this.roster.humans === 0) {
      return;
    }
    const dt = this.clock.dt;
    this.scripts.each((hooks, ctx) => hooks.tick?.(ctx, dt));
  }

  /**
   * Queue one input. Deliberately does not step: the tick owns the clock, so a
   * client cannot advance itself by sending faster. One from somebody not in the
   * match — seated, still choosing a class — is stepped by nothing and
   * acknowledged all the same (`UnspawnedInputs`).
   */
  receive(id: PlayerId, message: InputMessage): void {
    const member = this.roster.get(id);
    if (member) {
      member.inputs.receive(message);
    } else {
      this.unspawned.receive(id, message.seq);
    }
  }

  /**
   * Forget which seqs this player has sent: a new connection for a seated player
   * counts from the start again, and every one of its inputs would read as old.
   * Also what a seat going away calls, so nothing is kept for somebody who left
   * before they spawned.
   */
  resetInputs(id: PlayerId): void {
    this.roster.get(id)?.inputs.reset();
    this.unspawned.take(id);
  }

  /**
   * Advance every player by the inputs they have sent, and return everyone's
   * authoritative state — the part of a snapshot that is the same for all of
   * them, which `snapshotFor` is handed back — and how many actors there are to
   * tell anyone about.
   */
  step(): { players: PlayerSnapshot[]; actors: number } {
    this.clock.tick++;
    this.phases.run();
    return { players: this.roster.snapshot(), actors: this.actorTick.count };
  }

  /**
   * The last step's snapshot as one player sees it: everyone's state, their own
   * ack, and what they have still to be told.
   *
   * The players are shared and the rest is theirs alone — a hit marker goes to
   * whoever fired the round and to nobody else.
   */
  snapshotFor(id: PlayerId, players: PlayerSnapshot[]): SnapshotMessage {
    const member = this.roster.get(id);
    if (member) {
      member.sentTick = this.clock.tick;
    }
    return {
      tick: this.clock.tick,
      ack: member?.inputs.ack ?? this.unspawned.ack(id) ?? 0,
      presence: this.parts.snapshot,
      players,
      actors: this.actorTick.for(id),
      counters: this.tally.countersNow(),
      events: this.outbox.for(id),
    };
  }

  /**
   * Everything a script published on this tick, cleared at the top of the next.
   * Every one is also in the outbox, on its way to every client; this is what a
   * test and a diagnostic read, because the outbox holds several ticks at once.
   */
  get eventsThisTick(): readonly Announcement[] {
    return this.announcements.thisTick;
  }

  /** The event counter as it stands: the watermark a joining player is given in `joined`. */
  get eventCursor(): number {
    return this.outbox.cursor;
  }

  /**
   * Every shot the last `step` fired, in the order they left. A record, not a
   * to-do list: each one has already been paid for. What is left for a reader is
   * drawing a tracer and explaining a kill.
   */
  get shotsThisTick(): readonly FiredShot[] {
    return this.shots.fired;
  }

  /** What a shot from `shooter` would hit (`Shots.trace`). Applies no damage and records nothing. */
  traceShot(shooter: PlayerId, from: Vec3, direction: Vec3, range: number, message: InputMessage): ShotResult | null {
    return this.shots.trace(shooter, from, direction, range, message);
  }

  /**
   * Where `id` was, as the client that sent `message` would have been drawing
   * them. What a shot from `shooter` is judged against, for a test to read.
   */
  rewind(id: PlayerId, message: InputMessage, shooter: PlayerId, out: MovementState): MovementState | null {
    const member = this.roster.get(id);
    return member ? this.rewinder.sample(member.history, this.shots.targetFor(shooter, message), out) : null;
  }

  /** How far back a rewind may reach, in ticks. */
  get maxRewindTicks(): number {
    return this.rewinder.maxTicks;
  }

  /** How often a rewind could not be honoured as asked. For `/healthz`: this is measured before it is trusted. */
  rewindReport(): RewindReport {
    return this.rewinder.report;
  }

  drift(id: PlayerId): DriftReport | undefined {
    return this.roster.get(id)?.inputs.drift;
  }

  /** Every player's drift, for /healthz. */
  report(): { id: PlayerId; drift: DriftReport; engine: string; dropped: number }[] {
    return [...this.roster.values()].map((m) => ({ id: m.id, drift: { ...m.inputs.drift }, engine: m.engine, dropped: m.inputs.dropped }));
  }

  /** How this match may build a physics world, should anything need one (`Dynamics.setFactory`). */
  setPhysicsFactory(factory: () => PhysicsWorld | undefined): void {
    this.dynamics.setFactory(factory);
  }

  /** What this match is simulating, for `/healthz`. Zeroes where it is simulating nothing. */
  physicsReport(): { entities: number; triangles: number } {
    return this.dynamics.report();
  }

  /** Give back everything this match holds outside the JavaScript heap. Called where a game is removed (`Games.remove`). */
  dispose(): void {
    this.dynamics.free();
  }
}
