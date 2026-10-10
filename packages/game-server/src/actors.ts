// One match's actors: the creatures it runs that are not players.
//
// A plain class `Match` owns, as it owns its members: an actor lives exactly as
// long as the match that spawned it, so there is nothing here for the container.
// It is kept out of match/ because nothing about an actor is a player's —
// no input queue, no class, no prediction to correct — and the two meet in only
// three places, each a call from `Match`: a shot traced at them (`trace`), damage
// drained through the one queue (`hurt`), and the tick (`step`), which asks
// `ActorHost` for everything it needs of the players.
//
// Each tick, in spawn order: a dead one lies for its kind's `corpse` seconds and
// is taken out; a living one is thought for by its brain (the bots' `BotDriver`,
// over the actor rather than a member), stepped through `stepMovement` with its
// kind's capsule and speeds, and lands a blow if its goal is `attack` and its
// cooldown allows. A traversal link its motor hands over is crossed here, played
// along the link rather than stepped. docs/engine/actors.md has the whole of it.

import type { ResolvedWorld } from "@3d/shared/dsl/resolved.js";
import {
  ACTOR_GAITS,
  actorKey,
  MAX_ACTOR_ID,
  type ActorAction,
  type ActorGait,
  type ActorId,
  type ActorSpec,
  type ActorState,
  type ActorStateView,
} from "@3d/shared/game/actors/actor.js";
import {
  actorAssetsFor,
  actorLook,
  climbRole,
  gaitRole,
  rootAt,
  type ActorAssets,
  type ActorClip,
  type ActorLook,
  type ActorTraversalClip,
} from "@3d/shared/game/actors/assets.js";
import { actorKind, actorKindIndex, type ActorKindDef, type ActorKindId } from "@3d/shared/game/actors/kinds.js";
import type { CatalogueView } from "@3d/shared/game/catalogueView.js";
import type { BrainContext } from "@3d/shared/game/bots/brain.js";
import { BotDriver, type BotTurn } from "@3d/shared/game/bots/driver.js";
import type { FeetOf } from "@3d/shared/game/bots/motor.js";
import { NO_OBJECTIVE, type Objective } from "@3d/shared/game/bots/objective.js";
import type { NavPlanner } from "@3d/shared/game/bots/planner.js";
import { brainFor } from "@3d/shared/game/bots/registry.js";
import type { PlayerId } from "@3d/shared/net/messages/fields.js";
import { MODEL_FACING } from "@3d/shared/rig/character.js";
import { couldHit, POSE_MARGIN } from "@3d/shared/rig/hitboxes.js";
import type { CapsuleResolution, CapsuleWorld, Vec3 } from "@3d/shared/sim/capsule.js";
import { rayBox } from "@3d/shared/sim/hit.js";
import type { HitLocation } from "@3d/shared/sim/hitLocations.js";
import { idleInput } from "@3d/shared/sim/input.js";
import { createMovement, GRAVITY, horizontalSpeed, IDLE_SPEED, stepMovement, type MovementParams, type MovementState } from "@3d/shared/sim/movement.js";
import type { NavGraph } from "@3d/shared/nav/graph.js";
import { NO_INDEX_16 } from "@3d/shared/nav/format.js";
import { TRAVERSAL_KINDS } from "@3d/shared/nav/vocab.js";
import { KILL_PLANE_MARGIN, movementRules, type MovementRules } from "@3d/shared/sim/worldRules.js";
import type { BodyView, LoadedActorRig } from "./bodies.js";
import { thinkOrStand } from "./bots.js";
import { PlayerHistory } from "./history.js";

/** Seconds of the past a shot at an actor may be judged in: the players' rewind, and room to spare. */
const HISTORY_SECONDS = 0.5;
/** A blow reaches no further above or below than this, m: a target on the floor above is not in reach. */
const REACH_DY = 1;
/** Seconds a kind with no death clip falls over before it holds its last frame. */
const DIE_SECONDS = 1;
/** Seconds one loop of `idle` is played over for a kind with no idle clip. */
const IDLE_PERIOD = 2;
/** Where a shot lands on an actor drawn as its capsule: no bones, so the middle of the body. */
const CAPSULE_LOCATION: HitLocation = "torsoUpper";
/** Column-major identity, for a box already in world space. */
const IDENTITY: readonly number[] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** The fastest one actor is pushed out of another, m/s: a pile at one spawn point spreads over a few ticks, not one. */
const SEPARATION_SPEED = 4;
/** Walking into a body within this sine of head-on is a meeting on one line, and sidesteps. */
const HEAD_ON = 0.25;
/** How far a head-on push leans to the right: a share of the push, before it is renormalised. */
const SIDESTEP = 0.5;
/** Radians between consecutive ids' ways out of a pile: never two the same, never a line. */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/** The shortest a traversal is crossed in, s: a step down still takes a few ticks. */
const MIN_CROSSING = 0.2;

/**
 * A traversal link being crossed: from where the actor stood at its begin to the
 * end node's feet over `ticks`, ignoring collision. `played` when the look plays
 * it (`traverse` on the wire): a link's own clip (`clip`) moves the body along its
 * root path, stretched onto the link; a climb, in a straight line. Otherwise it is
 * moved in a straight line at its speed and drawn walking (`move`).
 */
interface Crossing {
  readonly link: number;
  readonly from: Vec3;
  readonly to: Vec3;
  readonly at: number;
  readonly ticks: number;
  readonly played: boolean;
  /** The link's own clip, or null for a climb or none. */
  readonly clip: ActorTraversalClip | null;
  /** `clip`'s index in the look's traversals plus one, as the wire names it; 0 for none. */
  readonly traversal: number;
}

/** A swing in progress: when it began, how long it lasts and on which of its ticks a blow lands. */
interface Swing {
  readonly at: number;
  readonly ticks: number;
  /** Ticks after `at`, ascending. */
  readonly hits: readonly number[];
  readonly target: PlayerId;
}

interface Actor {
  readonly id: ActorId;
  readonly kind: ActorKindDef;
  readonly kindIndex: number;
  readonly gait: ActorGait;
  /** Its body, head and clips, drawn from the seed as the client draws them; undefined for a capsule. */
  readonly look: ActorLook | undefined;
  /** The kind's capsule at this actor's own speed: its gait clip's root motion. */
  readonly body: MovementParams;
  readonly movement: MovementState;
  /** Where in its gait clip's cycle it is, 0..1: advanced by the ground it covers, so its feet do not slide. */
  cycle: number;
  health: number;
  readonly driver: BotDriver;
  objective: Objective;
  /** Counts `order` calls, so it thinks again at once. */
  ordered: number;
  /** Its brain threw once: said then, and it stands still from there. */
  failed: boolean;
  /** The swing it is in, or null. */
  swing: Swing | null;
  /** The first tick it may begin another swing. */
  nextSwing: number;
  /** The tick it died on, or null while it lives. */
  diedAt: number | null;
  /** The traversal it is crossing, or null. */
  crossing: Crossing | null;
  readonly history: PlayerHistory;
}

/** What the tick needs of the match around the actors. `Match`'s "actors" phase builds one. */
export interface ActorHost {
  readonly tick: number;
  readonly dt: number;
  /** Null until the world's graph is baked: actors stand, as bots do. */
  readonly nav: NavPlanner | null;
  /** What a brain sees. Built at most once a tick, and only if something thinks. */
  context(): BrainContext;
  feetOf: FeetOf;
  /** Where a player is and whether they are alive, for a blow. */
  target(id: PlayerId): { feet: Vec3; alive: boolean } | undefined;
  /** Queue a blow on a player: `melee`, by nobody, from this actor. */
  blow(target: PlayerId, amount: number, actor: ActorId): void;
  /** Queue this actor's death for falling under the world. */
  fell(actor: ActorId, health: number): void;
}

/** What a shot found on an actor. */
export interface ActorHit {
  id: ActorId;
  bone: string;
  location: HitLocation;
  /** Along the traced segment, 0..1. */
  fraction: number;
}

/** What an actor's look is drawn from: the catalogue its kinds' creatures are read out of, and the match seed. */
export interface ActorLooks {
  readonly catalogue: CatalogueView;
  readonly seed: number;
}

export class Actors {
  private readonly actors = new Map<ActorId, Actor>();
  /** Each kind's catalogue creature, read once: null for one drawn as its capsule. */
  private readonly assets = new Map<ActorKindId, ActorAssets | null>();
  private minted = 0;
  private readonly rules: MovementRules;
  private readonly killPlane: number;
  private readonly rewound = createMovement({ x: 0, y: 0, z: 0 }, 0, 0);
  private readonly boxMin: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly boxMax: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly pushed: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly resolution: CapsuleResolution = { position: { x: 0, y: 0, z: 0 }, grounded: false };

  constructor(
    private readonly collision: CapsuleWorld,
    world: ResolvedWorld,
    private readonly tickRate: number,
    private readonly bodies: BodyView,
    private readonly looks?: ActorLooks,
  ) {
    this.rules = movementRules(world);
    this.killPlane = world.spawn.position.y - KILL_PLANE_MARGIN;
  }

  get size(): number {
    return this.actors.size;
  }

  /** `ServerContext.actors.spawn`. Throws on a kind or a brain nobody declared, or ids run out. */
  spawn(spec: ActorSpec): ActorId {
    const kind = actorKind(spec.kind);
    if (!kind) {
      throw new Error(`a script spawned an actor of kind "${spec.kind}", which nothing declares`);
    }
    const brain = brainFor(spec.brain);
    if (!brain) {
      throw new Error(`a script spawned an actor with brain "${spec.brain}", which nothing declares`);
    }
    const health = spec.health ?? kind.health;
    if (!(health > 0) || !Number.isFinite(health)) {
      throw new Error(`a script spawned an actor with health ${health}`);
    }
    if (this.minted >= MAX_ACTOR_ID) {
      throw new Error(`this match has spawned ${MAX_ACTOR_ID} actors, and an actor's id is never reused`);
    }
    const gait = spec.gait ?? "walk";
    if (!ACTOR_GAITS.includes(gait)) {
      throw new Error(`a script spawned an actor with gait "${String(gait)}"; a gait is one of ${ACTOR_GAITS.join(", ")}`);
    }
    const id = ++this.minted;
    const { at, look: facing } = spec;
    const yaw = facing && Math.hypot(facing.x - at.x, facing.z - at.z) > 1e-6 ? Math.atan2(-(facing.x - at.x), -(facing.z - at.z)) : 0;
    const movement = createMovement(at, yaw, 0);
    const assets = this.assetsOf(kind);
    const look = assets && this.looks ? actorLook(assets, this.looks.seed, id, gait) : undefined;
    const speed = gaitSpeed(kind, gait, look);
    const actor: Actor = {
      id,
      kind,
      kindIndex: actorKindIndex(kind.id),
      gait,
      look,
      body: { radius: kind.radius, height: kind.height, walkSpeed: speed, runSpeed: speed, rideKerbs: true },
      movement,
      cycle: 0,
      health: Math.max(1, Math.round(health)),
      // The kind's reach first, so a brain that swings knows how far; a script's params over it.
      driver: new BotDriver(brain, { reach: kind.melee.reach, ...spec.params }),
      objective: spec.objective ?? NO_OBJECTIVE,
      ordered: 0,
      failed: false,
      swing: null,
      nextSwing: 0,
      diedAt: null,
      crossing: null,
      history: new PlayerHistory(Math.max(2, Math.round(this.tickRate * HISTORY_SECONDS))),
    };
    this.actors.set(id, actor);
    return id;
  }

  remove(id: ActorId): boolean {
    return this.actors.delete(id);
  }

  order(id: ActorId, objective: Objective | null): void {
    const actor = this.actors.get(id);
    if (actor) {
      actor.objective = objective ?? NO_OBJECTIVE;
      actor.ordered++;
    }
  }

  ids(): ActorId[] {
    return [...this.actors.keys()];
  }

  alive(id: ActorId): boolean {
    return this.actors.get(id)?.diedAt === null;
  }

  health(id: ActorId): number {
    return this.actors.get(id)?.health ?? 0;
  }

  state(id: ActorId): ActorStateView | undefined {
    const actor = this.actors.get(id);
    if (!actor) {
      return undefined;
    }
    const { feet, yaw } = actor.movement;
    return { id, kind: actor.kind.id, feet: { x: feet.x, y: feet.y, z: feet.z }, yaw, alive: actor.diedAt === null, health: actor.health };
  }

  /**
   * Take `amount` off a living actor, as the drain has already priced it. True
   * when this killed it: it lies from `tick` on, and takes nothing more.
   */
  hurt(id: ActorId, amount: number, tick: number): boolean {
    const actor = this.actors.get(id);
    if (!actor || actor.diedAt !== null || !(amount > 0)) {
      return false;
    }
    actor.health = Math.max(0, actor.health - Math.round(amount));
    if (actor.health > 0) {
      return false;
    }
    actor.diedAt = tick;
    actor.swing = null;
    actor.crossing = null; // it falls where it was, part-way through a window or not
    actor.driver.motor.reset();
    // It lies where it fell and is not stepped again: nothing should say it is still going.
    Object.assign(actor.movement.velocity, { x: 0, y: 0, z: 0 });
    return true;
  }

  /** One tick: the dead taken out when their time is up, the living thought for, moved and swinging. */
  step(host: ActorHost): void {
    const corpseTicks = (actor: Actor) => Math.round(Math.max(actor.kind.corpse, dieSeconds(actor)) * this.tickRate);
    for (const actor of this.actors.values()) {
      if (actor.diedAt !== null) {
        if (host.tick - actor.diedAt >= corpseTicks(actor)) {
          this.actors.delete(actor.id);
        }
        continue;
      }
      const m = actor.movement;
      if (actor.crossing) {
        this.cross(actor, host.tick, host.dt);
        continue;
      }
      const input = idleInput(m.yaw, m.pitch);
      if (host.nav && !actor.failed) {
        this.think(actor, host, input);
      }
      const traversal = actor.driver.motor.traversal;
      if (traversal >= 0 && host.nav) {
        actor.crossing = this.crossing(actor, host.nav.graph, traversal, host.tick);
        actor.swing = null;
        this.cross(actor, host.tick, host.dt);
        continue;
      }
      stepMovement(m, input, host.dt, this.collision, true, this.rules.mantles, this.rules.ladders, actor.body);
      if (m.feet.y < this.killPlane) {
        host.fell(actor.id, actor.health);
        continue;
      }
      this.separate(actor, host.dt);
      advanceCycle(actor, host.dt);
      this.swing(actor, host);
    }
    for (const actor of this.actors.values()) {
      actor.history.record(host.tick, actor.movement);
    }
  }

  /**
   * Push a living actor out of the bodies it yields to: every older one, already
   * stepped this tick, and any crossing a traversal, which nothing moves. The
   * younger always yields, so a crowd settles in one pass, the same way every run,
   * and the oldest in a crush is never held. The velocity into a body is taken off,
   * as a wall's would be, and the world has the last word on where the push lands.
   * Every pair, every tick: a horde is tens, not thousands.
   */
  private separate(actor: Actor, dt: number): void {
    const m = actor.movement;
    const v = m.velocity;
    const { radius, height } = actor.body;
    let px = 0;
    let pz = 0;
    for (const other of this.actors.values()) {
      if (other === actor || other.diedAt !== null || (other.id > actor.id && !other.crossing)) {
        continue;
      }
      const o = other.movement.feet;
      if (o.y >= m.feet.y + height || m.feet.y >= o.y + other.body.height) {
        continue;
      }
      let nx = m.feet.x - o.x;
      let nz = m.feet.z - o.z;
      const d = Math.hypot(nx, nz);
      const depth = radius + other.body.radius - d;
      if (depth <= 0) {
        continue;
      }
      if (d > 1e-6) {
        nx /= d;
        nz /= d;
      } else {
        // One on top of another, as a pile at one spawn point is: each its own way
        // round by its id, since one way for all lines them up and sandwiches the third.
        nx = Math.cos(actor.id * GOLDEN_ANGLE);
        nz = Math.sin(actor.id * GOLDEN_ANGLE);
      }
      // Walking straight into it, as two on one link do: lean the push to its own
      // right, so it steps round rather than being shoved back down the link.
      const speed = Math.hypot(v.x, v.z);
      if (speed > 1e-6 && v.x * nx + v.z * nz < 0 && Math.abs(nx * v.z - nz * v.x) < HEAD_ON * speed) {
        nx += (SIDESTEP * -v.z) / speed;
        nz += (SIDESTEP * v.x) / speed;
        const n = Math.hypot(nx, nz);
        nx /= n;
        nz /= n;
      }
      px += nx * depth;
      pz += nz * depth;
      const into = v.x * nx + v.z * nz;
      if (into < 0) {
        v.x -= into * nx;
        v.z -= into * nz;
      }
    }
    const length = Math.hypot(px, pz);
    if (length === 0) {
      return;
    }
    const scale = Math.min(1, (SEPARATION_SPEED * dt) / length);
    Object.assign(this.pushed, { x: m.feet.x + px * scale, y: m.feet.y, z: m.feet.z + pz * scale });
    const { position } = this.collision.resolveCapsule(this.pushed, radius, height, this.resolution);
    Object.assign(m.feet, { x: position.x, y: position.y, z: position.z });
    actor.driver.motor.jostled();
  }

  private think(actor: Actor, host: ActorHost, input: ReturnType<typeof idleInput>): void {
    const turn: BotTurn = {
      id: actorKey(actor.id),
      index: actor.id,
      tick: host.tick,
      dt: host.dt,
      movement: actor.movement,
      alive: true,
      nav: host.nav!,
      ordered: actor.ordered,
      objective: () => actor.objective,
      context: () => host.context(),
      feetOf: host.feetOf,
    };
    if (!thinkOrStand(actor.driver, turn, input, `actor ${actor.id}'s brain`)) {
      actor.failed = true;
    }
  }

  /**
   * Begin crossing `link` from where the actor stands. A climb its look has a clip
   * for (a window, a wall: MANTLE_*) takes that clip's length; anything else is
   * moved at the actor's speed across and falls as a body would down.
   */
  private crossing(actor: Actor, graph: NavGraph, link: number, tick: number): Crossing {
    const f = graph.feet;
    const end = graph.target[link]! * 3;
    const m = actor.movement;
    const from = { x: m.feet.x, y: m.feet.y, z: m.feet.z };
    const to = { x: f[end]!, y: f[end + 1]!, z: f[end + 2]! };
    const kind = graph.traversalKind[link];
    const clips = actor.look?.clips;
    const traversals = actor.look?.traversals ?? [];
    const script = animscriptOf(graph, link);
    const own = traversals.findIndex((t) => t.animscript === script);
    const clip = own >= 0 ? traversals[own]! : null;
    const role =
      !clip && clips && (kind === TRAVERSAL_KINDS.MANTLE_OVER || kind === TRAVERSAL_KINDS.MANTLE_ON)
        ? climbRole(actor.gait, (r) => clips[r] !== undefined)
        : undefined;
    let seconds: number;
    if (clip) {
      seconds = clip.duration;
    } else if (role) {
      seconds = clips![role]!.duration;
    } else {
      const across = Math.hypot(to.x - from.x, to.z - from.z);
      const drop = Math.max(0, from.y - to.y);
      const rise = Math.max(0, to.y - from.y);
      seconds = Math.max(MIN_CROSSING, across / actor.body.runSpeed, rise / actor.body.runSpeed, Math.sqrt((2 * drop) / GRAVITY));
    }
    if (Math.hypot(to.x - from.x, to.z - from.z) > 0.05) {
      m.yaw = Math.atan2(-(to.x - from.x), -(to.z - from.z));
    }
    const ticks = Math.max(1, Math.round(seconds * this.tickRate));
    return { link, from, to, at: tick, ticks, played: clip !== null || role !== undefined, clip, traversal: own + 1 };
  }

  /** One tick along the crossing: the feet placed on the line, the velocity what that moved them; at its end, the motor told. */
  private cross(actor: Actor, tick: number, dt: number): void {
    const crossing = actor.crossing!;
    const m = actor.movement;
    const t = Math.min(1, (tick - crossing.at + 1) / crossing.ticks);
    const { across, up } = crossing.clip ? stretched(crossing.clip, t) : { across: t, up: t };
    const x = crossing.from.x + (crossing.to.x - crossing.from.x) * across;
    const y = crossing.from.y + (crossing.to.y - crossing.from.y) * up;
    const z = crossing.from.z + (crossing.to.z - crossing.from.z) * across;
    Object.assign(m.velocity, { x: (x - m.feet.x) / dt, y: (y - m.feet.y) / dt, z: (z - m.feet.z) / dt });
    Object.assign(m.feet, { x, y, z });
    if (!crossing.played) {
      advanceCycle(actor, dt);
    }
    if (t >= 1) {
      actor.crossing = null;
      Object.assign(m.velocity, { x: 0, y: 0, z: 0 });
      actor.driver.motor.traversed();
    }
  }

  /**
   * A swing: begun when the brain wants one, the cooldown allows it and the target
   * is in reach; landing a blow on each of its clip's `fire` notes; over at the
   * clip's end, or as soon as the target is out of reach or the brain wants
   * something else.
   */
  private swing(actor: Actor, host: ActorHost): void {
    const goal = actor.driver.motor.goal;
    const reached = (target: PlayerId): boolean => {
      const at = host.target(target);
      const feet = actor.movement.feet;
      return !!at?.alive && Math.abs(at.feet.y - feet.y) <= REACH_DY && Math.hypot(at.feet.x - feet.x, at.feet.z - feet.z) <= actor.kind.melee.reach;
    };
    const current = actor.swing;
    if (current) {
      const into = host.tick - current.at;
      if (into < current.ticks && goal.kind === "attack" && goal.target === current.target && reached(current.target)) {
        if (current.hits.includes(into)) {
          host.blow(current.target, actor.kind.melee.damage, actor.id);
        }
        return;
      }
      actor.swing = null;
      // Cut short: the rest of a long clip does not hold the next swing back, the kind's cooldown does.
      actor.nextSwing = Math.min(actor.nextSwing, Math.max(host.tick, current.at + this.ticks(actor.kind.melee.cooldown)));
    }
    if (goal.kind !== "attack" || host.tick < actor.nextSwing || !reached(goal.target)) {
      return;
    }
    const clip = actor.look?.clips.attack;
    const ticks = this.ticks(clip ? clip.duration : actor.kind.melee.swing);
    const hits = clip && clip.hits.length > 0 ? clip.hits.map((at) => Math.min(ticks - 1, Math.round(at * this.tickRate))) : [0];
    actor.swing = { at: host.tick, ticks, hits, target: goal.target };
    actor.nextSwing = host.tick + Math.max(ticks, this.ticks(actor.kind.melee.cooldown));
    if (hits[0] === 0) {
      host.blow(goal.target, actor.kind.melee.damage, actor.id);
    }
  }

  /** Whole ticks in `seconds`, never fewer than one. */
  private ticks(seconds: number): number {
    return Math.max(1, Math.round(seconds * this.tickRate));
  }

  /** What each actor is doing as of `tick`, and how far into it. */
  private action(actor: Actor, tick: number): { action: ActorAction; phase: number; traversal: number } {
    if (actor.diedAt !== null) {
      return { action: "die", phase: Math.min(1, (tick - actor.diedAt) / (dieSeconds(actor) * this.tickRate)), traversal: 0 };
    }
    if (actor.crossing?.played) {
      return { action: "traverse", phase: Math.min(1, (tick - actor.crossing.at + 1) / actor.crossing.ticks), traversal: actor.crossing.traversal };
    }
    if (actor.swing && tick - actor.swing.at < actor.swing.ticks) {
      return { action: "attack", phase: Math.max(0, tick - actor.swing.at) / actor.swing.ticks, traversal: 0 };
    }
    if (horizontalSpeed(actor.movement) > IDLE_SPEED) {
      return { action: "move", phase: actor.cycle, traversal: 0 };
    }
    const period = actor.look?.clips.idle?.duration ?? IDLE_PERIOD;
    return { action: "idle", phase: ((tick / this.tickRate) % period) / period, traversal: 0 };
  }

  /** A kind's catalogue creature, read the first time it is asked for. A malformed one is said once, and is a capsule. */
  private assetsOf(kind: ActorKindDef): ActorAssets | undefined {
    if (!kind.body || !this.looks) {
      return undefined;
    }
    let assets = this.assets.get(kind.id);
    if (assets === undefined) {
      try {
        assets = actorAssetsFor(kind.body, this.looks.catalogue) ?? null;
      } catch (err) {
        console.warn(`[match] actor kind ${kind.id}'s catalogue entry will not read, so it is a capsule: ${err instanceof Error ? err.message : String(err)}`);
        assets = null;
      }
      this.assets.set(kind.id, assets);
    }
    return assets ?? undefined;
  }

  /** Every actor as the wire carries it, in spawn order. */
  snapshot(tick: number): ActorState[] {
    const out: ActorState[] = [];
    for (const actor of this.actors.values()) {
      const { feet, yaw } = actor.movement;
      const { action, phase, traversal } = this.action(actor, tick);
      out.push({
        id: actor.id,
        kind: actor.kindIndex,
        feet: { x: feet.x, y: feet.y, z: feet.z },
        yaw,
        speed: horizontalSpeed(actor.movement),
        gait: actor.gait,
        action,
        phase,
        traversal,
        dead: actor.diedAt !== null,
      });
    }
    return out;
  }

  /**
   * The nearest living actor the segment `from` → `to` meets before `nearest`
   * (a fraction of it), judged where each was at `at` — the moment the shooter
   * was drawing, as a player is judged. Null for none nearer.
   *
   * A kind with a body is posed and its boxes traced, as a player's is; one
   * without is an upright box the size of its capsule, and a hit on it counts as
   * `torsoUpper`.
   */
  trace(from: Vec3, to: Vec3, at: { tick: number; frac: number }, currentTick: number, nearest: number): ActorHit | null {
    let best: ActorHit | null = null;
    for (const actor of this.actors.values()) {
      if (actor.diedAt !== null) {
        continue; // a body lying there stops nothing: the round goes on to whoever is behind it
      }
      const movement = actor.history.sample(at.tick, at.frac, this.rewound) ?? actor.history.sample(actor.history.oldest, 0, this.rewound) ?? actor.movement;
      const { radius, height } = actor.kind;
      const loaded = actor.look && this.bodies.actor?.(actor.kind.id);
      const body = loaded ? (loaded.bodies[actor.look!.body] ?? loaded.bodies[0]) : undefined;
      const margin = body ? POSE_MARGIN : 0;
      const envelope = { x: movement.feet.x, y: movement.feet.y - margin, z: movement.feet.z };
      if (couldHit(from, to, envelope, radius, height + margin, margin) === null) {
        continue;
      }
      const hit = body ? this.traceBody(actor, body, movement, from, to, currentTick) : this.traceCapsule(actor, movement, from, to);
      if (hit !== null && hit.fraction < nearest && (best === null || hit.fraction < best.fraction)) {
        best = hit;
      }
    }
    return best;
  }

  /** Place, pose, update matrices and trace, in that order — `poseBody`'s for a player. */
  private traceBody(actor: Actor, body: LoadedActorRig, movement: MovementState, from: Vec3, to: Vec3, tick: number): ActorHit | null {
    const root = body.rig.root;
    root.position.set(movement.feet.x, movement.feet.y, movement.feet.z);
    root.rotation.y = movement.yaw + MODEL_FACING;
    body.poser.update({ speed: horizontalSpeed(movement), gait: actor.gait, ...this.action(actor, tick) }, actor.look!, 0);
    root.updateMatrixWorld(true);
    const hit = body.boxes.trace(from, to);
    return hit && { id: actor.id, bone: hit.bone, location: hit.location, fraction: hit.fraction };
  }

  private traceCapsule(actor: Actor, movement: MovementState, from: Vec3, to: Vec3): ActorHit | null {
    const { radius, height } = actor.kind;
    const { x, y, z } = movement.feet;
    Object.assign(this.boxMin, { x: x - radius, y, z: z - radius });
    Object.assign(this.boxMax, { x: x + radius, y: y + height, z: z + radius });
    const fraction = rayBox(from, to, IDENTITY, this.boxMin, this.boxMax);
    return fraction === null ? null : { id: actor.id, bone: "", location: CAPSULE_LOCATION, fraction };
  }
}

/** An actor's gait clip: its look's variant of the gait's role, or the nearest role it has. */
function gaitClip(look: ActorLook | undefined, gait: ActorGait): ActorClip | undefined {
  const role = look && gaitRole(gait, (r) => look.clips[r] !== undefined);
  return role && look.clips[role];
}

/**
 * m/s an actor moves at: its gait clip's root motion, which is how CoD moves an
 * AI, so the clip played at its own rate covers exactly the ground the body does.
 * A kind with no clip, or a clip that stands, moves at its own speeds.
 */
function gaitSpeed(kind: ActorKindDef, gait: ActorGait, look: ActorLook | undefined): number {
  const clip = gaitClip(look, gait);
  if (clip && clip.speed > 0) {
    return clip.speed;
  }
  return gait === "walk" ? kind.walkSpeed : kind.runSpeed;
}

/**
 * Turn the gait cycle by the ground covered this tick over the ground one cycle of
 * the clip covers: at the clip's own speed, that is its natural rate. A kind with
 * no clip turns the player's stride instead.
 */
function advanceCycle(actor: Actor, dt: number): void {
  const clip = gaitClip(actor.look, actor.gait);
  if (!clip) {
    actor.cycle = actor.movement.stride;
    return;
  }
  const speed = horizontalSpeed(actor.movement);
  if (speed <= IDLE_SPEED) {
    return; // it stands: the cycle holds, so it walks on from the same foot
  }
  const step = clip.speed > 0 ? (speed * dt) / (clip.speed * clip.duration) : dt / clip.duration;
  actor.cycle = (actor.cycle + step) % 1;
}

/**
 * How far along a link a traversal clip has carried the body `t` of the way through
 * it: `across` of the horizontal and `up` of the vertical, each 0 at its start and
 * 1 at its end. The clip's own path, stretched onto the link's ends, so a 4.8 m
 * clip drops a 4.6 m link with the clip's timing; an axis the clip barely moves
 * along is moved evenly instead.
 */
function stretched(clip: ActorTraversalClip, t: number): { across: number; up: number } {
  const end = clip.path[clip.path.length - 1]!;
  const at = rootAt(clip.path, t * clip.duration);
  return {
    across: Math.abs(end[1]) > STILL_AXIS ? at.forward / end[1] : t,
    up: Math.abs(end[3]) > STILL_AXIS ? at.up / end[3] : t,
  };
}

/** Less than this, m, and a traversal clip does not move along an axis for `stretched` to follow. */
const STILL_AXIS = 0.05;

/** The animscript a traversal link's begin node names, or undefined for a walk. */
function animscriptOf(graph: NavGraph, link: number): string | undefined {
  const trav = graph.traversal[link]!;
  return trav === NO_INDEX_16 ? undefined : graph.file.strings[graph.file.traversals.animscript[trav]!];
}

/** Seconds an actor's fall lasts: its death clip's, or the capsule's. */
function dieSeconds(actor: Actor): number {
  return actor.look?.clips.die?.duration ?? DIE_SECONDS;
}
