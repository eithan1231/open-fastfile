// Whose feet are in which trigger, and the scripts told as it changes:
// `triggerLeave` then `triggerEnter`, once each.

import type { ResolvedTrigger } from "@3d/shared/dsl/resolved.js";
import type { PlayerId } from "@3d/shared/net/messages/fields.js";
import { Occupancy } from "../occupancy.js";
import type { Roster } from "./roster.js";
import type { ScriptHost } from "./scripts.js";

export class Zones {
  private readonly occupancy: Occupancy;

  constructor(
    private readonly triggers: readonly ResolvedTrigger[],
    mode: string | undefined,
    private readonly roster: Roster,
    private readonly scripts: ScriptHost,
  ) {
    this.occupancy = new Occupancy(triggers, mode);
  }

  /**
   * Where everyone's feet are now, and the hooks for what changed — player by
   * player in roster order, each player's in trigger order. The dead are in
   * nothing.
   */
  step(): void {
    for (const member of this.roster.values()) {
      const { left, entered } = this.occupancy.update(member.id, member.player.dead ? null : member.player.movement.feet);
      this.hearLeft(member.id, left);
      for (const i of entered) {
        this.scripts.each((hooks, ctx) => hooks.triggerEnter?.(ctx, this.triggers[i]!, member.id));
      }
    }
  }

  /** Somebody is leaving the match: out of everything they were in, which the scripts hear, and forgotten. */
  leave(id: PlayerId): void {
    this.hearLeft(id, this.occupancy.update(id, null).left);
    this.occupancy.remove(id);
  }

  /** The tags of every trigger `id` is in. */
  zonesOf(id: PlayerId): string[] {
    return this.occupancy.zonesOf(id);
  }

  /** Everyone in any trigger carrying `tag`, in roster order. */
  occupants(tag: string): PlayerId[] {
    return this.roster.ids().filter((id) => this.occupancy.isIn(id, tag));
  }

  private hearLeft(id: PlayerId, left: readonly number[]): void {
    for (const i of left) {
      this.scripts.each((hooks, ctx) => hooks.triggerLeave?.(ctx, this.triggers[i]!, id));
    }
  }
}
