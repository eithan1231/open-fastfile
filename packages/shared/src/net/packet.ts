// What client and server say to each other, and the bytes they say it in.
//
// Definitions only — no transport. The client's socket and the server's
// geckos.io channel both send these packets, so the two cannot drift; neither
// end may import the other's networking code.
//
// The format is raw binary, bit-packed. A packet is a one-byte MessageType
// followed by that message's fields in declaration order. There are no keys on
// the wire and no self-description: both ends agree because they run the same
// schema, which is what PROTOCOL_VERSION is for.
//
// Three layers, and the split is the point:
//
//   codec/     the mechanism — bits in and out of a buffer, and the field types
//              a message can be described with. Knows nothing about this game.
//   messages/  the descriptions — one file per message, plus the field budgets
//              (fields.ts) and the simulation state a snapshot carries
//              (player.ts). No buffers here, only what a message is made of.
//   packet.ts  this file: which type byte is which message, and the encode and
//              decode a transport calls.
//
// -- The symmetry rule -------------------------------------------------------
//
// Several fields are quantized, which is lossy. That matters here in a way it
// would not in a chat protocol: this is a server-authoritative game, so a client
// predicts its own movement and the server re-simulates the same input to check
// it. If a client steps `yaw = 1.23456789` and the server replays the decoded
// `yaw = 1.2345`, the two diverge over an error the *encoding* invented, and
// prediction spends the rest of the match correcting a mistake nobody made.
//
// So: a sender rounds a quantized field to its wire value BEFORE simulating with
// it. `roundInput` (messages/input.ts) is that, and engine/controls/firstPerson.ts
// calls it on every tick's input before stepping — online or not, so that being
// connected never changes how the game plays.
//
// Positions and velocities are f32 and so also lossy against the f64 the
// simulation runs in, but they need no such discipline: they are authoritative
// state a client *adopts* whole from a snapshot, not a value both ends derive
// independently, so the rounding is absorbed by the next snapshot instead of
// accumulating. The same goes for `InputMessage.claim`, which the server compares
// against and never adopts: it is measured with a tolerance, not replayed.

import { BitReader, BitWriter } from "./codec/bits.js";
import type { Codec } from "./codec/schema.js";
import { inputMessage, type InputPacket } from "./messages/input.js";
import { snapshotMessage, type SnapshotMessage } from "./messages/snapshot.js";
// SHOTTRACE (docs/engine/diagnostics-shottrace.md)
import { shotTraceMessage, type ShotTraceMessage } from "./messages/shotTrace.js";
import {
  chooseClassMessage,
  classChosenMessage,
  joinedMessage,
  joinMessage,
  refusedMessage,
  type ChooseClassMessage,
  type ClassChosenMessage,
  type JoinedMessage,
  type JoinMessage,
  type RefusedMessage,
} from "./messages/session.js";

/**
 * Bumped whenever a layout under messages/ changes — including a reordering that
 * leaves every type the same, since field order *is* the format. Ends that
 * disagree must refuse each other rather than guess: JSON failed a mismatch
 * loudly, and this does not. A wrong version decodes into plausible nonsense.
 */
export const PROTOCOL_VERSION = 34;

/**
 * The leading byte of every packet. These are the old channel names: a raw
 * datagram says what it is itself, so the transport underneath does not have to
 * (geckos' named channels become one raw channel). The numbers are the format —
 * append, never renumber.
 */
export const MessageType = {
  join: 0,
  joined: 1,
  input: 2,
  snapshot: 3,
  // 4 is unassigned, and stays so: a number is never reused.
  refused: 5,
  // SHOTTRACE: appended, so every number above is the one it has always been.
  shotTrace: 6,
  chooseClass: 7,
  classChosen: 8,
} as const;

export type MessageType = (typeof MessageType)[keyof typeof MessageType];

interface Messages {
  [MessageType.join]: JoinMessage;
  [MessageType.joined]: JoinedMessage;
  [MessageType.input]: InputPacket;
  [MessageType.snapshot]: SnapshotMessage;
  [MessageType.refused]: RefusedMessage;
  [MessageType.shotTrace]: ShotTraceMessage; // SHOTTRACE
  [MessageType.chooseClass]: ChooseClassMessage;
  [MessageType.classChosen]: ClassChosenMessage;
}

const SCHEMAS = {
  [MessageType.join]: joinMessage,
  [MessageType.joined]: joinedMessage,
  [MessageType.input]: inputMessage,
  [MessageType.snapshot]: snapshotMessage,
  [MessageType.refused]: refusedMessage,
  [MessageType.shotTrace]: shotTraceMessage, // SHOTTRACE
  [MessageType.chooseClass]: chooseClassMessage,
  [MessageType.classChosen]: classChosenMessage,
} as const satisfies { [K in MessageType]: Codec<Messages[K]> };

/** A decoded packet, discriminated so a `switch` on `type` narrows `message`. */
export type Packet = { [K in MessageType]: { type: K; message: Messages[K] } }[MessageType];

export function encodePacket<K extends MessageType>(type: K, message: Messages[K]): Uint8Array {
  const w = new BitWriter();
  w.bits(type, 8);
  (SCHEMAS[type] as Codec<Messages[K]>).write(w, message);
  return w.finish();
}

/**
 * Throws on anything malformed — an unknown type byte, a truncated payload, a
 * string that is not UTF-8. Callers catch and drop the packet; a datagram off
 * the network is untrusted input, and the alternative to throwing is decoding
 * garbage into a player's position.
 */
export function decodePacket(bytes: Uint8Array): Packet {
  const r = new BitReader(bytes);
  const type = r.bits(8) as MessageType;
  const schema = SCHEMAS[type] as Codec<Messages[MessageType]> | undefined;
  if (!schema) {
    throw new RangeError(`unknown message type ${type}`);
  }
  return { type, message: schema.read(r) } as Packet;
}
