#!/usr/bin/env node
// Measure what a world costs to load and to draw, for before/after comparison.
//
//   pnpm dev                                  (or dev:api + a client on --base)
//   pnpm perf worlds/theater-bo1/_shots.json --out before.json
//   ...change something...
//   pnpm perf worlds/theater-bo1/_shots.json --compare before.json
//
// Each pose is measured in a browser of its own, so no shader compiled for one
// is cached for the next. Per pose:
//
// - load: navigation to the app's `[load]` line, and its slowest steps;
// - stall: the longest frame in the first STALL_WINDOW after load, and how many
//   shader programs were compiled after the prewarm — work that lands on frames;
// - steady: frame times with vsync off, after the stall window;
// - draws: draw calls and triangles in one frame, every pass counted.
//
// Headless numbers are only comparable with each other, on one machine. A pose
// needs `hold`, as for `pnpm shots`, so every run renders the same view.

// `instrument` and the `evaluate` callbacks are serialised into the page and run there.
/* global window, EventTarget, performance, requestAnimationFrame */

import fs from "node:fs";
import { chromium } from "playwright";
import { signIn } from "./signIn.mjs";

const STALL_WINDOW = 3000;

function parseArgs(argv) {
  const args = { target: undefined, base: "http://localhost:5173", seconds: 8, out: undefined, compare: undefined, software: false, timeout: 180 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--base") {
      args.base = argv[++i];
    } else if (a === "--seconds") {
      args.seconds = Number(argv[++i]);
    } else if (a === "--out") {
      args.out = argv[++i];
    } else if (a === "--compare") {
      args.compare = argv[++i];
    } else if (a === "--timeout") {
      args.timeout = Number(argv[++i]);
    } else if (a === "--software") {
      args.software = true;
    } else if (!a.startsWith("--")) {
      args.target = a;
    }
  }
  if (!args.target) {
    console.error(
      "usage: perf.mjs <poses.json | slug@x,y,z,yaw,pitch,hold> [--base URL] [--seconds N]\n                [--out FILE.json] [--compare FILE.json] [--timeout S] [--software]",
    );
    process.exit(1);
  }
  return args;
}

function posesOf(target) {
  if (!target.endsWith(".json")) {
    return [{ name: target.split("@")[0], pose: target }];
  }
  const spec = JSON.parse(fs.readFileSync(target, "utf8"));
  return Array.isArray(spec) ? spec : spec.poses;
}

/** Runs in the page before the app: watches three through its devtools hook, and times every frame. */
function instrument() {
  const seen = [];
  const hook = new EventTarget();
  hook.addEventListener("observe", (e) => seen.push(e.detail));
  window.__THREE_DEVTOOLS__ = hook;
  const renderer = () => seen.find((o) => o && o.info && o.info.programs);
  const state = { loaded: undefined, programsAtLoad: 0, frames: [] };
  window.__perf = state;
  window.__perfRenderer = renderer;

  const info = console.info;
  console.info = (...a) => {
    if (String(a[0]).startsWith("[load]")) {
      state.loadLine = String(a[0]);
      state.loaded = performance.now();
      state.programsAtLoad = renderer()?.info.programs.length ?? 0;
    }
    info(...a);
  };
  let last = performance.now();
  const tick = (now) => {
    if (state.loaded !== undefined) {
      state.frames.push([now - state.loaded, now - last]);
    }
    last = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function percentile(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

async function measure(pose, args) {
  const browser = await chromium.launch({
    args: args.software
      ? ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]
      : [
          "--use-gl=angle",
          "--use-angle=gl",
          "--enable-gpu",
          "--ignore-gpu-blocklist",
          "--disable-gpu-sandbox",
          "--disable-frame-rate-limit",
          "--disable-gpu-vsync",
        ],
  });
  try {
    const context = await browser.newContext({ viewport: { width: 1680, height: 900 } });
    await signIn(context, args.base);
    const page = await context.newPage();
    await page.addInitScript(instrument);
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const started = Date.now();
    await page.goto(`${args.base}/${pose.startsWith("#") ? pose : `#${pose}`}`);
    await page.waitForFunction(() => window.__perf?.loaded !== undefined, null, { timeout: args.timeout * 1000 });
    const loadMs = Date.now() - started;
    await page.waitForTimeout(STALL_WINDOW + args.seconds * 1000);

    const r = await page.evaluate(() => {
      const s = window.__perf;
      const info = window.__perfRenderer()?.info;
      return {
        line: s.loadLine,
        programsAtLoad: s.programsAtLoad,
        programs: info?.programs.length ?? 0,
        calls: info?.render.calls ?? 0,
        triangles: info?.render.triangles ?? 0,
        frames: s.frames,
      };
    });
    const early = r.frames.filter(([at]) => at < STALL_WINDOW).map(([, d]) => d);
    const steady = r.frames.filter(([at]) => at >= STALL_WINDOW).map(([, d]) => d);
    const sorted = [...steady].sort((a, b) => a - b);
    const steps = Object.fromEntries([...r.line.matchAll(/([a-z][a-z ]*?) (\d+)ms/g)].map((m) => [m[1].trim(), Number(m[2])]));
    return {
      loadMs,
      steps,
      stallMs: Math.round(Math.max(0, ...early)),
      lateProgramsCompiled: r.programs - r.programsAtLoad,
      programs: r.programs,
      fps: steady.length ? Number(((1000 * steady.length) / steady.reduce((a, b) => a + b, 0)).toFixed(1)) : 0,
      p50Ms: steady.length ? Number(percentile(sorted, 0.5).toFixed(1)) : 0,
      p95Ms: steady.length ? Number(percentile(sorted, 0.95).toFixed(1)) : 0,
      drawCalls: r.calls,
      triangles: r.triangles,
      errors,
    };
  } finally {
    await browser.close();
  }
}

const KEYS = [
  ["loadMs", "load ms"],
  ["stallMs", "stall ms"],
  ["lateProgramsCompiled", "late programs"],
  ["fps", "fps"],
  ["p50Ms", "p50 ms"],
  ["p95Ms", "p95 ms"],
  ["drawCalls", "draws"],
  ["triangles", "triangles"],
];

const args = parseArgs(process.argv.slice(2));
const baseline = args.compare ? JSON.parse(fs.readFileSync(args.compare, "utf8")) : {};
const results = {};
for (const { name, pose } of posesOf(args.target)) {
  const m = await measure(pose, args);
  results[name] = m;
  const before = baseline[name];
  console.log(`\n${name}`);
  for (const [key, label] of KEYS) {
    const delta = before ? `   (was ${before[key]})` : "";
    console.log(`  ${label.padEnd(14)} ${String(m[key]).padStart(9)}${delta}`);
  }
  const slowest = Object.entries(m.steps)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([k, v]) => `${k} ${v}`)
    .join(" · ");
  console.log(`  slowest steps  ${slowest}`);
  for (const e of m.errors.slice(0, 5)) {
    console.log(`  PAGEERROR ${e}`);
  }
}
if (args.out) {
  fs.writeFileSync(args.out, JSON.stringify(results, null, 2) + "\n");
  console.log(`\nwrote ${args.out}`);
}
