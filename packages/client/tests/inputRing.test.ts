// The unacknowledged-input ring, and the one piece of arithmetic in it.
//
// A client predicts ahead of the server and keeps what it has sent, so that a
// correction can be replayed on top of the server's answer. Which inputs are
// still "ours to replay" is decided by comparing a 16-bit counter that wraps, and
// getting that wrong is invisible for eighteen minutes and then catastrophic for
// one frame — every input a client has ever sent looks unacknowledged at once.

import { describe, expect, it } from "vitest";
import { after } from "@3d/shared/net/seq.js";

describe("which inputs are still ours to replay", () => {
  it("is the ordinary answer away from the wrap", () => {
    expect(after(10, 9)).toBe(true);
    expect(after(9, 10)).toBe(false);
    expect(after(500, 1)).toBe(true);
  });

  it("acknowledges an input by its own seq, which is not after itself", () => {
    // The boundary that decides whether the acked input is replayed a second
    // time. It must not be: the server has already applied it.
    expect(after(7, 7)).toBe(false);
    expect(after(0, 0)).toBe(false);
  });

  it("survives the wrap, which a plain `>` does not", () => {
    // Eighteen minutes into a match at 60 Hz. The client is sending seq 3 and the
    // server has acknowledged 65534: three inputs are outstanding, not 65537.
    expect(after(3, 65534)).toBe(true);
    expect(after(65534, 3)).toBe(false);
    expect(after(0, 65535)).toBe(true);
    expect(after(65535, 0)).toBe(false);
  });

  it("reads half the counter as the past and half as the future", () => {
    // The trick only works while the two are within half a period, which two
    // seconds of inputs comfortably are. Asserted so that the assumption is
    // written down rather than discovered.
    expect(after(0x7fff, 0)).toBe(true);
    expect(after(0x8000, 0)).toBe(false);
  });
});
