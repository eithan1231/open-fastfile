// Development tools, behind the dev keys: the inspector, the debug overlays, the
// navigation view, pose capture and the stats readout. This is the one object
// the rest of the app holds; each tool is its own module beside it.

import type * as THREE from "three";
import type { ShotTraceMessage } from "@3d/shared/net/messages/shotTrace.js";
import type { Animator } from "../../engine/animator.js";
import type { AudioSystem } from "../../engine/audio/system.js";
import { formatPose, poseFrom } from "../../engine/pose.js";
import type { Viewmodel } from "../../engine/viewmodel.js";
import type { Action } from "../../input/bindings.js";
import type { InputManager } from "../../input/InputManager.js";
import type { FrameUpdates } from "../frame.js";
import type { WeaponViewmodel } from "../weaponViewmodel.js";
import type { DevContext, ViewMode } from "./context.js";
import { Inspector } from "./inspector.js";
import { NavDebug } from "./navDebug.js";
import { Overlays, type BodySource } from "./overlays.js";
import { StatsReadout } from "./stats.js";

export type { DevContext, ViewMode } from "./context.js";

/** What the tools read beyond the context: the systems they report on. */
export interface DevSystems {
  readonly bodies: BodySource;
  readonly animator: Animator;
  readonly audio: AudioSystem;
  readonly viewmodel: Viewmodel;
  readonly weapon: WeaponViewmodel;
  readonly updates: FrameUpdates;
}

export class DevTools {
  private readonly overlays: Overlays;
  private readonly inspector: Inspector;
  private readonly nav: NavDebug;
  private readonly stats: StatsReadout;

  constructor(
    private readonly ctx: DevContext,
    private readonly systems: DevSystems,
  ) {
    this.overlays = new Overlays(ctx, systems.bodies);
    this.inspector = new Inspector(ctx, () => this.overlays.collidersShown);
    this.nav = new NavDebug(ctx);
    this.stats = new StatsReadout(ctx, this.overlays, this.nav, systems.updates, systems.viewmodel, systems.audio);
  }

  /** The dev keys. Only bound where `ui.debug.enabled` is. */
  bind(input: InputManager): void {
    const toggles: [Action, () => void][] = [
      ["inspector", () => this.inspector.toggle()],
      ["colliders", () => this.withRoot((root) => this.toggleColliders(root))],
      ["mantles", () => this.withRoot(() => this.overlays.toggleMantles())],
      ["hitboxes", () => this.withRoot(() => this.overlays.toggleHitboxes())],
      ["surfaces", () => this.withRoot(() => this.refreshing(() => this.overlays.toggleSurfaces()))],
      ["navigation", () => this.withRoot(() => this.refreshing(() => this.nav.toggle()))],
      ["shotTraces", () => this.withRoot(() => this.overlays.toggleShotTraces())], // SHOTTRACE
      ["hideModels", () => this.withRoot(() => this.toggleModels())],
      ["sun", () => this.withRoot(() => this.overlays.toggleSun())],
      ["pauseAnimation", () => this.togglePauseAnimation()],
      ["viewmodel", () => this.toggleViewmodel()],
      ["capturePose", () => this.capturePose()],
    ];
    for (const [action, run] of toggles) {
      input.on(action, run);
    }
  }

  /** Before the scene is disposed: the highlight borrows its geometry. */
  beforeSwap(): void {
    this.inspector.clear();
  }

  /** After a world is built, with every asset loaded. */
  afterBuild(root: THREE.Object3D): void {
    this.overlays.afterBuild(root);
    this.nav.afterBuild();
    this.stats.refresh();
  }

  /** Everything off, for returning to the menu. */
  reset(): void {
    this.inspector.reset();
    this.overlays.reset();
    this.nav.reset();
    this.stats.clear();
  }

  onModeChange(mode: ViewMode): void {
    this.inspector.onModeChange(mode);
  }

  update(dt: number): void {
    this.inspector.update(dt);
    this.overlays.update(dt);
    this.nav.update();
    this.stats.update(dt);
  }

  /** SHOTTRACE: the server's account of one round this player fired. */
  serverShotTrace(message: ShotTraceMessage): void {
    this.overlays.serverShotTrace(message);
  }

  /**
   * Copy a link that reproduces the current camera, with `hold` so it renders
   * identically again. Also written to the address bar and a toast, because the
   * clipboard refuses writes while the pointer is locked.
   */
  capturePose(): void {
    const slug = this.ctx.current.slug;
    if (!slug || this.ctx.view.mode !== "walk") {
      this.ctx.toaster.show("pose capture needs walk mode (Tab)");
      return;
    }
    const { movement } = this.ctx.firstPerson.player;
    const fragment = formatPose(poseFrom(slug, movement.feet, movement, true));
    const url = `${location.origin}${location.pathname}${fragment}`;
    history.replaceState(null, "", fragment);
    void navigator.clipboard?.writeText(url).catch(() => {});
    this.ctx.toaster.show(`pose copied  ${url}`);
    console.info(`[pose] ${url}`);
  }

  /** Run a toggle that needs a world to show anything over; with none, a key does nothing. */
  private withRoot(run: (root: THREE.Object3D) => void): void {
    const root = this.ctx.current.root;
    if (root) {
      run(root);
    }
  }

  /** Run a toggle whose result the stats line reports, and redraw the line now rather than at its next interval. */
  private refreshing(run: () => void): void {
    run();
    this.stats.refresh();
  }

  private toggleColliders(root: THREE.Object3D): void {
    this.overlays.toggleColliders(root);
    this.inspector.clear(); // a pick made in the other mode may no longer be pointable
    this.stats.refresh();
  }

  private toggleModels(): void {
    this.inspector.clear();
    this.overlays.toggleModels();
    this.stats.refresh();
  }

  private togglePauseAnimation(): void {
    const { animator } = this.systems;
    animator.paused = !animator.paused;
    this.ctx.toaster.show(animator.paused ? "animation paused" : "animation running");
  }

  private toggleViewmodel(): void {
    const { weapon } = this.systems;
    weapon.shown = !weapon.shown;
    this.ctx.toaster.show(weapon.shown ? "viewmodel shown" : "viewmodel hidden");
  }
}
