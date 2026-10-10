// The games this instance is hosting, and who is allowed into each.
//
// One process, several concurrent games, any number of maps. Each game holds a
// reference to its world for as long as it runs (see worlds.ts); two games on
// one map share the one `ResolvedWorld` and the one collision BVH, and the map
// is unloaded when the last of them ends.
//
// The roster lives here and not in Match, which is the simulation and has no
// business holding secrets. A player is admitted by an id the api issued and a
// key the api gave them; this file is what checks it.

import { createHash, timingSafeEqual } from "node:crypto";
import { inject, singleton } from "tsyringe";
import type { GameOrder, GameOrderPlayer } from "@3d/shared/protocol/events/server.js";
import type { PlayerId } from "@3d/shared/net/messages/fields.js";
import { config } from "./config.js";
import { admits, gametype } from "@3d/shared/game/gametypes/registry.js";
import { Bodies, type BodyView } from "./bodies.js";
import { Match } from "./match/match.js";
import { WorldRegistry } from "./worlds.js";
import { Weapons } from "./weapons.js";
import { Physics } from "./physics.js";
import { presenceFor } from "@3d/shared/worlds/presence.js";

export interface GameInstance {
  readonly id: string;
  readonly map: string;
  /** `worldHash` of the map as this instance loaded it: a joining client's must match. */
  readonly worldHash: string;
  readonly match: Match;
  /**
   * playerId → what the api said about that player: the key they must present,
   * and the class they chose. From the authority, never minted here.
   */
  readonly roster: ReadonlyMap<PlayerId, GameOrderPlayer>;
  readonly createdAt: number;
  readonly durationMs: number;
  /** Whether anyone has ever been in it, which is what tells "over" from "not started". */
  joined: boolean;
  /**
   * Players admitted and not yet spawned: seated, and on the class menu. Here so
   * that a game whose players are all still choosing is not mistaken for an
   * empty one and ended under them.
   */
  readonly choosing: Set<PlayerId>;
}

/**
 * Why a game stopped.
 *
 * A discriminated code rather than the prose it used to be: the log line wants a
 * sentence, the api wants a status, and a test wants to assert on it — three
 * things one English string was doing badly. `endingReason` is the only place
 * the sentence exists.
 */
export type Ending = "expired" | "abandoned" | "unattended" | "over" | "errored";

export function endingReason(ending: Ending): string {
  switch (ending) {
    case "expired":
      return "its time ran out";
    case "abandoned":
      return "everyone left";
    case "unattended":
      return "nobody arrived";
    case "over":
      return "its gametype called it";
    case "errored":
      return "it threw on its tick";
  }
}

export interface FinishedGame {
  game: GameInstance;
  ending: Ending;
}

/** How many ended games `Games` remembers, which only has to outlast a report and a reconnect. */
const REMEMBERED_ENDINGS = 256;

/** Digest first so the comparison is a fixed length whatever was presented. */
function keyMatches(presented: string, expected: string): boolean {
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

@singleton()
export class Games {
  private readonly instances = new Map<string, GameInstance>();

  /**
   * Games ordered but not yet standing, because their map is still loading.
   * They hold a place against `maxGames`, and a `drop` naming one is what tells
   * `create` to abandon it rather than stand up a game nobody is waiting for.
   */
  private readonly pending = new Set<string>();

  /**
   * Games this instance has stopped hosting, oldest first. A game id is minted
   * once per round, so one that comes back can only be a `hello` sent before the
   * api heard it was over — and standing that up again would load a world for a
   * game nobody will be sent to.
   */
  private readonly ended = new Set<string>();

  /**
   * Orders this instance would not host, and why, until Housekeeping takes them
   * to report. A refusal only logged leaves its players waiting out the api's
   * ready timeout, and the next placement free to pick this instance again.
   */
  private readonly refusals = new Map<string, string>();

  constructor(
    @inject(WorldRegistry) private readonly worlds: WorldRegistry,
    @inject(Weapons) private readonly weapons: Weapons,
    @inject(Bodies) private readonly bodies: BodyView,
    @inject(Physics) private readonly physics: Physics,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Stand a game up, loading its map if this instance does not already have it.
   *
   * Async because of that load, which is what lets one instance host any map the
   * authority names. The order is safe to replay: the api re-sends its whole list
   * on every reconnect, so a duplicate returns the running game rather than
   * loading its world a second time.
   */
  async create(order: GameOrder, at: number = this.now()): Promise<GameInstance | undefined> {
    const existing = this.instances.get(order.gameId);
    if (existing) {
      return existing;
    }

    if (this.ended.has(order.gameId)) {
      return undefined;
    }

    if (this.pending.has(order.gameId)) {
      // Ordered twice while its world is still loading. The first call is what
      // will stand it up; this one must not load the map a second time.
      return undefined;
    }

    if (this.count >= config.maxGames) {
      return this.refuse(order.gameId, `already hosting ${this.count}`);
    }

    const decl = gametype(order.gametype);
    if (!decl) {
      // Refuse the game, not the instance: an authority a version ahead may name a
      // gametype this build has never heard of, and the right answer is to keep
      // hosting everything else. Said out loud, because a game silently missing
      // from a fleet is very hard to account for from the other end.
      return this.refuse(order.gameId, `unknown gametype "${order.gametype}"`);
    }

    // Counted against capacity before the await, so several orders arriving
    // together cannot all pass the check above and overshoot maxGames.
    this.pending.add(order.gameId);

    let loaded;
    try {
      loaded = await this.worlds.acquire(order.map);
    } catch (err) {
      this.pending.delete(order.gameId);
      return this.refuse(order.gameId, `"${order.map}" would not load — ${err instanceof Error ? err.message : String(err)}`);
    }

    // Dropped while its world was loading, by a `gameEnd` or a shutdown. The
    // reference has to go back, and the game must not be stood up after all.
    if (!this.pending.delete(order.gameId)) {
      this.worlds.release(order.map);
      return undefined;
    }

    // The half of the check the authority could not make: a gametype may restrict
    // itself to certain source games, and which game a world came from is in its
    // text rather than in the manifest. Now that it is resolved, ask.
    if (!admits(decl, order.map, loaded.world.game)) {
      this.worlds.release(order.map);
      return this.refuse(order.gameId, `${decl.display} is not played on "${order.map}"`);
    }

    // This game's own presence over the map's one set of trees: two games on one
    // map in different modes see different solids and share every BVH and the bake.
    const presence = presenceFor(loaded.world, decl.mode);
    const surfaces = loaded.surfaces;
    const game: GameInstance = {
      id: order.gameId,
      map: order.map,
      worldHash: loaded.hash,
      match: new Match(surfaces ? surfaces.view(presence) : loaded.collision, loaded.world, config.tickRate, order.maxPlayers, this.weapons.all, {
        map: order.map,
        gametype: decl,
        catalogue: this.weapons.catalogue,
        bodies: this.bodies,
        nav: loaded.nav,
        presence,
        actorCollision: surfaces?.hasAiChannel ? surfaces.view(presence, "ai") : undefined,
        partView: surfaces ? (index) => surfaces.partView(index) : undefined,
        partBounds: surfaces ? (index) => surfaces.partBounds(index) : undefined,
      }),
      roster: new Map(order.players.map((player) => [player.id, player])),
      createdAt: at,
      durationMs: order.durationSeconds * 1000,
      joined: false,
      choosing: new Set(),
    };

    // How this game builds dynamics, if anything ever asks it to. Not called here:
    // a map's trimesh is the most expensive thing in @3d/shared/physics and no kind
    // the server simulates exists yet, so today this closure is never run. When one
    // does, it is run once, on that kind's first spawn.
    game.match.setPhysicsFactory(() => {
      const physics = this.physics.create();
      if (physics && loaded.surfaces) {
        // The presence as it stands when the world is built, not as the game began.
        const cost = physics.loadTerrain(loaded.surfaces, "shots", presence);
        console.log(`  physics ${order.map}: ${cost.triangles.toLocaleString()} map triangles in ${cost.ms}ms`);
      }
      return physics;
    });

    this.instances.set(game.id, game);
    return game;
  }

  /** The refusals not yet handed to the reporter, each once. */
  takeRefusals(): [gameId: string, reason: string][] {
    const taken = [...this.refusals];
    this.refusals.clear();
    return taken;
  }

  private refuse(gameId: string, reason: string): undefined {
    console.warn(`  ! refusing game ${gameId}: ${reason}`);
    this.refusals.set(gameId, reason);
    return undefined;
  }

  get(id: string): GameInstance | undefined {
    return this.instances.get(id);
  }

  all(): GameInstance[] {
    return [...this.instances.values()];
  }

  /** Stop hosting a game and give its world back. */
  drop(id: string): void {
    this.ended.add(id);
    if (this.ended.size > REMEMBERED_ENDINGS) {
      this.ended.delete(this.ended.values().next().value!);
    }

    // Still loading its world: `create` sees the reservation is gone and gives
    // the world reference back itself.
    if (this.pending.delete(id)) {
      return;
    }

    const game = this.instances.get(id);
    if (!game) {
      return;
    }

    this.instances.delete(id);
    // Before the world goes: a physics world is wasm memory that no garbage
    // collector frees, so a process that hosted a thousand games would hold a
    // thousand of them.
    game.match.dispose();
    this.worlds.release(game.map);
  }

  /**
   * Stop hosting every game not in `ids`, running or still loading, and say
   * which. The answer to a `hello`: the authority's list is the whole list, and
   * a game it no longer knows about — it restarted, or ended the game while this
   * instance was not listening — has nobody who will ever be sent to it.
   */
  retain(ids: ReadonlySet<string>): string[] {
    const gone = [...this.instances.keys(), ...this.pending].filter((id) => !ids.has(id));
    for (const id of gone) {
      this.drop(id);
    }
    return gone;
  }

  /** Whether this player may join this game. */
  admits(id: string, playerId: PlayerId, authorizationKey: string): boolean {
    const expected = this.instances.get(id)?.roster.get(playerId)?.authorizationKey;
    return expected !== undefined && keyMatches(authorizationKey, expected);
  }

  /** The games that are over, and why. Called once a second, not once a tick. */
  finished(at: number = this.now()): FinishedGame[] {
    const over: FinishedGame[] = [];

    for (const game of this.instances.values()) {
      const age = at - game.createdAt;

      if (game.match.failed !== undefined) {
        over.push({ game, ending: "errored" });
      } else if (game.match.ended !== undefined) {
        // The gametype's own verdict (`ServerContext.endMatch`), ahead of the clock's.
        over.push({ game, ending: "over" });
      } else if (age >= game.durationMs) {
        over.push({ game, ending: "expired" });
      } else if (game.match.humans === 0 && game.choosing.size === 0 && age >= config.joinGraceMs) {
        // Bots keep nobody company: a game only they are left in is over.
        over.push({ game, ending: game.joined ? "abandoned" : "unattended" });
      }
    }

    return over;
  }

  get size(): number {
    return this.instances.size;
  }

  /** Games held against `maxGames`: standing, and still loading. What the heartbeat reports. */
  get count(): number {
    return this.instances.size + this.pending.size;
  }

  /** People playing here, across every game: the load the heartbeat reports. A bot is not one. */
  get players(): number {
    let total = 0;

    for (const game of this.instances.values()) {
      total += game.match.humans;
    }

    return total;
  }
}
