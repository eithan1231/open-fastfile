// A weapon turning on the spot, drawn into a canvas of its own: the picture the
// class menu shows of what you are about to carry.
//
// **Its own renderer, not a corner of the world's.** A menu is drawn over the
// world canvas with a background of its own, so scissoring a viewport out of the
// main renderer would mean punching a transparent hole through the menu's CSS
// and keeping the two in step — the page's layout coupled to the scene behind
// it. A second context costs a menu nothing and is thrown away with it.
//
// It draws the same rig the game does (scene/viewmodel.ts), attachments and all,
// which is the point: the preview is not an illustration of the weapon, it is
// the weapon, hidden surfaces and fitted optic included. The hands are left off
// — a class menu is about the gun.

import * as THREE from "three";
import * as SkeletonUtils from "three/examples/jsm/utils/SkeletonUtils.js";
import type { GltfAsset } from "../scene/assets.js";
import { hideByBones, mountAttachments, type FittedAttachment } from "../scene/viewmodel.js";
import type { WeaponDef } from "@3d/shared/sim/weaponDef.js";
import { releaseRig } from "@3d/shared/rig/release.js";

/**
 * Where the camera sits, in the weapon's own frame: side on to its **left**,
 * a little above and ahead.
 *
 * Not turning, and this side rather than the other. A gun's left is the side a
 * player sees in first person — the eye is at the origin and the weapon is held
 * to its right — so it is the side the game's artists detailed, and the right
 * side of some weapons is barely textured because nothing ever looks at it. A
 * turntable spent half its time showing exactly that.
 */
const VIEW = new THREE.Vector3(-0.35, 0.22, -1);
/** Where the light comes from, in the same frame: over the viewer's shoulder. */
const KEY = new THREE.Vector3(-2, 3, -4);
/** How much bigger than the weapon the framing is, so nothing touches the edges. */
const MARGIN = 1.12;

export class WeaponPreview {
  readonly canvas: HTMLCanvasElement;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(35, 1, 0.01, 20);
  /** The weapon hangs under this, centred on its own bounds. */
  private readonly stand = new THREE.Group();
  private shown: THREE.Object3D | undefined;
  /** The shown weapon's bounds, centred on the origin: what the framing solves against. */
  private bounds: THREE.Box3 | undefined;
  private sized = { width: 0, height: 0 };
  /** Whether the camera has been solved for what is shown, at the size it is shown at. */
  private framed = false;
  private readonly watcher: ResizeObserver;

  constructor() {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    // The same grade as the world's, so a weapon does not change colour between
    // the menu and the player's hands.
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.canvas = this.renderer.domElement;
    this.canvas.style.width = "100%";
    this.canvas.style.height = "100%";
    this.canvas.style.display = "block";

    // Gently. A Call of Duty gun texture is dark — the AK-47's averages 54 of
    // 255 — and lighting one as if it were a mid grey takes it to white, which
    // reads as a weapon with no texture at all rather than as one over-lit.
    const key = new THREE.DirectionalLight(0xffffff, 1.9);
    key.position.copy(KEY);
    const fill = new THREE.DirectionalLight(0xc8d4e6, 0.6);
    fill.position.set(3, -1, 4);
    this.scene.add(key, fill, new THREE.AmbientLight(0xffffff, 0.35), this.stand);

    // Nothing moves, so there is no frame loop: the picture is redrawn when the
    // weapon changes and when the box it is drawn into changes size, and at no
    // other time.
    this.watcher = new ResizeObserver(() => this.render());
    this.watcher.observe(this.canvas);
  }

  /**
   * Show `weapon` with `attachments` fitted, framed and turning.
   *
   * `def` is the catalogue's resolved definition, so the surfaces hidden are the
   * ones that would be hidden in the game — an optic that folds the iron sights
   * away folds them here too.
   */
  show(weapon: GltfAsset, def: WeaponDef, attachments: readonly FittedAttachment[]): void {
    this.clear();
    const rig = buildPreviewRig(weapon, def, attachments);
    this.stand.add(rig);
    this.shown = rig;
    this.bounds = centre(rig);
    this.framed = false;
    this.render();
  }

  /** Nothing to show: an empty slot, or a weapon whose model would not load. */
  clear(): void {
    if (this.shown) {
      releaseRig(this.shown);
      this.shown = undefined;
      this.bounds = undefined;
      this.framed = false;
    }
    this.render();
  }

  /** Stop drawing and free the context. The canvas is no use afterwards. */
  dispose(): void {
    this.watcher.disconnect();
    this.clear();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }

  private render(): void {
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    if (width === 0 || height === 0) {
      return;
    }
    if (width !== this.sized.width || height !== this.sized.height) {
      this.sized = { width, height };
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      this.renderer.setSize(width, height, false);
      this.camera.aspect = width / height;
      this.framed = false;
    }
    // Framed here rather than when the weapon is set, because either of the two
    // can happen first: the box is measured as soon as the canvas is in the page
    // and the weapon arrives only once its model has been fetched. Whichever is
    // second draws, and both leave the camera solved for what is on screen.
    if (!this.framed) {
      this.frameWeapon();
      this.framed = true;
    }
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * Put the camera where the whole weapon fits, however narrow the box it is
   * drawn into gets.
   *
   * Solved against the bounding box in the **camera's own frame** rather than
   * against a bounding sphere: a sphere around a rifle is mostly empty air, and
   * fitting one leaves the gun a third of the size it could be. Both axes are
   * checked because the panel's box is taller than it is wide at some widths and
   * wider at others, and only one of them is ever the binding one.
   */
  private frameWeapon(): void {
    const bounds = this.bounds;
    if (!bounds) {
      return;
    }
    const forward = VIEW.clone().normalize();
    const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), forward).normalize();
    const up = new THREE.Vector3().crossVectors(forward, right).normalize();

    // The box's half-extent along each of the camera's axes: the support of the
    // eight corners, which for an axis-aligned box is the dot of its half-size
    // with the absolute of that axis.
    const half = bounds.getSize(new THREE.Vector3()).multiplyScalar(0.5);
    const extent = (axis: THREE.Vector3) => Math.abs(axis.x) * half.x + Math.abs(axis.y) * half.y + Math.abs(axis.z) * half.z;

    const halfV = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    const halfH = halfV * this.camera.aspect;
    const distance = Math.max(extent(up) / halfV, extent(right) / halfH) * MARGIN + extent(forward);

    this.camera.position.copy(forward).multiplyScalar(distance);
    this.camera.lookAt(0, 0, 0);
    this.camera.near = Math.max(0.01, distance - extent(forward) * 2);
    this.camera.far = distance + extent(forward) * 4;
    this.camera.updateProjectionMatrix();
  }
}

/**
 * Centre `rig` on its own bounds and return them, moved to the origin with it.
 *
 * **The bounds of what is drawn, not of what is there.** `Box3.setFromObject`
 * takes no notice of `visible`, and a Modern Warfare 2 gun carries every
 * attachment it accepts on the one model with the unfitted ones hidden — so its
 * box over the whole rig runs from the tip of a silencer nobody fitted to the
 * bottom of a grenade launcher nobody fitted, and framing that leaves the rifle
 * a third of the size of its own picture.
 *
 * Still `setFromObject`, though, one visible mesh at a time. A viewmodel's
 * meshes are skinned and carry no transform of their own — where the gun *is* is
 * the skeleton's doing — so a box built from `geometry.boundingBox` and the
 * mesh's own matrix lands near the origin at a fortieth of the size, and the
 * camera solved from it points at nothing at all.
 */
function centre(rig: THREE.Object3D): THREE.Box3 | undefined {
  rig.updateMatrixWorld(true);
  const bounds = new THREE.Box3();
  const box = new THREE.Box3();
  rig.traverseVisible((item) => {
    if (item instanceof THREE.Mesh) {
      bounds.union(box.setFromObject(item));
    }
  });
  if (bounds.isEmpty()) {
    return undefined;
  }
  const middle = bounds.getCenter(new THREE.Vector3());
  rig.position.sub(middle);
  return bounds.translate(middle.clone().negate());
}

/** The gun alone: the weapon GLB's own meshes, its attachments on their tags, and what the game hides hidden. */
function buildPreviewRig(weapon: GltfAsset, def: WeaponDef, attachments: readonly FittedAttachment[]): THREE.Object3D {
  // SkeletonUtils, not a plain clone: a skinned mesh needs its bones cloned with it.
  const root = SkeletonUtils.clone(weapon.scene);
  const joints = new Map<string, THREE.Object3D>();
  root.traverse((item) => {
    if (item instanceof THREE.Bone) {
      joints.set(item.name, item);
    }
  });
  mountAttachments(root, joints, attachments, def.weapon);
  hideByBones(root, def.hideBones);
  root.traverse((item) => {
    if (item instanceof THREE.Mesh) {
      item.frustumCulled = false;
    }
  });
  return root;
}
