// Entering a world, one load at a time: fetch and resolve it, mount it on a
// session, and bring the loading screen down over it. Also leaving one, and
// re-entering it when its files change on disk (dev only).
//
// Loads run one at a time (a save is several watcher events, an export
// hundreds), and only the newest counts: two mounts interleaving would have one
// dispose the scene the other is still building, since they share a session.

import { formatDiagnosticsAcrossFiles } from "@3d/shared/dsl/diagnostics.js";
import { catalogFilePath } from "@3d/shared/protocol/routes/catalog.js";
import { worldAssetPath } from "@3d/shared/protocol/routes/worlds.js";
import { POSE_TIME } from "../engine/fx/system.js";
import { poseOrientation, type Pose } from "../engine/pose.js";
import type { CurrentWorld } from "./currentWorld.js";
import { minimapInfo } from "./minimap.js";
import type { PauseController } from "./pause.js";
import type { ScreenRouter } from "./screens.js";
import type { Systems } from "./systems.js";
import type { Toaster } from "./toaster.js";
import type { UiState } from "./uiBridge.js";
import { loadWorldFromServer, worldBaseUrl } from "./worldFetch.js";
import type { Arrival, WorldSession } from "./WorldSession.js";

/**
 * How long file changes must stop before a hot reload runs. An exporter writing
 * a world is a burst of hundreds of files; a single edit in an editor is one,
 * and this is short enough that saving still feels immediate.
 */
const RELOAD_QUIET_MS = 200;

/** The catalogue's folder under the worlds root, as the watcher reports a path relative to it. */
const CATALOG_DIR = "catalog";

export class WorldLoader {
  private loads: Promise<void> = Promise.resolve();
  private generation = 0;
  /** Pending coalesced hot reload; see `sourceChanged`. */
  private reloadTimer: ReturnType<typeof setTimeout> | undefined;
  /** A pose from the URL, waiting for its world to finish building. */
  pendingPose: Pose | undefined;
  /** A world just came up: `reload` when it was the same world re-entered after an edit. */
  onEntered: ((reload: boolean) => void) | undefined;

  constructor(
    private readonly current: CurrentWorld,
    private readonly newSession: (slug: string) => WorldSession,
    private readonly systems: Systems,
    private readonly ui: UiState,
    private readonly screens: ScreenRouter,
    private readonly pause: PauseController,
    private readonly toaster: Toaster,
  ) {}

  /** Enter a world, or re-enter the current one after an edit (`reload`), keeping the camera. */
  enter(slug: string, reload = false): Promise<void> {
    const generation = ++this.generation;
    const next = this.loads.then(() => this.load(slug, reload, generation));
    this.loads = next; // `load` never rejects, so the queue cannot be poisoned
    return next;
  }

  /** Leave the world: a load still in flight must not put it back up, nor a file change from before re-enter it. */
  leave(): void {
    this.generation++;
    clearTimeout(this.reloadTimer);
    this.reloadTimer = undefined;
    this.current.session?.dispose();
    this.current.session = undefined;
    this.pendingPose = undefined;
    this.ui.worldName.value = null;
    this.ui.minimap.map.value = null;
    this.ui.minimap.pose.value = null;
    this.ui.error.value = null;
    this.ui.loading.value = null;
  }

  /** A `.world` or asset file changed on disk (dev server only). */
  sourceChanged(path: string | undefined): void {
    const session = this.current.session;
    if (!session) {
      return;
    }
    // This world's own files, or the catalogue — which belongs to no world and so
    // could never match a slug. A world cannot include another's sources, and an
    // exporter run rewrites every other world on disk, each of which used to
    // reload whatever world was loaded here.
    const inCatalog = path?.startsWith(`${CATALOG_DIR}/`) ?? false;
    if (path !== undefined && !inCatalog && !path.startsWith(`${session.slug}/`)) {
      return;
    }
    // The AssetStore is keyed by the URL scene/ loaded with, so the key has to be
    // built by the same builder rather than spelled out a second time here.
    const assetUrl = path === undefined ? undefined : inCatalog ? catalogUrlOf(path) : worldAssetPath(session.slug, path.slice(session.slug.length + 1));
    if (assetUrl !== undefined && session.assets.invalidate(assetUrl)) {
      console.info(`[reload] ${path} changed; reloading it`);
    }
    // One reload for a burst of changes. Each invalidation above is already
    // recorded, so a reload after the burst picks up all of them — while a
    // reload per file re-fetches and re-resolves the whole world, and an
    // exporter run writes hundreds of files per map.
    clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = undefined;
      if (this.current.session === session) {
        void this.enter(session.slug, true);
      }
    }, RELOAD_QUIET_MS);
  }

  /** Whether this load is still the one the app is waiting for. */
  private isCurrent(generation: number): boolean {
    return generation === this.generation;
  }

  private async load(slug: string, reload: boolean, generation: number): Promise<void> {
    if (!this.isCurrent(generation)) {
      return;
    }
    try {
      await this.loadWorld(slug, reload, generation);
    } catch (e) {
      // Or a world that throws leaves the loading screen up for good.
      if (!this.isCurrent(generation)) {
        return;
      }
      console.error(`Failed to load world "${slug}"`, e);
      this.screens.error({
        title: `Could not load world "${slug}"`,
        detail: e instanceof Error ? (e.stack ?? e.message) : String(e),
        watching: import.meta.env.DEV,
      });
    }
  }

  private async loadWorld(slug: string, reload: boolean, generation: number): Promise<void> {
    const { firstPerson, animator, fx, viewer } = this.systems;
    let entry = this.ui.worlds.value.find((w) => w.slug === slug) ?? { slug, name: slug };
    if (!reload) {
      this.ui.loading.value = { world: entry, step: "fetch", progress: 0 };
      this.screens.show("loading");
    }
    const result = await loadWorldFromServer(slug);
    if (!this.isCurrent(generation)) {
      return;
    }
    if ("fetchError" in result) {
      console.error(`Failed to load world "${slug}"`, result.fetchError);
      this.screens.error({ title: `Could not load world "${slug}"`, detail: String(result.fetchError), watching: false });
      return;
    }
    if (!result.ok) {
      const errors = result.diagnostics.filter((d) => d.severity === "error").length;
      const warnings = result.diagnostics.length - errors;
      const title = `${slug}: ${plural(errors, "error")}${warnings ? `, ${plural(warnings, "warning")}` : ""}`;
      this.screens.error({ title, detail: formatDiagnosticsAcrossFiles(result.sources, result.diagnostics), watching: true });
      return;
    }

    let arrival: Arrival = { kind: "spawn" };
    if (reload && this.current.slug === slug) {
      const { feet, yaw, pitch } = firstPerson.player.movement;
      arrival = { kind: "keep", feet: { ...feet }, yaw, pitch };
    } else if (this.pendingPose?.slug === slug) {
      const pose = this.pendingPose;
      arrival = { kind: "pose", feet: { x: pose.x, y: pose.y, z: pose.z }, ...poseOrientation(pose), hold: pose.hold };
    }
    this.pendingPose = undefined;

    if (this.current.slug !== slug) {
      this.current.session?.dispose();
      this.current.session = this.newSession(slug);
    }
    const session = this.current.session!;
    entry = { ...entry, name: result.world.name };
    const onStep = reload
      ? undefined
      : (step: string, index: number, count: number) => {
          // The fetch was the first of count + 1 steps.
          this.ui.loading.value = { world: entry, step, progress: (index + 1) / (count + 1) };
          return yieldToBrowser(); // or the step never paints: most of them are synchronous
        };
    await session.mount(result.world, arrival, onStep);
    if (!this.isCurrent(generation)) {
      return;
    } // left for the menu, or superseded
    const held = arrival.kind === "pose" && arrival.hold;
    // A held pose is a screenshot, so time holds too; a hot reload keeps whatever it was.
    if (arrival.kind !== "keep") {
      animator.paused = held;
      fx.paused = held;
    }
    // A particle system starts empty, so holding it at t=0 would screenshot a
    // clear sky and read as a rendering bug rather than a timing one. Replaying
    // to a fixed point in fixed steps also makes the frame identical run to run,
    // which is what keeps `pnpm shots` diffs meaningful for every world.
    if (held) {
      // The camera first: mounting leaves it at the dollhouse's framing until the
      // next frame, and a frustum-gated elem judged from there spawns nothing.
      if (this.pause.mode === "walk") {
        firstPerson.snapCamera();
      }
      fx.seekTo(POSE_TIME, viewer.camera);
      this.toaster.show("held still (pose has `hold`): press W/A/S/D to release");
    }

    this.ui.worldName.value = result.world.name;
    const minimap = result.world.minimap;
    this.ui.minimap.map.value = minimap ? minimapInfo(minimap, worldBaseUrl(slug)) : null;
    this.ui.error.value = null;
    this.ui.loading.value = null;
    this.pause.arrived(reload);
    this.screens.show("world");
    viewer.start();
    this.pause.setMode(arrival.kind === "keep" ? this.pause.mode : "walk");
    this.onEntered?.(reload);
  }
}

/**
 * A changed catalogue file as the URL the AssetStore keyed it by.
 *
 * `catalog/<kind>/<game>/<id>/<rest...>` — built with the route's own builder
 * rather than spelled out here, for the reason the world's asset path is: a
 * second spelling of one file silently stops invalidating it.
 */
function catalogUrlOf(relative: string): string | undefined {
  const [dir, kind, game, id, ...rest] = relative.split("/");
  if (dir !== CATALOG_DIR || !kind || !game || !id || rest.length === 0) {
    return undefined;
  }
  return catalogFilePath(kind, game, id, rest.join("/"));
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** Let the browser run a frame between synchronous load steps. Not rAF: that never fires in a background tab. */
function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
