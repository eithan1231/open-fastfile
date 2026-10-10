#!/usr/bin/env node
// Render a world from a fixed list of camera poses, for before/after comparison.
//
//   pnpm dev:api &
//   pnpm dev:client --port 5199 --strictPort &
//   pnpm shots worlds/dome-mw3/_shots.json --out before
//   ...change something...
//   pnpm shots worlds/dome-mw3/_shots.json --out after --compare before
//
// Poses come from the app: stand somewhere and press `P` to copy a
// `#slug@x,y,z,yaw,pitch,hold` link. Every pose must carry `hold`, or gravity
// settles the camera differently on each run and the diff measures that.
//
// The api has to be running: the client proxies worlds and assets to it, and a
// bare Vite dev server has none (see docs/server/README.md). The script signs in
// as a bench account first (scripts/signIn.mjs), or a pose lands on the sign-in screen.
//
// Renders on the real GPU through ANGLE (`--software` forces SwiftShader). The
// app logs `[render] renderer: ...`, echoed here, so you can see which you got.
// Needs Chromium once: `npx playwright install chromium`.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { chromium } from "playwright";
import { PNG } from "pngjs";
import { signIn } from "./signIn.mjs";

function parseArgs(argv) {
  const args = {
    shots: undefined,
    out: "shots",
    compare: undefined,
    base: "http://localhost:5199",
    software: false,
    settle: 20,
    stable: 3,
    interval: 3,
    timeout: 180,
    ui: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") {
      args.out = argv[++i];
    } else if (a === "--compare") {
      args.compare = argv[++i];
    } else if (a === "--base") {
      args.base = argv[++i];
    } else if (a === "--settle") {
      args.settle = Number(argv[++i]);
    } else if (a === "--stable") {
      args.stable = Number(argv[++i]);
    } else if (a === "--interval") {
      args.interval = Number(argv[++i]);
    } else if (a === "--timeout") {
      args.timeout = Number(argv[++i]);
    } else if (a === "--ui") {
      args.ui = true;
    } else if (a === "--software") {
      args.software = true;
    } else if (!a.startsWith("--")) {
      args.shots = a;
    }
  }
  if (!args.shots) {
    console.error(
      "usage: shots.mjs <poses.json> [--out DIR] [--compare DIR] [--base URL]\n" +
        "                 [--settle S] [--stable N] [--interval S] [--timeout S] [--ui] [--software]",
    );
    process.exit(1);
  }
  return args;
}

/** Mean absolute per-channel difference and the fraction of pixels that moved at all. */
function comparePng(aPath, bPath) {
  const a = PNG.sync.read(fs.readFileSync(aPath));
  const b = PNG.sync.read(fs.readFileSync(bPath));
  if (a.width !== b.width || a.height !== b.height) {
    return { changed: 1, mean: 255, note: "different size" };
  }
  let changed = 0;
  let total = 0;
  const n = a.width * a.height;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const d = Math.max(Math.abs(a.data[o] - b.data[o]), Math.abs(a.data[o + 1] - b.data[o + 1]), Math.abs(a.data[o + 2] - b.data[o + 2]));
    if (d > 2) {
      changed++;
    }
    total += d;
  }
  return { changed: changed / n, mean: total / n };
}

/**
 * Wait until several consecutive frames are byte-identical. A fixed sleep is not
 * enough: props stream in, instancing runs after them, and the shadow map only
 * re-renders when invalidated, so a shot can land either side of a change. The UI
 * is hidden while sampling, since its readouts change every tick.
 */
async function waitForStableFrame(page, { stable, interval, timeout }) {
  let last;
  let run = 0;
  for (let waited = 0; waited < timeout; waited += interval) {
    const shot = await page.screenshot({ type: "jpeg", quality: 40, scale: "css" });
    const hash = crypto.createHash("sha1").update(shot).digest("hex");
    if (hash === last) {
      if (++run >= stable) {
        return true;
      }
    } else {
      run = 0;
      last = hash;
    }
    await page.waitForTimeout(interval * 1000);
  }
  return false;
}

const args = parseArgs(process.argv.slice(2));

const spec = JSON.parse(fs.readFileSync(args.shots, "utf8"));
const poses = Array.isArray(spec) ? spec : spec.poses;
if (!Array.isArray(poses) || poses.length === 0) {
  console.error(`${args.shots}: expected a JSON array of {name, pose} entries, or {"poses": [...]}`);
  process.exit(1);
}

const missingHold = poses.filter((p) => !String(p.pose).includes("hold"));
if (missingHold.length) {
  console.error(`These poses lack \`hold\`, so they will not reproduce between runs:\n  ${missingHold.map((p) => p.name).join("\n  ")}`);
  console.error("Re-capture with `P` (which always adds it), or append `,hold` to the fragment.");
  process.exit(1);
}

fs.mkdirSync(args.out, { recursive: true });

const browser = await chromium.launch({
  args: args.software
    ? ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]
    : ["--use-gl=angle", "--use-angle=gl", "--enable-gpu", "--ignore-gpu-blocklist", "--disable-gpu-sandbox"],
});
const context = await browser.newContext({ viewport: { width: spec.width ?? 1280, height: spec.height ?? 720 } });
await signIn(context, args.base);
const page = await context.newPage();

const problems = [];
page.on("pageerror", (e) => problems.push(`PAGEERROR ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error") {
    problems.push(m.text());
  }
  if (m.text().startsWith("[render] renderer:")) {
    console.log(`  ${m.text()}`);
  }
});

for (const { name, pose } of poses) {
  const url = `${args.base}/${pose.startsWith("#") ? pose : `#${pose}`}`;
  await page.goto(url, { waitUntil: "networkidle" });
  // The fragment enters the world directly (see app/App.ts), so there is no
  // button to click: just the wait for the scene to build and the first frames.
  await page.waitForTimeout(args.settle * 1000);
  // Hidden for the stability check and, by default, for the shot itself: the
  // debug stats differ on every run, and an unlocked pointer shows the pause menu.
  await page.addStyleTag({ content: `[data-ui-root] { visibility: ${args.ui ? "visible" : "hidden"} !important; }` });
  const settled = await waitForStableFrame(page, args);
  if (!settled) {
    problems.push(`${name}: frame never stabilised within ${args.timeout}s — the shot may not be reproducible`);
  }
  const file = path.join(args.out, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(`  ${name} -> ${file}${settled ? "" : "   (UNSTABLE)"}`);
  // A reload rather than a same-page hash change: the app reads the fragment
  // once at startup, and re-entering the world is what applies the next pose.
  await page.goto("about:blank");
}

await browser.close();

if (problems.length) {
  console.log("\nconsole errors:");
  for (const p of [...new Set(problems)].slice(0, 20)) {
    console.log(`  ${p}`);
  }
}

if (args.compare) {
  console.log(`\n${"pose".padEnd(28)} ${"changed".padStart(9)} ${"mean |d|".padStart(9)}`);
  let worst = 0;
  for (const { name } of poses) {
    const before = path.join(args.compare, `${name}.png`);
    const after = path.join(args.out, `${name}.png`);
    if (!fs.existsSync(before)) {
      console.log(`${name.padEnd(28)} ${"(no baseline)".padStart(19)}`);
      continue;
    }
    const { changed, mean, note } = comparePng(before, after);
    worst = Math.max(worst, changed);
    console.log(`${name.padEnd(28)} ${(changed * 100).toFixed(2).padStart(8)}% ${mean.toFixed(2).padStart(9)}  ${note ?? ""}`);
  }
  console.log(`\nworst: ${(worst * 100).toFixed(2)}% of pixels changed`);
}
