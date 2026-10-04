// The match counts itself in, out loud: the worked example of a gametype saying
// something, and the first user of `publish` → `event`.
//
// Both halves, and that is the point of it. The server half decides *that* a
// second went by and publishes a name; the client half is the only thing that
// knows what that name sounds like. Neither could be written where the other is:
// a server naming `ui_mp_timer_countdown` would have to know which bank a
// browser built, and a browser deciding when the round starts would be a browser
// deciding.
//
// **Honest about the default gametype.** "Free Roam" has no round: nothing ends
// it, nothing restarts it, and there is no second countdown after this one. What is
// true of it is that a match *began*, and that is exactly what this says — the
// seconds before the first players can reasonably be moving, and then one line
// saying it is on. A gametype with a real round replaces this hook; it does not
// inherit a lie from it.
//
// **It keeps no state**, though a script may (`init`), because it needs none.
// The whole schedule is a function of two numbers it is handed each tick —
// `ctx.now`, the match clock, and the earliest `PlayerView.since`, which is when
// somebody first arrived — so two runs of the same match announce at the same
// ticks and a test can say so without a clock. The cost is written down in `startedAt` below.

import type { Script } from "../hooks.js";
import type { GameView } from "../context.js";

/**
 * How long the count is, seconds. It says one line per second that *passes*, so
 * six seconds is "five, four, three, two, one" and then the round.
 *
 * Six rather than the ten a real lobby counts, because this starts when the
 * *first* player joins rather than when the last one is ready: the others are
 * still loading a map, and there is nothing yet for a longer wait to wait for.
 */
const COUNTDOWN_SECONDS = 6;

/**
 * What this script can say, by the name it publishes.
 *
 * One table read by both halves, so `Script.sounds` — which `pnpm catalog`
 * checks against the banks that were built — cannot drift from what `event`
 * actually asks for. Both are IW5 names and both are in the catalogue because
 * this script asks for them (`scripts/cod/sound.py`'s `FEEDBACK_ALIASES`); on a
 * game whose bank has neither, this is silent, exactly as a Ghosts weapon is.
 */
const SAYS = {
  /** The game's own pre-match tick, `user_interface/ui_mp_countdown_v1`. */
  countdown: "ui_mp_timer_countdown",
  /** The sting the games play when a round is on. */
  roundStart: "mp_bonus_start",
} as const;

/**
 * When the count started, or undefined while nobody is here. Bots are nobody.
 *
 * The earliest join, and nothing more durable is available: a script has nowhere
 * to keep a number, so "the match began" has to be derivable from the view every
 * tick. The cost is that the *first* player leaving mid-count re-anchors it to
 * the next earliest and the count starts again — which is wrong for a round and
 * fine for a match that has not started one. A round clock that survives its
 * players is the first thing per-match script state buys.
 */
function startedAt(view: GameView): number | undefined {
  let earliest: number | undefined;
  for (const player of view.players) {
    // A bot is on the map from the first tick (`matchStart`), before anybody
    // could hear a count: the count is for people.
    if (!player.bot && player.since !== undefined && (earliest === undefined || player.since < earliest)) {
      earliest = player.since;
    }
  }
  return earliest;
}

/**
 * A millisecond of slack, which is what a boundary is compared with.
 *
 * `elapsed` is a difference of two clocks each derived from a tick count, and the
 * previous observation is reconstructed by subtracting one tick from it — so a
 * boundary that is arithmetically exact lands a femtosecond either side of where
 * it belongs. Measured, at 60 Hz and without this: tick 60 says "five" and tick
 * 61 says it again, because `1.0166666666666666 - 1/60` is `0.9999999999999999`.
 * A millisecond is fifteen orders of magnitude above that noise and a sixteenth
 * of the shortest tick anything here runs at, so it can separate the two and
 * cannot reach a real boundary.
 */
const CLOCK_SNAP = 1e-3;

/**
 * The whole seconds this tick crossed, as *seconds remaining*.
 *
 * Half-open at the last observation and closed at this one — `footfallsCrossed`'s
 * rule and the notetracks' — so a boundary sounds exactly once however many ticks
 * straddle it, and a tick long enough to cross two says both. The last one is
 * zero, which is the round starting rather than a number being read out.
 *
 * **The count starts at one second, not at zero.** Nothing has elapsed at the
 * instant the first player joins, and a line sitting exactly on it would be the
 * one boundary no amount of slack can place: it is where the clock begins.
 */
export function secondsCrossed(elapsedBefore: number, elapsedNow: number): number[] {
  // Both ends are whole seconds rather than a loop over the interval: an hour
  // into a match `elapsedNow` is 3,600, and counting up to it every tick would
  // cost more than everything else this script does.
  const first = Math.max(1, Math.floor(elapsedBefore + CLOCK_SNAP) + 1);
  const last = Math.min(COUNTDOWN_SECONDS, Math.floor(elapsedNow + CLOCK_SNAP));
  const out: number[] = [];
  for (let second = first; second <= last; second++) {
    out.push(COUNTDOWN_SECONDS - second);
  }
  return out;
}

export const countdownScript: Script = {
  id: "countdown",
  // Every gametype and every map: a match beginning is not one mode's question,
  // and a gametype with a round of its own is what replaces this rather than
  // something this has to know about.
  sounds: Object.values(SAYS),
  server: {
    tick: (ctx, dt) => {
      const began = startedAt(ctx);
      if (began === undefined) {
        return;
      }
      const elapsed = ctx.now - began;
      for (const left of secondsCrossed(elapsed - dt, elapsed)) {
        // The count itself carries no side: it is nobody's, which is why `team`
        // is absent rather than side 0. `value` is what is left, so one name
        // covers five lines and a HUD reading the same event needs no second one.
        ctx.publish(left > 0 ? { what: "countdown", value: left } : { what: "roundStart" });
      }
    },
  },
  client: {
    event: (ctx, event) => {
      // `hasOwn` rather than an index: `what` came off the wire, and
      // `SAYS["toString"]` would otherwise hand `say` a function.
      if (!Object.hasOwn(SAYS, event.what)) {
        return; // another script's vocabulary; every client hears every announcement
      }
      const alias = SAYS[event.what as keyof typeof SAYS];
      // `ui` for the tick and `voice` for the line, which is the mixer's own
      // split: a player who turns announcements down keeps the blip that tells
      // them the match is moving.
      ctx.say(alias, { channel: event.what === "countdown" ? "ui" : "voice" });
    },
  },
};
