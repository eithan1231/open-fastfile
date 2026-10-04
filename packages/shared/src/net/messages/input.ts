// Client → server, every tick: one step's command, what the client says it
// produced, and the few commands before it the server may not have had.

import { array, bool, struct, uint, type Codec } from "../codec/schema.js";
import type { MovementState } from "../../sim/movement.js";
import type { PlayerInput } from "../../sim/input.js";
import { axis, pitch, seconds, unit, yaw } from "./fields.js";
import { movementSchema } from "./player.js";

/**
 * One tick's command, without what identifies it: the part a datagram repeats
 * for the inputs before its newest (`InputPacket.earlier`).
 */
export interface InputStep {
  /** Seconds this input covers. The server clamps it — it is a client's claim about time. */
  dt: number;
  input: PlayerInput;
  /**
   * The server tick the client was drawing other players at when it produced this
   * input — the **low 16 bits** of it.
   *
   * This is what makes lag compensation possible. A client draws peers a tick
   * behind the newest snapshot and interpolated, so it aims at where they *were*;
   * for the server to judge a shot it has to reproduce that, and only the client
   * knows which moment it was looking at.
   *
   * Low bits because the server can recover the rest: the tick named can only be
   * in the recent past, so `current - ((current - renderTick) & 0xffff)` is
   * unambiguous for anything inside 32768 ticks — nine minutes at 60 Hz, against a
   * history one second deep.
   *
   * Per input rather than per tick, which is why it lives here: a tick that drains
   * four queued inputs rewinds four times, each to its own moment — and an input
   * recovered from a later datagram is judged at the moment it was built at.
   */
  renderTick: number;
  /** How far past `renderTick`, in [0, 1). The client's own interpolation factor, in server-tick space. */
  renderFrac: number;
}

/**
 * One input as a server queues and applies it. `seq` is what makes prediction
 * work: the client keeps every input it has sent and, on a correction, replays
 * the ones the server has not acknowledged yet.
 */
export interface InputMessage extends InputStep {
  seq: number;
  /**
   * Where the client says it ended up after applying `input`. The server
   * re-simulates the same input and compares, so this rides inside the input
   * message rather than in one of its own: the claim *is* this `seq`'s result,
   * and nothing has to correlate the two.
   *
   * A claim is never adopted. It is evidence, and a client is free to lie in it.
   * Null for an input recovered from `InputPacket.earlier`, which carries none.
   */
  claim: MovementState | null;
}

/**
 * What a client sends each tick: its newest input with the claim it produced,
 * and the few before it that the server has not acknowledged yet.
 *
 * The data channel is unordered and never retransmits, so a datagram lost is an
 * input lost — and the server would never step it. Repeating the last few makes
 * one loss cost nothing; the server takes each `seq` once (`Match.receive`).
 */
export interface InputPacket extends InputStep {
  /** The newest input's. `earlier[i]` is `seq - earlier.length + i`, so theirs are not sent. */
  seq: number;
  claim: MovementState;
  /** Oldest first, at most `REDUNDANT_INPUTS`. No claims: drift is measured on the newest. */
  earlier: InputStep[];
}

/**
 * How many earlier inputs a datagram repeats. Two survives any two consecutive
 * losses — 33 ms of a dropped link at 60 Hz — and three in a row at a 5% loss
 * rate is one input in 8000. Each costs 91 bits, and a datagram's worth then
 * stays inside `MAX_INPUTS_PER_TICK`'s four, so a recovered gap drains in a tick.
 */
export const REDUNDANT_INPUTS = 2;

/** The inputs one packet carries, oldest first, each with its own seq. */
export function inputsOf(packet: InputPacket): InputMessage[] {
  const n = packet.earlier.length;
  const out: InputMessage[] = packet.earlier.map((step, i) => ({ ...step, seq: (packet.seq - n + i) & 0xffff, claim: null }));
  out.push({ seq: packet.seq, dt: packet.dt, input: packet.input, claim: packet.claim, renderTick: packet.renderTick, renderFrac: packet.renderFrac });
  return out;
}

export const inputSchema = struct({
  yaw,
  pitch,
  forward: axis,
  right: axis,
  run: bool,
  jump: bool,
  fire: bool,
  ads: bool,
  reload: bool,
  swap: bool,
  use: bool,
}) satisfies Codec<PlayerInput>;

/**
 * 8 bits is 1/256 of a tick — 65 µs at 60 Hz, against a sprinting player's
 * ~0.1 m per tick. Far finer than the thing it is used to place.
 */
const renderFrac = unit;

const inputStep = struct({
  dt: seconds,
  input: inputSchema,
  renderTick: uint(16),
  renderFrac,
}) satisfies Codec<InputStep>;

export const inputMessage = struct({
  /** Wraps. A client sending 60 a second takes 18 minutes to come back around, and only unacknowledged ones are compared. */
  seq: uint(16),
  dt: seconds,
  input: inputSchema,
  claim: movementSchema,
  renderTick: uint(16),
  renderFrac,
  /** Two bits of count: room for three, though a client sends `REDUNDANT_INPUTS`. */
  earlier: array(inputStep, 2),
}) satisfies Codec<InputPacket>;

/**
 * A player's input as it will arrive at the server. The symmetry rule in
 * net/packet.ts: a client predicts with this, not with what it measured.
 */
export function roundInput(input: PlayerInput): PlayerInput {
  return inputSchema.round!(input);
}

/** The same, for the `dt` a client claims alongside it. */
export function roundDt(dt: number): number {
  return seconds.round!(dt);
}

/**
 * The same again, for the moment a client says it was aiming at.
 *
 * The symmetry rule reaches a field the client does not *step* but does *trace*
 * with: a client predicting its own shot must use the fraction the server will
 * decode, or the two disagree about where the target was by whatever the
 * quantization invented.
 */
export function roundRenderFrac(frac: number): number {
  return renderFrac.round!(frac);
}
