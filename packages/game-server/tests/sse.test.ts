// The SSE frame parser: the part that goes quietly wrong.
//
// Chunks off a socket do not arrive one event at a time, and every case below is
// one this reader would otherwise get subtly wrong in production rather than
// loudly wrong here.

import { describe, expect, it } from "vitest";
import { createSseParser } from "../src/net/sse.js";

describe("createSseParser", () => {
  it("reads one event", () => {
    expect(createSseParser().push('data: {"type":"hello"}\n\n')).toEqual([{ data: '{"type":"hello"}' }]);
  });

  it("reads several out of one chunk", () => {
    expect(createSseParser().push("data: one\n\ndata: two\n\n")).toEqual([{ data: "one" }, { data: "two" }]);
  });

  it("holds an event that spans chunks", () => {
    const parser = createSseParser();
    expect(parser.push('data: {"ty')).toEqual([]);
    expect(parser.push('pe":"hello"}')).toEqual([]);
    expect(parser.push("\n")).toEqual([]);
    expect(parser.push("\n")).toEqual([{ data: '{"type":"hello"}' }]);
  });

  it("holds a chunk that ends between the \\r and the \\n", () => {
    const parser = createSseParser();
    // The \r may be half of a \r\n, so it cannot be treated as a terminator yet.
    expect(parser.push("data: one\r")).toEqual([]);
    expect(parser.push("\n\r\n")).toEqual([{ data: "one" }]);
  });

  it("takes all three line endings", () => {
    expect(createSseParser().push("data: crlf\r\n\r\n")).toEqual([{ data: "crlf" }]);
    expect(createSseParser().push("data: lf\n\n")).toEqual([{ data: "lf" }]);

    // Lone \r too, but a trailing one is undecidable until the next byte says
    // whether it was half of a \r\n — so it is held rather than guessed at.
    const cr = createSseParser();
    expect(cr.push("data: cr\r\r")).toEqual([]);
    expect(cr.push("data: next\r\r")).toEqual([{ data: "cr" }]);
  });

  it("joins repeated data lines with newlines", () => {
    expect(createSseParser().push("data: one\ndata: two\n\n")).toEqual([{ data: "one\ntwo" }]);
  });

  it("ignores comments, which is what a keep-alive is", () => {
    expect(createSseParser().push(": ping\n\ndata: real\n\n")).toEqual([{ data: "real" }]);
  });

  it("keeps event and id, and ignores fields it has no use for", () => {
    expect(createSseParser().push("event: gameCreate\nid: 7\nretry: 500\ndata: x\n\n")).toEqual([{ event: "gameCreate", id: "7", data: "x" }]);
  });

  it("eats exactly one space after the colon, and no more", () => {
    expect(createSseParser().push("data:  two spaces\n\n")).toEqual([{ data: " two spaces" }]);
    expect(createSseParser().push("data:none\n\n")).toEqual([{ data: "none" }]);
  });

  it("dispatches nothing for an event with no data", () => {
    expect(createSseParser().push("event: empty\n\n")).toEqual([]);
  });

  it("starts a fresh event after each dispatch", () => {
    // Or `event` would leak from one frame into the next.
    expect(createSseParser().push("event: first\ndata: a\n\ndata: b\n\n")).toEqual([{ event: "first", data: "a" }, { data: "b" }]);
  });
});
