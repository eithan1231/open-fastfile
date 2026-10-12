// The debug overlays drawn over a world: colliders, mantle volumes and ladders,
// hit boxes, shot traces, surfaces, the sun marker, and hiding every model. Each
// toggle says what it shows in a toast and the console; `stats` is each one's
// share of the stats line.

import * as THREE from "three";
import type { DebugSurface } from "@3d/shared/collision/world.js";
import { ColliderView } from "../../engine/colliderView.js";
import { HitboxView } from "../../engine/hitboxView.js";
import { MantleView } from "../../engine/mantleView.js";
// SHOTTRACE (docs/engine/diagnostics-shottrace.md)
import { ShotTraceView } from "../../engine/shotTraceView.js";
import type { ShotTraceMessage } from "@3d/shared/net/messages/shotTrace.js";
import { SunView } from "../../engine/sunView.js";
import { SurfaceView } from "../../engine/surfaceView.js";
import type { DrawnBody } from "../../net/remotePlayers.js";
import type { DevContext } from "./context.js";

/** The peers standing now, each on the rig the last frame posed. */
export interface BodySource {
  drawnBodies(): readonly DrawnBody[];
}

export class Overlays {
  private readonly colliders = new ColliderView();
  private readonly mantles = new MantleView();
  private readonly hitboxes = new HitboxView();
  private readonly shotTraces = new ShotTraceView(); // SHOTTRACE
  private readonly sun = new SunView();
  private readonly surfaces = new SurfaceView();
  /** The live presence's version the collider view last drew. */
  private presenceSeen = 0;
  private modelsHidden = false;
  /** Nodes in the built world, counted while hiding or showing its models. */
  nodes = 0;

  constructor(
    private readonly ctx: DevContext,
    private readonly bodies: BodySource,
  ) {
    ctx.viewer.roots.keep(
      this.colliders.object,
      this.colliders.fullObject,
      this.sun.object,
      this.mantles.object,
      this.mantles.liveObject,
      this.mantles.ladderObject,
      this.hitboxes.object,
      this.shotTraces.object, // SHOTTRACE
      this.surfaces.object,
    );
  }

  /** Whether the collider boxes are showing, which is what a pick should hit. */
  get collidersShown(): boolean {
    return this.colliders.visible;
  }

  /** After a world is built, with every asset loaded. */
  afterBuild(root: THREE.Object3D): void {
    this.sun.build(root);
    // From the resolved world rather than `root`: a mantle volume has no
    // geometry in the scene to find, which is the whole reason this view exists.
    const world = this.ctx.current.world;
    this.mantles.build(world?.mantles ?? [], world?.ladders ?? []);
    // Rebuilt from scratch: the full view references the old collision world's geometry.
    const mode = this.colliders.currentMode;
    if (mode === "annotated") {
      this.colliders.build(root);
    } else if (mode === "everything") {
      this.colliders.buildFull(root, this.liveSurfaces());
    }
    this.colliders.setMode(mode); // clip groups are shown by un-hiding, and the build just hid them
    // Every peer is re-dressed from the new world's cast, and the sidecars read so
    // far belong to the store this mount may have invalidated.
    this.hitboxes.clear();
    this.shotTraces.clear(); // SHOTTRACE: the rigs and the collision world it traced are gone
    // Rebuilt from scratch for the collider view's reason: it borrows the old
    // collision world's position buffers.
    if (this.surfaces.visible) {
      this.surfaces.build(this.ctx.collision.debugSurfaces());
    }
    this.refreshModels();
  }

  /** Everything off, for returning to the menu. */
  reset(): void {
    this.colliders.setMode("off");
    this.hitboxes.setVisible(false);
    this.hitboxes.clear();
    this.shotTraces.setVisible(false); // SHOTTRACE
    this.surfaces.setVisible(false);
    this.surfaces.clear();
    this.sun.setVisible(false);
  }

  update(dt: number): void {
    const { viewer, firstPerson, live, current } = this.ctx;
    this.sun.update(viewer.camera); // follows the camera: a directional light is at infinity
    this.mantles.update(firstPerson.player.movement, live);
    // A part came or went: the "everything" view draws what is present, so it follows.
    const presence = live.presence;
    if (this.colliders.currentMode === "everything" && presence.version !== this.presenceSeen) {
      const root = current.root;
      if (root) {
        this.colliders.buildFull(root, this.liveSurfaces());
        this.colliders.setMode("everything");
      }
    }
    this.presenceSeen = presence.version;
    if (this.hitboxes.visible) {
      // After the frame's "others" step: the boxes are read off bone matrices
      // that the pose has already written this frame.
      this.hitboxes.update(this.bodies.drawnBodies(), current.assets);
    }
    // SHOTTRACE: unconditional, because it has to watch `WeaponData.fired` even
    // while it is off — or turning it on would draw every round fired since the
    // world was mounted. It allocates nothing until it is shown.
    this.shotTraces.update(firstPerson.player, live, this.bodies.drawnBodies(), current.assets, dt);
  }

  /** Cycle collider view: off, proxies + map clip brushes, everything in the collision BVH. */
  toggleColliders(root: THREE.Object3D): void {
    const next = this.colliders.nextMode();
    if (next === "annotated") {
      this.colliders.build(root);
    } else if (next === "everything") {
      this.colliders.buildFull(root, this.liveSurfaces());
    }
    this.colliders.setMode(next);
    this.ctx.toaster.show(
      next === "off"
        ? "colliders off"
        : next === "annotated"
          ? "colliders: proxies + map clip brushes (press C again for everything that collides)"
          : "colliders: everything in the collision BVH, prop hulls included",
    );
    const groups = this.colliders.clipGroups;
    if (next === "annotated" && groups.length) {
      console.info(`[colliders] ${this.colliders.colliderCount} box proxies  ·  ${this.colliders.clipBrushCount} clip brushes in ${groups.length} group(s)`);
      for (const g of groups) {
        const mats = g.materials?.length ? `  [${g.materials.join(", ")}]` : "";
        console.info(`  ${g.group}  blocks ${g.blocks?.join("+") ?? "?"}  ${g.triangles} tris${mats}`);
      }
    }
  }

  /**
   * Show the mantle volumes and ladders a world lets you climb, and which of
   * them you could climb now.
   *
   * Its own toggle rather than a third collider mode: a mantle volume is not a
   * collider, and rolling it into `X` would suggest it stops you.
   */
  toggleMantles(): void {
    const showing = !this.mantles.visible;
    this.mantles.setVisible(showing);
    if (!showing) {
      this.ctx.toaster.show("mantle volumes off");
      return;
    }
    const total = this.mantles.count;
    const named = this.mantles.namedCount;
    const ladders = this.mantles.ladderCount;
    this.ctx.toaster.show(total || ladders ? `mantle volumes: ${total}, ladders: ${ladders}` : "this world declares no mantle volumes or ladders");
    console.info(
      total
        ? `[mantles] ${total} volume(s), ${named} naming a kind (onto/over); the highlighted one is what holding jump would climb`
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
    const showing = !this.hitboxes.visible;
    this.hitboxes.setVisible(showing);
    if (!showing) {
      this.ctx.toaster.show("hit boxes off");
      return;
    }
    const bodies = this.bodies.drawnBodies().length;
    this.ctx.toaster.show(bodies ? `hit boxes on ${bodies} ${bodies === 1 ? "body" : "bodies"}` : "hit boxes: nobody else is here");
    console.info(
      bodies
        ? "[hitboxes] head and helmet pink, torso blue, arms yellow, legs green — drawn at the pose each peer is interpolated to"
        : "[hitboxes] nothing to draw: no peer is wearing a body. It takes two clients — `pnpm dev:mp` with two tabs",
    );
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
    const showing = !this.shotTraces.visible;
    this.shotTraces.setVisible(showing);
    this.ctx.toaster.show(showing ? "shot traces on (cyan: this client, magenta: the server)" : "shot traces off");
    if (showing) {
      console.info("[shottrace] cyan is this client's own trace, magenta the server's; the stats line carries the gap between the two");
      console.info("[shottrace] the server sends nothing unless it was started with SHOT_TRACE=1 — see docs/engine/diagnostics-shottrace.md");
    }
  }

  /** SHOTTRACE: the server's account of one round this player fired. */
  serverShotTrace(message: ShotTraceMessage): void {
    this.shotTraces.serverTrace(message);
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
    const showing = !this.surfaces.visible;
    this.surfaces.setVisible(showing);
    if (!showing) {
      this.surfaces.clear();
      this.ctx.toaster.show("surfaces off");
      return;
    }
    this.surfaces.build(this.ctx.collision.debugSurfaces());
    const histogram = this.surfaces.histogram;
    if (this.surfaces.empty) {
      this.ctx.toaster.show("this world's collision carries no surfaces");
      console.info("[surfaces] nothing to draw: a hand-written world has none, and an imported map needs re-exporting (scripts/cod/collision.py)");
      return;
    }
    const total = histogram.reduce((n, row) => n + row.triangles, 0);
    this.ctx.toaster.show(`surfaces: ${histogram.length} kind${histogram.length === 1 ? "" : "s"} over ${total.toLocaleString()} triangles`);
    // The histogram is the acceptance test: all `default` means no face's
    // material was read, and all of one kind means it was read from the wrong place.
    for (const { surface, triangles } of histogram) {
      console.info(`  ${surface.padEnd(14)} ${triangles.toLocaleString().padStart(9)}  ${((triangles / total) * 100).toFixed(1)}%`);
    }
  }

  /** Show a marker in the sky for each directional light. */
  toggleSun(): void {
    this.sun.setVisible(!this.sun.visible);
    if (this.sun.visible) {
      this.sun.update(this.ctx.viewer.camera);
      console.info(`[sun] showing ${this.sun.count} directional light${this.sun.count === 1 ? "" : "s"}`);
    }
  }

  /** Hide every model: if frame time collapses, the cost is the scene graph's size, not pixels. */
  toggleModels(): void {
    this.modelsHidden = !this.modelsHidden;
    this.refreshModels();
    this.ctx.viewer.invalidateShadows();
  }

  /** Each shown overlay's readings, onto the stats line's two halves. */
  stats(primary: string[], secondary: string[]): void {
    const { firstPerson, live } = this.ctx;
    if (this.colliders.currentMode === "annotated") {
      const n = this.colliders.colliderCount;
      primary.push(`${n} collider${n === 1 ? "" : "s"}`);
      // Counted apart from the proxies: an imported map often has none of those and thousands of clip brushes.
      if (this.colliders.clipBrushCount) {
        primary.push(`${this.colliders.clipBrushCount} clip brushes`);
      }
    }
    if (this.mantles.visible) {
      // The live climb, not just the count: "in a volume and nothing lights up"
      // is the reading that explains a mantle that would not start.
      const climb = this.mantles.liveClimb;
      primary.push(`${this.mantles.count} mantle${this.mantles.count === 1 ? "" : "s"}`);
      primary.push(climb ? `climb ${climb.height.toFixed(2)} m${climb.over ? " (over)" : ""}${climb.crouched ? " (crouched)" : ""}` : "no climb here");
      if (this.mantles.ladderCount) {
        // On one, or reaching one: which is the difference a stuck grab needs.
        const on = firstPerson.player.movement.move.kind === "ladder";
        primary.push(on ? "on a ladder" : this.mantles.ladderAhead ? "ladder ahead" : "no ladder ahead");
      }
    }
    if (this.surfaces.visible) {
      // What is under the player *now*, from the same query a footstep makes:
      // the colour says what the map is, and this says what the engine reads.
      const feet = firstPerson.player.movement.feet;
      const under = live.surfaceAt({ x: feet.x, y: feet.y + 0.1, z: feet.z }, 1.5);
      primary.push(`${this.surfaces.histogram.length} surface kinds`);
      primary.push(under === null ? "standing on nothing" : `on ${under}`);
    }
    if (this.hitboxes.visible) {
      // Boxes *and* bodies: boxes with no body means nobody is wearing one, and a
      // body with no boxes means its sidecar did not load — different faults.
      const { boxes, bodies } = this.hitboxes.counts;
      primary.push(`${boxes} hit box${boxes === 1 ? "" : "es"} on ${bodies} bod${bodies === 1 ? "y" : "ies"}`);
    }
    // SHOTTRACE: the divergence is the whole point of the view, so it goes on the
    // primary line. `no server trace` is its own reading: the game server was
    // started without SHOT_TRACE, or the round's packet was lost.
    if (this.shotTraces.visible) {
      const { traces, divergence } = this.shotTraces.counts;
      primary.push(`${traces} shot trace${traces === 1 ? "" : "s"}`);
      primary.push(divergence === null ? "no server trace" : `client/server apart by ${divergence.toFixed(3)} m`);
    }
    secondary.push(`${this.nodes} nodes`);
    if (this.modelsHidden) {
      secondary.push("models HIDDEN");
    }
  }

  /** What the BVHs hold that this match collides with: the base, the present parts and every prop hull. */
  private liveSurfaces(): DebugSurface[] {
    const presence = this.ctx.live.presence;
    return this.ctx.collision.debugSurfaces().filter((surface) => surface.part === undefined || presence.has(surface.part));
  }

  /** Apply model hiding to both the placement groups and the InstancedMeshes they were pooled into. */
  private refreshModels(): void {
    this.nodes = 0;
    this.ctx.current.root?.traverse((obj) => {
      this.nodes++;
      if (obj.userData.model === true || obj instanceof THREE.InstancedMesh) {
        obj.visible = !this.modelsHidden;
      }
    });
  }
}
