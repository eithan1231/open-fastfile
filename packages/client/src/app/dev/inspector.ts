// The inspector: pick what is under the cursor (the crosshair while walking),
// highlight it, and say what it is through `UiState.debug.inspector`.

import * as THREE from "three";
import { ScenePicker, type Pick } from "../../engine/picking.js";
import type { PickInfo } from "../uiBridge.js";
import type { DevContext, ViewMode } from "./context.js";

/** Seconds between hover picks while the inspector is open: a pick is a raycast over the whole scene. */
const HOVER_INTERVAL = 1 / 15;

/** How far a press may move and still count as a click rather than an orbit drag, in pixels. */
const CLICK_SLOP = 4;

export class Inspector {
  private readonly picker = new ScenePicker();
  private inspecting = false;
  /** A click pins a pick; hovering shows whatever is under the cursor. */
  private pinned: Pick | undefined;
  private hovered: Pick | undefined;
  /** What the highlight currently covers, so hovering does not rebuild it every tick. */
  private shownKey: THREE.Object3D | undefined;
  /** Cursor in normalised device coordinates; the screen centre while walking. */
  private readonly cursor = new THREE.Vector2();
  private hoverAccum = 0;
  private pressedAt: { x: number; y: number } | undefined;

  /** `pickColliders`: whether the collider view is up, so its boxes are what a pick hits. */
  constructor(
    private readonly ctx: DevContext,
    private readonly pickColliders: () => boolean,
  ) {
    ctx.viewer.roots.keep(this.picker.overlay);
    const canvas = ctx.viewer.renderer.domElement;
    canvas.addEventListener("mousemove", (e) => {
      if (ctx.view.mode !== "walk") {
        this.setCursor(e);
      }
    });
    canvas.addEventListener("pointerdown", (e) => {
      this.pressedAt = { x: e.clientX, y: e.clientY };
    });
    canvas.addEventListener("pointerup", (e) => this.onPointerUp(e));
  }

  toggle(): void {
    if (this.ctx.current.root) {
      this.setInspecting(!this.inspecting);
    }
  }

  onModeChange(mode: ViewMode): void {
    if (mode === "walk") {
      this.cursor.set(0, 0);
    } // walking aims with the crosshair
  }

  update(dt: number): void {
    const { ui, firstPerson, view, current } = this.ctx;
    ui.debug.crosshair.value = this.inspecting && view.mode === "walk" && firstPerson.enabled;
    if (this.inspecting && current.root && !this.pinned) {
      this.hoverAccum += dt;
      if (this.hoverAccum >= HOVER_INTERVAL) {
        this.hoverAccum = 0;
        this.hovered = this.pick();
        this.refresh();
      }
    }
  }

  /** Everything off, for returning to the menu. */
  reset(): void {
    this.picker.releaseTrees();
    this.setInspecting(false);
  }

  /** Drop the pick: before the scene goes (the highlight borrows its geometry), or when what is pickable changed. */
  clear(): void {
    this.pinned = undefined;
    this.hovered = undefined;
    this.shownKey = undefined;
    this.picker.clear();
    if (this.inspecting) {
      this.ctx.ui.debug.inspector.value = null;
    }
  }

  private setInspecting(on: boolean): void {
    this.inspecting = on;
    this.clear();
    if (!on) {
      this.ctx.ui.debug.inspector.value = undefined;
    }
  }

  private onPointerUp(e: PointerEvent): void {
    const from = this.pressedAt;
    this.pressedAt = undefined;
    if (!this.inspecting || !this.ctx.current.root || e.button !== 0) {
      return;
    }
    if (from && Math.hypot(e.clientX - from.x, e.clientY - from.y) > CLICK_SLOP) {
      return;
    } // an orbit drag
    if (this.ctx.view.mode !== "walk") {
      this.setCursor(e);
    }
    this.pinned = this.hovered = this.pick();
    this.refresh();
  }

  private setCursor(e: MouseEvent): void {
    const rect = this.ctx.viewer.renderer.domElement.getBoundingClientRect();
    this.cursor.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  }

  private pick(): Pick | undefined {
    const root = this.ctx.current.root;
    return root ? this.picker.pick(this.cursor, this.ctx.viewer.camera, root, this.pickColliders()) : undefined;
  }

  /** A pick that highlights part of its entity (the map shell) re-highlights as the cursor moves; a prop only when the entity changes. */
  private refresh(): void {
    const shown = this.pinned ?? this.hovered;
    const key = shown ? (shown.highlighted < shown.meshes ? shown.mesh : shown.entity) : undefined;
    if (key !== this.shownKey) {
      this.shownKey = key;
      if (shown) {
        this.picker.highlight(shown);
      } else {
        this.picker.clear();
      }
    }
    if (this.inspecting) {
      this.ctx.ui.debug.inspector.value = shown ? pickInfo(shown, shown === this.pinned) : null;
    }
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
