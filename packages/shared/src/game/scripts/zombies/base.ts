// Zombies, as Black Ops plays it: rounds of a horde that grows, points for every
// hit and kill, and doors bought with them. The worked example of a script with
// state of its own (`init`) — a round clock has to survive its players — and of
// the per-player points and match counters it keeps.
//
// The numbers are BO1's own, read out of its GSC and string tables:
// reverse/t5-zombies/README.md § 5, and docs/cod/reference.md#black-ops-zombies
// for the table and what each is read from. What the world carries — zones that
// target their spawners, door triggers that target their parts — is CoD's own
// entity links, exported as they are (worlds/AUTHORING.md); what they mean is here.
//
// Slice 1: walkers, runners and sprinters from the zones players stand in, and
// buyable doors. No risers, dogs, boards, perks, box, power or last stand.
//
// What it sounds like is the game's own, both halves: a round's start and end and
// a purchase taken or refused are said here (`SAYS`), and a zombie's voice is its
// kind's (`ActorKindDef.sounds`).

import type { GameKey, ResolvedPoint } from "../../../dsl/resolved.js";
import type { PlayerId } from "../../../net/messages/fields.js";
import type { HitLocation } from "../../../sim/hitLocations.js";
import type { WorldIndex } from "../../../worlds/worldIndex.js";
import type { ActorGait } from "../../actors/actor.js";
import { TRANSIT_ZOMBIE_KIND, ZOMBIE_KIND, type ActorKindId } from "../../actors/kinds.js";
import { ArmedWith } from "../../classes.js";
import type { GameView, ServerContext } from "../../context.js";
import type { DamageCause } from "../../damage.js";
import type { UsableThing } from "../../focus.js";
import { ZOMBIES_BO2_HORDE_GAMETYPE, ZOMBIES_GAMETYPE } from "../../gametypes/zombies.js";
import { defineScript } from "../../hooks.js";
import { hashString, seeded } from "../../random.js";

/** Every player's purse at the start (`zombie_score_start_Np`, MEDIUM: 500 for any count). */
export const START_POINTS = 500;
/** A hit that does not kill (`damage` and `damage_light`, both 10). */
export const HIT_POINTS = 10;
/** A kill, before the bonus for how (`zombie_score_kill_Nplayer`). */
export const KILL_POINTS = 50;
/** The bonus by the killing hit's location (`player_add_points_kill_bonus`); a limb earns none. */
const KILL_BONUS: Partial<Record<HitLocation, number>> = { head: 50, helmet: 50, neck: 20, torsoUpper: 10, torsoLower: 10 };
/** A kill with a blow rather than a round (`zombie_score_bonus_melee`), whatever it hit. */
export const MELEE_BONUS = 80;

/** At most this many alive at once (`zombie_ai_limit`). */
export const MAX_ALIVE = 24;
/** Seconds from the first player arriving to round 1 (`round_start`'s `wait( 2 )`). */
export const FIRST_ROUND_DELAY = 2;
/** Seconds between one round's last kill and the next round (`zombie_between_round_time`). */
export const ROUND_BREAK = 10;
/** Seconds the end is on screen before the match is over (`zombie_intermission_time`). */
export const GAME_OVER_SECONDS = 15;
/** A player brought back after this round with less than `RESPAWN_FLOOR` points is given that many (`spectators_respawn`). */
const RESPAWN_FLOOR_AFTER = 6;
const RESPAWN_FLOOR = 1500;

/** The tag every zone's volumes carry (their `script_noteworthy`); a zone is named by its first. */
export const ZONE_MARK = "player_volume";
/** A spawner a slice-1 zone does not use: risers and dogs (their own structs), and quads before the power. */
const NOT_A_WALKER = ["riser", "find_flesh", "quad_zombie_spawner"];
/** A door's buy trigger, and one that opens on the power rather than for points. */
export const DOOR_TAG = "zombie_door";
const ELECTRIC_DOOR_TAG = "electric_door";
/** Where a window is: a point whose `target` is the window's parts (`exterior_goal`). */
const WINDOW_TAG = "exterior_goal";
const CLIP_TAG = "clip";

/** A door whose map sets no price (`door_init`'s default). */
export const DEFAULT_DOOR_PRICE = 1000;
/** Each door's `zombie_cost`, by the tag its trigger targets, per map. */
const DOOR_PRICES: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  "theater-bo1": {
    foyer_top_door: 750,
    foyer_bottom_door: 750,
    vip_top_door: 1000,
    alley_door2: 1000,
    backstage_door: 1250,
    dress_door: 1250,
    dining_room_door: 1250,
    alleyway_fencedoor: 1250,
  },
};

/**
 * What this script publishes. `value` is the round for the first three; the last
 * two carry the `player` who pressed and `value` the price.
 */
const SAYS = { round: "round", roundOver: "roundOver", gameOver: "gameOver", purchase: "purchase", deny: "deny" } as const;

/**
 * What each is heard as: the names both Black Ops games give them, each world
 * resolving them in its own game's bank. A game over has no line of its own in
 * either bank that anything builds yet, so it is silent.
 */
const HEARD = {
  round: "mus_zombie_round_start",
  roundOver: "mus_zombie_round_over",
  purchase: "zmb_cha_ching",
  deny: "zmb_no_cha_ching",
} as const satisfies Partial<Record<(typeof SAYS)[keyof typeof SAYS], string>>;

/** The horde each game's worlds are overrun by; a game not here gets Black Ops'. */
const HORDE: Partial<Record<GameKey, ActorKindId>> = { t5: ZOMBIE_KIND.id, t6: TRANSIT_ZOMBIE_KIND.id };

const DEFAULT_LOADOUT: Partial<Record<GameKey, ArmedWith>> = {
  t5: {
    primary: {
      weapon: "t5/m1911_mp",
    },
  },

  t6: {
    primary: {
      weapon: "t6/fiveseven_mp",
    },
  },
};

/** Which kind this match spawns: its world's game's horde, or TranZit's in the preview gametype. */
export function hordeKind(view: Pick<GameView, "game" | "gametype">): ActorKindId {
  if (view.gametype.id === ZOMBIES_BO2_HORDE_GAMETYPE) {
    return TRANSIT_ZOMBIE_KIND.id;
  }
  return (view.game && HORDE[view.game]) ?? ZOMBIE_KIND.id;
}

/** How many zombies a round has (`round_spawning`, `default_max_zombie_func`). `players` is people, at least one. */
export function zombiesInRound(round: number, players: number): number {
  let multiplier = Math.max(1, round / 5);
  if (round >= 10) {
    multiplier *= round * 0.15;
  }
  const max = 24 + Math.trunc((players <= 1 ? 0.5 * 6 : (players - 1) * 6) * multiplier);
  const share = round === 1 ? 0.25 : round < 3 ? 0.3 : round < 4 ? 0.5 : round < 5 ? 0.7 : round < 6 ? 0.9 : 1;
  return Math.trunc(max * share);
}

/** Each zombie's health in a round (`ai_calculate_health`): 150, +100 a round to round 9, then +10 %. */
export function zombieHealth(round: number): number {
  let health = 150;
  for (let r = 2; r <= round; r++) {
    health = r >= 10 ? health + Math.trunc(health * 0.1) : health + 100;
  }
  return health;
}

/**
 * Seconds between spawns in a round: 2.0, times 0.95 at each round's end while it
 * is above 0.08, and then held there (`round_think`).
 */
export function spawnDelay(round: number): number {
  let delay = 2;
  for (let r = 2; r <= round; r++) {
    if (delay > 0.08) {
      delay *= 0.95;
    } else if (delay < 0.08) {
      delay = 0.08;
    }
  }
  return delay;
}

/**
 * One zombie's gait (`set_run_speed`): a draw in [speed, speed + 35), a walker at
 * 35 or under, a runner at 70 or under, else a sprinter. `speed` is 1 in round 1
 * and 8 a round after (`zombie_move_speed`).
 */
export function gaitFor(round: number, rng: () => number): ActorGait {
  const speed = round <= 1 ? 1 : (round - 1) * 8;
  const draw = speed + Math.floor(rng() * 35);
  return draw <= 35 ? "walk" : draw <= 70 ? "run" : "sprint";
}

/** What killing a zombie earns: 50, and a bonus by the killing hit's location, or 80 for a blow. */
export function killReward(cause: DamageCause, location: HitLocation | undefined): number {
  return KILL_POINTS + (cause === "melee" ? MELEE_BONUS : ((location && KILL_BONUS[location]) ?? 0));
}

/** Whether a usable thing is a door's buy trigger. */
export function isDoor(thing: UsableThing): boolean {
  return thing.kind === "trigger" && thing.tags.includes(DOOR_TAG) && thing.target !== undefined;
}

/**
 * What opening this door costs on this map, or null for one that is not bought
 * — an electric door, which the power opens. Both halves ask it: the prompt shows
 * the price the server charges because they read it here.
 */
export function priceOf(thing: UsableThing, map: string): number | null {
  if (!isDoor(thing) || thing.tags.includes(ELECTRIC_DOOR_TAG)) {
    return null;
  }
  return DOOR_PRICES[map]?.[thing.target!] ?? DEFAULT_DOOR_PRICE;
}

/**
 * The zones a player's feet are in, from the tags of the triggers they stand in:
 * a zone is its volumes' first tag, and its volumes are the triggers marked
 * `ZONE_MARK` (CoD's `info_volume`s, named by `targetname`).
 */
export function zonesIn(world: WorldIndex, tags: readonly string[]): string[] {
  return tags.filter(
    (tag) => tag !== ZONE_MARK && (world.triggers.byTag.get(tag) ?? []).some((trigger) => trigger.tags[0] === tag && trigger.tags.includes(ZONE_MARK)),
  );
}

/**
 * The spawners a zone wakes: the points carrying its volumes' `target`
 * (`zone_init`: `zone.volumes[0].target`), less the kinds slice 1 does not spawn.
 */
export function spawnersOf(world: WorldIndex, zone: string): ResolvedPoint[] {
  const target = world.triggers.byTag.get(zone)?.find((trigger) => trigger.tags.includes(ZONE_MARK))?.target;
  const points = target === undefined ? [] : (world.points.byTag.get(target) ?? []);
  return points.filter((point) => !point.tags.some((tag) => NOT_A_WALKER.includes(tag) || tag.endsWith("_dog")));
}

/**
 * The window clips zombies climb in through: for each window (`exterior_goal`)
 * the solids its `target` names, where every one of them is a `clip` — the
 * boards, when they are parts too, stay.
 */
export function windowClips(world: WorldIndex): string[] {
  const tags = new Set<string>();
  for (const window of world.points.byTag.get(WINDOW_TAG) ?? []) {
    const solids = window.target === undefined ? undefined : world.solids.byTag.get(window.target);
    if (solids?.length && solids.every((solid) => solid.tags.includes(CLIP_TAG))) {
      tags.add(window.target!);
    }
  }
  return [...tags];
}

type Phase = "waiting" | "round" | "break" | "over";

/** One match's round clock: kept by the engine, never replicated (hooks.ts, `init`). */
interface ZombiesState {
  /** This match's draws: which spawner, and each zombie's gait. */
  readonly rng: () => number;
  phase: Phase;
  /** When the phase began; undefined while waiting for the first player. */
  since: number | undefined;
  round: number;
  /** Still to spawn this round (`zombie_total`). */
  left: number;
  nextSpawnAt: number;
  /** The spawner used last, drawn once more if drawn again (`old_spawn`). */
  last: ResolvedPoint | undefined;
}

/** The people in the match: bots are not survivors a round counts or waits for. */
function people(ctx: GameView): PlayerId[] {
  return ctx.players.filter((player) => !player.bot).map((player) => player.id);
}

function alive(ctx: ServerContext, id: PlayerId): boolean {
  return ctx.state(id)?.alive === true;
}

function aliveZombies(ctx: ServerContext): number {
  return ctx.actors.ids().filter((id) => ctx.actors.state(id)?.alive).length;
}

function startRound(ctx: ServerContext<ZombiesState>, round: number): void {
  const s = ctx.memory;
  s.phase = "round";
  s.since = ctx.now;
  s.round = round;
  s.left = zombiesInRound(round, Math.max(1, people(ctx).length));
  s.nextSpawnAt = ctx.now;
  ctx.setCounter("round", round);
  ctx.publish({ what: SAYS.round, value: round });
}

/** The round is won: the dead come back for the next one, BO1's way. */
function endRound(ctx: ServerContext<ZombiesState>): void {
  const s = ctx.memory;
  s.phase = "break";
  s.since = ctx.now;

  ctx.publish({ what: SAYS.roundOver, value: s.round });

  for (const id of people(ctx)) {
    if (ctx.respawn(id) && s.round > RESPAWN_FLOOR_AFTER && ctx.points(id) < RESPAWN_FLOOR) {
      ctx.addPoints(id, RESPAWN_FLOOR - ctx.points(id));
    }
  }
}

/** One spawn if one is due: at a spawner of a zone a living player stands in. */
function spawnOne(ctx: ServerContext<ZombiesState>): void {
  if (ctx.memory.left <= 0 || ctx.now < ctx.memory.nextSpawnAt || aliveZombies(ctx) >= MAX_ALIVE) {
    return;
  }

  const zones = new Set<string>();
  for (const id of people(ctx)) {
    if (alive(ctx, id)) {
      for (const zone of zonesIn(ctx.world, ctx.zonesOf(id))) {
        zones.add(zone);
      }
    }
  }

  const spawners = [...zones].flatMap((zone) => spawnersOf(ctx.world, zone));
  if (spawners.length === 0) {
    return; // nobody in a zone: spawning waits, as BO1's does with no active spawners
  }

  let at = spawners[Math.floor(ctx.memory.rng() * spawners.length)]!;
  if (at === ctx.memory.last) {
    at = spawners[Math.floor(ctx.memory.rng() * spawners.length)]!;
  }

  ctx.memory.last = at;
  ctx.actors.spawn({
    kind: hordeKind(ctx),
    brain: "zombie",
    objective: { kind: "hunt" },
    at: at.position,
    look: at.look,
    gait: gaitFor(ctx.memory.round, ctx.memory.rng),
    health: zombieHealth(ctx.memory.round),
  });

  ctx.memory.left--;
  ctx.memory.nextSpawnAt = ctx.now + spawnDelay(ctx.memory.round);
}

export const zombiesScript = defineScript<ZombiesState>({
  id: "zombies",
  gametypes: [ZOMBIES_GAMETYPE, ZOMBIES_BO2_HORDE_GAMETYPE],
  sounds: Object.values(HEARD),
  actors: [ZOMBIE_KIND.id, TRANSIT_ZOMBIE_KIND.id],
  // A door is the one thing used in slice 1, and from any angle (reverse/t5-zombies § 4).
  // Everything else — wall buys, perks, the box — is not usable yet, so it offers no prompt.
  usable: (view, thing) => {
    const price = priceOf(thing, view.map);
    if (price === null || !view.world.solids.byTag.has(thing.target!)) {
      return null;
    }
    return view.isPresent(thing.target!) ? { look: false } : null;
  },
  server: {
    init: (ctx) => ({
      rng: seeded(hashString(`${ctx.seed}:zombies`)),
      phase: "waiting",
      since: undefined,
      round: 0,
      left: 0,
      nextSpawnAt: 0,
      last: undefined,
    }),
    combatRules: () => ({ respawnDelay: null }),
    // No class menu, at the start or between deaths: the starting pistol is the script's (`playerJoin`).
    classRules: () => ({ customClasses: false, change: "refuse" }),
    // The windows open: zombies climb in where BO1's boards would be.
    matchStart: (ctx) => {
      for (const window of windowClips(ctx.world)) {
        ctx.world.setPresent(window, false);
      }
    },
    playerJoin: (ctx, id) => {
      ctx.setTeam(id, "survivors");
      ctx.addPoints(id, START_POINTS);
    },
    playerSpawn: (ctx, id) => {
      if (!ctx.game) {
        return;
      }

      const loadout = DEFAULT_LOADOUT[ctx.game];

      if (!loadout) {
        return;
      }

      ctx.setLoadout(id, loadout);
    },
    tick: (ctx) => {
      const here = people(ctx);

      if (ctx.memory.phase === "over") {
        if (ctx.now - ctx.memory.since! >= GAME_OVER_SECONDS) {
          ctx.endMatch(`everyone died in round ${ctx.memory.round}`);
        }
        return;
      }

      if (ctx.memory.phase === "waiting") {
        if (here.length > 0) {
          ctx.memory.since ??= ctx.now;
          if (ctx.now - ctx.memory.since >= FIRST_ROUND_DELAY) {
            startRound(ctx, 1);
          }
        }
        return;
      }

      // With nobody left standing it is over, as `checkForAllDead` calls it.
      if (here.length > 0 && !here.some((id) => alive(ctx, id))) {
        ctx.memory.phase = "over";
        ctx.memory.since = ctx.now;
        ctx.publish({ what: SAYS.gameOver, value: ctx.memory.round });
        return;
      }

      if (ctx.memory.phase === "break") {
        if (ctx.now - ctx.memory.since! >= ROUND_BREAK) {
          startRound(ctx, ctx.memory.round + 1);
        }
        return;
      }

      spawnOne(ctx);

      if (ctx.memory.left <= 0 && aliveZombies(ctx) === 0) {
        endRound(ctx);
      }
    },
    // Ten for a hit that leaves it standing; the killing hit is paid by `actorDeath`.
    actorDamage: (ctx, actor, amount, by) => {
      const health = ctx.actors.state(actor)?.health ?? 0;
      if (by !== null && amount > 0 && amount < health) {
        ctx.addPoints(by, HIT_POINTS);
      }
    },
    actorDeath: (ctx, _actor, by, cause, location) => {
      if (by !== null) {
        ctx.addPoints(by, killReward(cause, location));
      }
    },
    interact: (ctx, thing, player) => {
      const price = priceOf(thing, ctx.map);
      // `world.isPresent` counts a purchase made earlier this tick, so a door two
      // players press together is paid for once.
      if (price === null || !ctx.world.isPresent(thing.target!)) {
        return;
      }

      if (ctx.points(player) < price) {
        ctx.publish({ what: SAYS.deny, player, value: price });
        return;
      }

      ctx.addPoints(player, -price);
      ctx.world.setPresent(thing.target!, false);
      ctx.publish({ what: SAYS.purchase, player, value: price });
    },
  },
  client: {
    event: (ctx, event) => {
      // `hasOwn` rather than an index: `what` came off the wire (countdown.ts).
      const alias = Object.hasOwn(HEARD, event.what) ? HEARD[event.what as keyof typeof HEARD] : undefined;
      if (alias === undefined) {
        return;
      }
      // A purchase is the buyer's to hear; a round is everybody's.
      if (event.player !== undefined && event.player !== ctx.self?.id) {
        return;
      }
      ctx.say(alias, { channel: event.player === undefined ? "voice" : "ui" });
    },
    prompt: (ctx, thing) => {
      const price = priceOf(thing, ctx.map);
      return price === null ? null : `Press {key} to open door [Cost: ${price}]`;
    },
  },
});
