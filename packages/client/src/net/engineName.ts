// Which JavaScript engine this browser is, as a short label for a diagnostic.
//
// It rides in the join and is never acted on. `Math.sin` and `Math.exp` are
// implementation-defined, so a Firefox client and a Chrome one predicting the
// same inputs through the same code diverge microscopically. That is harmless —
// the server is authoritative and a hit box is computed there alone — but it
// shows up as a small systematic drift on one browser and not another, which is
// a ghost somebody would otherwise chase. See `DriftReport` in game-server.
//
// Order matters: every Chromium browser also says "Safari", and Edge says both.

const ENGINES: readonly [string, RegExp][] = [
  ["edge", /\bEdg\//],
  ["opera", /\bOPR\//],
  ["firef", /\bFirefox\//],
  ["chrom", /\bChrom(e|ium)\//],
  ["safar", /\bSafari\//],
];

/** A five-character label, or "" where the agent says nothing recognisable. */
export function engineName(agent: string = navigator.userAgent): string {
  return ENGINES.find(([, pattern]) => pattern.test(agent))?.[0] ?? "";
}
