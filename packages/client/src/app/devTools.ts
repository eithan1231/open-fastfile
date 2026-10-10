// Development tools: the inspector (pick and highlight what is under the cursor),
// collider view, the hit box view, the navigation view, the sun marker, hiding
// every model, pose capture, and the stats readout. What they show goes to the
// UI through `UiState.debug`.

import * as THREE from "three";
import type { ResolvedWorld } from "@3d/shared/dsl/resolved.js";
import { ColliderView } from "../engine/colliderView.js";
import { HitboxView, type SidecarSource } from "../engine/hitboxView.js";
import { MantleView } from "../engine/mantleView.js";
import { describeNode, NavView } from "../engine/navView.js";
import { worldFileUrl } from "../scene/assetUrl.js";
import { decodeNav } from "@3d/shared/nav/format.js";
import { movementRules } from "@3d/shared/sim/worldRules.js";
// SHOTTRACE (docs/engine/diagnostics-shottrace.md)
import { ShotTraceView } from "../engine/shotTraceView.js";
import type { ShotTraceMessage } from "@3d/shared/net/messages/shotTrace.js";
import type { CollisionView, CollisionWorld, DebugSurface } from "@3d/shared/collision/world.js";
import { basePresence } from "@3d/shared/worlds/presence.js";
import { linksThroughParts } from "@3d/shared/nav/parts.js";
import type { FirstPersonControls } from "../engine/controls/firstPerson.js";
import { ScenePicker, type Pick } from "../engine/picking.js";
import { formatPose, poseFrom } from "../engine/pose.js";
import { SunView } from "../engine/sunView.js";
import { SurfaceView } from "../engine/surfaceView.js";
import type { Viewer } from "../engine/viewer.js";
import type { DrawnBody } from "../net/remotePlayers.js";
import type { PickInfo, UiState } from "./uiBridge.js";
import { worldBaseUrl } from "./worldLoader.js";

export type ViewMode = "walk" | "dollhouse";

/** Seconds between hover picks while the inspector is open: a pick is a raycast over the whole scene. */
const HOVER_INTERVAL = 1 / 15;

/** Seconds between stats updates. Nobody reads a readout faster, and each one re-renders its panel. */
const STATS_INTERVAL = 0.1;

/** How far a press may move and still count as a click rather than an orbit drag, in pixels. */
const CLICK_SLOP = 4;

/**
 * The navigation bake's share of a frame, ms. A few, so the page stays
 * responsive: dome's five seconds of bake take about twenty at 60 fps. A slice
 * stops between links, so one long link can overrun it (navigation.md, "Budgets").
 */
const NAV_SLICE_MS = 4;

/** Where the nearest node is looked for around the player, for the stats line, m. */
const NAV_NEAR = { dy: 2, reach: 4 };

interface Deps {
  viewer: Viewer;
  collision: CollisionWorld;
  /** The collision as the match has it: what a player steps and traces against. */
  live: CollisionView;
  firstPerson: FirstPersonControls;
  ui: UiState;
  toast: (text: string) => void;
  root: () => THREE.Object3D | undefined;
  world: () => ResolvedWorld | undefined;
  mode: () => ViewMode;
  slug: () => string | undefined;
  /** The viewmodel's state, if one is held. */
  viewmodel: () => string | undefined;
  /** Voices sounding now, out of the world's placements. A thunk, like `root` and `world`. */
  audio: () => { voices: number; placements: number };
  /**
   * The peers standing now, each on the rig the last frame posed.
   *
   * A thunk rather than `RemotePlayers` itself, for the reason `root` and `world`
   * are thunks: what this reaches for changes under it, and the debug layer has no
   * business holding the transport. It is also what keeps `net/` from naming a
   * debug view — what it hands over is a fact about the frame just drawn.
   */
  bodies: () => readonly DrawnBody[];
  /**
   * The session's asset store, narrowed to the calls the hit box and navigation
   * views make of it. A sidecar or a `nav.bin` is an asset: keyed by the URL it
   * came from, and freed with the world that wanted it. Undefined before a world
   * is mounted.
   */
  assets: () => (SidecarSource & NavSource) | undefined;
}

/** Where the navigation view reads a world's `nav.bin` from. */
export interface NavSource {
  bytes(url: string): Promise<Uint8Array | undefined>;
}

export class DevTools {
  private readonly scenePicker = new ScenePicker();
  private readonly colliderView = new ColliderView();
  private readonly mantleView = new MantleView();
  private readonly hitboxView = new HitboxView();
  private readonly shotTraceView = new ShotTraceView(); // SHOTTRACE
  private readonly sunView = new SunView();
  private readonly surfaceView = new SurfaceView();
  private readonly navView = new NavView();
  /** Moves on every load and reset, so a `nav.bin` that arrives for a world since left is dropped. */
  private navGeneration = 0;
  /** The live presence's version the collider view last drew. */
  private presenceSeen = 0;
  /** The links each solid shuts in the graph the `K` view baked, by solid index. */
  private partLinks: readonly (readonly number[])[] = [];
  /** What the stats line says while there is no graph to describe: loading, or why there is none. */
  private navNote: string | null = null;
  private inspecting = false;
  private modelsHidden = false;
  private nodes = 0;

  /** A click pins a pick; hovering shows whatever is under the cursor. */
  private pinned: Pick | undefined;
  private hovered: Pick | undefined;
  /** What the highlight currently covers, so hovering does not rebuild it every tick. */
  private shownKey: THREE.Object3D | undefined;
  /** Cursor in normalised device coordinates; the screen centre while walking. */
  private readonly cursor = new THREE.Vector2();
  private hoverAccum = 0;
  private pressedAt: { x: number; y: number } | undefined;

  private frames = 0;
  private fpsAccum = 0;
  private fps = 0;
  private statsAccum = STATS_INTERVAL;

  constructor(private readonly deps: Deps) {
    deps.viewer.roots.keep(
      this.scenePicker.overlay,
      this.colliderView.object,
      this.colliderView.fullObject,
      this.sunView.object,
      this.mantleView.object,
      this.mantleView.liveObject,
      this.mantleView.ladderObject,
      this.hitboxView.object,
      this.shotTraceView.object, // SHOTTRACE
      this.surfaceView.object,
      this.navView.nodeObject,
      this.navView.linkObject,
    );
    const canvas = deps.viewer.renderer.domElement;
    canvas.addEventListener("mousemove", (e) => {
      if (deps.mode() !== "walk") {
        this.setCursor(e);
      }
    });
    canvas.addEventListener("pointerdown", (e) => {
      this.pressedAt = { x: e.clientX, y: e.clientY };
    });
    canvas.addEventListener("pointerup", (e) => this.onPointerUp(e));
  }

  /** Before the scene is disposed: the highlight borrows its geometry. */
  beforeSwap(): void {
    this.clearSelection();
  }

  /** After a world is built, with every asset loaded. */
  afterBuild(root: THREE.Object3D): void {
    this.sunView.build(root);
    // From the resolved world rather than `root`: a mantle volume has no
    // geometry in the scene to find, which is the whole reason this view exists.
    const world = this.deps.world();
    this.mantleView.build(world?.mantles ?? [], world?.ladders ?? []);
    // Rebuilt from scratch: the full view references the old collision world's geometry.
    const mode = this.colliderView.currentMode;
    if (mode === "annotated") {
      this.colliderView.build(root);
    } else if (mode === "everything") {
      this.colliderView.buildFull(root, this.liveSurfaces());
    }
    this.colliderView.setMode(mode); // clip groups are shown by un-hiding, and the build just hid them
    // Every peer is re-dressed from the new world's cast, and the sidecars read so
    // far belong to the store this mount may have invalidated.
    this.hitboxView.clear();
    this.shotTraceView.clear(); // SHOTTRACE: the rigs and the collision world it traced are gone
    // Rebuilt from scratch for the collider view's reason: it borrows the old
    // collision world's position buffers.
    if (this.surfaceView.visible) {
      this.surfaceView.build(this.deps.collision.debugSurfaces());
    }
    // Baked against the collision just replaced, so baked again, and only if
    // someone is looking: a view nobody pressed `K` for costs nothing.
    this.navGeneration++;
    this.navView.clear();
    this.navNote = null;
    this.partLinks = [];
    if (this.navView.visible) {
      this.loadNavigation();
    }
    this.refreshModels();
  }

  /** What the BVHs hold that this match collides with: the base, the present parts and every prop hull. */
  private liveSurfaces(): DebugSurface[] {
    const presence = this.deps.live.presence;
    return this.deps.collision.debugSurfaces().filter((surface) => surface.part === undefined || presence.has(surface.part));
  }

  /** Everything off, for returning to the menu. */
  reset(): void {
    this.scenePicker.releaseTrees();
    this.setInspecting(false);
    this.colliderView.setMode("off");
    this.hitboxView.setVisible(false);
    this.hitboxView.clear();
    this.shotTraceView.setVisible(false); // SHOTTRACE
    this.surfaceView.setVisible(false);
    this.surfaceView.clear();
    this.navGeneration++;
    this.navView.setMode("off");
    this.navView.clear();
    this.partLinks = [];
    this.navNote = null;
    this.sunView.setVisible(false);
    this.clearSelection();
    this.deps.ui.debug.stats.value = null;
  }

  onModeChange(mode: ViewMode): void {
    if (mode === "walk") {
      this.cursor.set(0, 0);
    } // walking aims with the crosshair
  }

  update(dt: number): void {
    const { viewer, firstPerson, ui } = this.deps;
    this.sunView.update(viewer.camera); // follows the camera: a directional light is at infinity
    ui.debug.crosshair.value = this.inspecting && this.deps.mode() === "walk" && firstPerson.enabled;
    if (this.inspecting && this.deps.root() && !this.pinned) {
      this.hoverAccum += dt;
      if (this.hoverAccum >= HOVER_INTERVAL) {
        this.hoverAccum = 0;
        this.hovered = this.pick();
        this.refreshSelection();
      }
    }
    this.mantleView.update(firstPerson.player.movement, this.deps.live);
    // A part came or went: the "everything" view draws what is present, so it follows.
    const presence = this.deps.live.presence;
    if (this.colliderView.currentMode === "everything" && presence.version !== this.presenceSeen) {
      const root = this.deps.root();
      if (root) {
        this.colliderView.buildFull(root, this.liveSurfaces());
        this.colliderView.setMode("everything");
      }
    }
    if (presence.version !== this.presenceSeen && this.partLinks.length > 0) {
      this.showPartBlockers();
    }
    this.presenceSeen = presence.version;
    // Only while it is shown: turning the view off pauses a bake, it does not drop it.
    if (this.navView.visible && this.navView.update(() => performance.now(), NAV_SLICE_MS)) {
      this.navBaked();
    }
    if (this.hitboxView.visible) {
      // After `RemotePlayers.update`, which App's frame runs first: the boxes are
      // read off bone matrices that the pose has already written this frame.
      this.hitboxView.update(this.deps.bodies(), this.deps.assets());
    }
    // SHOTTRACE: unconditional, because it has to watch `WeaponData.fired` even
    // while it is off — or turning it on would draw every round fired since the
    // world was mounted. It allocates nothing until it is shown.
    this.shotTraceView.update(firstPerson.player, this.deps.live, this.deps.bodies(), this.deps.assets(), dt);
    this.updateStats(dt);
  }

  toggleInspector(): void {
    if (!this.deps.root()) {
      return;
    }
    this.setInspecting(!this.inspecting);
  }

  /** Cycle collider view: off, proxies + map clip brushes, everything in the collision BVH. */
  /**
   * Show the mantle volumes and ladders a world lets you climb, and which of
   * them you could climb now.
   *
   * Its own toggle rather than a third collider mode: a mantle volume is not a
   * collider, and rolling it into `C` would suggest it stops you.
   */
  toggleMantles(): void {
    if (!this.deps.root()) {
      return;
    }
    const showing = !this.mantleView.visible;
    this.mantleView.setVisible(showing);
    if (!showing) {
      this.deps.toast("mantle volumes off");
      return;
    }
    const total = this.mantleView.count;
    const named = this.mantleView.namedCount;
    const ladders = this.mantleView.ladderCount;
    this.deps.toast(total || ladders ? `mantle volumes: ${total}, ladders: ${ladders}` : "this world declares no mantle volumes or ladders");
    console.info(
      total
        ? `[mantles] ${total} volume(s), ${named} naming a kind (onto/over); the highlighted one is what a jump would climb`
        : "[mantles] this world declares none — imported maps get them from the exporter (scripts/cod/mantle.py)",
    );
    console.info(
      ladders
        ? `[ladders] ${ladders} ladder(s), orange; the highlighted one is what the grab check meets from here`
        : "[ladders] this world declares none — imported maps get them from the exporter (scripts/cod/ladder.py)",
    );
  }

  /**
   * Show the hit volumes a bullet is traced against, on the peers wearing them.
   *
   * Not a collider mode either, and for a sharper reason than the mantle view's: a
   * hit box stops nothing at all. It is what a shot is judged against, on a body
   * the collider view draws as a capsule.
   */
  toggleHitboxes(): void {
    if (!this.deps.root()) {
      return;
    }
    const showing = !this.hitboxView.visible;
    this.hitboxView.setVisible(showing);
    if (!showing) {
      this.deps.toast("hit boxes off");
      return;
    }
    const bodies = this.deps.bodies().length;
    this.deps.toast(bodies ? `hit boxes on ${bodies} ${bodies === 1 ? "body" : "bodies"}` : "hit boxes: nobody else is here");
    console.info(
      bodies
        ? "[hitboxes] head and helmet pink, torso blue, arms yellow, legs green — drawn at the pose each peer is interpolated to"
        : "[hitboxes] nothing to draw: no peer is wearing a body. It takes two clients — `pnpm dev:mp` with two tabs",
    );
  }

  /**
   * Cycle the navigation view: off, the graph bots walk, and the graph with every
   * link the bake turned down.
   *
   * Baked here the first time it is turned on, from the world's `nav.bin` and this
   * client's collision — the game server's bake, run in slices a frame — so there
   * is nothing for a server to send and nothing to pay until someone looks.
   */
  toggleNavigation(): void {
    if (!this.deps.root()) {
      return;
    }
    const next = this.navView.nextMode();
    this.navView.setMode(next);
    this.statsAccum = STATS_INTERVAL;
    if (next === "off") {
      this.deps.toast("navigation off");
      return;
    }
    if (this.navView.state === "empty" && this.navNote === null) {
      this.loadNavigation();
    }
    const state = this.navView.state;
    this.deps.toast(
      this.navNote && state !== "baking"
        ? `navigation: ${this.navNote}`
        : next === "graph"
          ? `navigation: the graph${state === "ready" ? "" : " (baking — nodes are where the file puts them until it is done)"}`
          : "navigation: everything, with the links the bake turned down (press K again for off)",
    );
  }

  /** Fetch the world's `nav.bin` and start baking it. */
  private loadNavigation(): void {
    const world = this.deps.world();
    const slug = this.deps.slug();
    const assets = this.deps.assets();
    const source = world?.navigation?.source;
    if (!world || !slug || !assets || !source) {
      this.navNote = "this world declares none";
      console.info("[nav] this world has no `navigation { source: }` — bots here stand still (docs/engine/navigation.md)");
      return;
    }
    const generation = ++this.navGeneration;
    this.navNote = "loading";
    void assets.bytes(worldFileUrl(source, worldBaseUrl(slug))).then((bytes) => {
      if (generation !== this.navGeneration) {
        return; // the world was left or reloaded while this was on its way
      }
      if (!bytes) {
        this.navNote = `could not fetch ${source}`;
        return;
      }
      let file;
      try {
        file = decodeNav(bytes);
      } catch (err) {
        this.navNote = `${source} would not decode`;
        console.warn(`[nav] ${source}: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      this.navNote = null;
      // Against the base, every part absent, as a game server bakes it (nav/parts.ts).
      this.navView.bake(file, this.deps.collision.view(basePresence(world)), movementRules(world), this.deps.firstPerson.tickRate, performance.now());
      console.info(
        `[nav] ${file.nodes.count.toLocaleString()} nodes, ${file.links.count.toLocaleString()} links in ${source}: baking at ${this.deps.firstPerson.tickRate} Hz, ${NAV_SLICE_MS} ms a frame`,
      );
    });
  }

  /** The bake just finished: say what it found, and what each colour means. */
  /** Mark the links the present parts shut, as a game server's match holds them. */
  private showPartBlockers(): void {
    const presence = this.deps.live.presence;
    this.navView.setShut(new Set(this.partLinks.flatMap((links, i) => (presence.has(i) ? links : []))));
  }

  private navBaked(): void {
    const s = this.navView.summary!;
    const graph = this.navView.graph;
    const world = this.deps.world();
    if (graph && world) {
      const { collision } = this.deps;
      const parts = world.solids.map((_, i) => {
        const bounds = collision.partBounds(i);
        return bounds && { min: bounds.min, max: bounds.max, world: collision.partView(i) };
      });
      this.partLinks = linksThroughParts(graph, collision.view(basePresence(world)), parts);
      this.showPartBlockers();
    }
    const cpu = s.cpuMs ? `${Math.round(s.cpuMs.total).toLocaleString()} ms of slices` : "";
    const wall = this.navView.wallMs === null ? "" : ` over ${(this.navView.wallMs / 1000).toFixed(1)} s`;
    this.deps.toast(`navigation: ${s.usable}/${s.nodes} nodes usable, ${s.valid.toLocaleString()} links valid, ${s.invalid.toLocaleString()} invalid`);
    console.info(
      `[nav] baked: ${s.usable}/${s.nodes} nodes usable, ${s.valid.toLocaleString()} links valid, ${s.invalid.toLocaleString()} invalid; ${cpu}${wall}`,
    );
    const legend = this.navView.legend();
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

  /**
   * SHOTTRACE: show where the last few rounds went, as this client traced them
   * and as the server said they went.
   *
   * A temporary diagnostic — docs/engine/diagnostics-shottrace.md, whose last
   * section is how to take all of this out again. The server half needs
   * `SHOT_TRACE=1` on the game server; without it only this end's line is drawn.
   */
  toggleShotTraces(): void {
    if (!this.deps.root()) {
      return;
    }
    const showing = !this.shotTraceView.visible;
    this.shotTraceView.setVisible(showing);
    this.deps.toast(showing ? "shot traces on (cyan: this client, magenta: the server)" : "shot traces off");
    if (showing) {
      console.info("[shottrace] cyan is this client's own trace, magenta the server's; the stats line carries the gap between the two");
      console.info("[shottrace] the server sends nothing unless it was started with SHOT_TRACE=1 — see docs/engine/diagnostics-shottrace.md");
    }
  }

  /** SHOTTRACE: the server's account of one round this player fired. */
  serverShotTrace(message: ShotTraceMessage): void {
    this.shotTraceView.serverTrace(message);
  }

  /**
   * Colour the collision by what each triangle is made of.
   *
   * Its own toggle rather than a fourth collider mode, for the mantle view's
   * reason turned around: this *is* the collider geometry, but what it shows is
   * not whether something stops you — it is the one fact about a map that only a
   * footstep can hear, and the only way to check it is to look.
   */
  toggleSurfaces(): void {
    if (!this.deps.root()) {
      return;
    }
    const showing = !this.surfaceView.visible;
    this.surfaceView.setVisible(showing);
    if (!showing) {
      this.surfaceView.clear();
      this.deps.toast("surfaces off");
      return;
    }
    this.surfaceView.build(this.deps.collision.debugSurfaces());
    this.statsAccum = STATS_INTERVAL;
    const histogram = this.surfaceView.histogram;
    if (this.surfaceView.empty) {
      this.deps.toast("this world's collision carries no surfaces");
      console.info("[surfaces] nothing to draw: a hand-written world has none, and an imported map needs re-exporting (scripts/cod/collision.py)");
      return;
    }
    const total = histogram.reduce((n, row) => n + row.triangles, 0);
    this.deps.toast(`surfaces: ${histogram.length} kind${histogram.length === 1 ? "" : "s"} over ${total.toLocaleString()} triangles`);
    // The histogram is the acceptance test: all `default` means no face's
    // material was read, and all of one kind means it was read from the wrong place.
    for (const { surface, triangles } of histogram) {
      console.info(`  ${surface.padEnd(14)} ${triangles.toLocaleString().padStart(9)}  ${((triangles / total) * 100).toFixed(1)}%`);
    }
  }

  toggleColliders(): void {
    const root = this.deps.root();
    if (!root) {
      return;
    }
    const next = this.colliderView.nextMode();
    if (next === "annotated") {
      this.colliderView.build(root);
    } else if (next === "everything") {
      this.colliderView.buildFull(root, this.liveSurfaces());
    }
    this.colliderView.setMode(next);
    this.deps.toast(
      next === "off"
        ? "colliders off"
        : next === "annotated"
          ? "colliders: proxies + map clip brushes (press C again for everything that collides)"
          : "colliders: everything in the collision BVH, prop hulls included",
    );
    this.clearSelection(); // a pick made in the other mode may no longer be pointable
    this.statsAccum = STATS_INTERVAL;
    const groups = this.colliderView.clipGroups;
    if (next === "annotated" && groups.length) {
      console.info(
        `[colliders] ${this.colliderView.colliderCount} box proxies  ·  ${this.colliderView.clipBrushCount} clip brushes in ${groups.length} group(s)`,
      );
      for (const g of groups) {
        const mats = g.materials?.length ? `  [${g.materials.join(", ")}]` : "";
        console.info(`  ${g.group}  blocks ${g.blocks?.join("+") ?? "?"}  ${g.triangles} tris${mats}`);
      }
    }
  }

  /** Show a marker in the sky for each directional light. */
  toggleSun(): void {
    if (!this.deps.root()) {
      return;
    }
    this.sunView.setVisible(!this.sunView.visible);
    if (this.sunView.visible) {
      this.sunView.update(this.deps.viewer.camera);
      console.info(`[sun] showing ${this.sunView.count} directional light${this.sunView.count === 1 ? "" : "s"}`);
    }
  }

  /** Hide every model: if frame time collapses, the cost is the scene graph's size, not pixels. */
  toggleModels(): void {
    if (!this.deps.root()) {
      return;
    }
    this.modelsHidden = !this.modelsHidden;
    this.clearSelection();
    this.refreshModels();
    this.deps.viewer.invalidateShadows();
  }

  /**
   * Copy a link that reproduces the current camera, with `hold` so it renders
   * identically again. Also written to the address bar and a toast, because the
   * clipboard refuses writes while the pointer is locked.
   */
  capturePose(): void {
    const slug = this.deps.slug();
    if (!slug || this.deps.mode() !== "walk") {
      this.deps.toast("pose capture needs walk mode (Tab)");
      return;
    }
    const { movement } = this.deps.firstPerson.player;
    const fragment = formatPose(poseFrom(slug, movement.feet, movement, true));
    const url = `${location.origin}${location.pathname}${fragment}`;
    history.replaceState(null, "", fragment);
    void navigator.clipboard?.writeText(url).catch(() => {});
    this.deps.toast(`pose copied  ${url}`);
    console.info(`[pose] ${url}`);
  }

  private setInspecting(on: boolean): void {
    this.inspecting = on;
    this.clearSelection();
    if (!on) {
      this.deps.ui.debug.inspector.value = undefined;
    }
  }

  private onPointerUp(e: PointerEvent): void {
    const from = this.pressedAt;
    this.pressedAt = undefined;
    if (!this.inspecting || !this.deps.root() || e.button !== 0) {
      return;
    }
    if (from && Math.hypot(e.clientX - from.x, e.clientY - from.y) > CLICK_SLOP) {
      return;
    } // an orbit drag
    if (this.deps.mode() !== "walk") {
      this.setCursor(e);
    }
    this.pinned = this.hovered = this.pick();
    this.refreshSelection();
  }

  private setCursor(e: MouseEvent): void {
    const rect = this.deps.viewer.renderer.domElement.getBoundingClientRect();
    this.cursor.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  }

  private pick(): Pick | undefined {
    const root = this.deps.root();
    return root ? this.scenePicker.pick(this.cursor, this.deps.viewer.camera, root, this.colliderView.visible) : undefined;
  }

  /** A pick that highlights part of its entity (the map shell) re-highlights as the cursor moves; a prop only when the entity changes. */
  private refreshSelection(): void {
    const shown = this.pinned ?? this.hovered;
    const key = shown ? (shown.highlighted < shown.meshes ? shown.mesh : shown.entity) : undefined;
    if (key !== this.shownKey) {
      this.shownKey = key;
      if (shown) {
        this.scenePicker.highlight(shown);
      } else {
        this.scenePicker.clear();
      }
    }
    if (this.inspecting) {
      this.deps.ui.debug.inspector.value = shown ? pickInfo(shown, shown === this.pinned) : null;
    }
  }

  private clearSelection(): void {
    this.pinned = undefined;
    this.hovered = undefined;
    this.shownKey = undefined;
    this.scenePicker.clear();
    if (this.inspecting) {
      this.deps.ui.debug.inspector.value = null;
    }
  }

  /** Apply model hiding to both the placement groups and the InstancedMeshes they were pooled into. */
  private refreshModels(): void {
    this.nodes = 0;
    this.deps.root()?.traverse((obj) => {
      this.nodes++;
      if (obj.userData.model === true || obj instanceof THREE.InstancedMesh) {
        obj.visible = !this.modelsHidden;
      }
    });
    this.statsAccum = STATS_INTERVAL;
  }

  /** The stats line's navigation readings: how far the bake is, or the graph and the node nearest `p`. */
  private navStats(p: { x: number; y: number; z: number }): string[] {
    const state = this.navView.state;
    if (state === "failed") {
      return [`nav bake failed: ${this.navView.failure}`];
    }
    if (state === "baking") {
      return [`baking nav… ${Math.floor(this.navView.progress * 100)}%`];
    }
    const graph = this.navView.graph;
    if (!graph) {
      return [`nav: ${this.navNote ?? "none"}`];
    }
    const s = this.navView.summary!;
    // The node you stand by, with why each of its links out is invalid: the
    // answer to "why will a bot not go there?" without picking a line.
    const near = graph.nearestNode(p, NAV_NEAR.dy, NAV_NEAR.reach);
    return [`nav ${s.usable}/${s.nodes} nodes, ${s.valid.toLocaleString()} links`, near < 0 ? "no node near" : describeNode(graph, near)];
  }

  private updateStats(dt: number): void {
    const { ui, viewer, firstPerson } = this.deps;
    this.frames++;
    this.fpsAccum += dt;
    if (this.fpsAccum >= 0.5) {
      this.fps = Math.round(this.frames / this.fpsAccum);
      this.frames = 0;
      this.fpsAccum = 0;
    }
    this.statsAccum += dt;
    const world = this.deps.world();
    if (!ui.debug.enabled.value || !world || this.statsAccum < STATS_INTERVAL) {
      return;
    }
    this.statsAccum = 0;

    const mode = this.deps.mode();
    const p = mode === "walk" ? firstPerson.player.movement.feet : viewer.camera.position;
    // The loop runs frame callbacks before rendering, so this is the previous frame's tally.
    const { calls, triangles } = viewer.renderer.info.render;
    const tris = triangles >= 1e6 ? `${(triangles / 1e6).toFixed(2)}M` : `${Math.round(triangles / 1000)}k`;
    const primary = [
      world.name,
      `(${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)})`,
      `${this.fps} fps`,
      `${calls} draws`,
      `${tris} tris`,
      mode,
      viewer.qualityLevel,
    ];
    if (this.colliderView.currentMode === "annotated") {
      const n = this.colliderView.colliderCount;
      primary.push(`${n} collider${n === 1 ? "" : "s"}`);
      // Counted apart from the proxies: an imported map often has none of those and thousands of clip brushes.
      if (this.colliderView.clipBrushCount) {
        primary.push(`${this.colliderView.clipBrushCount} clip brushes`);
      }
    }
    if (this.mantleView.visible) {
      // The live climb, not just the count: "in a volume and nothing lights up"
      // is the reading that explains a mantle that would not start.
      const live = this.mantleView.liveClimb;
      primary.push(`${this.mantleView.count} mantle${this.mantleView.count === 1 ? "" : "s"}`);
      primary.push(live ? `climb ${live.rise.toFixed(2)} m${live.over ? " (over)" : ""}` : "no climb here");
      if (this.mantleView.ladderCount) {
        // On one, or reaching one: which is the difference a stuck grab needs.
        const on = firstPerson.player.movement.ladder !== null;
        primary.push(on ? "on a ladder" : this.mantleView.ladderAhead ? "ladder ahead" : "no ladder ahead");
      }
    }
    if (this.surfaceView.visible) {
      // What is under the player *now*, from the same query a footstep makes:
      // the colour says what the map is, and this says what the engine reads.
      const feet = firstPerson.player.movement.feet;
      const under = this.deps.live.surfaceAt({ x: feet.x, y: feet.y + 0.1, z: feet.z }, 1.5);
      primary.push(`${this.surfaceView.histogram.length} surface kinds`);
      primary.push(under === null ? "standing on nothing" : `on ${under}`);
    }
    if (this.navView.visible) {
      primary.push(...this.navStats(p));
    }
    if (this.hitboxView.visible) {
      // Boxes *and* bodies: boxes with no body means nobody is wearing one, and a
      // body with no boxes means its sidecar did not load — different faults.
      const { boxes, bodies } = this.hitboxView.counts;
      primary.push(`${boxes} hit box${boxes === 1 ? "" : "es"} on ${bodies} bod${bodies === 1 ? "y" : "ies"}`);
    }
    // SHOTTRACE: the divergence is the whole point of the view, so it goes on the
    // primary line. `no server trace` is its own reading: the game server was
    // started without SHOT_TRACE, or the round's packet was lost.
    if (this.shotTraceView.visible) {
      const { traces, divergence } = this.shotTraceView.counts;
      primary.push(`${traces} shot trace${traces === 1 ? "" : "s"}`);
      primary.push(divergence === null ? "no server trace" : `client/server apart by ${divergence.toFixed(3)} m`);
    }
    const secondary = [viewer.profiler.format(), `passes ${viewer.pipeline.format()}`, `${this.nodes} nodes`];
    const weapon = this.deps.viewmodel();
    if (weapon) {
      secondary.push(weapon);
    }
    if (this.modelsHidden) {
      secondary.push("models HIDDEN");
    }
    // Voices *and* placements: no voices with placements is a world whose loops
    // are all out of earshot (or whose context the browser has not started), and
    // no placements at all is a world with no ambience — different readings.
    const audio = this.deps.audio();
    if (audio.placements) {
      secondary.push(`${audio.voices}/${audio.placements} voices`);
    }
    ui.debug.stats.value = { primary, secondary };
  }
}

function vec(v: THREE.Vector3, places = 2): string {
  return `${v.x.toFixed(places)}, ${v.y.toFixed(places)}, ${v.z.toFixed(places)}`;
}

/** What the inspector says about a pick: most identifying rows first, absent ones left out. */
export function pickInfo(pick: Pick, pinned: boolean): PickInfo {
  const rows: [string, string][] = [];
  // First, because it changes what every row below is about: on a proxy the
  // identity is still the prop's, but the geometry described is the box's.
  if (pick.clip) {
    rows.push(["picked", "map clip brush"]);
    if (pick.clip.contents) {
      rows.push(["contents", pick.clip.contents]);
    }
    if (pick.clip.blocks?.length) {
      rows.push(["blocks", pick.clip.blocks.join(", ")]);
    }
    if (!pick.clip.collides) {
      rows.push(["collides", "no (not in this engine's collision)"]);
    }
    if (pick.clip.materials?.length) {
      rows.push(["clip material", pick.clip.materials.join(", ")]);
    }
    if (pick.clip.brushes) {
      const which = pick.clip.brush === undefined ? "" : `#${pick.clip.brush} of `;
      rows.push(["brush", `${which}${pick.clip.brushes.toLocaleString()}`]);
    }
  } else if (pick.collider) {
    rows.push(["picked", "collision box"]);
  }
  if (pick.source) {
    rows.push(["asset", pick.source]);
  }
  if (pick.name) {
    rows.push(["name", pick.name]);
  }
  if (pick.tags) {
    rows.push(["tags", pick.tags.join(" ")]);
  }
  if (pick.id !== undefined) {
    rows.push(["id", String(pick.id)]);
  }
  if (pick.material) {
    rows.push(["material", pick.material]);
  }
  if (pick.collide) {
    rows.push(["collide", pick.collide]);
  }
  if (pick.animation) {
    rows.push(["animate", pick.animation]);
  }
  rows.push(["at", vec(pick.position)]);
  // Shown for everything: "is this prop upright?" is what a rotation import gets wrong without looking broken.
  rows.push(["rotate", `${vec(pick.rotation, 1)}°`]);
  if (pick.scale && (pick.scale.x !== 1 || pick.scale.y !== 1 || pick.scale.z !== 1)) {
    rows.push(["scale", vec(pick.scale, 3)]);
  }
  rows.push(["size", `${vec(pick.size)} m`]);
  if (!pick.collider || pick.clip) {
    // A box proxy is always 12 triangles; a clip group's count says how big the family of barriers is.
    const part = pick.meshes > 1 && !pick.clip ? ` of ${pick.meshes} meshes` : "";
    rows.push(["mesh", `${pick.triangles.toLocaleString()} tris${part}`]);
  }
  rows.push(["distance", `${pick.distance.toFixed(2)} m`]);

  // The asset filename is the most recognisable handle on a prop; a name is there only when the world file gave one.
  const stem = pick.source
    ?.split("/")
    .pop()
    ?.replace(/\.(glb|gltf)$/, "");
  const hint = !pinned
    ? "Click to pin"
    : pick.collider
      ? "Pinned · the box this prop collides as"
      : pick.highlighted < pick.meshes
        ? "Pinned · highlighting the piece under the cursor"
        : "Pinned · click elsewhere to change";
  return { title: stem ?? pick.name ?? "unnamed", rows, hint, pinned, collider: pick.collider };
}
