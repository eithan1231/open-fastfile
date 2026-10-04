// What a script may be asked, and what a script is.
//
// Every hook is optional, so a script answers only the questions it has an
// opinion about — the way a node type declares only the properties it takes. The
// implemented ones are `init` (a script's own state, made once per match),
// `cast` (what a player wears and holds), `matchStart`
// and `playerJoin` (a match beginning, and somebody arriving), `playerSpawn`
// (which spawns a gametype wants), the three combat hooks (the numbers, the hit
// and the kill), the two class hooks (the rules, and each request), `tick` (a
// gametype's own clock), `botObjective` (what a bot is for), `event` (what it
// says out loud, in the browser that hears it), the two trigger hooks and
// `interact` (a player's feet in a volume, and the use key), and `usable` and
// `prompt` (what can be used, and what it says). The rest are declared so that the shape is
// settled before anything depends on it, and each says which piece of work builds
// it rather than pretending to work now.

import type { PlayerId } from "../net/messages/fields.js";
import type { Announcement } from "./announcement.js";
import type { HitLocation } from "../sim/hitLocations.js";
import type { SpawnQuery } from "../sim/worldRules.js";
import type { CastChoice } from "./cast.js";
import type { ClassRequest, ClassRules, ClassTiming } from "./classes.js";
import type { DamageCause } from "./damage.js";
import type { ClientContext, GameView, PlayerView, ScriptId, ServerContext } from "./context.js";
import type { GametypeId, TeamId } from "./gametypes/declaration.js";
import type { CombatRules } from "./rules.js";
import type { Objective } from "./bots/objective.js";
import type { ActorId } from "./actors/actor.js";
import type { ActorKindId } from "./actors/kinds.js";
import type { ResolvedTrigger } from "../dsl/resolved.js";
import type { UsableThing, UseVerdict } from "./focus.js";

/** A hit on its way to somebody's health, as `playerDamage` is handed it. */
export interface DamageEvent {
  readonly id: PlayerId;
  /** What it would cost. Already through the weapon's falloff, the location and `damageScale`. */
  readonly amount: number;
  /** Who is responsible, or null for the world: a fall, a script, a volume. */
  readonly by: PlayerId | null;
  /** What did it. A death this hit causes carries the same cause. */
  readonly cause: DamageCause;
  /** Where on the body, when a trace put it there. Absent for damage no bullet caused. */
  readonly location?: HitLocation;
  /** The actor that dealt it, when one did. `by` is null beside it: an actor is nobody. */
  readonly actor?: ActorId;
}

/** What a script says about a hit. An absent field is no opinion, not a zero. */
export interface DamageVerdict {
  /** Take nothing off. The hit is seen and refused, and nothing reaches health. */
  ignore?: boolean;
  /** Cost this instead of what was asked. Ignored when `ignore` is set. */
  amount?: number;
}

/** The hooks that may change the game. Server-only, because only the server may. */
export interface ServerHooks<S = unknown> {
  /**
   * This script's state for one match, made once when the match is built, before
   * any other hook of it is asked: every server hook of this script is then handed
   * it as `ctx.memory`, the same object for the life of the match.
   *
   * Server-only and never replicated, which is why it is allowed at all: a client
   * half never sees it, so no hook both ends run can depend on it. It changes only
   * inside hooks, and a hook is asked on a tick — so two runs of one match still
   * play out the same. `ctx.memory` is undefined while this runs.
   */
  init?(ctx: ServerContext): S;
  /**
   * The numbers combat is played by, asked **once at match start** and fixed for
   * the game — they reach every client in `joined`, so a mid-game change would
   * have to be a message of its own.
   *
   * Built. `Partial`, for the reason every hook is optional: a script that only
   * wants friendly fire on says that and nothing else, and the rest stays at
   * `DEFAULT_COMBAT_RULES`. The first script with an opinion wins, as with
   * `playerSpawn`; nothing is merged across scripts, so two of them cannot each
   * set half the rules and leave which half won to declaration order.
   */
  combatRules?(ctx: ServerContext<S>): Partial<CombatRules> | void;
  /**
   * The match has begun: asked **once**, on its first tick, before any bot
   * thinks and before anybody's input is spent.
   *
   * Built, and not gated on people the way `tick` is: a gametype's bots are
   * added here, so they are on the map before the first player arrives rather
   * than appearing around them. A match exists as soon as its game is ordered,
   * which is seconds before anybody can have loaded the map.
   */
  matchStart?(ctx: ServerContext<S>): void;
  /**
   * Somebody — a player or a bot — is joining: in the roster, on the side they
   * were given, and not yet spawned. `setTeam` here decides where they spawn,
   * since `playerSpawn` is asked next.
   *
   * Built. `ctx.player(id)?.bot` tells a bot from a person.
   */
  playerJoin?(ctx: ServerContext<S>, id: PlayerId): void;
  /**
   * The spawns this gametype wants for this player, as a query for
   * `spawnPoints(world, query)` — which already widens a query the map cannot
   * satisfy, so a gametype may ask for a mode and side a map never anticipated.
   *
   * Built. Returning nothing means "no opinion", and the caller keeps its own.
   */
  playerSpawn?(ctx: ServerContext<S>, id: PlayerId): SpawnQuery | void;
  /**
   * Somebody is about to be hurt, and this is the last word before health moves.
   * `Callback_PlayerDamage` is the name it has in the games.
   *
   * Built. Return a verdict to refuse the hit or change what it costs; return
   * nothing to let it stand, which is what a script with no opinion does. It runs
   * after friendly fire has already refused the hit, so a script that wants to
   * see a teammate's round needs `friendlyFire: true` and its own rule here.
   *
   * Damaging somebody from inside this is allowed and does not recurse: the
   * engine queues it and drains the queue once this returns. See
   * `ServerContext.send`, which is specified with the same rule.
   */
  playerDamage?(ctx: ServerContext<S>, hit: DamageEvent): DamageVerdict | void;
  /**
   * They are dead. `Callback_PlayerKilled`.
   *
   * Built, and fires **exactly once** — on the tick health reached zero, not on
   * every tick of the respawn countdown, because a body takes no further damage
   * and nothing else can bring this about.
   *
   * `by` is null for a death nobody is responsible for, and is the victim
   * themselves for their own doing. Both are suicides (`isSuicide`), and neither
   * scores a point. `cause` says how — a fall out of the world is `outOfWorld`
   * with nobody responsible.
   */
  playerDeath?(ctx: ServerContext<S>, id: PlayerId, by: PlayerId | null, cause: DamageCause, actor?: ActorId): void;
  /**
   * Who may choose a class, and when a change takes effect: asked **once at match
   * start**, like `combatRules`, and merged over `DEFAULT_CLASS_RULES`.
   *
   * Built. `customClasses: false` reaches every client in `joined`, which is what
   * takes the class menu away; the rest is enforced here and nowhere else.
   */
  classRules?(ctx: ServerContext<S>): Partial<ClassRules> | void;
  /**
   * A player asked for one of their classes, and this is the last word on when
   * it takes effect — `Callback_PlayerChangeClass`, if the games had one.
   *
   * Built. `request.timing` is what the engine would do anyway: the rules, the
   * grace after a spawn and any per-player override already applied. Return a
   * timing to change it, or nothing to let it stand. The first script with an
   * opinion wins. Refusing a player's *first* choice still spawns them — without
   * their class, carrying what they would be armed with had they none.
   */
  classChoice?(ctx: ServerContext<S>, request: ClassRequest): ClassTiming | void;
  /**
   * A living player's feet entered a trigger's volume this tick. Built, and
   * asked of every script. Once per entry: standing in it asks nothing more,
   * and `triggerLeave` comes before it may fire again.
   *
   * Occupancy is every trigger's, `use` or not, measured once a tick after
   * movement and health and before `tick` — so a script's clock already sees
   * who is where (`ctx.zonesOf`, `ctx.occupants`). A player who dies leaves
   * everything they were in; one who leaves the match is simply gone.
   */
  triggerEnter?(ctx: ServerContext<S>, trigger: ResolvedTrigger, id: PlayerId): void;
  /** Their feet left it: stepped out, or died. Built, as `triggerEnter`. */
  triggerLeave?(ctx: ServerContext<S>, trigger: ResolvedTrigger, id: PlayerId): void;
  /**
   * A player pressed the use key, and this is what they had in focus
   * (focus.ts): the thing the server worked out from their input, never one the
   * client named. Everything after that is the script's — a price, spending it,
   * `ctx.world.setPresent`. Built, and asked of every script.
   *
   * Once per press: the key's rising edge, however long it is then held. A
   * press with nothing in focus asks nothing.
   */
  interact?(ctx: ServerContext<S>, thing: UsableThing, player: PlayerId): void;
  /**
   * The match advanced one tick. `dt` is `1 / tickRate` and never a frame's.
   *
   * Built, and the hook a gametype's own clock runs on: a round, a countdown, a
   * score limit and a respawn wave are all "what time is it" questions, and this
   * is the only place asked one every tick. Called once per tick after health has
   * moved — so a script sees this tick's deaths and respawns — and before the
   * physics step, so anything it kills leaves its body on the same tick as every
   * other death.
   *
   * `ctx.now` is the match clock (`tick / tickRate`), and `ctx.memory` is where
   * a script keeps what the clock is counting — a round that survives everybody
   * leaving needs somewhere to keep a number (`init`).
   */
  tick?(ctx: ServerContext<S>, dt: number): void;
  /**
   * An actor is about to be hurt: the last word before its health moves, as
   * `playerDamage` is a player's. `amount` is already through the weapon's
   * falloff, the location and `damageScale`; `location` is where a trace put it,
   * absent for damage no bullet caused. Return a verdict to refuse or re-price it.
   *
   * Built. A hit a script refuses leaves no marker. Queued like every hit, so
   * damaging anything from here does not recurse.
   */
  actorDamage?(
    ctx: ServerContext<S>,
    actor: ActorId,
    amount: number,
    by: PlayerId | null,
    location: HitLocation | undefined,
    cause: DamageCause,
  ): DamageVerdict | void;
  /**
   * An actor is dead: fired once, on the tick its health reached zero. It lies
   * playing its death for its kind's `corpse` seconds and is then taken out,
   * unless a script's `actors.remove` takes it sooner. Built.
   */
  actorDeath?(ctx: ServerContext<S>, actor: ActorId, by: PlayerId | null, cause: DamageCause, location: HitLocation | undefined): void;
  /** Not built: nothing sends yet. */
  receive?(ctx: ServerContext<S>, from: ScriptId, message: unknown): void;
  /**
   * What this bot should be doing, asked each time it thinks — for a script that
   * would rather answer from what it sees than remember what it ordered. Return nothing to leave the
   * bot's objective as it is (`bots.order`, or what it was added with); an answer
   * replaces it. The first script with an opinion wins.
   *
   * Built. Runs whenever a bot thinks, people or not.
   */
  botObjective?(ctx: ServerContext<S>, bot: PlayerId): Objective | void;
}

/** The hooks that may only look and draw. */
export interface ClientHooks {
  /**
   * What a player of this side wears and holds.
   *
   * Built, and the reason the client half exists at all: a world with no game
   * server must dress its players exactly as one with a server does, so this runs
   * in the browser and on a game server and has to agree. Pure — see `castFor`.
   */
  cast?(view: GameView, team: TeamId | undefined): CastChoice | undefined;
  /**
   * Something this gametype published happened, and this is where it becomes a
   * sound (or, later, something drawn).
   *
   * Built, and the reason `publish` now reaches a browser at all. The script that
   * published it is the script that hears it — same id, same module, both ends —
   * so the vocabulary never has to be agreed between two files: a server half
   * says `{ what: "flagTaken", team }` and this half is the only thing that knows
   * that is `mp_enemy_obj_taken` unless you are on that side.
   *
   * Every client hears every announcement. What differs is `ctx.self`, so
   * localising is a read and not a message the server had to address.
   */
  event?(ctx: ClientContext, event: Announcement): void;
  /**
   * What the prompt says while `thing` is in this player's focus, or null for
   * nothing at all. `{key}` in it becomes the name of the key use is bound to,
   * so "Press {key} to open the door [Cost: 1000]" reads with whatever key the
   * player has. The first script with an opinion wins; none shows
   * "Press {key} to use".
   *
   * Built. Asked every frame something is in focus, so it is a read of what the
   * snapshot already carries — no prompt text crosses the wire, and the price it
   * shows should come from the same pure function the server half charges by.
   */
  prompt?(ctx: ClientContext, thing: UsableThing): string | null | void;
}

/**
 * One script: a module in the table, named, with a server half, a client half, or
 * both.
 *
 * **A world names a behaviour; it never ships one.** Nothing here is loaded from
 * `WORLDS_ROOT` — a game server holds nothing that survives a game and reads
 * nothing off disk, and evaluating code from the worlds volume would make it an
 * execution surface across the whole fleet. The table in registry.ts is the entire
 * answer, exactly as `NODE_TYPES` is for a node and `API_ROUTES` for a route.
 */
export interface Script<S = unknown> {
  readonly id: ScriptId;
  /**
   * Every alias this script's client half can `say`.
   *
   * Declared so it can be *checked*: `pnpm catalog` resolves each of these
   * against the sound banks that were actually built and exits non-zero on one
   * nothing holds, which is where the view-hands check already lives. A script
   * naming an alias no exporter produced is silence at run time, and silence that
   * looks like success is the failure mode this whole layer exists to avoid —
   * `scripts/cod/sound.py`'s `FEEDBACK_ALIASES` is the other end of that ledger,
   * and it grows one entry at a time because a root nothing asks for is how 161 MB
   * of voiceover gets shipped.
   */
  readonly sounds?: readonly string[];
  /**
   * Every actor kind this script may spawn (`ServerContext.actors.spawn`).
   *
   * What a browser loads creatures for: a world fetches the bodies and clips of
   * these kinds only, rather than every kind's on every map. A kind spawned and not
   * declared here is drawn as its capsule.
   */
  readonly actors?: readonly ActorKindId[];
  /** The gametypes that want this script. Empty or absent means every one. */
  readonly gametypes?: readonly GametypeId[];
  /** The map slugs it runs on. Empty or absent means every map. */
  readonly maps?: readonly string[];
  /**
   * Whether `player` may use `thing` now, and whether they must be looking at it
   * to: null is "not now" (no focus, no prompt), a verdict is "yes", and nothing
   * is no opinion. The first script with an opinion wins; with none, a thing is
   * usable from any angle (`DEFAULT_USE`).
   *
   * **Both ends run it** — a browser to decide what is in focus for the prompt,
   * a game server on the use key's edge — so it belongs to neither half and must
   * be a pure function of what it is handed: `view.isPresent`, the roster, the
   * clock. Built.
   */
  usable?(view: GameView, thing: UsableThing, player: PlayerView): UseVerdict | null | void;
  readonly server?: ServerHooks<S>;
  readonly client?: ClientHooks;
}

/** Declare a script with state of its own (`ServerHooks.init`), keeping the state's type inside it. */
export function defineScript<S>(script: Script<S>): Script {
  return script as unknown as Script;
}
