// Who a player of this match is, as the gametype's scripts answer it: the body a
// shot is traced against, and the weapon in an otherwise empty hand.
//
// The same `cast` call the browser makes, with the same inputs, so the two cannot
// disagree about what anyone is wearing or carrying — which is why `cast` is pure.

import { bodyFor, type CastChoice } from "@3d/shared/game/cast.js";
import type { GameView } from "@3d/shared/game/context.js";
import type { PlayerId } from "@3d/shared/net/messages/fields.js";
import type { WeaponId, WeaponRegistry } from "@3d/shared/sim/weaponRegistry.js";
import type { BodyView, LoadedBody } from "../bodies.js";
import type { ScriptHost } from "./scripts.js";

export class MatchCast {
  constructor(
    private readonly scripts: ScriptHost,
    private readonly view: GameView,
    private readonly bodies: BodyView,
    private readonly weapons: WeaponRegistry,
  ) {}

  /**
   * The body this player wears: the same call the browser makes, off the same
   * id, so the bones a bullet meets are the bones somebody was drawn with.
   *
   * Asked with no side, because the browser asks with no side (`remotePlayers.spawn`
   * says why): narrowing the cast by team here would dress a player in a body the
   * client is not drawing, which is a hit box on another body's skeleton.
   */
  bodyOf(id: PlayerId): LoadedBody | undefined {
    // The body's own game, which a borrowed cast (`castFor`'s stand-in) makes
    // other than the world's.
    const character = bodyFor(id, this.choice()?.characters ?? []);
    return character === undefined ? undefined : this.bodies.get(character.body.game, character.id);
  }

  /**
   * What a player spawns holding when their class arms them with nothing this
   * instance holds: the gametype's, not the world's. Null where this gametype
   * names none, or names one this instance's catalogue does not hold — unarmed
   * is visible, and a different gun would not be.
   */
  defaultWeapon(): WeaponId | null {
    const named = this.choice()?.defaultWeapon;
    return named != null && this.weapons.entry(named) ? named : null;
  }

  private choice(): CastChoice | undefined {
    return this.scripts.firstClient((hooks) => hooks.cast?.(this.view, undefined));
  }
}
