// The rules a world imposes on the player in it: where they start, and how far
// they may fall before the world gives up on them.
//
// These are deliberately not part of PlayerState (docs/engine/player.md): they
// come with the world, not with the player. They live here rather than in the
// client because a server re-simulating a player has to apply exactly the same
// ones, and a kill plane that disagreed by a metre would respawn one end and not
// the other — a divergence that looks like a physics bug. The mantle volumes and
// ladders are here for the same reason, and a sharper one: a climb the two ends
// disagree about moves a player metres.

import type { ResolvedSpawn, ResolvedWorld } from "../dsl/resolved.js";
import { LadderVolumes } from "./ladder.js";
import { MantleVolumes } from "./mantle.js";
import type { Player } from "./player.js";

/** How far below the spawn a player has to fall before respawning, m. */
export const KILL_PLANE_MARGIN = 50;

/** Point `player` at this world's spawn and kill plane. Does not move them; `respawn()` does that. */
export function applyWorldRules(player: Player, world: ResolvedWorld, spawn?: ResolvedSpawn): void {
  // The spawn is the only height the world still declares, so the kill plane
  // hangs off it. An imported map's lowest walkable point is not far below one.
  player.setKillPlane(world.spawn.position.y - KILL_PLANE_MARGIN);
  const at = spawn ?? world.spawn;
  player.setSpawn(at.position, at.look);
  // Built here rather than held by the caller: a world's mantle volumes are one
  // of its rules, and this is the one place a world imposes those on a player.
  const rules = movementRules(world);
  player.setMantles(rules.mantles);
  player.setLadders(rules.ladders);
}

/** The climbs a world allows, as a movement step takes them. */
export interface MovementRules {
  mantles: MantleVolumes;
  ladders: LadderVolumes;
}

/**
 * A world's mantle volumes and ladders, built the one way a player gets them.
 * The navigation bake simulates its links with these too (nav/validate.ts), so a
 * link it calls walkable is one a player in this world can walk.
 */
export function movementRules(world: Pick<ResolvedWorld, "mantles" | "ladders">): MovementRules {
  return { mantles: new MantleVolumes(world.mantles), ladders: new LadderVolumes(world.ladders) };
}

/**
 * Whether a node tagged with `modes` exists in a match of `mode`.
 *
 * Untagged is every mode. A tagged node is absent when no mode is being played
 * (Free Roam): it belongs to some game, and none is on. Spawns do not use this —
 * `spawnPoints` widens rather than excludes, because a player must go somewhere.
 */
export function presentIn(modes: readonly string[] | undefined, mode: string | undefined): boolean {
  if (modes === undefined) {
    return true;
  }
  return mode !== undefined && modes.includes(mode);
}

/** What a spawn choice is made against: the mode being played and the side asking. */
export interface SpawnQuery {
  mode?: string;
  team?: string;
  /** Prefer a round-start spawn. Those are the ones a map intends for an opening spawn. */
  start?: boolean;
}

/**
 * The spawn points this world offers for a query, best match first.
 *
 * Narrowing is deliberate rather than exact: a map declares spawns per mode and
 * side, and a server asking for a combination the map never anticipated must
 * still get somewhere to put a player rather than nowhere. So each constraint is
 * dropped in turn, and an empty result means the world declared no spawns at
 * all — for which `ResolvedWorld.spawn` is the fallback every world has.
 */
export function spawnPoints(world: ResolvedWorld, query: SpawnQuery = {}): ResolvedSpawn[] {
  const all = world.spawnPoints;
  if (all.length === 0) {
    return [];
  }

  const matches = (spawn: ResolvedSpawn, withStart: boolean, withTeam: boolean): boolean => {
    if (query.mode !== undefined && spawn.modes !== undefined && !spawn.modes.includes(query.mode)) {
      return false;
    }
    if (withTeam && query.team !== undefined && spawn.team !== undefined && spawn.team !== query.team) {
      return false;
    }
    return !withStart || spawn.start === query.start;
  };

  // Most specific first; the last pass constrains nothing and so always answers.
  for (const [withStart, withTeam] of [
    [query.start !== undefined, true],
    [false, true],
    [false, false],
  ] as const) {
    const found = all.filter((spawn) => matches(spawn, withStart, withTeam));
    if (found.length > 0) {
      return found;
    }
  }

  return all;
}
