// SHOTTRACE — a temporary diagnostic (docs/engine/diagnostics-shottrace.md).
// Delete this file with the rest of it.
//
// A new message type is four coordinated edits in packet.ts, and three of the
// four fail loudly if they are missed (`satisfies` on SCHEMAS, and the type of
// `Messages`). The fourth does not: **the numbers are the format**, so inserting
// a type rather than appending one renumbers every message after it and two ends
// on different builds decode each other into plausible nonsense. That is what
// the first case here is for.

import { describe, expect, it } from "vitest";
import { decodePacket, encodePacket, MessageType, UNRELIABLE } from "../src/net/packet.js";
import { shotTraceMessage, type ShotTraceMessage } from "../src/net/messages/shotTrace.js";
import { BitReader, BitWriter } from "../src/net/codec/bits.js";

/** A round that stopped on somebody, from a shooter who is nowhere near an axis. */
const LANDED: ShotTraceMessage = {
  ordinal: 41_337,
  from: { x: 12.5, y: 2.25, z: -87.75 },
  direction: { x: -0.5, y: 0.25, z: -0.828125 },
  distance: 37.5,
  met: "player",
  target: "gTq1-9",
};

function roundTrip(message: ShotTraceMessage): ShotTraceMessage {
  const w = new BitWriter();
  shotTraceMessage.write(w, message);
  return shotTraceMessage.read(new BitReader(w.finish()));
}

describe("the shot trace message", () => {
  it("was appended, so every message that existed before it kept its number", () => {
    expect(MessageType).toEqual({ join: 0, joined: 1, input: 2, snapshot: 3, leave: 4, refused: 5, shotTrace: 6, chooseClass: 7, classChosen: 8 });
  });

  it("is unreliable: a lost diagnostic is a line that is not drawn, never a wrong one", () => {
    expect(UNRELIABLE.has(MessageType.shotTrace)).toBe(true);
  });

  it("carries every field back, and the fields are distinguishable from each other", () => {
    const back = roundTrip(LANDED);
    // Every number here is exact in f32 and different from every other, so a
    // struct written in the wrong order comes back visibly wrong rather than
    // looking like rounding.
    expect(back).toEqual(LANDED);
  });

  it("carries a miss, which is the case a hit marker cannot express at all", () => {
    const missed: ShotTraceMessage = { ...LANDED, distance: 208.03125, met: "none", target: null };
    expect(roundTrip(missed)).toEqual(missed);
    expect(roundTrip({ ...LANDED, met: "world", target: null })).toMatchObject({ met: "world", target: null });
  });

  it("goes through the packet table under its own type byte", () => {
    const bytes = encodePacket(MessageType.shotTrace, LANDED);
    expect(bytes[0]).toBe(MessageType.shotTrace);
    const packet = decodePacket(bytes);
    expect(packet.type).toBe(MessageType.shotTrace);
    expect(packet.message).toEqual(LANDED);
  });

  it("wraps its ordinal at 16 bits, as `WeaponData.fired` does on both ends", () => {
    expect(roundTrip({ ...LANDED, ordinal: 65_535 }).ordinal).toBe(65_535);
    expect(() => roundTrip({ ...LANDED, ordinal: 65_536 })).toThrow(RangeError);
  });
});
