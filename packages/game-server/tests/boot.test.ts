// That a boot which is only *waiting* does not quietly exit instead.
//
// `awaitReady` backs off with @3d/shared/lifecycle's delay, whose timer is
// released on purpose so a loop's period never holds a shutdown open. At boot
// there is nothing else to hold the process: `listen()` has not run, so the
// event loop drains during the first backoff and node exits 13 with the top
// level await still pending. The retry loop reads as if it works and never
// reaches attempt 2 — which is why this spawns the real process rather than
// calling `awaitReady`, where vitest's own event loop would hide it.

import { spawn } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const packageRoot = path.resolve(import.meta.dirname, "..");

/** A port nothing answers on, so boot stays in the retry it is supposed to retry. */
const DEAD_API = "http://127.0.0.1:9";

const FIRST_ATTEMPT = "api not ready (attempt 1/10)";

/** Past the first backoff (1000ms) with margin, and well short of the ten attempts. */
const PAST_FIRST_BACKOFF_MS = 2500;

/** How long tsx may take to start the process; on a loaded machine that alone is seconds. */
const STARTUP_MS = 20_000;

describe("booting against an api that is not up yet", () => {
  it(
    "keeps retrying instead of exiting",
    async () => {
      const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
        cwd: packageRoot,
        env: { ...process.env, API_URL: DEAD_API, NODE_ENV: "development" },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let output = "";
      let saidRetry: () => void = () => {};
      const firstAttempt = new Promise<void>((resolve) => (saidRetry = resolve));
      const onData = (chunk: Buffer) => {
        output += chunk;
        if (output.includes(FIRST_ATTEMPT)) {
          saidRetry();
        }
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);

      const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
      const after = (ms: number) => new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), ms));

      // The backoff is timed from the line announcing it, not from spawn, so a slow
      // start cannot eat the margin the assertion below depends on.
      const announced = await Promise.race([firstAttempt.then(() => "announced" as const), exited, after(STARTUP_MS)]);
      const outcome = announced === "announced" ? await Promise.race([exited, after(PAST_FIRST_BACKOFF_MS)]) : announced;

      child.kill("SIGKILL");

      // It said it would retry, so it has to still be here to do it. Before the
      // boot anchor this exited 13 about a second in, one line after saying so.
      expect(output).toContain(FIRST_ATTEMPT);
      expect(outcome, `exited during boot instead of retrying:\n${output}`).toBe("timeout");
    },
    STARTUP_MS + 10_000,
  );
});
