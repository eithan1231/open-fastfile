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
// has sent since, and smooths the remainder into its camera.
//
// It was not always so, and what was deleted is worth knowing about. The server
// used to `reanchor` to each `InputMessage.claim` — adopting the client's own
// account of where it ended up — and only *measure* the gap. That kept the
// measurement honest for free: each step was replayed from where the client said
// the last one finished, so `DriftReport` held one step's error rather than a
// running sum. It had to, because two trajectories left to run free never rejoin
// — a wall is where a millimetre of disagreement becomes permanent, since one
// side stops against it while the other slides along it.
//
// Correcting changes that calculus rather than breaking it: the client now rejoins
// *us* on every snapshot, so the figure stays a per-step prediction error without
// us discarding our own answer to get one. What it measures is no longer "do the
// two simulations agree" but "how far ahead of the correction is this client
// predicting" — a number that is small for an honest client precisely because it
// is being corrected, and that is a validator's input rather than a diagnostic.
//
// Two consequences to know about. We own where a player spawns, so arriving
// through a pose link or keeping a position across a hot reload now snaps you to
// our idea of you. And a world with no collision mesh can no longer be hosted at
// all (worlds.ts): correcting a player against nothing is worse than not checking
// them.

import type { CapsuleWorld, RayHit, Vec3 } from "@3d/shared/sim/capsule.js";
import { BULLET_RANGE } from "@3d/shared/sim/weaponDef.js";
import { createMovement, EYE_HEIGHT, HEIGHT, RADIUS, type MovementState } from "@3d/shared/sim/movement.js";
import { NO_BODIES, type BodyView, type LoadedBody } from "./bodies.js";
import { PlayerHistory } from "./history.js";
import type { PhysicsWorld } from "@3d/shared/physics/world.js";
import { ENTITY_POLICY, type EntityKindId } from "@3d/shared/sim/entityKinds.js";
import { bodyKnock, localKnock, RAGDOLL_SEGMENTS, SEGMENT_FOR_LOCATION } from "@3d/shared/sim/ragdollBones.js";
import { poseFromRig } from "@3d/shared/rig/ragdollPose.js";
import type { ResolvedWorld } from "@3d/shared/dsl/resolved.js";
import { roundInput, type InputMessage } from "@3d/shared/net/messages/input.js";
import { botId, type PlayerId } from "@3d/shared/net/messages/fields.js";
import { after } from "@3d/shared/net/seq.js";
import { idleInput } from "@3d/shared/sim/input.js";
import type { NavGraph } from "@3d/shared/nav/graph.js";
import { NavMatchState, type NavBlockerShape } from "@3d/shared/nav/dynamic.js";
import { BotDriver, type BotTurn } from "@3d/shared/game/bots/driver.js";
import type { BrainContext } from "@3d/shared/game/bots/brain.js";
import { NO_OBJECTIVE, type BotSpec, type Objective } from "@3d/shared/game/bots/objective.js";
import { ALL_ABILITIES, NavPlanner } from "@3d/shared/game/bots/planner.js";
import { actorMover } from "@3d/shared/nav/mover.js";
import { brainFor } from "@3d/shared/game/bots/registry.js";
import type { BotController, BotOptions } from "./bots.js";
import { Actors } from "./actors.js";
import type { ActorId, ActorState } from "@3d/shared/game/actors/actor.js";
import { MAX_SNAPSHOT_ACTORS } from "@3d/shared/net/messages/actors.js";
import {
  MAX_ANNOUNCE_NAME_BYTES,
  MAX_ANNOUNCE_VALUE,
  MAX_SNAPSHOT_EVENTS,
  MAX_SPAWNS_PER_SNAPSHOT,
  MIN_ANNOUNCE_VALUE,
  type AnnounceEvent,
  type DeathEvent,
  type GameEvent,
  type HitEvent,
  type SpawnEvent,
} from "@3d/shared/net/messages/events.js";
import type { PlayerSnapshot, SnapshotMessage } from "@3d/shared/net/messages/snapshot.js";
import { Player } from "@3d/shared/sim/player.js";
import { applyWorldRules, spawnPoints, type SpawnQuery } from "@3d/shared/sim/worldRules.js";
import type { ResolvedSpawn } from "@3d/shared/dsl/resolved.js";
import type { Loadout } from "@3d/shared/sim/loadout.js";
import { CATALOG_VERSION, WeaponRegistry, type WeaponId } from "@3d/shared/sim/weaponRegistry.js";
import { catalogueViewOf, type CatalogueView } from "@3d/shared/game/catalogueView.js";
import { bodyFor, type CastChoice } from "@3d/shared/game/cast.js";
import { MODEL_FACING } from "@3d/shared/rig/character.js";
import { couldHit, POSE_MARGIN, type BodyHit } from "@3d/shared/rig/hitboxes.js";
import type { HitLocation } from "@3d/shared/sim/hitLocations.js";
import { bodyYaw } from "@3d/shared/sim/pose.js";
import { aimAngles, aimDirection, coneSample, shotSpread, shotStream, spreadDirection, type Aim, type ReadKick } from "@3d/shared/sim/recoil.js";
import type { WeaponController, WeaponData } from "@3d/shared/sim/weapon.js";
import type { GameView, PlayerStateView, PlayerView, ServerContext } from "@3d/shared/game/context.js";
import { defaultGametype } from "@3d/shared/game/gametypes/default.js";
import type { GametypeDecl, TeamId } from "@3d/shared/game/gametypes/declaration.js";
import type { Announcement } from "@3d/shared/game/announcement.js";
import type { DamageEvent, DamageVerdict, Script } from "@3d/shared/game/hooks.js";
import { hashString } from "@3d/shared/game/random.js";
import { scriptsFor } from "@3d/shared/game/registry.js";
import { DEFAULT_COMBAT_RULES, shotDamage, type CombatRules } from "@3d/shared/game/rules.js";
import { DEFAULT_CLASS_RULES, type ArmedWeapon, type ArmedWith, type ClassRequest, type ClassRules, type ClassTiming } from "@3d/shared/game/classes.js";
import { isSuicide } from "@3d/shared/game/damage.js";
import { counterIndex, isMatchValue, MATCH_VALUE_MAX, MATCH_VALUE_MIN, MAX_POINTS } from "@3d/shared/game/matchValues.js";
import { indexWorld, type WorldIndex } from "@3d/shared/worlds/worldIndex.js";
import { DEFAULT_SURFACE } from "@3d/shared/sim/surfaces.js";
import { presenceFor, presentNamed, type Presence } from "@3d/shared/worlds/presence.js";
import { focusOf, usableBy, usableThings, viewerAt, type UsableThing } from "@3d/shared/game/focus.js";
import type { Bounds } from "@3d/shared/game/volumes.js";
import type { PlayerInput } from "@3d/shared/sim/input.js";
import type { ServerWorld } from "@3d/shared/game/context.js";
import { capsuleIn, MatchParts } from "./parts.js";
import { Occupancy } from "./occupancy.js";

/**
 * Inputs one player may spend in a single tick. A client at our tick rate sends
 * one; a burst after a stall is legitimate and worth draining. Past this it is
 * either a stall long enough that replaying it is pointless or a client buying
 * itself extra movement, and neither deserves the CPU.
 */
const MAX_INPUTS_PER_TICK = 4;

/**
 * How much of the recent past to keep, seconds.
 *
 * Deliberately four times `MAX_REWIND_SECONDS`, so that **the ring is never the
 * binding constraint**: a tick that has aged out of it can only come from a clock
 * that has drifted or a client that is lying, which keeps those two failure modes
 * distinguishable from ordinary lag. At 60 Hz and ~200 bytes a state it is about
 * 12 KB per player.
 */
const HISTORY_SECONDS = 1;

/**
 * How far back a shot may reach, seconds.
 *
 * This is the bound on the injustice lag compensation does to the person being
 * shot at: they can be killed up to this long after they broke line of sight on
 * their own screen. A quarter-second is the usual figure, and it is a number a
 * victim can reason about.
 */
const MAX_REWIND_SECONDS = 0.25;

/** How far a bullet reaches. Shared, because a client predicting one traces the same distance. */
const SHOT_RANGE = BULLET_RANGE;

/**
 * Damage applications one drain may make before it is a script in a loop.
 *
 * A hook may damage somebody, and *their* death hook somebody else; that is the
 * point of a queue, and it terminates on its own because a dead player takes no
 * more damage. A cycle that does not terminate is a bug in a script, and it would
 * otherwise take this match's tick with it. Sixty-four is far more than a chain
 * of real deaths can be and far less than a loop needs to hurt.
 */
const MAX_DAMAGE_PER_DRAIN = 64;

/**
 * How long a death keeps riding in the snapshot tail, seconds.
 *
 * A kill feed line that never arrives is a permanent lie about the match, and
 * there is no reliable channel to put one on (net/messages/events.ts). Half a
 * second is thirty datagrams' redundancy at 60 Hz: a burst loss longer than that
 * is a connection that has already stopped being playable. A hit marker is
 * retained for nothing at all, which is the other half of that decision.
 */
const KILL_FEED_REPEAT_SECONDS = 0.5;

/**
 * How long an announcement keeps riding in the snapshot tail, seconds.
 *
 * Twice a death's, because the two failures are not the same size: a kill feed
 * line that never arrives is contradicted by a scoreboard the player can open,
 * and "the enemy has the flag" is contradicted by nothing — a player who missed
 * it is misinformed for the rest of the round. It costs almost nothing to say so:
 * an announcement is a handful of bytes, they are rare where deaths are not, and
 * `outgoingFor` gives up the *oldest* first, so the kind held longest is the kind
 * dropped first under pressure rather than one crowding a death out.
 */
const ANNOUNCE_REPEAT_SECONDS = 1;

/**
 * How many announcements one tick may raise before it is a script in a loop.
 *
 * The tail carries seven events of every kind together, so a script publishing
 * per tick per player is a snapshot with nothing in it but chatter. Dropped and
 * said out loud rather than thrown, unlike a runaway `damage()`: a flood is not a
 * wrong answer the way an unanswerable hit is, and a throw here would take every
 * other game on this process's tick with it.
 */
const MAX_ANNOUNCEMENTS_PER_TICK = 8;

/** One encoder, to measure a published name against the field that has to carry it. */
const NAME_BYTES = new TextEncoder();

/**
 * A shot one tick's replay fired, and what it found.
 *
 * **No client ever sends one of these.** It exists because this server stepped
 * that client's own input through the same weapon state machine and the shot
 * counter advanced (`WeaponData.fired`), which is what makes rate of fire,
 * ammunition, burst discipline and reload gating unforgeable: there is nothing
 * to forge.
 */
export interface FiredShot {
  shooter: PlayerId;
  /** `WeaponData.fired` after this round left: which shot of this weapon's life it was. */
  ordinal: number;
  /** Where it came from and which way it went, for whoever has to draw or explain it. */
  from: Vec3;
  direction: Vec3;
  /** Null where the bullet reached `SHOT_RANGE` without meeting anything. */
  result: ShotResult | null;
}

/** How far a client's claim sits from our replay of the same step. Metres, per step, never cumulative. */
export interface DriftReport {
  /** The most recent input applied. */
  current: number;
  /** The worst single step this session: a spike, which one bad tick is enough to cause. */
  max: number;
  /**
   * The average step. This is the number that catches a systematic mismatch —
   * a prop solid on one end and air on the other holds a small error on *every*
   * step, which `max` cannot tell apart from one dropped packet.
   */
  mean: number;
  /** Inputs compared so far, so a max of 0 can be told from no data. */
  samples: number;
}

/**
 * How often a client asked to be judged against a moment this server could not
 * honour as asked.
 *
 * Measured before it is trusted, exactly as drift was: `implausible` is a client
 * naming a tick we never sent it, `clamped` is one reaching further back than
 * `MAX_REWIND_SECONDS` allows. Neither refuses the shot. Both being zero is the
 * expected state, and either being nonzero says something specific — a clock that
 * has drifted, or a client that is lying.
 */
export interface RewindReport {
  implausible: number;
  clamped: number;
}

/** A shot that stopped on the map. */
export interface WorldShot {
  kind: "world";
  /** Metres from the shot's origin. */
  distance: number;
  normal: Vec3;
  /** Which clipmap tree answered, as `RayHit.kind` means it. */
  surface: "map" | "prop";
}

/** A shot that landed on somebody. Damage is the caller's: this says what was hit, not what it cost. */
export interface PlayerShot {
  kind: "player";
  id: PlayerId;
  /** The joint whose box the bullet entered. `location` is what a hit on it counts as. */
  bone: string;
  location: HitLocation;
  distance: number;
}

/** A shot that landed on an actor (actors.ts). */
export interface ActorShot {
  kind: "actor";
  id: ActorId;
  /** The joint whose box it entered, or "" for a kind shot as its capsule. */
  bone: string;
  location: HitLocation;
  distance: number;
}

/** What a shot found. Null is a shot that reached its range without meeting anything. */
export type ShotResult = WorldShot | PlayerShot | ActorShot;

/**
 * Damage waiting its turn.
 *
 * A `DamageEvent` and nothing more: what a script is handed when it is asked
 * about a hit is exactly what the engine is carrying, so there is no second
 * description of a hit to keep in step with the first.
 */
/**
 * A hit on its way to somebody's health, plus what the *corpse* will need.
 *
 * `DamageEvent` is what a script sees and is deliberately about health alone. A
 * ragdoll needs the round itself — which way it was going, and how hard — and that
 * is known only where the shot was traced and is gone by the end of the tick
 * (`fireShots` clears `shots`). So it rides along here rather than being looked up
 * again from something that no longer exists.
 */
type PendingDamage = DamageEvent & {
  /** Unit, along the round that caused it. Absent for damage no bullet caused. */
  readonly along?: Vec3;
  /**
   * Past a script's say: no `playerDamage` verdict. What the world does when it
   * gives up on somebody — a player held under the kill plane whose death a
   * script refused would hang there for the rest of the match.
   */
  readonly certain?: boolean;
};

/** A hit on its way to an actor: the same queue as a player's, told apart by `kind`. */
interface PendingActorDamage {
  readonly kind: "actor";
  readonly actor: ActorId;
  readonly amount: number;
  readonly by: PlayerId | null;
  readonly cause: DamageEvent["cause"];
  readonly location?: HitLocation;
  /** Past a script's say, as a player's fall out of the world is. */
  readonly certain?: boolean;
}

/**
 * An event waiting to go out, with the last tick it may ride on and who is to
 * hear it (null: everybody).
 *
 * Retention is per event rather than per kind because it is the only thing that
 * differs between them: a hit marker lives for the tick it happened on, a death
 * for `KILL_FEED_REPEAT_SECONDS` of them.
 */
interface Outgoing {
  event: GameEvent;
  to: PlayerId | null;
  until: number;
}

interface Member {
  /** Ours: the same input, re-simulated. This is the state a snapshot carries. */
  player: Player;
  queue: InputMessage[];
  /** The last seq we applied, echoed back as SnapshotMessage.ack. Never goes back: the queue is in seq order. */
  ack: number;
  /**
   * The newest seq queued or applied, or undefined before the first. Datagrams
   * arrive reordered and repeat each other's inputs (`InputPacket.earlier`), so
   * anything not after this is a copy or a straggler and is dropped.
   */
  newest: number | undefined;
  /** What this player was doing, tick by tick, so a shot can be judged against it. */
  history: PlayerHistory;
  /**
   * The newest tick whose snapshot has gone out to them.
   *
   * A client cannot have been drawing a tick it has not been sent, so this is the
   * ceiling on any moment it may ask us to rewind to — and asking for one past it
   * is the cheapest lie there is to catch.
   */
  sentTick: number;
  drift: DriftReport;
  /**
   * Which engine they predict in, from their join. Reported beside `drift` and
   * never acted on — see `JoinMessage.engine`.
   */
  engine: string;
  /** Dropped because the queue was already full: a flooding or badly lagged client. */
  dropped: number;
  /**
   * The match clock when they joined, which is what `PlayerView.since` carries.
   *
   * A script with no state of its own (`ServerHooks.init`) derives its clock
   * from this, since it is on the view it is handed each tick.
   */
  since: number;
  /**
   * The body a bullet is traced against, or undefined where this instance cannot
   * build one (no catalogue, a hand-written world, a body that would not load).
   *
   * Resolved once, at join. Per shot would mean running the gametype's scripts over
   * a freshly indexed world for every bullet (`castFor` → `view` → `indexWorld`),
   * and a player must not change body mid-game in any case: the browser dressed
   * them once too.
   */
  body: LoadedBody | undefined;
  /** The class they carry, and are re-armed with at every spawn. Undefined for a player joined with none. */
  loadout: Loadout | undefined;
  /** Which of their classes that is, as the game order lists them: what a repeated choice is recognised by. */
  classIndex: number | undefined;
  /**
   * A class chosen for their next spawn, held until then — how a change that is
   * not allowed to take effect at once is enforced. Nothing else ever equips a
   * member except `armFor`, and it reads this only at a spawn.
   */
  pending: { loadout: Loadout; index: number } | undefined;
  /** The tick they last spawned on, which the class grace is measured from. */
  spawnedAt: number;
  /** A script's word on this player's mid-game changes (`ServerContext.setClassChange`), over the rules. */
  classChange: ClassTiming | undefined;
  /** What a script has them spawn with instead of their class (`setLoadout`), until it says otherwise. */
  forced: ArmedWith | undefined;
  /** What a script armed them with while they were dead (`arm`): their next spawn, once. */
  armNext: ArmedWith | undefined;
  /** Set for a bot: what writes its input, since no client sends any. See `thinkBots`. */
  bot: BotState | undefined;
  /**
   * Whether the last input spent held the use key. Kept across inputs and ticks,
   * so a press is its rising edge and a repeated or re-sent input presses nothing.
   */
  useHeld: boolean;
}

/** A bot's side of a member. */
interface BotState {
  controller: BotController;
  /** Its place among the match's bots, from 1: what spreads their thinks over the ticks. */
  index: number;
  /** The last input's `seq`, counting as a client's does. */
  seq: number;
  /** Its controller threw once: said then, and not asked again. It stands still. */
  failed: boolean;
  /** What a script last said it is for (`bots.order`, `botObjective`), kept here so a script need not. */
  objective: Objective;
  /** Counts `bots.order` calls, so the bot thinks again at once. */
  ordered: number;
}

/** What a match is playing: the map, the rules, and the catalogue its cast comes from. */
export interface Playing {
  /** The world's slug, which is what a gametype's `maps` restriction names. */
  map: string;
  gametype: GametypeDecl;
  catalogue: CatalogueView;
  /** The rigs a shot is traced against, for the bodies that catalogue dresses players in. */
  bodies: BodyView;
  /**
   * The scripts this match runs. Absent means the registry's answer for this
   * gametype and map, which is what a real game gets.
   *
   * Here for the reason a `CapsuleWorld` and a `BodyView` are constructor
   * arguments rather than things this builds: a test that wants to watch a hook
   * fire has nowhere else to put one, since `SCRIPTS` is a compiled-in table and
   * there is nothing to register with. Nothing in the server passes it.
   */
  scripts?: readonly Script[];
  /**
   * The world's navigation, shared by every game on the map (worlds.ts). Its
   * graph is null until baked, and bots stand still until it is not. Absent for
   * a world with none, where they stand still for good.
   */
  nav?: { readonly graph: NavGraph | null; readonly partLinks?: readonly (readonly number[])[]; readonly actorPartLinks?: readonly (readonly number[])[] };
  /**
   * What an actor collides with: the same presence on the `ai` channel
   * (`CollisionWorld.view(presence, "ai")`). Absent: the players' collision.
   */
  actorCollision?: CapsuleWorld;
  /**
   * Which of the world's solids are present, live. The same object the match's
   * collision view reads (`CollisionWorld.view`), so `Games` hands in both.
   * Absent: seeded here from the gametype's mode, for a test with no parts.
   */
  presence?: Presence;
  /** One part alone (`CollisionWorld.partView`), for a restore's overlap check. */
  partView?: (index: number) => CapsuleWorld;
  /** A part's bounds (`CollisionWorld.partBounds`): where a solid with `use` is. Absent: no solid is usable. */
  partBounds?: (index: number) => Bounds | undefined;
}

export class Match {
  private readonly members = new Map<PlayerId, Member>();
  private currentTick = 0;
  /** How often a rewind could not be honoured as asked. See `RewindReport`. */
  private readonly rewinds: RewindReport = { implausible: 0, clamped: 0 };
  /**
   * The dynamics this game is simulating, or undefined while it is simulating none.
   *
   * **Built on demand, and today never.** A physics world costs a Rapier trimesh
   * over the map — 88k triangles on dome-mw3, 296k on interchange — and a Rapier
   * collider belongs to one world, so two games on one map would pay it twice.
   * Nothing the server reads depends on a corpse (`ENTITY_POLICY.ragdoll` is
   * `serverSimulates: false`), so no game builds one. The first kind gameplay reads
   * — a grenade, whose resting place decides who dies — is what turns this on, and
   * `spawnEntity` is where.
   */
  private physics: PhysicsWorld | undefined;
  /** Makes one, when something finally needs it. Set by `Games`; absent in a test that does not care. */
  private physicsFactory: (() => PhysicsWorld | undefined) | undefined;
  /** Advances per join, never per player, so two players never take the same point in a row. */
  private spawnCursor = 0;
  /**
   * One shot's scratch: where a player was, what the map answered, and the far end
   * of the segment. A burst of pellets allocates its answers and nothing else.
   */
  private readonly rewound: MovementState = createMovement({ x: 0, y: 0, z: 0 }, 0, 0);
  private readonly mapHit: RayHit = { distance: 0, normal: { x: 0, y: 0, z: 0 }, kind: "map", surface: DEFAULT_SURFACE };
  private readonly shotEnd: Vec3 = { x: 0, y: 0, z: 0 };
  /** Where a shot leaves along, refilled per round: the shooter's intent plus the kick. */
  private readonly shotAim: Aim = { yaw: 0, pitch: 0 };
  private readonly shotDirection: Vec3 = { x: 0, y: 0, z: 0 };
  /** Where in this round's cone it goes, refilled per round (sim/recoil.ts). */
  private readonly shotCone = { angle: 0, radius: 0 };
  /** Every shot this tick's replay fired, cleared at the top of `step`. */
  private readonly shots: FiredShot[] = [];
  /** Everything a script published this tick, cleared with the shots. */
  private readonly published: Announcement[] = [];
  /** What each client has still to be told, oldest first. See `Outgoing`. */
  private readonly outbox: Outgoing[] = [];
  /**
   * The last event id issued, counting up for the life of this match and
   * wrapping at 16 bits.
   *
   * Never per recipient: a client de-dupes by keeping the newest id it has seen,
   * which only works while the order is one order. It reaches a joining player in
   * `joined`, so their watermark starts where this count already is.
   */
  private lastEventId = 0;
  /** The tick a script's flood of announcements was last complained about, so it is said once per tick. */
  private floodedTick = -1;
  /** Entity ids, 12 bits, counting up for the life of the match beside `lastEventId`. */
  private lastEntityId = 0;
  /** What combat costs here. Asked of the scripts once, in the constructor, and fixed after. */
  private combat: CombatRules = DEFAULT_COMBAT_RULES;
  /** Who may choose a class, and when it takes effect. Asked once, beside `combat`. */
  private classes: ClassRules = DEFAULT_CLASS_RULES;
  /** Damage asked for and not yet applied. See `hurt`: this drains, it does not recurse. */
  private readonly pendingDamage: (PendingDamage | PendingActorDamage)[] = [];
  /** The creatures this match runs that are not players (actors.ts). */
  private readonly actors: Actors;
  /** Every actor as the last `step` left it, which each snapshot carries — or, past the cap, the nearest. */
  private actorStates: ActorState[] = [];
  private draining = false;
  /** What each side has scored. A side with no entry has scored nothing. */
  private readonly points = new Map<TeamId, number>();
  /** The gametype's counters, in its `counters` order: what `setCounter` sets and the snapshot carries. */
  private readonly counterValues: number[];
  /**
   * Each script's own state (`ServerHooks.init`), made once in the constructor
   * and handed back to its every hook as `ctx.memory`. Keyed by the script
   * object, since that is what the hooks are asked through.
   */
  private readonly memories = new Map<Script, unknown>();
  /** Why a script ended the match (`ServerContext.endMatch`), once one has. `Games` stops hosting it. */
  private endedBy: string | undefined;
  private failure: string | undefined;
  /**
   * The world as a script addresses it, built once.
   *
   * `indexWorld` walks every object in the map, and a context is now built per
   * hit rather than per join — which on a busy tick is several a tick. The world
   * itself never changes for the life of a match, so this is a pure function of a
   * constant.
   */
  private index: WorldIndex | undefined;
  /** The scripts this match asks, resolved once: `scriptsFor` is a filter, and a hit asks again. */
  private readonly scripts: readonly Script[];
  /** Members that are bots, so `humans` is a subtraction rather than a walk of the roster every tick. */
  private bots = 0;
  /** Bots this match has ever added, which is what the next one's id counts from: an id is never reused. */
  private botsMinted = 0;
  /** The graph, this match's blocked links and the search its bots share, once the world's bake is done. */
  private planner: NavPlanner | undefined;
  /** The same graph by an actor's links (nav/mover.ts), with blocked links of its own. Built beside `planner`. */
  private actorPlanner: NavPlanner | undefined;
  /** Blockers a script added before the graph was baked, applied the moment it is. */
  private readonly pendingBlockers = new Map<string, { shape: NavBlockerShape; on: boolean }>();
  /** Whether `matchStart` has been asked: on the first step, once. */
  private begun = false;
  /** The world's removable parts: what is present, and what a script has asked to change. */
  private readonly parts: MatchParts;
  /** The index a script sees, with `setPresent` on it. Built once, like the index. */
  private scriptWorld: ServerWorld | undefined;
  /** Which triggers each player's feet are in, as of this tick. */
  private readonly occupancy: Occupancy;
  /** Every trigger and solid with `use`, built on the first press: the world never changes. */
  private usables: UsableThing[] | undefined;
  /** Presses this tick's drain found something in focus for, asked of `interact` after it. */
  private readonly uses: { id: PlayerId; thing: UsableThing }[] = [];

  constructor(
    private readonly collision: CapsuleWorld,
    private readonly world: ResolvedWorld,
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
    this.actors = new Actors(playing.actorCollision ?? collision, world, tickRate, playing.bodies, {
      catalogue: playing.catalogue,
      seed: hashString(playing.map),
    });
    this.scripts = playing.scripts ?? scriptsFor(playing.gametype.id, playing.map);
    this.parts = new MatchParts(
      world,
      () => (this.index ??= indexWorld(this.world)),
      playing.presence ?? presenceFor(world, playing.gametype.mode),
      playing.partView,
    );
    this.occupancy = new Occupancy(world.triggers, playing.gametype.mode);
    this.counterValues = (playing.gametype.counters ?? []).map(() => 0);
    // Before any other hook, so the first `combatRules` already has its state.
    const making = this.serverContext();
    for (const script of this.scripts) {
      if (script.server?.init) {
        this.memories.set(script, script.server.init(making));
      }
    }
    // At match start, which for a Match is the moment it exists: the rules reach
    // every client in `joined` and are read on every hit, so there is no later
    // point at which asking again would be safe.
    this.combat = this.askCombatRules();
    this.classes = this.askClassRules();
  }

  get tickDt(): number {
    return 1 / this.tickRate;
  }

  /** Everyone in the match, bots included: everyone a snapshot carries. */
  get size(): number {
    return this.members.size;
  }

  /**
   * The members who are people. What decides that a game is empty, what an
   * instance reports as its load and what fills a game's seats: a bot keeps no
   * game alive and takes nobody's place.
   */
  get humans(): number {
    return this.members.size - this.bots;
  }

  get tick(): number {
    return this.currentTick;
  }

  /** The api sized the lobby in people, so bots do not count against it. */
  get full(): boolean {
    return this.humans >= this.maxPlayers;
  }

  has(id: PlayerId): boolean {
    return this.members.has(id);
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

  /**
   * Add a bot, and return the id it was given: `#b` and a count (`botId`), which
   * the api can never issue. It joins as a player does — a side, a spawn, a class
   * or the gametype's weapon — and from the next tick its controller moves it.
   * A side the gametype does not have throws, as `setTeam` does.
   */
  addBot(spec: BotOptions): PlayerId {
    let side: number | undefined;
    if (spec.team !== undefined) {
      side = this.playing.gametype.teams.indexOf(spec.team);
      if (side < 0) {
        throw new Error(`a bot was put on "${spec.team}", which gametype "${this.playing.gametype.id}" does not have`);
      }
    }
    const index = ++this.botsMinted;
    const id = botId(index);
    this.admit(id, spec.loadout, "bot", spec.loadout === undefined ? undefined : 0, side, {
      controller: spec.controller,
      index,
      seq: 0,
      failed: false,
      objective: spec.objective ?? NO_OBJECTIVE,
      ordered: 0,
    });
    return id;
  }

  /** `ServerContext.bots.add`: a bot driven by a brain from `BRAINS`, which is how a real game gets one. */
  private addScriptedBot(spec: BotSpec): PlayerId {
    const brain = brainFor(spec.brain);
    if (!brain) {
      throw new Error(`a script added a bot with brain "${spec.brain}", which nothing declares`);
    }
    return this.addBot({ controller: new BotDriver(brain, spec.params), team: spec.team, objective: spec.objective });
  }

  /** `ServerContext.bots.order`. */
  private orderBot(id: PlayerId, objective: Objective | null): void {
    const member = this.members.get(id);
    if (!member) {
      return;
    }
    if (!member.bot) {
      throw new Error(`a script gave ${id} an objective, and ${id} is not a bot`);
    }
    member.bot.objective = objective ?? NO_OBJECTIVE;
    member.bot.ordered++;
  }

  /** Take a bot out of the match. False for an id that is not a bot here. */
  removeBot(id: PlayerId): boolean {
    if (this.members.get(id)?.bot === undefined) {
      return false;
    }
    this.leave(id);
    return true;
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
    if (this.members.has(id)) {
      return "now";
    }
    const player = new Player(this.collision, this.weapons);
    // The stream this player's recoil draws from. Their id, hashed — the browser
    // hashes the same id the moment it is told it, so the kick this server gives
    // a shot is the kick that client already predicted (sim/recoil.ts).
    player.setSeed(hashString(id));
    // Before the spawn, which a gametype chooses by side.
    player.setTeam(side ?? this.sideFor());
    // Held under the kill plane rather than put back on a spawn: here passing it
    // is a death (`fallOutOfWorld`), and the client predicts the same hold.
    player.setFallOut("die");
    const member: Member = {
      player,
      queue: [],
      ack: 0,
      newest: undefined,
      history: new PlayerHistory(Math.max(2, Math.round(this.tickRate * HISTORY_SECONDS))),
      sentTick: -1,
      drift: { current: 0, max: 0, mean: 0, samples: 0 },
      engine,
      dropped: 0,
      since: this.currentTick / this.tickRate,
      body: this.bodyOf(id),
      loadout: undefined,
      classIndex: undefined,
      pending: undefined,
      spawnedAt: this.currentTick,
      classChange: undefined,
      forced: undefined,
      armNext: undefined,
      bot,
      useHeld: false,
    };
    // In the roster before a script is asked about their class, so the hook sees
    // them and anything it calls on them lands.
    this.members.set(id, member);
    if (bot) {
      this.bots++;
    }
    // In the roster and on a side, not yet placed: a script may change the side
    // here, and the spawn it is asked for next follows it.
    const joining = this.serverContext();
    for (const script of this.scripts) {
      script.server?.playerJoin?.(this.scoped(joining, script), id);
    }
    applyWorldRules(player, this.world, this.spawnFor(id));

    let timing: ClassTiming = "now";
    if (loadout !== undefined) {
      const asked = this.classes.customClasses ? "now" : "refuse";
      timing = this.classVerdict({ id, index: index ?? 0, first: true, alive: false, sinceSpawn: 0, timing: asked }) === "refuse" ? "refuse" : "now";
      if (timing === "now") {
        member.loadout = loadout;
        member.classIndex = index;
      }
    }
    this.armFor(member);
    player.respawn();
    player.revive(this.combat.maxHealth);
    return timing;
  }

  /**
   * A player's `index`th class, chosen mid-game. Returns when it takes effect —
   * see `ClassTiming` — which is decided here, in this order: no classes in this
   * gametype, a script's `refuse` for this player, a dead player (whose soonest is
   * their next spawn), a script's word for this player, the grace after a spawn,
   * and the gametype's rule. Then the `classChoice` hook has the last word.
   *
   * The same choice again changes nothing: the client re-sends until it is
   * answered, and a repeat must not refill a magazine by re-arming.
   */
  chooseLoadout(id: PlayerId, loadout: Loadout, index: number): ClassTiming {
    const member = this.members.get(id);
    if (!member) {
      return "refuse";
    }
    if (member.pending?.index === index) {
      return "nextSpawn";
    }
    if (member.classIndex === index) {
      // The class in hand. Choosing it again cancels a change still waiting.
      member.pending = undefined;
      return "now";
    }

    const alive = !member.player.dead;
    const sinceSpawn = (this.currentTick - member.spawnedAt) / this.tickRate;
    let timing: ClassTiming;
    if (!this.classes.customClasses || member.classChange === "refuse") {
      timing = "refuse";
    } else if (!alive) {
      timing = "nextSpawn";
    } else if (member.classChange !== undefined) {
      timing = member.classChange;
    } else if (sinceSpawn < this.classes.grace) {
      timing = "now";
    } else {
      timing = this.classes.change;
    }
    timing = this.classVerdict({ id, index, first: false, alive, sinceSpawn, timing });
    // Nothing is in a corpse's hands to change: the soonest is the next spawn.
    if (timing === "now" && !alive) {
      timing = "nextSpawn";
    }

    if (timing === "now") {
      member.loadout = loadout;
      member.classIndex = index;
      member.pending = undefined;
      // A script's weapons outrank a class (`setLoadout`): the class is theirs
      // again the moment the script lets go, and not before.
      if (member.forced === undefined) {
        this.armFor(member);
      }
    } else if (timing === "nextSpawn") {
      member.pending = { loadout, index };
    }
    return timing;
  }

  /** What the gametype's scripts say about a class request. The first with an opinion wins. */
  private classVerdict(request: ClassRequest): ClassTiming {
    const ctx = this.serverContext();
    for (const script of this.scripts) {
      const said = script.server?.classChoice?.(this.scoped(ctx, script), request);
      if (said) {
        return said;
      }
    }
    return request.timing;
  }

  /**
   * Hand a member what they carry now: what a script armed them with while they
   * were dead, else what a script has them spawn with, else their class.
   */
  private armFor(member: Member): void {
    const scripted = member.armNext ?? member.forced;
    member.armNext = undefined;
    if (scripted) {
      member.player.equipWeapons(armedWeapon(scripted.primary), armedWeapon(scripted.secondary));
      return;
    }
    const player = member.player;
    if (member.loadout) {
      player.equipLoadout(member.loadout);
    }
    if (!member.loadout || player.weaponId === null) {
      player.equipById(this.defaultWeapon());
    }
  }

  /** The class rules this match plays by, as the wire carries `customClasses` in `joined`. */
  get classRules(): ClassRules {
    return this.classes;
  }

  /**
   * The body this player wears, as `@3d/shared` decides it — the same call the
   * browser makes, off the same id, so the bones a bullet meets are the bones
   * somebody was drawn with.
   *
   * Asked with no side, because the browser asks with no side (`remotePlayers.spawn`
   * says why): narrowing the cast by team here would dress a player in a body the
   * client is not drawing, which is a hit box on another body's skeleton.
   */
  private bodyOf(id: PlayerId): LoadedBody | undefined {
    // The body's own game, which a borrowed cast (`castFor`'s stand-in) makes
    // other than the world's.
    const character = bodyFor(id, this.castFor()?.characters ?? []);
    return character === undefined ? undefined : this.playing.bodies.get(character.body.game, character.id);
  }

  leave(id: PlayerId): void {
    if (this.members.get(id)?.bot) {
      this.bots--;
    }
    this.members.delete(id);
    this.occupancy.remove(id);
  }

  /**
   * Which side the next player joins: the smallest, and the earliest of those on a
   * tie.
   *
   * Deterministic on purpose, so a test can assert it and two runs of the same
   * joins produce the same sides. Null in a free-for-all, which is a gametype
   * declaring no `teams` — not the same thing as a gametype whose sides are full,
   * which cannot happen because the smallest side always has room.
   *
   * A script overrides it through `ServerContext.setTeam`; this is only the
   * default, the way `spawnFor` is only the default placement.
   */
  private sideFor(): number | null {
    const sides = this.playing.gametype.teams;
    if (sides.length === 0) {
      return null;
    }
    const counts = sides.map(() => 0);
    for (const member of this.members.values()) {
      const side = member.player.side;
      if (side !== null && side < counts.length) {
        counts[side]!++;
      }
    }
    let best = 0;
    for (let i = 1; i < counts.length; i++) {
      if (counts[i]! < counts[best]!) {
        best = i;
      }
    }
    return best;
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

  /** A player's side as the scripts name it, or undefined in a free-for-all. */
  private teamOf(id: PlayerId): string | undefined {
    const side = this.members.get(id)?.player.side;
    return side == null ? undefined : this.playing.gametype.teams[side];
  }

  /**
   * What a player spawns holding when their class arms them with nothing this
   * instance holds.
   *
   * The gametype's, not the world's: a world says nothing about what anyone
   * carries any more. Null where this gametype names none, or names one this
   * instance's catalogue does not hold — unarmed is visible, and a different gun
   * would not be.
   */
  private defaultWeapon(): WeaponId | null {
    const named = this.castFor()?.defaultWeapon;
    return named != null && this.weapons.entry(named) ? named : null;
  }

  /**
   * Who a player of this match is, as the gametype's scripts answer it.
   *
   * The same call the browser makes, with the same inputs, so the two cannot
   * disagree about what anyone is wearing or carrying — which is the reason
   * `castFor` is pure.
   */
  private castFor(team?: string): CastChoice | undefined {
    const view = this.view();
    for (const script of this.scripts) {
      const chosen = script.client?.cast?.(view, team);
      if (chosen) {
        return chosen;
      }
    }
    return undefined;
  }

  /**
   * Where to put the next player. Round-robin over the spawns the gametype asks
   * for — deliberately not the furthest-from-an-enemy rule a real spawn system
   * needs, which wants teams this does not have yet.
   *
   * The query is the gametype's now rather than a fixed `{ start: true }`, which
   * is what finally reaches the `mode:` and `team:` every imported map has
   * carried all along. With the default gametype it *is* `{ start: true }`, so
   * nothing about today's placement changes.
   *
   * Undefined means the world declared no spawns, and `applyWorldRules` falls
   * back to the single one every world has.
   */
  private spawnFor(id: PlayerId): ResolvedSpawn | undefined {
    const points = spawnPoints(this.world, this.spawnQuery(id));
    if (points.length === 0) {
      return undefined;
    }
    return points[this.spawnCursor++ % points.length];
  }

  /** What the gametype's scripts want asked of the map. The first with an opinion wins. */
  private spawnQuery(id: PlayerId): SpawnQuery {
    for (const script of this.scripts) {
      const wanted = script.server?.playerSpawn?.(this.scoped(this.serverContext(), script), id);
      if (wanted) {
        return wanted;
      }
    }
    return { start: true };
  }

  /** What every script sees, on either end. */
  private view(): GameView {
    this.index ??= indexWorld(this.world);
    return {
      world: this.index,
      game: this.world.game,
      map: this.playing.map,
      gametype: this.playing.gametype,
      catalogue: this.playing.catalogue,
      now: this.currentTick / this.tickRate,
      seed: hashString(this.playing.map),
      players: [...this.members].map(([id, member]) => this.playerView(id, member)),
      player: (id) => {
        const member = this.members.get(id);
        return member === undefined ? undefined : this.playerView(id, member);
      },
      // The applied presence, which is what the snapshot carries: a hook both ends
      // run reads the same bits here as a browser does.
      isPresent: (tagOrName) => presentNamed(this.index!, this.parts.presence, tagOrName),
      counter: (name) => this.counterValues[counterIndex(this.playing.gametype, name)]!,
    };
  }

  private playerView(id: PlayerId, member: Member): PlayerView {
    return { id, team: this.teamOf(id), since: member.since, bot: member.bot !== undefined, points: member.player.points };
  }

  /**
   * `ctx` as `script` is handed it: with its own state as `memory`. A copy per
   * script, so a script that keeps a context never reads another's state — and
   * none at all for a script with no `init`, which is most of them.
   */
  private scoped(ctx: ServerContext, script: Script): ServerContext {
    return this.memories.has(script) ? { ...ctx, memory: this.memories.get(script) } : ctx;
  }

  /**
   * The authority a server hook is handed.
   *
   * `send` throws rather than doing nothing, because it is not built and a silent
   * no-op would let a script believe it had been heard. That is the rule the rest
   * of these kept until they existed.
   */
  private serverContext(): ServerContext {
    return {
      ...this.view(),
      memory: undefined,
      world: (this.scriptWorld ??= {
        ...(this.index ??= indexWorld(this.world)),
        setPresent: (tagOrName, on) => this.parts.request(tagOrName, on, (part) => this.occupied(part)),
        isPresent: (tagOrName) => this.parts.isPresent(tagOrName),
      }),
      setTeam: (id, team) => this.setTeam(id, team),
      spawn: (id, at) => this.placeAt(id, at),
      damage: (id, amount, by, cause = "script") => this.hurt({ id, amount, by, cause }),
      arm: (id, weapons) => this.armNow(id, weapons),
      setLoadout: (id, weapons) => {
        const member = this.members.get(id);
        if (member) {
          member.forced = weapons === null ? undefined : this.checkArmed(weapons);
        }
      },
      setClassChange: (id, timing) => {
        const member = this.members.get(id);
        if (member) {
          member.classChange = timing ?? undefined;
        }
      },
      score: (team, delta) => this.addScore(team, delta),
      points: (id) => this.members.get(id)?.player.points ?? 0,
      addPoints: (id, delta) => this.addPoints(id, delta),
      setCounter: (name, value) => this.setCounter(name, value),
      respawn: (id) => this.respawnNow(id),
      endMatch: (reason) => {
        this.endedBy ??= reason;
      },
      publish: (event) => this.publish(event),
      send: (): never => {
        throw new Error("a script called send(), which is declared but not built");
      },
      bots: {
        add: (spec) => this.addScriptedBot(spec),
        remove: (id) => this.removeBot(id),
        order: (id, objective) => this.orderBot(id, objective),
        ids: () => [...this.members].filter(([, member]) => member.bot !== undefined).map(([id]) => id),
      },
      state: (id) => this.stateOf(id),
      zonesOf: (id) => this.occupancy.zonesOf(id),
      occupants: (tag) => [...this.members.keys()].filter((id) => this.occupancy.isIn(id, tag)),
      actors: {
        spawn: (spec) => this.actors.spawn(spec),
        remove: (id) => this.actors.remove(id),
        order: (id, objective) => this.actors.order(id, objective),
        damage: (id, amount, by, cause = "script") => this.hurt({ kind: "actor", actor: id, amount, by, cause }),
        ids: () => this.actors.ids(),
        state: (id) => this.actors.state(id),
      },
      nav: {
        ready: this.navigation !== null,
        nearestNode: (point, maxDy) => this.navigation?.nearestNode(point, maxDy) ?? -1,
        addBlocker: (id, shape, on = true) => this.addBlocker(id, shape, on),
        setBlocked: (id, on) => this.setBlocked(id, on),
      },
    };
  }

  /** Where a player is and how they are, as a script or a brain reads it. A copy: nothing written to it moves anybody. */
  private stateOf(id: PlayerId): PlayerStateView | undefined {
    const member = this.members.get(id);
    if (!member) {
      return undefined;
    }
    const { feet, yaw } = member.player.movement;
    return { feet: { x: feet.x, y: feet.y, z: feet.z }, yaw, alive: !member.player.dead, health: member.player.health, team: this.teamOf(id) };
  }

  /** What a brain sees: the view, where everyone is, and the graph. Reads only. */
  private brainContext(nav: NavPlanner): BrainContext {
    return { ...this.view(), state: (id) => this.stateOf(id), nav };
  }

  /** `ServerContext.nav.addBlocker`: on the match's state, or kept until there is one. */
  private addBlocker(id: string, shape: NavBlockerShape, on: boolean): readonly number[] {
    const nav = this.navigation;
    if (!nav) {
      this.pendingBlockers.set(id, { shape, on });
      return [];
    }
    this.actorPlanner?.state.addBlocker(id, shape, on);
    return nav.state.addBlocker(id, shape, on);
  }

  private setBlocked(id: string, on: boolean): boolean {
    const nav = this.navigation;
    if (!nav) {
      const pending = this.pendingBlockers.get(id);
      if (!pending || pending.on === on) {
        return false;
      }
      pending.on = on;
      return true;
    }
    this.actorPlanner?.state.setBlocked(id, on);
    return nav.state.setBlocked(id, on);
  }

  /** What combat costs here, as the wire carries it to a client in `joined`. */
  get rules(): CombatRules {
    return this.combat;
  }

  /** What each side has scored. Empty in a free-for-all: `score` is keyed by side, and there are none. */
  get scores(): ReadonlyMap<TeamId, number> {
    return this.points;
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

  /** `NetServer.tick`'s catch: end this match for `err`, and only this one. */
  fail(err: unknown): void {
    this.failure ??= err instanceof Error ? err.message : String(err);
  }

  /** The counters as the snapshot carries them. */
  private countersNow(): number[] {
    return [...this.counterValues];
  }

  /** `ServerContext.addPoints`: the purse moves, never below nothing and never past what the wire carries. */
  private addPoints(id: PlayerId, delta: number): void {
    if (!this.playing.gametype.points) {
      throw new Error(`a script gave ${id} points, and gametype "${this.playing.gametype.id}" keeps none`);
    }
    if (!Number.isInteger(delta)) {
      throw new Error(`points are whole: a script asked for ${delta}`);
    }
    const player = this.members.get(id)?.player;
    if (!player) {
      return;
    }
    const next = player.points + delta;
    if (next < 0) {
      throw new Error(`a script took ${-delta} points from ${id}, who has ${player.points}`);
    }
    player.setPoints(Math.min(MAX_POINTS, next));
  }

  /** `ServerContext.setCounter`: a declared name and a value the wire can carry, or a throw. */
  private setCounter(name: string, value: number): void {
    const index = counterIndex(this.playing.gametype, name);
    if (!isMatchValue(value)) {
      throw new Error(`counter "${name}" wants a whole number in ${MATCH_VALUE_MIN}..${MATCH_VALUE_MAX}, not ${value}`);
    }
    this.counterValues[index] = value;
  }

  /** `ServerContext.respawn`: a dead player back now, as the countdown would have put them. */
  private respawnNow(id: PlayerId): boolean {
    const member = this.members.get(id);
    if (!member?.player.dead) {
      return false;
    }
    this.respawnPlayer(id, member);
    return true;
  }

  /**
   * Everything a script published on this tick, cleared at the top of the next.
   *
   * Every one of these is also in the outbox and on its way to every client — the
   * tail carries them like any other event now that an announcement has a layout
   * both ends compile against (net/messages/events.ts). This is what a test and a
   * diagnostic read, because the outbox is private and holds several ticks at
   * once.
   */
  get eventsThisTick(): readonly Announcement[] {
    return this.published;
  }

  /**
   * The event counter as it stands, which is the watermark a joining player is
   * given in `joined`. Everything they are ever told about is above it.
   */
  get eventCursor(): number {
    return this.lastEventId;
  }

  /**
   * Put an event in the outbox, to ride on the next `snapshotFor` and on every
   * one up to `hold` seconds later.
   *
   * The id is issued here and nowhere else, so the order one client sees is the
   * order every client sees — which is what makes "newer than the newest I have
   * seen" a sound de-dupe at the far end.
   */
  private announce(
    event: Omit<HitEvent, "id"> | Omit<DeathEvent, "id"> | Omit<SpawnEvent, "id"> | Omit<AnnounceEvent, "id">,
    to: PlayerId | null,
    hold: number,
  ): void {
    this.lastEventId = (this.lastEventId + 1) & 0xffff;
    this.outbox.push({
      event: { ...event, id: this.lastEventId } as GameEvent,
      to,
      until: this.currentTick + Math.round(this.tickRate * hold),
    });
  }

  /**
   * What a script said happened, on its way to every client.
   *
   * **Checked here rather than at the codec**, because a `str(5)` that threw
   * would do it halfway through encoding a snapshot the whole room was waiting
   * for. A malformed announcement throws where the script asked for it — the rule
   * `setTeam` already follows, and for the same reason: a countdown that said
   * nothing, or said it about the wrong side, is a wrong answer nothing would
   * report.
   *
   * The side becomes an **index** into the gametype's `teams`, as
   * `PlayerState.team` does, and undefined stays null rather than becoming side 0.
   */
  private publish(event: Announcement): void {
    const bytes = NAME_BYTES.encode(event.what).length;
    if (bytes === 0 || bytes > MAX_ANNOUNCE_NAME_BYTES) {
      throw new Error(`publish() wants a name of 1..${MAX_ANNOUNCE_NAME_BYTES} bytes, not ${bytes}: "${event.what}"`);
    }
    if (event.value !== undefined && (!Number.isInteger(event.value) || event.value < MIN_ANNOUNCE_VALUE || event.value > MAX_ANNOUNCE_VALUE)) {
      throw new Error(`publish() wants an integer in ${MIN_ANNOUNCE_VALUE}..${MAX_ANNOUNCE_VALUE}, not ${event.value}`);
    }
    const side = event.team === undefined ? null : this.playing.gametype.teams.indexOf(event.team);
    if (side !== null && side < 0) {
      throw new Error(`publish() named side "${event.team}", which ${this.playing.gametype.id} does not have`);
    }
    if (event.player !== undefined && !this.members.has(event.player)) {
      throw new Error(`publish() named player "${event.player}", who is not in this match`);
    }

    if (this.published.length >= MAX_ANNOUNCEMENTS_PER_TICK) {
      // Once per tick, not once per event dropped: a flood that logs per event is
      // a second flood. `published` holds what actually went out, so a test and a
      // diagnostic see the cap rather than being told about it.
      if (this.floodedTick !== this.currentTick) {
        this.floodedTick = this.currentTick;
        console.warn(`[match] a script published more than ${MAX_ANNOUNCEMENTS_PER_TICK} announcements in one tick; dropping the rest`);
      }
      return;
    }
    this.published.push(event);
    this.announce({ kind: "announce", what: event.what, team: side, value: event.value ?? null, player: event.player ?? null }, null, ANNOUNCE_REPEAT_SECONDS);
  }

  /**
   * What `id` has still to hear, oldest first.
   *
   * Capped at what the tail can carry, keeping the **newest**: an event that has
   * been in here longest has been sent most often, so it is the one whose loss is
   * least likely and whose repeat is worth least.
   */
  private outgoingFor(id: PlayerId): GameEvent[] {
    const mine = this.outbox.filter((held) => held.to === null || held.to === id).map((held) => held.event);

    // Spawns are capped first and separately. One is a hundred bytes against a
    // death's twenty, nearly all of it the sixteen rotations a corpse starts from,
    // so seven of them would be a tail worth more than the snapshot it rides on.
    // The newest are kept for the same reason the tail keeps the newest of
    // anything: one that has been held longest has been sent most often.
    let spawns = 0;
    const capped: GameEvent[] = [];
    for (let i = mine.length - 1; i >= 0; i--) {
      const event = mine[i]!;
      if (event.kind === "spawn" && ++spawns > MAX_SPAWNS_PER_SNAPSHOT) {
        continue;
      }
      capped.unshift(event);
    }
    return capped.length <= MAX_SNAPSHOT_EVENTS ? capped : capped.slice(capped.length - MAX_SNAPSHOT_EVENTS);
  }

  /** The class rules the gametype's scripts want, asked once, as `askCombatRules` is. */
  private askClassRules(): ClassRules {
    const ctx = this.serverContext();
    for (const script of this.scripts) {
      const wanted = script.server?.classRules?.(this.scoped(ctx, script));
      if (wanted) {
        return { ...DEFAULT_CLASS_RULES, ...wanted };
      }
    }
    return DEFAULT_CLASS_RULES;
  }

  /**
   * `ServerContext.arm`: these weapons in their hands now if they are alive, or at
   * their next spawn — once — if they are not.
   */
  private armNow(id: PlayerId, weapons: ArmedWith): void {
    const member = this.members.get(id);
    if (!member) {
      return;
    }
    member.armNext = this.checkArmed(weapons);
    if (!member.player.dead) {
      this.armFor(member);
    }
  }

  /**
   * A script's weapons, checked against this instance's catalogue before anything
   * is equipped. A weapon it does not hold, or an attachment that weapon does not
   * offer, throws: a script that asked for a rifle and silently got an empty hand
   * is a wrong answer nothing would report — `setTeam`'s rule.
   */
  private checkArmed(weapons: ArmedWith): ArmedWith {
    for (const armed of [weapons.primary, weapons.secondary]) {
      if (!armed) {
        continue;
      }
      const entry = this.weapons.entry(armed.weapon);
      if (!entry) {
        throw new Error(`a script armed a player with "${armed.weapon}", which this instance's catalogue does not hold`);
      }
      for (const attachment of armed.attachments ?? []) {
        if (!entry.attachments.some((offered) => offered.id === attachment)) {
          throw new Error(`a script fitted "${attachment}" to "${armed.weapon}", which does not offer it`);
        }
      }
    }
    return weapons;
  }

  /**
   * The rules the gametype's scripts want, asked once. The first with an opinion
   * wins, over the defaults — `spawnQuery`'s rule, for the same reason.
   */
  private askCombatRules(): CombatRules {
    const ctx = this.serverContext();
    for (const script of this.scripts) {
      const wanted = script.server?.combatRules?.(this.scoped(ctx, script));
      if (wanted) {
        return { ...DEFAULT_COMBAT_RULES, ...wanted };
      }
    }
    return DEFAULT_COMBAT_RULES;
  }

  /**
   * Put a player on a side, as `ServerContext.setTeam` does.
   *
   * An unknown side throws. A gametype's `teams` is the whole vocabulary, and
   * quietly putting a misspelled side on index 0 would be a wrong answer that
   * looks like an ordinary assignment for the rest of the match.
   */
  private setTeam(id: PlayerId, team: TeamId): void {
    const side = this.playing.gametype.teams.indexOf(team);
    if (side < 0) {
      throw new Error(`a script put a player on "${team}", which gametype "${this.playing.gametype.id}" does not have`);
    }
    this.members.get(id)?.player.setTeam(side);
  }

  /** Put a player on a spawn, as `ServerContext.spawn` does: it becomes theirs, and they are on it now. */
  private placeAt(id: PlayerId, at: ResolvedSpawn): void {
    const player = this.members.get(id)?.player;
    if (!player) {
      return;
    }
    player.setSpawn(at.position, at.look);
    player.respawn();
  }

  private addScore(team: TeamId, delta: number): void {
    this.points.set(team, (this.points.get(team) ?? 0) + delta);
  }

  // -- Damage ----------------------------------------------------------------------

  /**
   * Take health off somebody — eventually.
   *
   * **A queue, never a stack.** The hit is pushed, and drained only by whichever
   * call is not already draining: a `playerDamage` hook that damages a second
   * player, whose `playerDeath` hook damages a third, is one loop here rather than
   * three frames of recursion. It is the rule `ServerContext.send` is specified
   * with, written down there before either existed, and it is why a hook may damage
   * freely without knowing what it is being called from.
   */
  private hurt(hit: PendingDamage | PendingActorDamage): void {
    this.pendingDamage.push(hit);
    if (this.draining) {
      return;
    }
    this.draining = true;
    try {
      for (let applied = 0; this.pendingDamage.length > 0; applied++) {
        if (applied >= MAX_DAMAGE_PER_DRAIN) {
          this.pendingDamage.length = 0;
          throw new Error(`a script's damage did not stop after ${MAX_DAMAGE_PER_DRAIN} applications`);
        }
        this.applyDamage(this.pendingDamage.shift()!);
      }
    } finally {
      this.draining = false;
    }
  }

  /**
   * One hit, all the way through: who is allowed to land it, what the scripts say
   * it costs, what it takes off, and what a death that follows is worth.
   */
  private applyDamage(hit: PendingDamage | PendingActorDamage): void {
    if ("kind" in hit) {
      this.applyActorDamage(hit);
      return;
    }
    const member = this.members.get(hit.id);
    // A body takes no more damage, which is also what makes `playerDeath` fire
    // exactly once: nothing can take the same player below zero twice.
    if (!member || member.player.dead || !this.mayHurt(hit.id, hit.by)) {
      return;
    }

    const verdict = hit.certain ? undefined : this.damageVerdict(hit);
    if (verdict?.ignore) {
      return;
    }
    const amount = verdict?.amount ?? hit.amount;
    // No delay at all where the gametype brings the dead back itself: `stepHealth`
    // does not count them down.
    if (!member.player.hurt(amount, this.combat.respawnDelay ?? 0)) {
      return;
    }

    this.awardKill(hit.id, hit.by);
    // Before the hooks, so that a death a hook causes is announced after the one
    // that caused it: the ids are the order, and a feed reads top to bottom.
    this.announce({ kind: "death", victim: hit.id, killer: hit.by, cause: hit.cause }, null, KILL_FEED_REPEAT_SECONDS);
    // Nobody is there to see a body fall out of the bottom of the world.
    if (hit.cause !== "outOfWorld") {
      this.announceCorpse(hit, member);
    }
    const ctx = this.serverContext();
    for (const script of this.scripts) {
      script.server?.playerDeath?.(this.scoped(ctx, script), hit.id, hit.by, hit.cause, hit.actor);
    }
  }

  /**
   * One hit on an actor, all the way through: `actorDamage` has the last word on
   * what it costs, and `actorDeath` hears the death, once. Nothing is scored: what
   * an actor is worth is the gametype's to say.
   */
  private applyActorDamage(hit: PendingActorDamage): void {
    if (!this.actors.alive(hit.actor)) {
      return;
    }
    let verdict: DamageVerdict | undefined;
    if (!hit.certain) {
      const ctx = this.serverContext();
      for (const script of this.scripts) {
        const said = script.server?.actorDamage?.(this.scoped(ctx, script), hit.actor, hit.amount, hit.by, hit.location, hit.cause);
        if (said) {
          verdict = said;
          break;
        }
      }
    }
    if (verdict?.ignore || !this.actors.hurt(hit.actor, verdict?.amount ?? hit.amount, this.currentTick)) {
      return;
    }
    const ctx = this.serverContext();
    for (const script of this.scripts) {
      script.server?.actorDeath?.(this.scoped(ctx, script), hit.actor, hit.by, hit.cause, hit.location);
    }
  }

  /**
   * The actors' tick: after the players have moved and before health, so a blow
   * that kills starts its victim's countdown on this tick. Brains see the players
   * where this tick's inputs left them.
   */
  private stepActors(): void {
    if (this.actors.size === 0) {
      return;
    }
    const nav = this.actorNavigation;
    let brains: BrainContext | undefined;
    this.actors.step({
      tick: this.currentTick,
      dt: this.tickDt,
      nav,
      context: () => (brains ??= this.brainContext(nav!)),
      feetOf: (id) => this.members.get(id)?.player.movement.feet,
      target: (id) => {
        const player = this.members.get(id)?.player;
        return player && { feet: player.movement.feet, alive: !player.dead };
      },
      blow: (target, amount, actor) => this.hurt({ id: target, amount, by: null, cause: "melee", actor }),
      fell: (actor, health) => this.hurt({ kind: "actor", actor, amount: health, by: null, cause: "outOfWorld", certain: true }),
    });
  }

  /**
   * The actors one player is told about: all of them, or past the cap the nearest
   * to them, nearest first and spawn order on a tie. Somebody not in the match —
   * seated, choosing a class — has no feet to measure from and gets the oldest.
   */
  private actorsFor(id: PlayerId): ActorState[] {
    const all = this.actorStates;
    if (all.length <= MAX_SNAPSHOT_ACTORS) {
      return all;
    }
    const feet = this.members.get(id)?.player.movement.feet;
    if (!feet) {
      return all.slice(0, MAX_SNAPSHOT_ACTORS);
    }
    const away = (a: ActorState) => (a.feet.x - feet.x) ** 2 + (a.feet.y - feet.y) ** 2 + (a.feet.z - feet.z) ** 2;
    return all
      .map((actor) => ({ actor, d: away(actor) }))
      .sort((a, b) => a.d - b.d || a.actor.id - b.actor.id)
      .slice(0, MAX_SNAPSHOT_ACTORS)
      .map(({ actor }) => actor);
  }

  /**
   * Describe the body this death left behind, for every client to build.
   *
   * **The pose is what makes this worth sending.** Every end runs the same
   * simulation, so the only thing that has to travel is where the body started —
   * but it has to travel exactly, and the pose cannot be recomputed at the far end
   * to the precision a rigid-body sim needs (net/messages/entities.ts says why).
   * The rig is already posed, at the instant of the killing round, because that is
   * how the round was judged.
   *
   * The impulse is the round's own: `direction * impulseFor(amount)`, at the
   * segment the hit location names. A death no bullet caused pushes nothing, and
   * the body simply falls.
   *
   * Silent where this instance has no body for the player — a hand-written world,
   * a missing catalogue — which is the same condition that already means it cannot
   * trace a bullet against them.
   */
  private announceCorpse(hit: PendingDamage, member: Member): void {
    const body = member.body;
    if (!body) {
      return;
    }
    // Posed exactly as `traceBody` poses it, because a corpse that starts anywhere
    // other than where the body was drawn is a body that jumps as it dies.
    const movement = member.player.movement as MovementState;
    const root = body.rig.root;
    root.position.set(movement.feet.x, movement.feet.y, movement.feet.z);
    root.rotation.y = bodyYaw(movement) + MODEL_FACING;
    body.poser.update(movement, member.player.weapon?.data ?? null, 0);
    root.updateMatrixWorld(true);

    const pose = poseFromRig(body.rig);
    if (!pose) {
      return; // not a body with a skeleton to fall over; the death still stands
    }

    // A round does two things and they travel as two fields — see `bodyKnock` and
    // `localKnock`. The **body** knock carries the whole corpse along the round,
    // and is sent apart from the victim's own velocity because the far end shares
    // the two out differently: momentum to every segment equally, knock weighted by
    // height so the body topples about its feet. The **local** knock stays an
    // impulse at the bone that was hit, which is the snap on top.
    const segment = hit.location ? SEGMENT_FOR_LOCATION[hit.location] : "chest";
    const along = hit.along;
    const carry = along ? bodyKnock(hit.amount) : 0;
    const push = along ? localKnock(hit.amount, segment) : 0;

    this.announce(
      {
        kind: "spawn",
        entity: (this.lastEntityId = (this.lastEntityId + 1) & 0xfff),
        what: "ragdoll",
        tick: this.currentTick & 0xffff,
        ragdoll: {
          victim: hit.id,
          origin: pose[0]!.position,
          rotations: pose.map((at) => at.rotation),
          velocity: movement.velocity,
          knock: along ? { x: along.x * carry, y: along.y * carry, z: along.z * carry } : { x: 0, y: 0, z: 0 },
          segment: RAGDOLL_SEGMENTS.indexOf(segment),
          impulse: along ? { x: along.x * push, y: along.y * push, z: along.z * push } : { x: 0, y: 0, z: 0 },
        },
      },
      null,
      KILL_FEED_REPEAT_SECONDS,
    );
  }

  /**
   * Whether `by` may take health off `id`.
   *
   * Only a **teammate** is stopped. A player may always hurt themselves — their
   * own grenade is the usual way, and a rule that stopped it would make a
   * gametype's own kill volume unusable too — and `by` being null is the world
   * rather than a person. In a free-for-all nobody has a side, so nobody is a
   * teammate.
   */
  private mayHurt(id: PlayerId, by: PlayerId | null): boolean {
    if (this.combat.friendlyFire || by === null || by === id) {
      return true;
    }
    const shooter = this.members.get(by)?.player.side ?? null;
    return shooter === null || shooter !== (this.members.get(id)?.player.side ?? null);
  }

  /** What the gametype's scripts say this hit costs. The first with an opinion wins. */
  private damageVerdict(hit: DamageEvent): DamageVerdict | undefined {
    const ctx = this.serverContext();
    for (const script of this.scripts) {
      const said = script.server?.playerDamage?.(this.scoped(ctx, script), hit);
      if (said) {
        return said;
      }
    }
    return undefined;
  }

  /**
   * A point to whoever earned it.
   *
   * Not a suicide and not a teamkill: neither is a kill, and a mode with friendly
   * fire on would otherwise reward one. A free-for-all scores nothing at all,
   * because `score` is keyed by side and a free-for-all has none — per-player
   * scoring needs a verb that does not exist yet.
   *
   * The two refusals overlap today: somebody is always on their own side, so the
   * teamkill test already refuses every suicide and the first clause cannot be
   * observed on its own. It is written anyway, because it is the reason — and
   * because the day a free-for-all keeps a score, it is the only one left.
   */
  private awardKill(victim: PlayerId, killer: PlayerId | null): void {
    if (killer === null || isSuicide(victim, killer)) {
      return;
    }
    const side = this.teamOf(killer);
    if (side === undefined || side === this.teamOf(victim)) {
      return;
    }
    this.addScore(side, 1);
  }

  /**
   * A tick of health: the dead counted down, the living regenerating.
   *
   * The delay is read **before** the clock advances, so "regeneration starts after
   * `regenDelay`" is a fact about one tick rather than about which side of an
   * increment it was asked on.
   */
  private stepHealth(): void {
    for (const [id, member] of this.members) {
      const player = member.player;
      if (player.dead) {
        // Null: the gametype's own `respawn`, and never the clock's.
        if (this.combat.respawnDelay !== null && player.countdown(this.tickDt)) {
          this.respawnPlayer(id, member);
        }
      } else {
        player.recover(this.tickDt, player.sinceDamage >= this.combat.regenDelay ? this.combat.regenRate : 0);
      }
    }
  }

  /**
   * Put a dead player back. A fresh spawn from the gametype's own query, and full
   * health.
   *
   * Armed afresh, as every spawn is — full magazines, primary in hand — with the
   * class they chose while they were down if they chose one, and whatever a
   * script has said about their weapons ahead of any class (`armFor`).
   */
  private respawnPlayer(id: PlayerId, member: Member): void {
    applyWorldRules(member.player, this.world, this.spawnFor(id));
    if (member.pending) {
      member.loadout = member.pending.loadout;
      member.classIndex = member.pending.index;
      member.pending = undefined;
    }
    this.armFor(member);
    member.spawnedAt = this.currentTick;
    member.player.respawn();
    member.player.revive(this.combat.maxHealth);
  }

  /**
   * Everybody the last inputs carried past the kill plane dies of it: nobody's
   * doing, so a suicide, and past any script's say (`PendingDamage.certain`).
   * `Player.step` has already held them where they fell, on this end and on
   * theirs.
   */
  private fallOutOfWorld(): void {
    for (const [id, member] of this.members) {
      if (!member.player.dead && member.player.outOfWorld) {
        this.hurt({ id, amount: member.player.health, by: null, cause: "outOfWorld", certain: true });
      }
    }
  }

  /**
   * Queue one input. Deliberately does not step: the tick owns the clock, so a
   * client cannot advance itself by sending faster.
   *
   * Only an input newer than any before it: one that arrives after a later one
   * would be applied out of order and lower `ack`, and a repeat would be applied
   * twice. A packet's inputs come oldest first, so a gap is filled in order.
   */
  receive(id: PlayerId, message: InputMessage): void {
    const member = this.members.get(id);
    if (!member) {
      return;
    }
    if (member.newest !== undefined && !after(message.seq, member.newest)) {
      return;
    }

    // A cap rather than unbounded growth: a client that stops reading is a
    // memory leak, and replaying a two-second-old input helps nobody.
    if (member.queue.length >= MAX_INPUTS_PER_TICK * 4) {
      member.dropped++;
      return;
    }

    member.queue.push(message);
    member.newest = message.seq;
  }

  /**
   * Forget which seqs this player has sent: a new connection for a seated player
   * counts from the start again, and every one of its inputs would read as old.
   */
  resetInputs(id: PlayerId): void {
    const member = this.members.get(id);
    if (member) {
      member.queue.length = 0;
      member.newest = undefined;
    }
  }

  /**
   * Advance every player by the inputs they have sent, and return the
   * authoritative state. The returned message's `ack` is meaningless on its own
   * — `snapshotFor` sets each player's own.
   */
  step(): SnapshotMessage {
    this.currentTick++;
    this.shots.length = 0;
    this.published.length = 0;
    // Retention expires here rather than on delivery: an event is dropped once,
    // by the clock, and not once per player who has been sent it.
    for (let i = this.outbox.length - 1; i >= 0; i--) {
      if (this.outbox[i]!.until < this.currentTick) {
        this.outbox.splice(i, 1);
      }
    }

    // Once, on the first tick, and whether or not anybody is here yet: a
    // gametype's bots are added here, so they are on the map before the first
    // player. Before the bots think, so the ones it adds think this tick.
    if (!this.begun) {
      this.begun = true;
      const ctx = this.serverContext();
      for (const script of this.scripts) {
        script.server?.matchStart?.(this.scoped(ctx, script));
      }
    }

    // Before the drain, so a bot's input for this tick is spent in it, like a
    // client's that arrived in time.
    this.thinkBots();

    for (const [id, member] of this.members) {
      const inputs = member.queue.splice(0, MAX_INPUTS_PER_TICK);

      for (const message of inputs) {
        member.ack = message.seq;
        // An edge and never a level: held across inputs, so a press is asked once
        // however long the key stays down. Tracked while dead too, so a key held
        // through a respawn presses nothing.
        const pressed = message.input.use && !member.useHeld;
        member.useHeld = message.input.use;

        // A dead player is acked and not simulated: the queue must still drain or
        // it backs up for the whole countdown, but nothing moves and nothing
        // fires. A client that keeps predicting is corrected on the next
        // snapshot, which is what a death screen exists to cover.
        if (member.player.dead) {
          continue;
        }
        // Before the step: from where they stood when the input was made, which
        // is where the prompt they read was worked out from.
        if (pressed) {
          this.pressUse(id, member, message.input);
        }

        // The client's own dt, not our wall clock: re-simulating the step they
        // actually took is the whole point. Clamped because it is still a claim
        // about time, and the codec's 0.25 s ceiling is far too generous to hand
        // to gravity.
        const dt = Math.min(Math.max(message.dt, 0), 2 * this.tickDt);
        const held = member.player.weapon;
        const firedBefore = held?.data.fired ?? 0;
        // **Trace, then kick.** A bullet is away before the weapon recoils, so a
        // round fired on this step leaves along the aim as it stood *before* the
        // step's own impulse — the aim the player last saw. Copied, because
        // `Player.step` adds that impulse into this very object.
        const aimedWith = held ? { pitch: held.data.viewKick.pitch, yaw: held.data.viewKick.yaw } : null;
        // The cone is the same case and for the same reason: a round is placed by
        // how hot the weapon was *before* its own `fireAdd` opened it further,
        // which is also the cone the shooter was shown. Two numbers, because the
        // width needs the aim as it stood too — a shot loosed on the step that
        // finished raising the sights is an aimed shot.
        const heldWith = held ? { spread: held.data.spread, ads: held.data.ads } : null;
        member.player.step(message.input, dt);
        // Inside the loop, because this is the only scope holding both the input
        // that fired and the `renderTick`/`renderFrac` naming the moment its
        // sender was drawing: four queued inputs are four different moments.
        this.fireShots(id, member, held, firedBefore, aimedWith, heldWith, message);

        // Measured, and then **not** acted on. The claim is evidence about what
        // the client predicted; our own answer is what anybody gets told.
        //
        // This is where a `reanchor(message.claim)` used to be, and deleting it is
        // what makes this server authoritative. It was defensible while the client
        // was believed anyway: it kept each measurement to one step's error rather
        // than a running sum, because two trajectories left to run free never
        // rejoin. They do not have to any more — the client adopts our state on
        // every snapshot and replays its unacked inputs from it, so the figure
        // stays a per-step prediction error without us throwing our own answer
        // away to get one. It is now the client that rejoins us.
        //
        // A bot has no client and claims nothing, so there is nothing to measure;
        // nor does an input recovered from a later datagram.
        if (!member.bot && message.claim) {
          record(member.drift, distance(member.player.movement.feet, message.claim.feet));
        }
      }
    }

    // After every input is spent, so a hook that changes the world does so between
    // players' steps rather than in the middle of one.
    this.interactions();

    // After the inputs that carried anybody over the edge, and before health, so
    // their countdown starts on this tick like any other death's.
    this.fallOutOfWorld();
    this.stepActors();

    // After the shots, so a player killed this tick starts their countdown on it
    // rather than a tick late, and before the history below, which records the
    // state a snapshot carries.
    this.stepHealth();

    // After health, so a player who died this tick leaves what they were in on it,
    // and before `tick`, so a gametype's clock reads where everyone is now.
    this.stepOccupancy();

    // After health, so a gametype's own clock sees this tick's deaths and
    // respawns rather than last tick's — and before the physics step, so a player
    // a script kills here leaves their body on the same tick as every other
    // death. One context for all of them, because `view()` walks the roster and
    // this runs sixty times a second.
    this.stepScripts();

    // After health, so anything spawned by a death this tick exists before the
    // world is advanced past it. Exactly once per tick, whatever happened above:
    // the step count is what every end has to agree on.
    this.physics?.step(this.currentTick);

    // After the physics step, so the tick that stepped with a part is the tick it
    // leaves on, on every end (`SnapshotPresence.since`); the next tick's movement
    // and shots see the change.
    this.parts.flush(this.currentTick, {
      physics: this.physics,
      nav: this.planner?.state,
      actorNav: this.actorPlanner?.state,
      occupied: (part) => this.occupied(part),
    });

    // After the inputs are spent, so a slot holds the state at the *end* of its
    // tick — which is what a client drew, since a snapshot carries exactly this.
    for (const member of this.members.values()) {
      member.history.record(this.currentTick, member.player.movement as MovementState);
    }

    this.actorStates = this.actors.snapshot(this.currentTick);
    return {
      tick: this.currentTick,
      ack: 0,
      presence: this.parts.snapshot,
      players: this.playerStates(),
      actors: this.actorStates.slice(0, MAX_SNAPSHOT_ACTORS),
      counters: this.countersNow(),
      events: [],
    };
  }

  /**
   * What `id` pressed the use key on, if anything: their focus (game/focus.ts)
   * from `feet` and the input's own view angles, found now and asked of
   * `interact` once the drain is done. The server's focus, never the client's
   * word: nothing on the wire names a thing.
   */
  private pressUse(id: PlayerId, member: Member, input: PlayerInput): void {
    const things = (this.usables ??= usableThings(this.world, this.playing.gametype.mode, (i) => this.playing.partBounds?.(i)));
    if (things.length === 0) {
      return;
    }
    const view = this.view();
    const player = view.player(id)!;
    const viewer = viewerAt(member.player.movement.feet, input.yaw, input.pitch);
    const thing = focusOf(this.collision, things, this.parts.presence, viewer, (t) => usableBy(this.scripts, view, t, player));
    if (thing) {
      this.uses.push({ id, thing });
    }
  }

  /** Every press this tick found a thing for, to every script's `interact`, in the order they were pressed. */
  private interactions(): void {
    if (this.uses.length === 0) {
      return;
    }
    const ctx = this.serverContext();
    for (const { id, thing } of this.uses.splice(0)) {
      for (const script of this.scripts) {
        script.server?.interact?.(this.scoped(ctx, script), thing, id);
      }
    }
  }

  /**
   * Where everyone's feet are, against the triggers, and `triggerLeave` then
   * `triggerEnter` for what changed — player by player in roster order, each
   * player's in trigger order. The dead are in nothing.
   */
  private stepOccupancy(): void {
    let ctx: ServerContext | undefined;
    const triggers = this.world.triggers;
    for (const [id, member] of this.members) {
      const { left, entered } = this.occupancy.update(id, member.player.dead ? null : member.player.movement.feet);
      if (left.length === 0 && entered.length === 0) {
        continue;
      }
      ctx ??= this.serverContext();
      for (const i of left) {
        for (const script of this.scripts) {
          script.server?.triggerLeave?.(this.scoped(ctx, script), triggers[i]!, id);
        }
      }
      for (const i of entered) {
        for (const script of this.scripts) {
          script.server?.triggerEnter?.(this.scoped(ctx, script), triggers[i]!, id);
        }
      }
    }
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
  private stepScripts(): void {
    if (this.humans === 0) {
      return;
    }
    const ctx = this.serverContext();
    for (const script of this.scripts) {
      script.server?.tick?.(this.scoped(ctx, script), this.tickDt);
    }
  }

  /**
   * One input per bot, queued for this tick's drain as a client's would be.
   *
   * Shaped as a client's so that nothing downstream has to know: `dt` is one
   * tick, the input is rounded as the wire would round it, and `renderTick` names
   * the last tick stepped — what a bot "sees" is the world as the previous tick
   * left it, and a shot it fires is judged there. A client's is a tick or more
   * older, and a bot's zero would be clamped to the rewind floor, a quarter of a
   * second back. `claim` is its own state, which nothing reads: drift is not
   * measured for a bot.
   *
   * Idle, without asking the controller, until the world's graph is baked: a bot
   * stands still until it has somewhere to plan. Queued even then, because a
   * member is only stepped by its inputs, and a bot with none would hang in the
   * air where it spawned.
   */
  private thinkBots(): void {
    if (this.bots === 0) {
      return;
    }
    const nav = this.navigation;
    // Built at most once this tick, and only if some bot thinks on it: most ticks
    // none does, and a view walks the roster.
    let brains: BrainContext | undefined;
    let scripts: ServerContext | undefined;
    const context = (): BrainContext => (brains ??= this.brainContext(nav!));
    const feetOf = (id: PlayerId) => this.members.get(id)?.player.movement.feet;
    for (const [id, member] of this.members) {
      const bot = member.bot;
      if (!bot) {
        continue;
      }
      const movement = member.player.movement as MovementState;
      const input = idleInput(movement.yaw, movement.pitch);
      if (nav && !bot.failed) {
        const turn: BotTurn = {
          id,
          index: bot.index,
          tick: this.currentTick,
          dt: this.tickDt,
          movement,
          alive: !member.player.dead,
          nav,
          ordered: bot.ordered,
          objective: () => {
            scripts ??= this.serverContext();
            for (const script of this.scripts) {
              const said = script.server?.botObjective?.(this.scoped(scripts, script), id);
              if (said) {
                bot.objective = said;
                break;
              }
            }
            return bot.objective;
          },
          context,
          feetOf,
        };
        try {
          bot.controller.think(turn, input);
        } catch (err) {
          // One bot's controller must not take this tick from every game on the
          // process. It stands still from here on, and says why once.
          bot.failed = true;
          Object.assign(input, idleInput(movement.yaw, movement.pitch));
          console.warn(`[match] bot ${id}'s controller threw, so it stands still: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      bot.seq = (bot.seq + 1) & 0xffff;
      member.queue.push({
        seq: bot.seq,
        dt: this.tickDt,
        input: roundInput(input),
        claim: movement,
        renderTick: (this.currentTick - 1) & 0xffff,
        renderFrac: 0,
      });
    }
  }

  /**
   * The world's graph, this match's changes to it and the search its bots share,
   * or null until the bake is done and for good on a world with none. Built on
   * the first call that finds a graph, so a match that started before the bake
   * finished gets one as soon as it does — with whatever blockers a script added
   * in the meantime.
   */
  get navigation(): NavPlanner | null {
    if (this.planner) {
      return this.planner;
    }
    const graph = this.playing.nav?.graph;
    if (!graph) {
      return null;
    }
    const state = new NavMatchState(graph);
    const actorState = new NavMatchState(graph);
    for (const [id, { shape, on }] of this.pendingBlockers) {
      state.addBlocker(id, shape, on);
      actorState.addBlocker(id, shape, on);
    }
    this.pendingBlockers.clear();
    this.parts.registerBlockers(state, this.playing.nav?.partLinks);
    this.parts.registerBlockers(actorState, this.playing.nav?.actorPartLinks);
    this.planner = new NavPlanner(graph, state);
    this.actorPlanner = new NavPlanner(graph, actorState, ALL_ABILITIES, actorMover(graph));
    return this.planner;
  }

  /** The actors' planner: the graph by an actor's links, with its own blocked links. Null when `navigation` is. */
  get actorNavigation(): NavPlanner | null {
    return this.navigation && this.actorPlanner!;
  }

  /**
   * Where `id` was, as the client that sent `message` would have been drawing them.
   *
   * The moment comes off the input rather than off the tick, because a tick that
   * drains four queued inputs has four different moments in it.
   *
   * Never refuses. A rewind it cannot honour is clamped to the nearest one it can,
   * and counted: a refused shot is indistinguishable from a miss to the player who
   * fired it and impossible to account for afterwards, while a clamped one is
   * resolved against a *more current* world, which is the conservative direction.
   */
  rewind(id: PlayerId, message: InputMessage, shooter: PlayerId, out: MovementState): MovementState | null {
    const member = this.members.get(id);
    if (!member) {
      return null;
    }
    const { tick, frac } = this.rewindTarget(shooter, message);
    const sampled = member.history.sample(tick, frac, out);
    if (sampled) {
      return sampled;
    }
    // In the window but not in *this* player's ring: they joined after that tick.
    // Their oldest is the earliest they can be judged at.
    const oldest = member.history.oldest;
    return oldest < 0 ? null : member.history.sample(oldest, 0, out);
  }

  /**
   * Every shot the last `step` fired, in the order they left.
   *
   * A record, not a to-do list: each `PlayerShot` in here has already been paid
   * for — `fireShots` queues the damage as the round is traced, so a target
   * killed by the first round of a burst does not take the rest of it. What is
   * left for a reader is drawing a tracer and explaining a kill.
   */
  get shotsThisTick(): readonly FiredShot[] {
    return this.shots;
  }

  /**
   * The shots the replay of `message` fired, traced and recorded.
   *
   * `weapon` is the controller that was held *before* the step. A swap that
   * completed inside it hands back a different one, counting from its own
   * total: subtracting across the two would invent a burst out of nothing, or
   * 65535 of them. Neither weapon can have fired on such a step — the one going
   * away is `dropping` and the one arriving is `raising` — so identity is the
   * whole check, and the same check covers a respawn that rebuilt the weapon.
   *
   * `kick` is the view kick as it stood *before* the step, for the reason given
   * where it is captured. A step that fired more than one round — a sprint cut
   * short by the trigger, on a weapon whose `fireTime` is 0 — traces all of them
   * along it: they left within one step of each other, and it is the last aim
   * their shooter saw.
   */
  private fireShots(
    shooter: PlayerId,
    member: Member,
    weapon: WeaponController | undefined,
    before: number,
    kick: ReadKick | null,
    heat: { spread: number; ads: number } | null,
    message: InputMessage,
  ): void {
    const held = member.player.weapon;
    if (held === undefined || held !== weapon) {
      return;
    }
    // Wrap-safe: `fired` is a uint16 on both ends, and the difference is the
    // count however many times it has been round.
    const count = (held.data.fired - before) & 0xffff;
    if (count === 0) {
      return;
    }

    // Where they ended the step, not where they started it: a client turns and
    // fires on one input, and `roundInput` means both ends turned by the same
    // quantized amount before stepping.
    //
    // Their intent **plus the view kick they had already taken** — the aim's own
    // recoil, not the gun's, which rocks the model and decides nothing. It is the
    // half of the aim this server owns outright: it cannot reproduce a mouse, so
    // it takes the client's word for where they were looking and bounds it, while
    // the kick is its own arithmetic off a seed derived from the player's id and
    // the shot's own ordinal. A client that sent a finished aim could hide a kick
    // it never took — so it sends intent and nothing else.
    const movement = member.player.movement;
    const { feet } = movement;
    const eye = { x: feet.x, y: feet.y + EYE_HEIGHT, z: feet.z };
    // Degrees wide, from how hot the weapon was before this step and how far into
    // the sights they had got. **This server decides it**: the width is the
    // weapon's own numbers, and where in it each round lands is drawn from the
    // same seeded stream the recoil is, so a client has nothing to send and
    // nothing to bend. It predicts the identical cone from the identical seed.
    const cone = heat ? shotSpread(held.def, heat.spread, heat.ads) : 0;
    for (let i = 0; i < count; i++) {
      const ordinal = (before + i + 1) & 0xffff;
      // Per round rather than per step, which is the whole reason these were
      // traced one at a time before there was a cone to trace them in: two rounds
      // of a burst share an aim and must not share a deviation.
      const aim = aimDirection(aimAngles(movement, kick, this.shotAim), this.shotDirection);
      spreadDirection(aim, cone, coneSample(shotStream(member.player.seed, ordinal), this.shotCone));
      const result = this.traceShot(shooter, eye, aim, SHOT_RANGE, message);
      this.shots.push({ shooter, ordinal, from: { ...eye }, direction: { ...aim }, result });
      if (result?.kind === "player") {
        // `held.def` rather than the entry's: it is the definition with this
        // player's attachments already merged into it (`resolveWeapon`), so a
        // silencer's damage penalty is in the number without being looked up
        // twice.
        const amount = shotDamage(held.def, result.location, result.distance, this.combat);
        const victim = this.members.get(result.id);
        const before = victim?.player.health ?? 0;
        this.hurt({ id: result.id, amount, by: shooter, cause: "bullet", location: result.location, along: { ...aim } });
        // **After** the damage, and only if it cost them something. A marker is
        // this server's answer about its own trace, so a round a teammate absorbs
        // with friendly fire off, or one a script ignored, or one that met a
        // location the weapon file scores at zero, draws nothing — the shooter
        // hit somebody and it counted for nothing, which is what they are shown.
        if (victim && victim.player.health < before) {
          this.announce({ kind: "hit", location: result.location, lethal: victim.player.dead }, shooter, 0);
        }
      } else if (result?.kind === "actor") {
        const amount = shotDamage(held.def, result.location, result.distance, this.combat);
        const before = this.actors.health(result.id);
        this.hurt({ kind: "actor", actor: result.id, amount, by: shooter, cause: "bullet", location: result.location });
        // A marker only for a round that cost it something, as for a player.
        if (this.actors.health(result.id) < before) {
          this.announce({ kind: "hit", location: result.location, lethal: !this.actors.alive(result.id) }, shooter, 0);
        }
      }
    }
  }

  /**
   * What a shot from `shooter` hits: nothing, the map, or somebody.
   *
   * `direction` is a unit vector and `range` the bullet's reach in metres;
   * `message` is the input the shot came with, whose `renderTick`/`renderFrac`
   * name the moment the shooter was drawing — every other player is judged there
   * rather than here (`rewind`).
   *
   * **The nearest of everything wins**, and the map is one of the candidates: a
   * bullet that meets a wall before reaching a body is a miss, and the two are
   * compared as fractions of one segment because a bone's box answers in those.
   * The map's own trace is the `"shots"` channel, which is not the geometry a
   * capsule walks into — `clip_player` over a window stops a player and not a
   * bullet.
   *
   * Applies no damage and records nothing. What was hit is the whole answer.
   */
  traceShot(shooter: PlayerId, from: Vec3, direction: Vec3, range: number, message: InputMessage): ShotResult | null {
    if (!(range > 0)) {
      return null;
    }
    const to = this.shotEnd;
    to.x = from.x + direction.x * range;
    to.y = from.y + direction.y * range;
    to.z = from.z + direction.z * range;

    // The map first, so a body behind a wall is rejected by a fraction rather than
    // by a second trace per player.
    const map = this.collision.traceRay(from, direction, range, "shots", this.mapHit);
    let nearest = map === null ? 1 : map.distance / range;
    let best: ShotResult | null = map === null ? null : { kind: "world", distance: map.distance, normal: { ...map.normal }, surface: map.kind };

    for (const [id, member] of this.members) {
      // Nobody shoots themselves: the origin is inside the shooter's own body, so
      // every one of their shots would stop on their own chest. A body waiting to
      // respawn is not there to be shot either — it would stop a round meant for
      // whoever is behind it.
      if (id === shooter || member.body === undefined || member.player.dead) {
        continue;
      }
      const rewound = this.rewind(id, message, shooter, this.rewound);
      if (rewound === null) {
        continue;
      }

      // The broad phase, against the capsule rather than a pose — posing is the
      // expensive half and almost nobody survives this. The capsule is dropped as
      // well as widened by `POSE_MARGIN`: a vaulting body hangs its legs below the
      // feet the simulation moves, and the boxes there are hittable.
      const feet = rewound.feet;
      const envelope = { x: feet.x, y: feet.y - POSE_MARGIN, z: feet.z };
      if (couldHit(from, to, envelope, RADIUS, HEIGHT + POSE_MARGIN, POSE_MARGIN) === null) {
        continue;
      }

      const hit = this.traceBody(member.body, rewound, member.player.weapon?.data ?? null, from, to);
      if (hit !== null && hit.fraction < nearest) {
        nearest = hit.fraction;
        best = { kind: "player", id, bone: hit.bone, location: hit.location, distance: hit.fraction * range };
      }
    }
    if (this.actors.size > 0) {
      const actor = this.actors.trace(from, to, this.rewindTarget(shooter, message), this.currentTick, nearest);
      if (actor !== null) {
        best = { kind: "actor", id: actor.id, bone: actor.bone, location: actor.location, distance: actor.fraction * range };
      }
    }
    return best;
  }

  /**
   * Put one body where that player was, in the pose they were drawn in, and trace
   * the segment against its boxes.
   *
   * Place, pose, then update the world matrices, in that order — the client's
   * `RemotePlayers.update` does exactly this, and each step depends on the last:
   * the poser reads the root's world rotation to aim the spine, and `trace` reads
   * `matrixWorld` and updates nothing, so a rig posed without the third step is
   * traced in its bind pose.
   *
   * The weapon is the one in their hands now rather than the one they held at the
   * moment rewound to, which is what the client draws a peer with as well: the
   * pose needs a weapon's state and the history keeps only a `MovementState`.
   */
  private traceBody(body: LoadedBody, movement: MovementState, weapon: WeaponData | null, from: Vec3, to: Vec3): BodyHit | null {
    const root = body.rig.root;
    root.position.set(movement.feet.x, movement.feet.y, movement.feet.z);
    root.rotation.y = bodyYaw(movement) + MODEL_FACING;
    // `dt` is spent on the mixer's own bookkeeping and nothing else: the pose is a
    // function of the state, which is what lets one rig be posed per shot.
    body.poser.update(movement, weapon, 0);
    root.updateMatrixWorld(true);
    return body.boxes.trace(from, to);
  }

  /**
   * The absolute tick a client's `renderTick` names, clamped to something this
   * server can actually answer.
   *
   * `renderTick` is the low 16 bits, so the rest is recovered from our own clock:
   * the tick named is in the recent past, and the masked difference is how far
   * back. That is wrap-safe for anything inside 32768 ticks, against a window of
   * sixty.
   */
  private rewindTarget(shooter: PlayerId, message: InputMessage): { tick: number; frac: number } {
    const member = this.members.get(shooter);
    let tick = this.currentTick - ((this.currentTick - message.renderTick) & 0xffff);
    let frac = Math.min(Math.max(message.renderFrac, 0), 1);

    const sent = member?.sentTick ?? -1;
    if (sent >= 0 && tick > sent) {
      // They cannot have drawn a snapshot we never sent.
      tick = sent;
      frac = 0;
      this.rewinds.implausible++;
    }
    const floor = this.currentTick - this.maxRewindTicks;
    if (tick < floor) {
      tick = floor;
      frac = 0;
      this.rewinds.clamped++;
    }
    return { tick, frac };
  }

  /** How far back a rewind may reach, in ticks. A quarter of a second, whatever the rate. */
  get maxRewindTicks(): number {
    return Math.max(1, Math.round(this.tickRate * MAX_REWIND_SECONDS));
  }

  /**
   * How this match may build a physics world, should anything need one.
   *
   * A factory rather than a world, because most games never build one and a map's
   * trimesh is the most expensive thing in the subtree. What comes back is ready —
   * terrain included — so that nothing here has to know what a map is.
   */
  setPhysicsFactory(factory: () => PhysicsWorld | undefined): void {
    this.physicsFactory = factory;
  }

  /**
   * Queue a spawn in this match's own physics world, building the world if this is
   * the first thing to need it.
   *
   * A kind whose policy says the server does not simulate it never gets here: the
   * server decides its spawn, says it once, and the clients do the rest.
   */
  spawnEntity(id: number, kind: EntityKindId, build: Parameters<PhysicsWorld["spawn"]>[3]): void {
    if (!ENTITY_POLICY[kind].serverSimulates) {
      return;
    }
    this.physics ??= this.physicsFactory?.();
    this.physics?.spawn(id, kind, this.currentTick, build);
  }

  /** What this match is simulating, for `/healthz`. Zeroes where it is simulating nothing. */
  physicsReport(): { entities: number; triangles: number } {
    return { entities: this.physics?.count ?? 0, triangles: this.physics?.terrainStats?.triangles ?? 0 };
  }

  /**
   * Give back everything this match holds outside the JavaScript heap.
   *
   * A Rapier world is wasm memory and no garbage collector frees it, so a game
   * server that hosted a thousand games would hold a thousand worlds. Called where
   * a game is removed (`Games.remove`).
   */
  dispose(): void {
    this.physics?.free();
    this.physics = undefined;
  }

  /** How often a rewind could not be honoured as asked. For `/healthz`: this is measured before it is trusted. */
  rewindReport(): RewindReport {
    return { ...this.rewinds };
  }

  /**
   * The last step's snapshot as one player sees it: everyone's state, their own
   * ack, and what they have still to be told.
   *
   * The players are shared and the other two are theirs alone — a hit marker goes
   * to whoever fired the round and to nobody else.
   */
  snapshotFor(id: PlayerId, players: PlayerSnapshot[]): SnapshotMessage {
    const member = this.members.get(id);
    if (member) {
      member.sentTick = this.currentTick;
    }
    return {
      tick: this.currentTick,
      ack: member?.ack ?? 0,
      presence: this.parts.snapshot,
      players,
      actors: this.actorsFor(id),
      counters: this.countersNow(),
      events: this.outgoingFor(id),
    };
  }

  drift(id: PlayerId): DriftReport | undefined {
    return this.members.get(id)?.drift;
  }

  /** Every player's drift, for /healthz. */
  report(): { id: PlayerId; drift: DriftReport; engine: string; dropped: number }[] {
    return [...this.members].map(([id, m]) => ({ id, drift: { ...m.drift }, engine: m.engine, dropped: m.dropped }));
  }

  /** Which of the world's solids are present now. */
  get presence(): Presence {
    return this.parts.presence;
  }

  /** Whether a living member is standing inside `part`. */
  private occupied(part: CapsuleWorld): boolean {
    for (const member of this.members.values()) {
      if (!member.player.dead && capsuleIn(part, member.player.movement.feet)) {
        return true;
      }
    }
    return false;
  }

  private playerStates(): PlayerSnapshot[] {
    return [...this.members].map(([id, m]) => ({ id, state: m.player.snapshot() }));
  }
}

function distance(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function record(drift: DriftReport, metres: number): void {
  drift.current = metres;
  drift.max = Math.max(drift.max, metres);
  drift.samples++;

  // Incremental, so nothing has to hold a running total that /healthz would then serialise.
  drift.mean += (metres - drift.mean) / drift.samples;
}

/** A script's weapon as a class's slot would name it, so one `equipWeapons` serves both. */
function armedWeapon(armed: ArmedWeapon | null | undefined): { weapon: string; attachments: string[] } | null {
  return armed ? { weapon: armed.weapon, attachments: [...(armed.attachments ?? [])] } : null;
}
