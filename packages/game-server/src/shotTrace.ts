// SHOTTRACE (docs/engine/diagnostics-shottrace.md): this tick's rounds, each to
// the player who fired it.
//
// Addressed rather than broadcast, for the reason a hit marker is: this is one
// client's own answer about its own shot, and telling the room where everybody
// else's bullets went is a wallhack with a debug flag in front of it.

import { encodePacket, MessageType } from "@3d/shared/net/packet.js";
import type { ShotTraceMessage } from "@3d/shared/net/messages/shotTrace.js";
import { BULLET_RANGE } from "@3d/shared/sim/weaponDef.js";
import type { GameInstance } from "./games.js";
import type { FiredShot } from "./match/shots.js";
import type { NetServer } from "./net/server.js";

/** Send each of the last tick's shots in `game` to whoever fired it. */
export function sendShotTraces(net: NetServer, game: GameInstance): void {
  for (const shot of game.match.shotsThisTick) {
    net.sendTo(game.id, shot.shooter, encodePacket(MessageType.shotTrace, shotTracePacket(shot)));
  }
}

/**
 * One `FiredShot` as the wire carries it. Exported, so a test can assert the
 * mapping without a socket.
 *
 * A round that met nothing reports the weapon's whole range, because the client
 * draws a line and needs a far end; `met: "none"` is what says the far end is
 * open air rather than a surface.
 */
export function shotTracePacket(shot: FiredShot): ShotTraceMessage {
  const result = shot.result;
  return {
    ordinal: shot.ordinal,
    from: shot.from,
    direction: shot.direction,
    distance: result === null ? BULLET_RANGE : result.distance,
    met: result === null ? "none" : result.kind,
  };
}
