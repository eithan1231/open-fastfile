// The navigation view: the graph bots walk, baked in this browser from the
// world's `nav.bin` against this client's collision — the game server's bake,
// run in slices a frame — so there is nothing for a server to send and nothing
// to pay until someone looks.

import { basePresence } from "@3d/shared/worlds/presence.js";
import { decodeNav } from "@3d/shared/nav/format.js";
import { linksThroughParts } from "@3d/shared/nav/parts.js";
import { movementRules } from "@3d/shared/sim/worldRules.js";
import { describeNode, NavView } from "../../engine/navView.js";
import { worldFileUrl } from "../../scene/assetUrl.js";
import { worldBaseUrl } from "../worldFetch.js";
import type { DevContext } from "./context.js";

/**
 * The navigation bake's share of a frame, ms. A few, so the page stays
 * responsive: dome's five seconds of bake take about twenty at 60 fps. A slice
 * stops between links, so one long link can overrun it (navigation.md, "Budgets").
 */
const NAV_SLICE_MS = 4;

/** Where the nearest node is looked for around the player, for the stats line, m. */
const NAV_NEAR = { dy: 2, reach: 4 };

export class NavDebug {
  private readonly view = new NavView();
  /** Moves on every load and reset, so a `nav.bin` that arrives for a world since left is dropped. */
  private generation = 0;
  /** The live presence's version the shut links were last marked for. */
  private presenceSeen = 0;
  /** The links each solid shuts in the baked graph, by solid index. */
  private partLinks: readonly (readonly number[])[] = [];
  /** What the stats line says while there is no graph to describe: loading, or why there is none. */
  private note: string | null = null;

  constructor(private readonly ctx: DevContext) {
    ctx.viewer.roots.keep(this.view.nodeObject, this.view.linkObject);
  }

  get visible(): boolean {
    return this.view.visible;
  }

  /** Cycle: off, the graph bots walk, and the graph with every link the bake turned down. */
  toggle(): void {
    const next = this.view.nextMode();
    this.view.setMode(next);
    if (next === "off") {
      this.ctx.toaster.show("navigation off");
      return;
    }
    if (this.view.state === "empty" && this.note === null) {
      this.load();
    }
    const state = this.view.state;
    this.ctx.toaster.show(
      this.note && state !== "baking"
        ? `navigation: ${this.note}`
        : next === "graph"
          ? `navigation: the graph${state === "ready" ? "" : " (baking — nodes are where the file puts them until it is done)"}`
          : "navigation: everything, with the links the bake turned down (press K again for off)",
    );
  }

  /** A new world: baked against the collision just replaced, so baked again, and only if someone is looking. */
  afterBuild(): void {
    this.forget();
    if (this.view.visible) {
      this.load();
    }
  }

  reset(): void {
    this.view.setMode("off");
    this.forget();
  }

  update(): void {
    const presence = this.ctx.live.presence;
    if (presence.version !== this.presenceSeen && this.partLinks.length > 0) {
      this.showPartBlockers();
    }
    this.presenceSeen = presence.version;
    // Only while it is shown: turning the view off pauses a bake, it does not drop it.
    if (this.view.visible && this.view.update(() => performance.now(), NAV_SLICE_MS)) {
      this.baked();
    }
  }

  /** The stats line's readings: how far the bake is, or the graph and the node nearest `p`. */
  stats(p: { x: number; y: number; z: number }): string[] {
    const state = this.view.state;
    if (state === "failed") {
      return [`nav bake failed: ${this.view.failure}`];
    }
    if (state === "baking") {
      return [`baking nav… ${Math.floor(this.view.progress * 100)}%`];
    }
    const graph = this.view.graph;
    if (!graph) {
      return [`nav: ${this.note ?? "none"}`];
    }
    const s = this.view.summary!;
    // The node you stand by, with why each of its links out is invalid: the
    // answer to "why will a bot not go there?" without picking a line.
    const near = graph.nearestNode(p, NAV_NEAR.dy, NAV_NEAR.reach);
    return [`nav ${s.usable}/${s.nodes} nodes, ${s.valid.toLocaleString()} links`, near < 0 ? "no node near" : describeNode(graph, near)];
  }

  private forget(): void {
    this.generation++;
    this.view.clear();
    this.note = null;
    this.partLinks = [];
  }

  /** Fetch the world's `nav.bin` and start baking it. */
  private load(): void {
    const { world, slug, assets } = this.ctx.current;
    const source = world?.navigation?.source;
    if (!world || !slug || !assets || !source) {
      this.note = "this world declares none";
      console.info("[nav] this world has no `navigation { source: }` — bots here stand still (docs/engine/navigation.md)");
      return;
    }
    const generation = ++this.generation;
    this.note = "loading";
    const tickRate = this.ctx.firstPerson.tickRate;
    void assets.bytes(worldFileUrl(source, worldBaseUrl(slug))).then((bytes) => {
      if (generation !== this.generation) {
        return; // the world was left or reloaded while this was on its way
      }
      if (!bytes) {
        this.note = `could not fetch ${source}`;
        return;
      }
      let file;
      try {
        file = decodeNav(bytes);
      } catch (err) {
        this.note = `${source} would not decode`;
        console.warn(`[nav] ${source}: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      this.note = null;
      // Against the base, every part absent, as a game server bakes it (nav/parts.ts).
      this.view.bake(file, this.ctx.collision.view(basePresence(world)), movementRules(world), tickRate, performance.now());
      console.info(
        `[nav] ${file.nodes.count.toLocaleString()} nodes, ${file.links.count.toLocaleString()} links in ${source}: baking at ${tickRate} Hz, ${NAV_SLICE_MS} ms a frame`,
      );
    });
  }

  /** Mark the links the present parts shut, as a game server's match holds them. */
  private showPartBlockers(): void {
    const presence = this.ctx.live.presence;
    this.view.setShut(new Set(this.partLinks.flatMap((links, i) => (presence.has(i) ? links : []))));
  }

  /** The bake just finished: say what it found, and what each colour means. */
  private baked(): void {
    const s = this.view.summary!;
    const graph = this.view.graph;
    const world = this.ctx.current.world;
    if (graph && world) {
      const { collision } = this.ctx;
      const parts = world.solids.map((_, i) => {
        const bounds = collision.partBounds(i);
        return bounds && { min: bounds.min, max: bounds.max, world: collision.partView(i) };
      });
      this.partLinks = linksThroughParts(graph, collision.view(basePresence(world)), parts);
      this.showPartBlockers();
    }
    const cpu = s.cpuMs ? `${Math.round(s.cpuMs.total).toLocaleString()} ms of slices` : "";
    const wall = this.view.wallMs === null ? "" : ` over ${(this.view.wallMs / 1000).toFixed(1)} s`;
    this.ctx.toaster.show(`navigation: ${s.usable}/${s.nodes} nodes usable, ${s.valid.toLocaleString()} links valid, ${s.invalid.toLocaleString()} invalid`);
    console.info(
      `[nav] baked: ${s.usable}/${s.nodes} nodes usable, ${s.valid.toLocaleString()} links valid, ${s.invalid.toLocaleString()} invalid; ${cpu}${wall}`,
    );
    const legend = this.view.legend();
    if (!legend) {
      return;
    }
    const hex = (colour: number) => `#${colour.toString(16).padStart(6, "0")}`;
    for (const { label, colour, count } of legend.nodes) {
      console.info(`  node  ${label.padEnd(26)} ${count.toLocaleString().padStart(7)}  ${hex(colour)}`);
    }
    for (const { label, colour, count } of legend.links) {
      console.info(`  link  ${label.padEnd(26)} ${count.toLocaleString().padStart(7)}  ${hex(colour)}`);
    }
    const reasons = Object.entries(legend.reasons);
    if (reasons.length) {
      console.info(`  invalid by reason: ${reasons.map(([name, n]) => `${name} ${n.toLocaleString()}`).join(", ")}`);
    }
  }
}
