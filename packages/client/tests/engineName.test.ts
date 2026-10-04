// Which engine a client says it predicts in. A label for a diagnostic, and the
// order of the checks is the whole of it: every Chromium browser also claims to
// be Safari, and Edge claims to be both.

import { describe, expect, it } from "vitest";
import { engineName } from "../src/net/engineName.js";

const CHROME = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0";
const SAFARI = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15";
const EDGE = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0";

describe("the engine a client names", () => {
  it("tells the browsers apart, including the ones wearing each other's names", () => {
    expect(engineName(FIREFOX)).toBe("firef");
    expect(engineName(SAFARI)).toBe("safar");
    // Both of these also say "Safari/537.36", and Edge says "Chrome" as well.
    expect(engineName(CHROME)).toBe("chrom");
    expect(engineName(EDGE)).toBe("edge");
  });

  it("says nothing rather than guessing, and always fits the wire's five characters", () => {
    expect(engineName("some-crawler/1.0")).toBe("");
    for (const agent of [CHROME, FIREFOX, SAFARI, EDGE, ""]) {
      expect(engineName(agent).length).toBeLessThanOrEqual(5);
    }
  });
});
