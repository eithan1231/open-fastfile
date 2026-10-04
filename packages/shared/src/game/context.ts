// What a script may see, and — on the server only — what it may change.
//
// The split is the whole design. `ClientContext` has no verb that changes
// anything: no `damage`, no `score`, no `setTeam`, no `spawn`. So "validate server
// scripts so a client cannot cheat" is not a validator here, it is a missing
// vocabulary — a cheated client script can only lie to itself, because the words
// for lying to anyone else do not exist in its type. The one channel it has to
// authority is `request`, which is a question, not a statement.
//
// It is the same shape `sim/` already uses: the simulation sees collision through
// `CapsuleWorld` and never `collision/world.ts`, which is what keeps three.js out
// of it. Here the narrow type is what keeps authority out of the browser.

import type { GameKey, ResolvedSpawn } from "../dsl/resolved.js";
import type { PlayerId } from "../net/messages/fields.js";
import type { WorldIndex } from "../worlds/worldIndex.js";
import type { Announcement, FeedbackOptions } from "./announcement.js";
import type { CatalogueView } from "./catalogueView.js";
import type { ArmedWith, ClassTiming } from "./classes.js";
import type { DamageCause } from "./damage.js";
import type { GametypeDecl, TeamId } from "./gametypes/declaration.js";
import type { NavBlockerShape } from "../nav/dynamic.js";
import type { Vec3 } from "../sim/capsule.js";
import type { BotSpec, Objective } from "./bots/objective.js";
import type { ActorId, ActorSpec, ActorStateView } from "./actors/actor.js";

/** A script's name in the table, and the address another script sends to. */
export type ScriptId = string;

/** What a script knows about one player. Read-only: a view, not the player. */
export interface PlayerView {
  readonly id: PlayerId;
  /** The side they are on, or undefined in a free-for-all. */
  readonly team?: TeamId;
  /**
   * The match clock when they joined — `GameView.now`'s units, so `now - since`
   * is how long they have been here.
   *
   * **Only where the end knows.** A game server admitted them and has the tick;
   * a browser is told nobody's join time and leaves this undefined, so a hook
   * *both* ends run may not read it or the two will disagree. It is here because
   * a gametype's clock has to start somewhere and a hook both ends run has no
   * state of its own: the first player arriving is the only "match began" either
   * end has.
   */
  readonly since?: number;
  /**
   * A bot a game server is driving (`ServerContext.bots`), rather than a person.
   * Both ends know, from the id alone (`isBotId`), so any hook may read it: a
   * clock that starts when somebody arrives should not start for a bot.
   */
  readonly bot: boolean;
  /**
   * Their purse (`ServerContext.addPoints`): 0 in a gametype that keeps none.
   * The snapshot carries it, so both ends read the same number for the same
   * tick, and a price a client shows is checked against what the server charges.
   */
  readonly points: number;
}

/**
 * Where a player is and how they are, now. Server-only (`ServerContext.state`):
 * a browser knows other players' positions only as late as its last snapshot,
 * so a hook both ends run may not read one or the two will disagree.
 */
export interface PlayerStateView {
  /** A copy: changing it moves nobody. */
  readonly feet: Vec3;
  readonly yaw: number;
  readonly alive: boolean;
  readonly health: number;
  readonly team?: TeamId;
}

/**
 * What every script may read, on either end.
 *
 * Read-only by construction rather than by convention — there is no setter on it
 * anywhere, so the client half of a script cannot be given one by accident.
 */
export interface GameView {
  /**
   * The world's objects by id and tag.
   *
   * Built on each end from that end's own copy of the world text, and never sent:
   * `ResolvedObject.id` is a positional ordinal, so two ends on different text
   * address different objects. Nothing here may put one on the wire until a world
   * hash lands in the join handshake.
   */
  readonly world: WorldIndex;
  /** Which game the map came from, from `world { game: }`. Undefined for a hand-written world. */
  readonly game: GameKey | undefined;
  /** The map's slug, which is what a gametype's `maps` restriction names. */
  readonly map: string;
  readonly gametype: GametypeDecl;
  readonly catalogue: CatalogueView;
  /**
   * The simulation's clock: `tick / tickRate`, never a wall clock.
   *
   * So a client three frames behind reads the same value for the same tick as the
   * server does. `Date.now()` is banned over this subtree for this reason.
   */
  readonly now: number;
  /** Derived from the game's id, so both ends draw the same numbers. See random.ts. */
  readonly seed: number;
  readonly players: readonly PlayerView[];
  player(id: PlayerId): PlayerView | undefined;
  /**
   * Whether every `solid` with this name or tag is present, as the last tick
   * left it — the snapshot's bits in a browser, the applied presence on a game
   * server, so both ends read the same answer for the same tick. A change a
   * server script has asked for this tick is not here yet
   * (`ServerContext.world.isPresent` counts it). A name or tag no solid carries
   * throws.
   */
  isPresent(tagOrName: string): boolean;
  /**
   * One of the gametype's `counters` as the last tick left it — the snapshot's
   * value in a browser, the server's own on a game server. 0 until a script sets
   * it. A name the gametype does not declare throws.
   */
  counter(name: string): number;
}

/**
 * A client script's context: it may draw and predict; it may not decide.
 *
 * Every verb that changes shared state is absent, and that is not an oversight
 * to be filled in later — it is the reason this type is separate from
 * `ServerContext`.
 */
export interface ClientContext extends GameView {
  /**
   * Which of `players` this browser is, or undefined before it has joined one.
   *
   * A read, like everything else here — and the thing that makes one broadcast
   * announcement enough: "the enemy has the flag" and "we have the flag" are the
   * same event, read against the side the reader is on.
   */
  readonly self: PlayerView | undefined;
  /**
   * Say something out loud: an alias, played flat on a feedback channel.
   *
   * **Presentation, and it cannot become anything else.** There is no position
   * to give it, so a script cannot put a noise anywhere in the world — it is
   * `THREE.Audio` at the listener, which does not attenuate, does not pan and
   * does not duck when the player turns their head (docs/engine/audio.md#the-three-kinds-which-want-opposite-things).
   * That is the same argument the rest of this type is built on: a cheated client
   * script can only lie to itself, and the loudest lie available here is a sound
   * in this one browser.
   *
   * An alias no bank here holds is a warning and silence — see
   * `client/src/app/scripts.ts`, and `pnpm catalog`, which refuses a build whose
   * scripts name one.
   */
  say(alias: string, options?: FeedbackOptions): void;
  /**
   * Ask the server for something. A question, not a statement: the outcome
   * arrives in a later snapshot, or it does not arrive.
   *
   * Not built. The reliable `command` message it rides on is specified with
   * pickups; until then a client script only reads and dresses.
   */
  request(command: unknown): void;
}

/**
 * The world as a server script may change it: the index every script reads, and
 * the one verb that changes what is there.
 */
export interface ServerWorld extends WorldIndex {
  /**
   * Remove (false) or restore (true) every `solid` with this name or tag: its
   * collision, its physics collider, its navigation blocker and its drawn meshes,
   * for everyone in the match. Applied at the end of this tick, in that order;
   * the snapshot carries it to every client.
   *
   * A name or tag no solid carries throws. So does restoring a solid a living
   * player is standing inside — pushing them out is not built.
   */
  setPresent(tagOrName: string, on: boolean): void;
  /** Whether every solid with this name or tag is present now, pending changes included. Throws as `setPresent` does. */
  isPresent(tagOrName: string): boolean;
}

/**
 * The server's context: the only one with verbs that change anything.
 *
 * `S` is the script's own state: whatever its `init` returned, handed back to
 * every server hook of that script as `memory` (hooks.ts).
 */
export interface ServerContext<S = unknown> extends GameView {
  /**
   * This script's state for this match: the object its `server.init` returned,
   * the same one on every hook, and undefined for a script with no `init`.
   * Server-only and never replicated — a client half cannot read it, so nothing
   * both ends run may depend on it (docs/engine/scripting.md#a-script-keeps-its-own-state).
   */
  readonly memory: S;
  /** The world, with the verb that removes and restores its solids. */
  readonly world: ServerWorld;
  /**
   * Put a player on a side, by a name the gametype's `teams` lists. Naming one it
   * does not throws, because putting them on side 0 instead is a wrong answer
   * nothing would report.
   *
   * It moves the side and nothing else. Where they respawn follows on their next
   * death, since `playerSpawn` is asked then; what they are *wearing* does not
   * follow at all — a body is chosen once at join and a bullet is traced against
   * that skeleton, so redressing someone mid-game would move their hit boxes off
   * the body every client is drawing.
   */
  setTeam(id: PlayerId, team: TeamId): void;
  /** Put a player at a spawn, now: it becomes their spawn and they are placed on it. */
  spawn(id: PlayerId, at: ResolvedSpawn): void;
  /**
   * Take `amount` off somebody, as `by` — or as the world, for null — and by
   * `cause`, which a death it causes carries into the kill feed. `script` where it
   * names none; a blast a script sets off is `explosion`, and a neutral car's is
   * nobody's (`by` null), which makes the death a suicide.
   *
   * The number is used as given: the gametype's `damageScale` is the engine's
   * multiplier for a bullet's own arithmetic, and a script naming 30 already
   * knows its own scale. Nothing at or below zero does anything, so this is not a
   * way to heal — `CombatRules.regenRate` is.
   *
   * **Queued, and drained after the current hook returns**, never applied
   * re-entrantly: a damage hook that damages someone, whose death hook damages a
   * third, is a queue that drains rather than a stack that overflows. The same
   * rule `send` is specified with, and the reason it is written down there.
   */
  damage(id: PlayerId, amount: number, by: PlayerId | null, cause?: DamageCause): void;
  /**
   * Arm a player now, with these weapons instead of their class: full magazines,
   * primary in hand, in the middle of a life if they are alive. For somebody
   * dead it waits for their next spawn, once. Their class is untouched, so the
   * spawn after that arms them with it again — `setLoadout` is the one that lasts.
   *
   * **Nothing to desync.** A snapshot carries both weapons and a count of how
   * often the player has been armed, so a client rebuilds exactly what this
   * handed over instead of predicting a change it was never told about.
   *
   * A weapon this instance's catalogue does not hold throws, as `setTeam` does
   * for a side: an empty hand where a script asked for a rifle is a wrong answer
   * nothing would report.
   */
  arm(id: PlayerId, weapons: ArmedWith): void;
  /**
   * What a player spawns with from now on, instead of their class — or null to
   * give them their class back. Not applied until their next spawn; `arm` too, for
   * now as well. Their choices still count, and are what they get back.
   */
  setLoadout(id: PlayerId, weapons: ArmedWith | null): void;
  /**
   * What a class change this player makes mid-game does, over `ClassRules.change`
   * and the grace — `now` to let them change ad hoc, `refuse` to stop them, or
   * null to hand them back to the rules. Kept by the engine for the rest of the
   * match, since it is the engine that applies it.
   */
  setClassChange(id: PlayerId, timing: ClassTiming | null): void;
  /**
   * Add to a side's score. The engine gives a kill one point; this is everything
   * else. Kept on the game server and not sent: nothing reads a score yet.
   */
  score(team: TeamId, delta: number): void;
  /** A player's purse, as `PlayerView.points`: 0 for nobody here. */
  points(id: PlayerId): number;
  /**
   * Add `delta` points to a player's purse, or spend them with a negative one.
   * The snapshot carries the purse to every client, and the HUD shows it.
   *
   * A spend that would take them below zero throws — checking a price is the
   * script's, and a purse gone negative is one that check was skipped for — and
   * so does a gametype that declares no `points`, and a fraction. Past
   * `MAX_POINTS` the purse stops at it. Nobody here is ignored.
   */
  addPoints(id: PlayerId, delta: number): void;
  /**
   * Set one of the gametype's `counters`, which every client reads in the next
   * snapshot (`GameView.counter`) and the HUD shows. A name the gametype does not
   * declare throws, and so does a value that is not a whole number in ±2²³.
   */
  setCounter(name: string, value: number): void;
  /**
   * Bring a dead player back now: a spawn from `playerSpawn`, full health,
   * armed afresh — what the engine's own countdown does, for a gametype whose
   * `respawnDelay` is null and so never does it. False, and nothing done, for
   * somebody alive or not here.
   */
  respawn(id: PlayerId): boolean;
  /**
   * The gametype is over: this game server stops hosting it within a second and
   * tells the api, which puts its players back in their lobby. `reason` is for
   * the log. Say so first with `publish` — nothing else tells a client why.
   * Idempotent; the match plays on until it is dropped.
   */
  endMatch(reason: string): void;
  /**
   * Tell every client something happened.
   *
   * Built. The announcement rides the snapshot tail like every other event
   * (net/messages/events.ts), repeated for `ANNOUNCE_REPEAT_SECONDS` because a
   * player who missed one is misinformed for the rest of the round, and every
   * client's copy of this script's `client.event` hook hears it.
   *
   * **Broadcast, and localised at the far end.** There is no recipient here on
   * purpose: an announcement carries the side it is about, and each client reads
   * that against its own, so "we have the flag" and "the enemy has the flag" are
   * one event rather than two addressed messages a server has to split.
   *
   * An `Announcement` rather than an arbitrary value, which is what this said
   * before anything carried it: a value with no layout has nothing to write it
   * through, and an event both ends compile against is what makes repeating one
   * safe. A malformed one throws, as `setTeam` does for a side that does not
   * exist — a countdown that silently said nothing is the failure this whole
   * layer is avoiding.
   */
  publish(event: Announcement): void;
  /**
   * Say something to another script.
   *
   * Delivered at the end of the current hook and never re-entrantly, so a cycle
   * is a queue that drains rather than a stack that overflows. Not built.
   */
  send(to: ScriptId, message: unknown): void;
  /**
   * The bots in this match: players the server drives, each by a brain from
   * `BRAINS` (game/bots/registry.ts). See docs/engine/scripting.md, "Bots".
   */
  readonly bots: ScriptBots;
  /** Where a player is and how they are, or undefined for nobody here. */
  state(id: PlayerId): PlayerStateView | undefined;
  /**
   * The tags of every trigger this player's feet are in, as of this tick's
   * occupancy: each once, in trigger declaration order. Empty for the dead and
   * for nobody here. An area is every trigger sharing a tag, so this is "which
   * areas", and an untagged trigger adds nothing.
   */
  zonesOf(id: PlayerId): readonly string[];
  /** Every living player whose feet are in a trigger carrying `tag`, in roster order. */
  occupants(tag: string): PlayerId[];
  /** The world's navigation, as this match has it. */
  readonly nav: ScriptNav;
  /**
   * The actors in this match: creatures the server runs that are not players,
   * each of a kind in `ACTOR_KINDS` and driven by a brain from `BRAINS`. See
   * docs/engine/actors.md.
   */
  readonly actors: ScriptActors;
}

/** A script's hold on the match's actors. */
export interface ScriptActors {
  /**
   * Spawn one and return its id: counting up from 1, never reused in a match.
   * It stands where it is put and its brain starts on the next tick. A kind or a
   * brain nobody declared throws, and so does the 65,536th spawn of one match.
   */
  spawn(spec: ActorSpec): ActorId;
  /** Take one out at once, alive or dead. False for an id that is not here. */
  remove(id: ActorId): boolean;
  /** A new objective, or null for `none`; it thinks again at once. An id not here is ignored. */
  order(id: ActorId, objective: Objective | null): void;
  /**
   * Take `amount` off one, as `by` or as nobody, by `cause` (`script` where it
   * names none). Queued like `ServerContext.damage`, and heard by `actorDamage`.
   */
  damage(id: ActorId, amount: number, by: PlayerId | null, cause?: DamageCause): void;
  /** Every actor here, dead ones still lying included, in the order they were spawned. */
  ids(): readonly ActorId[];
  /** Where one is and how it is, as a copy; undefined for an id not here. */
  state(id: ActorId): ActorStateView | undefined;
}

/** A script's hold on the match's bots. */
export interface ScriptBots {
  /**
   * Add a bot and return its id (`#b` and a count, never reused). It joins as a
   * player does — `playerJoin`, a side, a spawn from `playerSpawn`, the gametype's
   * weapon — and its brain starts on the next tick. A brain or a side nobody
   * declared throws.
   */
  add(spec: BotSpec): PlayerId;
  /** Take a bot out. False for an id that is not a bot here. */
  remove(id: PlayerId): boolean;
  /**
   * Give a bot a new objective, or null for `none`; it thinks again at once.
   * Kept by the engine, which is where the bot's brain reads it. An id that is
   * here and is not a bot throws.
   */
  order(id: PlayerId, objective: Objective | null): void;
  /** Every bot here, in the order they were added. */
  ids(): readonly PlayerId[];
}

/**
 * The world's graph, as a script may use it: where its nodes are, and the
 * links a door or a script shuts (nav/dynamic.ts). The seam doors will use.
 */
export interface ScriptNav {
  /** Whether the world's graph is baked. Until it is, bots stand still and blockers wait. */
  readonly ready: boolean;
  /** The usable node nearest a point, within `maxDy` of its height; -1 for none, or before `ready`. */
  nearestNode(point: Vec3, maxDy?: number): number;
  /**
   * Shut the links through a box, or these links, under `id` (on unless `on` is
   * false). Returns the links it covers — none before `ready`, when it is kept
   * and applied the moment the graph is. An id in use is replaced.
   */
  addBlocker(id: string, shape: NavBlockerShape, on?: boolean): readonly number[];
  /** Open (false) or shut (true) a blocker. Whether anything changed. Bots replan around it. */
  setBlocked(id: string, on: boolean): boolean;
}
