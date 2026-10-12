// Baking an imported world's navigation graph against its real collision: what
// the navBake*.test.ts files share. One file per source game, so vitest runs
// the slow bakes side by side rather than one after another.

import { expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { bakeNav, type NavBakeSummary } from "@3d/shared/nav/bake.js";
import { decodeNav } from "@3d/shared/nav/format.js";
import { components, LINK_ORIGIN, LINK_REASON_NAMES, LINK_STATUS, type NavGraph } from "@3d/shared/nav/graph.js";
import { LINK_FLAGS, LINK_KINDS } from "@3d/shared/nav/vocab.js";
import { TICK_RATE } from "@3d/shared/net/messages/fields.js";
import type { CapsuleWorld } from "@3d/shared/sim/capsule.js";
import { movementRules } from "@3d/shared/sim/worldRules.js";
import type { ResolvedWorld } from "@3d/shared/dsl/resolved.js";
import { loadResolvedWorld } from "@3d/shared/worlds/load.js";
import type { WorldSource } from "@3d/shared/worlds/source.js";
import { buildServerCollision } from "../src/collision.js";

const WORLDS = path.resolve(import.meta.dirname, "../../../worlds");

function dirSource(slug: string): WorldSource {
  const dir = path.join(WORLDS, slug);
  return {
    describe: dir,
    payload: () =>
      Promise.resolve({
        entryPath: "world.world",
        sources: Object.fromEntries(
          fs
            .readdirSync(dir)
            .filter((f) => f.endsWith(".world"))
            .map((f) => [f, fs.readFileSync(path.join(dir, f), "utf8")]),
        ),
      }),
    asset: (rel) => {
      const file = path.join(dir, rel);
      return Promise.resolve(fs.existsSync(file) ? new Uint8Array(fs.readFileSync(file)) : undefined);
    },
  };
}

const catalogFile = (ref: { kind: string; game: string; id: string }, rel: string): Promise<Uint8Array | undefined> => {
  const file = path.join(WORLDS, "catalog", ref.kind, ref.game, ref.id, rel);
  return Promise.resolve(fs.existsSync(file) ? new Uint8Array(fs.readFileSync(file)) : undefined);
};

/** Whether `slug` has been exported with everything a bake reads. */
export function exported(slug: string): boolean {
  return ["assets/collision.glb", "assets/nav.bin", "navigation.world"].every((f) => fs.existsSync(path.join(WORLDS, slug, f)));
}

/**
 * The bakes that cost a minute or more of CPU run only with `NAV_BAKE_ALL=1`, so
 * `pnpm test` stays quick; dome's bake and the bot tests on it always run.
 */
export function heavyBake(slug: string): boolean {
  return process.env.NAV_BAKE_ALL === "1" && exported(slug);
}

/**
 * Of the world's spawn points, how many stand near a node in the graph's largest
 * strongly connected component. A spawn's origin is authored above the floor (on
 * dome, about 2 m) and a player drops from it, so it is grounded first.
 */
export function spawnConnectivity(
  world: ResolvedWorld,
  graph: NavGraph,
  collision: CapsuleWorld,
): { spawns: number; inLargest: number; noNode: number; largest: number } {
  const { component, sizes } = components(graph, "strong");
  const largestId = sizes.indexOf(Math.max(...sizes));
  let inLargest = 0;
  let noNode = 0;
  for (const spawn of world.spawnPoints) {
    const p = spawn.position;
    const floor = collision.groundBelow({ x: p.x, y: p.y + 0.5, z: p.z }, 5) ?? p.y;
    const node = graph.nearestNode({ x: p.x, y: floor, z: p.z }, 1, 8);
    if (node < 0) {
      noNode++;
    } else if (component[node] === largestId) {
      inLargest++;
    }
  }
  return { spawns: world.spawnPoints.length, inLargest, noNode, largest: sizes[largestId]! };
}

/** Whether `slug` is on disk with the collision a movement query reads. */
export function hasCollision(slug: string): boolean {
  return ["world.world", "assets/collision.glb"].every((f) => fs.existsSync(path.join(WORLDS, slug, f)));
}

/** One world off disk with its collision built, as a game server holds it. */
export async function loadCollision(slug: string): Promise<{ world: ResolvedWorld; collision: CapsuleWorld; source: WorldSource }> {
  const source = dirSource(slug);
  const world = (await loadResolvedWorld(source)).world!;
  const collision = (await buildServerCollision(world, source, catalogFile))!.world;
  return { world, collision, source };
}

export async function bake(slug: string): Promise<{ summary: NavBakeSummary; graph: NavGraph; world: ResolvedWorld; collision: CapsuleWorld }> {
  const { world, collision, source } = await loadCollision(slug);
  expect(world.navigation?.source).toBeDefined();
  const file = decodeNav((await source.asset(world.navigation!.source))!);
  const { graph, summary } = bakeNav(file, collision, movementRules(world), { tickRate: TICK_RATE }, () => performance.now());
  return { summary, graph, world, collision };
}

export function report(slug: string, summary: NavBakeSummary, spawns: ReturnType<typeof spawnConnectivity>): void {
  const cpu = summary.cpuMs!;
  console.log(
    [
      `  ${slug}: ${summary.usable}/${summary.nodes} nodes usable ${JSON.stringify(summary.unusable)}, ${summary.nudged} nudged,` +
        ` snap drop median ${summary.snapDrop.median.toFixed(2)} p95 ${summary.snapDrop.p95.toFixed(2)} max ${summary.snapDrop.max.toFixed(2)} m`,
      `    derived: ${summary.derived.pairs} pairs → ${summary.derived.candidates} candidates → ${summary.derived.probed} past the probe → ${summary.derived.valid} valid`,
      `    links: ${summary.valid} valid, ${summary.invalid} invalid ${JSON.stringify(summary.reasons)}`,
      `    traversals: ${JSON.stringify(summary.traversals)}`,
      `    simulated ${summary.simulated} links, ${summary.simulatedTicks} ticks; ${summary.probeSamples} probe samples`,
      `    cpu: snap ${cpu.snap.toFixed(0)} ms, derive+probe ${cpu.derive.toFixed(0)} ms, validate ${cpu.validate.toFixed(0)} ms, total ${cpu.total.toFixed(0)} ms`,
      `    spawns: ${spawns.inLargest}/${spawns.spawns} in the largest strong component (${spawns.largest} nodes), ${spawns.noNode} with no node within 8 m`,
    ].join("\n"),
  );
}

/** What a bake is pinned to: everything but the time it took. */
export function pinned(summary: NavBakeSummary) {
  return {
    usable: summary.usable,
    unusable: summary.unusable,
    derived: summary.derived,
    valid: summary.valid,
    reasons: summary.reasons,
    traversals: summary.traversals,
  };
}

export interface GameWalkLinks {
  all: number;
  valid: number;
  /** Of them, those between two usable nodes: a link from a node with no floor under it says nothing about the follower. */
  betweenUsable: number;
  validBetweenUsable: number;
  /** INVALID ones by LINK_REASON name. */
  reasons: Record<string, number>;
}

/**
 * How the file's own game walk links fared in simulation. A source that ships
 * its links (HAS_GAME_WALK_LINKS) says a character walks each one, so a low
 * rate here is a follower or collision bug passing itself off as bad data.
 */
export function gameWalkLinks(graph: NavGraph): GameWalkLinks {
  const out: GameWalkLinks = { all: 0, valid: 0, betweenUsable: 0, validBetweenUsable: 0, reasons: {} };
  for (let l = 0; l < graph.linkCount; l++) {
    if (graph.origin[l] !== LINK_ORIGIN.FILE || graph.kind[l] !== LINK_KINDS.WALK || !(graph.flags[l]! & LINK_FLAGS.GAME)) {
      continue;
    }
    const valid = graph.status[l] === LINK_STATUS.VALID;
    out.all++;
    out.valid += valid ? 1 : 0;
    if (graph.usable[graph.source[l]!] === 1 && graph.usable[graph.target[l]!] === 1) {
      out.betweenUsable++;
      out.validBetweenUsable += valid ? 1 : 0;
    }
    if (!valid) {
      const name = LINK_REASON_NAMES[graph.reason[l]!] ?? `reason${graph.reason[l]}`;
      out.reasons[name] = (out.reasons[name] ?? 0) + 1;
    }
  }
  console.log(
    `    game walk links: ${out.valid}/${out.all} valid (${((100 * out.valid) / out.all).toFixed(1)}%), ` +
      `${out.validBetweenUsable}/${out.betweenUsable} between usable nodes ` +
      `(${((100 * out.validBetweenUsable) / out.betweenUsable).toFixed(1)}%) ${JSON.stringify(out.reasons)}`,
  );
  return out;
}

/**
 * The plan's guard: on a game that ships its walk links, fewer than this share
 * validating means our follower, not the data, is wrong. Measured, not wished:
 * docs/cod/navigation.md has the rates.
 */
export const GAME_LINK_FLOOR = 0.85;
