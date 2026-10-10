// Where a member is put: on joining, on coming back from a death, and where a
// script says.

import type { ResolvedSpawn, ResolvedWorld } from "@3d/shared/dsl/resolved.js";
import type { PlayerId } from "@3d/shared/net/messages/fields.js";
import type { CombatRules } from "@3d/shared/game/rules.js";
import { applyWorldRules, spawnPoints, type SpawnQuery } from "@3d/shared/sim/worldRules.js";
import type { Classes } from "./classes.js";
import type { Member } from "./roster.js";
import type { ScriptHost } from "./scripts.js";

export class Spawns {
  /** Advances per spawn, never per player, so two players never take the same point in a row. */
  private cursor = 0;

  constructor(
    private readonly world: ResolvedWorld,
    private readonly scripts: ScriptHost,
    private readonly classes: Classes,
    private readonly rules: () => CombatRules,
  ) {}

  /** Put a member on the next spawn the gametype wants for them. Not yet alive: `respawn` or the join does that. */
  place(member: Member): void {
    applyWorldRules(member.player, this.world, this.pointFor(member.id));
  }

  /**
   * Put a dead member back: a fresh spawn from the gametype's own query, armed
   * afresh — full magazines, primary in hand, with the class they chose while
   * they were down — and full health.
   */
  respawn(member: Member): void {
    this.place(member);
    this.classes.spawned(member);
    member.player.respawn();
    member.player.revive(this.rules().maxHealth);
  }

  /** Put a member on a spawn, as `ServerContext.spawn` does: it becomes theirs, and they are on it now. */
  placeAt(member: Member, at: ResolvedSpawn): void {
    member.player.setSpawn(at.position, at.look);
    member.player.respawn();
  }

  /**
   * Where to put the next player. Round-robin over the spawns the gametype asks
   * for — deliberately not the furthest-from-an-enemy rule a real spawn system
   * needs, which wants teams this does not have yet.
   *
   * Undefined means the world declared no spawns, and `applyWorldRules` falls
   * back to the single one every world has.
   */
  private pointFor(id: PlayerId): ResolvedSpawn | undefined {
    const points = spawnPoints(this.world, this.query(id));
    if (points.length === 0) {
      return undefined;
    }
    return points[this.cursor++ % points.length];
  }

  /** What the gametype's scripts want asked of the map. The first with an opinion wins; with none, the start spawns. */
  private query(id: PlayerId): SpawnQuery {
    return this.scripts.first((hooks, ctx) => hooks.playerSpawn?.(ctx, id)) ?? { start: true };
  }
}
