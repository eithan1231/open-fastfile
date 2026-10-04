// The worlds this instance currently has loaded, and what it cost to load them.
//
// An instance hosts whatever the authority orders. It is told a map when a game
// is created, not at boot, so a world and its collision BVH are built on demand
// and thrown away once no game needs them — an instance that hosted one busy map
// this morning should not still be holding its BVH tonight.
//
// -- Refcounted, not cached --------------------------------------------------
//
// `acquire` and `release` bracket a game's lifetime, and the count is games, not
// players. Two games on one map share the load; the second `release` unloads it.
// A cache with a timeout was the alternative and is worse for the same reason a
// cache always is: it holds the biggest object in the process — a BVH over a
// whole map's triangles — against a future that may not happen.
//
// -- Why the in-flight promise is shared -------------------------------------
//
// Two orders for the same map arriving in one `hello` would otherwise both miss,
// both load, and both build a BVH; one of the two results would then be dropped
// on the floor, having cost a full map parse. So the promise goes in the map
// before the first await, and the second caller waits on the first's work.
//
// -- Navigation is loaded here and baked after --------------------------------
//
// A world with a `navigation` node has its `nav.bin` fetched beside the
// collision and its graph baked against that collision (nav.ts). The bake is
// started and not awaited: the world is returned, and its games are joinable,
// while it runs. A missing or unreadable file is a world with no bots' paths, not
// a world that failed to load.

import { inject, singleton } from "tsyringe";
import { hasErrors } from "@3d/shared/dsl/diagnostics.js";
import { loadResolvedWorld } from "@3d/shared/worlds/load.js";
import { indexWorld, type WorldIndex } from "@3d/shared/worlds/worldIndex.js";
import type { ResolvedWorld } from "@3d/shared/dsl/resolved.js";
import type { CapsuleWorld } from "@3d/shared/sim/capsule.js";
import { Api } from "./api.js";
import type { CollisionChannel, CollisionWorld } from "@3d/shared/collision/world.js";
import { buildServerCollision } from "./collision.js";
import { decodeNav } from "@3d/shared/nav/format.js";
import { movementRules } from "@3d/shared/sim/worldRules.js";
import type { WorldSource } from "@3d/shared/worlds/source.js";
import { NavBaker, type WorldNav } from "./nav.js";
import { basePresence } from "@3d/shared/worlds/presence.js";
import { worldHash } from "@3d/shared/worlds/hash.js";
import type { NavPart } from "@3d/shared/nav/parts.js";

export interface LoadedWorld {
  readonly map: string;
  readonly world: ResolvedWorld;
  /** How this map's objects are addressed by id, name or tag. Shared by every game on it, like the BVH. */
  readonly index: WorldIndex;
  /** `worldHash`: what a joining client's world must match, or its ids mean other things. */
  readonly hash: string;
  /**
   * What stops a capsule here. Always real: a world with no collision is refused
   * at load rather than hosted, because this server *corrects* players now and
   * correcting one against nothing drops them through the floor forever.
   */
  readonly collision: CapsuleWorld;
  /**
   * The same collision, unnarrowed, for something that needs its own copy of the
   * map's triangles rather than a query against this one — a physics engine
   * building a trimesh, today.
   *
   * A second field rather than widening `collision`, because that narrowing is the
   * point: the simulation sees a `CapsuleWorld` and must go on seeing one, or
   * `sim/` grows a way to reach three.js. Optional so that a test standing a world
   * up out of a literal need not build a real one.
   */
  readonly surfaces?: CollisionWorld;
  /**
   * Where bots can walk, or undefined for a world with no `navigation` node (or
   * one whose file would not load). Baked in the background as the world loads:
   * `nav.graph` is null until `nav.ready`.
   */
  readonly nav?: WorldNav;
}

interface Entry {
  /** Shared by every caller that asked while this was loading. */
  readonly loading: Promise<LoadedWorld>;
  /** Games holding this world. At zero it is unloaded. */
  games: number;
}

@singleton()
export class WorldRegistry {
  private readonly entries = new Map<string, Entry>();

  constructor(
    @inject(Api) private readonly api: Api,
    @inject(NavBaker) private readonly baker: NavBaker,
  ) {}

  /** The maps loaded right now. Reported in the heartbeat as a placement hint, never as a filter. */
  get loaded(): string[] {
    return [...this.entries.keys()];
  }

  /**
   * Take a reference to a map, loading it if this is the first. Every `acquire`
   * that resolves must be matched by exactly one `release`, which is why the
   * caller that fails to stand a game up releases in a `finally`.
   */
  async acquire(map: string): Promise<LoadedWorld> {
    const existing = this.entries.get(map);
    if (existing) {
      existing.games += 1;
      return existing.loading;
    }

    const entry: Entry = { loading: this.load(map), games: 1 };
    this.entries.set(map, entry);

    try {
      return await entry.loading;
    } catch (err) {
      // A map that would not load is not a map this instance is holding. Drop it
      // so the next order retries rather than replaying the same rejection.
      this.entries.delete(map);
      throw err;
    }
  }

  /** Give a reference back. The last one out unloads the map. */
  release(map: string): void {
    const entry = this.entries.get(map);
    if (!entry) {
      return;
    }

    entry.games -= 1;

    if (entry.games <= 0) {
      this.entries.delete(map);
      // A bake still running is work for a world nobody holds any more.
      void entry.loading.then(
        (world) => world.nav?.cancel(),
        () => {},
      );
      console.log(`  - unloaded "${map}": no games left on it`);
    }
  }

  private async load(map: string): Promise<LoadedWorld> {
    const source = this.api.worlds.world(map);
    const started = Date.now();

    const loaded = await loadResolvedWorld(source);

    if (loaded.error !== undefined) {
      throw new Error(`${map}: ${loaded.error}`);
    }

    if (!loaded.world || hasErrors(loaded.diagnostics)) {
      throw new Error(`${map}: failed to resolve`);
    }

    const { world } = loaded;
    const index = indexWorld(world);
    const objects = index.objects.length;
    console.log(`  + loaded "${map}": ${objects} object(s), ` + `${index.byName.size} named, ${index.byTag.size} tag(s) in ${Date.now() - started}ms`);

    const collisionStarted = Date.now();
    const built = await buildServerCollision(world, source, (ref, rel) =>
      this.api.client.catalogFile({ kind: ref.kind, game: ref.game, id: ref.id, rest: rel }),
    );

    if (built) {
      const { assets, placements, missing } = built.props;
      console.log(
        `    collision ${built.triangles.toLocaleString()} clipmap triangles, ` +
          `${placements.toLocaleString()} prop hulls over ${assets.toLocaleString()} assets in ${Date.now() - collisionStarted}ms`,
      );

      // A prop solid on the client and absent here is drift that reads as a
      // netcode problem, so it is named rather than left to the drift figures.
      if (missing > 0) {
        console.warn(`    ! ${missing} prop collider(s) failed to load: players will pass through them here and not on their own screen.`);
      }
    }

    // Refused rather than hosted unarmed. This used to be a warning, back when the
    // server only *measured* how far a client had drifted and a world it could not
    // check merely made those figures meaningless. Now it corrects, and a
    // correction computed against no geometry puts a player under the map and
    // keeps them there — so a missing mesh is a world this process cannot host,
    // not a world it hosts badly. Every world on disk is an imported map and ships
    // a `collision.glb`, so reaching here means the mesh is absent or empty.
    if (!built) {
      throw new Error(`"${map}" has no server collision mesh, and a server that corrects players cannot host a world it cannot check`);
    }

    const nav = await this.loadNav(map, world, source, built.world);
    return { map, world, index, hash: worldHash(world), collision: built.world, surfaces: built.world, nav };
  }

  /** Fetch and decode the world's `nav.bin`, and queue its bake. Undefined where there is none to bake. */
  private async loadNav(map: string, world: ResolvedWorld, source: WorldSource, collision: CollisionWorld): Promise<WorldNav | undefined> {
    const rel = world.navigation?.source;
    if (rel === undefined) {
      return undefined;
    }
    let bytes: Uint8Array | undefined;
    try {
      bytes = await source.asset(rel);
    } catch (err) {
      console.warn(`    ! nav: could not fetch ${rel}, so bots here will stand still: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
    if (!bytes) {
      console.warn(`    ! nav: the world names ${rel} and it is not there, so bots here will stand still`);
      return undefined;
    }
    try {
      const file = decodeNav(bytes);
      console.log(`    nav ${file.nodes.count.toLocaleString()} nodes, ${file.links.count.toLocaleString()} links in ${rel}: baking`);
      // Against the base, with every part absent, once for every game and mode on
      // the map; each part is then a blocker over the links it fills (nav/parts.ts).
      const partsOn = (channel: CollisionChannel) =>
        world.solids.map((_, i): NavPart | undefined => {
          const bounds = collision.partBounds(i, channel);
          return bounds && { min: bounds.min, max: bounds.max, world: collision.partView(i, channel) };
        });
      // An actor's parts against its own channel: a window's AI clip shuts the climb through it.
      const actor = collision.hasAiChannel ? { ground: collision.view(basePresence(world), "ai"), parts: partsOn("ai") } : undefined;
      return this.baker.bake(map, file, collision.view(basePresence(world)), movementRules(world), partsOn("player"), actor);
    } catch (err) {
      console.warn(`    ! nav: ${rel} would not decode, so bots here will stand still: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }
}
