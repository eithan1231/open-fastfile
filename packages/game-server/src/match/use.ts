// The use key: what a press had in focus, found as the input is spent, and every
// script's `interact` asked once the drain is done — so a hook that changes the
// world does so between players' steps rather than in the middle of one.

import type { ResolvedWorld } from "@3d/shared/dsl/resolved.js";
import type { PlayerId } from "@3d/shared/net/messages/fields.js";
import type { GameView } from "@3d/shared/game/context.js";
import { focusOf, usableBy, usableThings, viewerAt, type UsableThing } from "@3d/shared/game/focus.js";
import type { GametypeDecl } from "@3d/shared/game/gametypes/declaration.js";
import type { Bounds } from "@3d/shared/game/volumes.js";
import type { CapsuleWorld } from "@3d/shared/sim/capsule.js";
import type { PlayerInput } from "@3d/shared/sim/input.js";
import type { Presence } from "@3d/shared/worlds/presence.js";
import type { Member } from "./roster.js";
import type { ScriptHost } from "./scripts.js";

export class Interactions {
  /** Every trigger and solid with `use`, built on the first press: the world never changes. */
  private usables: UsableThing[] | undefined;
  /** Presses this tick's drain found something in focus for, asked of `interact` after it. */
  private readonly pressed: { id: PlayerId; thing: UsableThing }[] = [];

  constructor(
    private readonly world: ResolvedWorld,
    private readonly gametype: GametypeDecl,
    private readonly collision: CapsuleWorld,
    private readonly presence: Presence,
    private readonly scripts: ScriptHost,
    private readonly view: GameView,
    private readonly partBounds: ((index: number) => Bounds | undefined) | undefined,
  ) {}

  /**
   * What `member` pressed the use key on, if anything: their focus
   * (game/focus.ts) from where they stand and the input's own view angles. The
   * server's focus, never the client's word: nothing on the wire names a thing.
   */
  press(member: Member, input: PlayerInput): void {
    const things = (this.usables ??= usableThings(this.world, this.gametype.mode, (i) => this.partBounds?.(i)));
    if (things.length === 0) {
      return;
    }
    const player = this.view.player(member.id)!;
    const viewer = viewerAt(member.player.movement.feet, input.yaw, input.pitch);
    const thing = focusOf(this.collision, things, this.presence, viewer, (t) => usableBy(this.scripts.list, this.view, t, player));
    if (thing) {
      this.pressed.push({ id: member.id, thing });
    }
  }

  /** Every press this tick found a thing for, to every script's `interact`, in the order they were pressed. */
  flush(): void {
    for (const { id, thing } of this.pressed.splice(0)) {
      this.scripts.each((hooks, ctx) => hooks.interact?.(ctx, thing, id));
    }
  }
}
