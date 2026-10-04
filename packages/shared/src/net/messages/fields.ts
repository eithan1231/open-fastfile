// The field budgets every message is built from.
//
// Each of these is two claims: what range a quantity really has, and how finely
// it is worth carrying. They live together rather than inline at each use so
// that the claims can be read, and argued with, as a set — and so that two
// messages carrying the same quantity cannot disagree about it.
//
// Quantized fields are lossy; net/packet.ts explains the rule that makes that
// safe in a predict-and-replay loop.

import { angle, f32, quant, quat as quatCodec, signed, str, struct, type Codec, type Quat } from "../codec/schema.js";
import type { Vec3 } from "../../sim/movement.js";
import { COMBAT_TIMER_MAX } from "../../sim/player.js";

/** Server-assigned, unique for a session. Not a database id. */
export type PlayerId = string;

/**
 * An id is short and ASCII in practice (geckos hands out a channel id), so one
 * length byte is plenty. It is still the single most expensive field in a
 * snapshot: a per-match slot number would cost 8 bits rather than ~72.
 */
export const playerId = str(8);

/**
 * What every bot's id starts with. `#` is outside the api's player-id alphabet
 * (api/src/matchmaking/ids.ts), so a bot a game server mints can never collide
 * with a player the api admitted, and either end can tell one from the other.
 */
export const BOT_ID_PREFIX = "#b";

/** Whether this player is a bot a game server is driving rather than somebody the api admitted. */
export function isBotId(id: PlayerId): boolean {
  return id.startsWith(BOT_ID_PREFIX);
}

/** The `n`th bot of a match: `#b` and `n` in base 36, which stays within 8 characters to 36^6. */
export function botId(n: number): PlayerId {
  return BOT_ID_PREFIX + n.toString(36);
}

/** 0.005°, well under what a mouse resolves and far under what a player perceives. */
export const yaw = angle(16);
export const pitch = angle(16);

/**
 * A stick or key axis, -1..1. 8 bits is ~0.008, finer than a keyboard's three
 * values need — and `signed` rather than `quant` because standing still has to
 * encode as an exact zero, which a symmetric `quant` cannot do at any width.
 */
export const axis = signed(8);

/** Metres and m/s. Kept as full floats: a world's extent is not something to pin down here. */
export const metres = f32;

/**
 * A rotation, 32 bits, smallest-three. Re-exported here rather than reached for in
 * `codec/` directly, so that every field budget is still readable as one set.
 */
export const quat: Codec<Quat> = quatCodec;
export type { Quat } from "../codec/schema.js";

/** A tick's length. The cap is generous — the server clamps `dt` anyway, since it is a client's claim about time. */
export const seconds = quant(0, 0.25, 12);

/**
 * The default fixed tick, hertz, and the step it implies. Both ends run a fixed
 * tick so that friction and gravity integrate over the same steps; at a variable
 * frame time they drift apart over an error nobody chose.
 *
 * This is only the default. A server's real rate reaches a client in
 * `JoinedMessage.tickRate`, and the client accumulates to whatever it is told.
 */
export const TICK_RATE = 60;
export const TICK_DT = 1 / TICK_RATE;

/**
 * The short movement timers: coyote time, the jump buffer, the landing slowdown,
 * the time since a jump (which stops counting at half a second), and the time
 * left of a mantle. Everything measured by one must stay under a
 * second — `tests/movement.test.ts` asserts that of the mantle, which is the
 * only one long enough to be worth checking.
 */
export const shortTimer = quant(0, 1, 8);

/** A mantle's climb height, m. The tallest the games animate is 1.45 m; 8 bits is under a centimetre. */
export const climb = quant(0, 2, 8);

/**
 * The two combat clocks: time since the last hit, and time left of a respawn.
 *
 * A second budget rather than `shortTimer` because neither fits in one second —
 * regeneration waits about five — and `weaponTimer`'s sixteen would buy nothing
 * either clock can use. The range is `COMBAT_TIMER_MAX`, which the simulation
 * clamps both to, so the value held is the value carried; 8 bits over it is
 * 39 ms, under three ticks, and neither number is acted on by a client at all.
 */
export const combatTimer = quant(0, COMBAT_TIMER_MAX, 8);

/** A weapon's state timer: the longest is a reload, comfortably under 16 s. */
export const weaponTimer = quant(0, 16, 12);

/** 0 (hip) to 1 (in the sights). */
export const unit = quant(0, 1, 8);

export const vec3: Codec<Vec3> = struct({ x: metres, y: metres, z: metres });
