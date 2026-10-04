// What a gametype says out loud, on the side of the seam that both ends share:
// the countdown's schedule, and the shape of the vocabulary a client script has.
//
// The schedule is tested as arithmetic rather than through a match, because that
// is what it is — a script keeps no state, so "which lines does this tick say" is
// a pure function of two numbers and a test can drive it a femtosecond at a time.
// `announce.test.ts` in the game server is the other half: that one proves the
// same script publishes them through a real `Match`.

import { describe, expect, it, vi } from "vitest";
import { countdownScript, secondsCrossed } from "../../src/game/scripts/countdown.js";
import type { ClientContext, ServerContext } from "../../src/game/context.js";
import type { Announcement } from "../../src/game/announcement.js";

const DT = 1 / 60;

/** Every line a whole run of the count says, tick by tick, from the moment somebody joined. */
function wholeCount(dt = DT, seconds = 8): number[][] {
  const out: number[][] = [];
  for (let tick = 1; tick <= Math.round(seconds / dt); tick++) {
    const elapsed = tick * dt;
    const said = secondsCrossed(elapsed - dt, elapsed);
    if (said.length > 0) {
      out.push(said);
    }
  }
  return out;
}

describe("the countdown's schedule", () => {
  it("says one line per second that passes, ending at zero", () => {
    expect(wholeCount()).toEqual([[5], [4], [3], [2], [1], [0]]);
  });

  // The rule `footfallsCrossed` and the reload notetracks already follow: a
  // boundary belongs to exactly one observation, so a repeat is impossible and a
  // gap is too.
  it("gives each boundary to exactly one tick, whatever the rate", () => {
    for (const rate of [20, 30, 60, 128]) {
      expect(wholeCount(1 / rate).flat()).toEqual([5, 4, 3, 2, 1, 0]);
    }
  });

  // A tick that overran, which `FixedRateLoop` does not run back to back: the
  // seconds it stepped over are still said rather than skipped.
  it("says both lines when one tick crosses two seconds", () => {
    expect(secondsCrossed(0.5, 2.5)).toEqual([5, 4]);
  });

  /**
   * The count starts at one second and not at zero: nothing has elapsed at the
   * instant somebody joined, and that instant is where the clock begins rather
   * than a second going by.
   *
   * The femtosecond either side of it is `CLOCK_SNAP`'s business, and the test
   * above is the one that would catch it — 30 Hz and 60 Hz both reconstruct a
   * previous observation just *below* a boundary they already crossed, and said
   * "five" twice before that constant existed.
   */
  it("does not put a line on the instant the count starts", () => {
    expect(secondsCrossed(-1e-15, DT)).toEqual([]);
    expect(secondsCrossed(1e-15, DT)).toEqual([]);
    expect(secondsCrossed(0, 0)).toEqual([]);
  });

  it("stops rather than counting up for the rest of the match", () => {
    expect(secondsCrossed(6, 7)).toEqual([]);
    // An hour in. A loop that counted to `elapsedNow` would run 3,600 times here,
    // every tick, for ever.
    expect(secondsCrossed(3599.98, 3600)).toEqual([]);
  });
});

describe("the countdown's two halves", () => {
  /** A `ServerContext` that is only what this hook reads: the clock, the roster, and `publish`. */
  function serverContext(now: number, since: number[]): { ctx: ServerContext; said: Announcement[] } {
    const said: Announcement[] = [];
    const players = since.map((joined, i) => ({ id: `p${i}`, since: joined }));
    const ctx = { now, players, publish: (event: Announcement) => void said.push(event) } as unknown as ServerContext;
    return { ctx, said };
  }

  it("publishes a name and a number, never an alias", () => {
    const { ctx, said } = serverContext(3, [0]);
    countdownScript.server?.tick?.(ctx, DT);
    expect(said).toEqual([{ what: "countdown", value: 3 }]);
    // Nothing in what crossed is a file, an alias or a channel: the client half
    // is the only thing that knows this is `ui_mp_timer_countdown`.
    expect(JSON.stringify(said)).not.toMatch(/ui_mp|\.webm/);
  });

  it("starts from the earliest join, because that is the only clock a script has", () => {
    // The first player is 3 seconds in; the second arrived a moment ago. The
    // count is the match's, not the newcomer's.
    const { ctx, said } = serverContext(3, [0, 2.9]);
    countdownScript.server?.tick?.(ctx, DT);
    expect(said).toEqual([{ what: "countdown", value: 3 }]);
  });

  it("says nothing while nobody has joined", () => {
    const { ctx, said } = serverContext(3, []);
    countdownScript.server?.tick?.(ctx, DT);
    expect(said).toEqual([]);
  });

  it("turns a name into an alias at the client, and nothing else into anything", () => {
    const heard: [string, string | undefined][] = [];
    const ctx = { say: (alias: string, options?: { channel?: string }) => void heard.push([alias, options?.channel]) } as unknown as ClientContext;

    countdownScript.client?.event?.(ctx, { what: "countdown", value: 3 });
    countdownScript.client?.event?.(ctx, { what: "roundStart" });
    expect(heard).toEqual([
      ["ui_mp_timer_countdown", "ui"],
      ["mp_bonus_start", "voice"],
    ]);

    // Every client hears every announcement, so another gametype's vocabulary
    // reaches this hook and has to be ignored rather than guessed at.
    countdownScript.client?.event?.(ctx, { what: "flagTaken", team: "axis" });
    // And `what` came off the wire: an index into the table would answer
    // `Object.prototype.toString` here and hand `say` a function.
    countdownScript.client?.event?.(ctx, { what: "toString" });
    expect(heard).toHaveLength(2);
  });

  it("names only aliases it declares, so `pnpm catalog` can check them", () => {
    const said = new Set<string>();
    const ctx = { say: (alias: string) => void said.add(alias) } as unknown as ClientContext;
    for (const what of ["countdown", "roundStart"]) {
      countdownScript.client?.event?.(ctx, { what });
    }
    expect([...said].sort()).toEqual([...(countdownScript.sounds ?? [])].sort());
  });
});

/**
 * The narrowness, as a type rather than as a runtime check.
 *
 * "Validate server scripts so a client cannot cheat" is not a validator here, it
 * is a **missing vocabulary** — so the test for it is that the words do not
 * compile. `@ts-expect-error` fails the build if the member ever appears, which
 * is the only way this can be asserted: there is nothing to call at run time.
 */
describe("a client script cannot reach an authority verb", () => {
  it("has no damage, score, setTeam, spawn, publish or send", () => {
    const ctx = {} as ClientContext;
    // @ts-expect-error a client script may not hurt anybody
    expect(ctx.damage).toBeUndefined();
    // @ts-expect-error a client script may not score
    expect(ctx.score).toBeUndefined();
    // @ts-expect-error a client script may not move anybody's side
    expect(ctx.setTeam).toBeUndefined();
    // @ts-expect-error a client script may not place anybody
    expect(ctx.spawn).toBeUndefined();
    // @ts-expect-error a client script may not tell anybody else anything
    expect(ctx.publish).toBeUndefined();
    // @ts-expect-error a client script may not talk to another script
    expect(ctx.send).toBeUndefined();
  });

  it("cannot put the one thing it can do anywhere in the world", () => {
    const say = vi.fn();
    const ctx = { say } as unknown as ClientContext;
    // @ts-expect-error `say` takes an alias and two presentation options; there is
    // no position, so nothing a script says can be placed, panned or attenuated.
    ctx.say("mp_bonus_start", { channel: "voice", position: { x: 1, y: 2, z: 3 } });
    // @ts-expect-error and the channels are feedback's two, not the mixer's five:
    // `sfx`, `footsteps` and `ambience` belong to things that are somewhere.
    ctx.say("mp_bonus_start", { channel: "sfx" });
    expect(say).toHaveBeenCalledTimes(2);
  });
});
