// The first-person viewmodel: hands and weapon drawn over the world in a pass of
// their own (own scene, camera and field of view, depth cleared first). So they
// never clip into a wall, and nothing that keeps a built world static (frozen
// matrices, instancing, the collision BVH, the shadow map, picking) ever sees
// them. docs/engine/rendering.md#the-viewmodel.

import * as THREE from "three";
import type { ViewmodelRig } from "../scene/viewmodel.js";
import { keepAlpha } from "../scene/importedMaterials.js";
import { horizontalSpeed, type MovementState } from "@3d/shared/sim/movement.js";
import { releaseRig } from "@3d/shared/rig/release.js";
import type { WeaponController, WeaponEvent } from "@3d/shared/sim/weapon.js";
import { scaleFov } from "./viewer.js";
import { WeaponMotion, type MotionFrame, type MotionPose } from "./weaponMotion.js";
import type { RenderPass } from "./render/pipeline.js";

/** The game's default `cg_fov`, which its viewmodels are posed for: horizontal degrees at 4:3. */
export const COD_FOV = 65;
/** Hands reach within centimetres of the eye in a reload; the world camera's 10 cm would cut them. */
const NEAR = 0.01;
const FAR = 10;

/** `cg_fov` (horizontal at 4:3, widened with the screen) as a vertical field of view in degrees. */
export function codFovToVertical(fov: number): number {
  return scaleFov(fov, 3 / 4);
}

/**
 * The world's sun and ambient lights, for the viewmodel's scene. Each sun copy
 * shares its source's shadow (the same map and matrix): the rig is drawn at the
 * eye's world position, so it is shadowed exactly where the world is, and it is
 * never drawn into the map, since the map only renders with the world pass. The
 * shadow three's constructor builds for the copy is dropped on the floor — it
 * has no render target yet, and there is no way to ask for a light without one.
 */
export function copyLights(root: THREE.Object3D): THREE.Light[] {
  const out: THREE.Light[] = [];
  root.traverse((o) => {
    if (o instanceof THREE.DirectionalLight) {
      const light = new THREE.DirectionalLight(o.color, o.intensity);
      // The shadow fit moves the source but never turns it, so its direction is copied once.
      light.position.copy(o.getWorldPosition(new THREE.Vector3()));
      light.target.position.copy(o.target.getWorldPosition(new THREE.Vector3()));
      light.castShadow = o.castShadow;
      light.shadow = o.shadow;
      out.push(light);
    } else if (o instanceof THREE.AmbientLight || o instanceof THREE.HemisphereLight) {
      out.push(o.clone());
    }
  });
  return out;
}

/** What the viewmodel follows each frame. */
export interface ViewFrame {
  /** The world camera: its orientation and aspect. */
  camera: THREE.PerspectiveCamera;
  /** Radians the view turned since the last frame (yaw left, pitch up positive). */
  turn: { yaw: number; pitch: number };
  /** The player's movement, for the walk bob and the jolt of a jump or landing. */
  movement: Readonly<MovementState>;
}

const NO_TURN = { yaw: 0, pitch: 0 };
/** A weapon at rest, for the frame before one is held. */
const NO_KICK = { pitch: 0, yaw: 0 };

/**
 * The scope picture, drawn over the whole frame at full aim.
 *
 * **One full-screen quad, multiplied.** That is the game's own blend
 * (`scope_overlay_us_iw5` is `srcBlend zero, dstBlend srccolor`): the picture is
 * a white circle on black, so multiplying it onto the frame keeps what is inside
 * the circle and takes everything else to the tube's black. The reticle is drawn
 * into the picture, so there is nothing else to place.
 *
 * **The picture is a square of the screen's height, centred**, and the quad is
 * the whole screen — the UVs are what make the square. Its edge pixels are black
 * and the texture is clamped, so the black to either side of the tube costs
 * nothing to draw and needs no second quad. The game's own `adsOverlayWidth`
 * and `adsOverlayHeight` are 480 x 480 in a 640 x 480 virtual screen for every
 * overlay in both games, which is that same square on any aspect, so they are
 * not carried.
 *
 * Nothing here is tone-mapped: the output pass has already written encoded
 * colour, and this multiplies onto it the way the game multiplies onto a
 * finished frame.
 */
class Scope {
  private readonly scene = new THREE.Scene();
  /** The whole framebuffer, in clip space: no projection to set up and none to resize. */
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly material = new THREE.MeshBasicMaterial({
    // ZERO/SRC_COLOR by hand rather than THREE.MultiplyBlending, and the alpha
    // left alone: this covers the whole frame, so multiplying the canvas's alpha
    // by the picture's would show the page through the tube. See keepAlpha.
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.ZeroFactor,
    blendDst: THREE.SrcColorFactor,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    transparent: true,
  });
  private aspect = 0;

  constructor() {
    keepAlpha(this.material);
    this.scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material));
  }

  get ready(): boolean {
    return this.material.map !== null;
  }

  /** Look through `texture`, or through nothing. The texture belongs to the world's AssetStore, so it is not disposed here. */
  use(texture: THREE.Texture | undefined): void {
    this.material.map = texture ?? null;
    this.material.needsUpdate = true;
    this.aspect = 0;
  }

  render(renderer: THREE.WebGLRenderer): void {
    const map = this.material.map;
    if (!map) {
      return;
    }
    const size = renderer.getSize(new THREE.Vector2());
    const aspect = size.height > 0 ? size.width / size.height : 1;
    if (aspect !== this.aspect) {
      // The picture spans the height, so it covers 1 / aspect of the width;
      // across the full quad u therefore runs `aspect` wide, centred on it.
      this.aspect = aspect;
      map.repeat.set(aspect, 1);
      map.offset.set((1 - aspect) / 2, 0);
    }
    renderer.render(this.scene, this.camera);
  }

  /** Compile the quad's program, once there is a picture to draw. */
  async prewarm(renderer: THREE.WebGLRenderer): Promise<void> {
    if (this.ready) {
      await renderer.compileAsync(this.scene, this.camera);
    }
  }
}

export class Viewmodel {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(codFovToVertical(COD_FOV), 1, NEAR, FAR);
  /** Drawn at all (walk mode, and not hidden by the dev toggle). */
  visible = true;
  /** The arms stand still (a held pose, the animation toggle). The weapon itself runs on with the player. */
  paused = false;

  /** Follows the world camera (the rig hangs under it, eye at its origin), so the rig is where the player's eye is. */
  private readonly view = new THREE.Group();
  /** The procedural motion, about the eye. */
  private readonly motionPivot = new THREE.Group();
  /** The scope picture and the camera that draws it over the whole frame; both exist whether or not one is fitted. */
  private readonly scope = new Scope();
  private rig: ViewmodelRig | undefined;
  /** The player's weapon, which this draws: it plays the clips the weapon's events ask for. */
  private weapon: WeaponController | undefined;
  private mixer: THREE.AnimationMixer | undefined;
  private actions = new Map<string, THREE.AnimationAction>();
  private current: THREE.AnimationAction | undefined;
  private adsAction: THREE.AnimationAction | undefined;
  private motion: WeaponMotion | undefined;
  private lights: THREE.Light[] = [];
  /** What the motion model is asked for each frame, and where it answers; both refilled in place. */
  private readonly motionFrame: MotionFrame = { dt: 0, turn: NO_TURN, speed: 0, grounded: false, climb: 0, ads: 0, kick: NO_KICK };
  private readonly motionPose: MotionPose = { x: 0, y: 0, z: 0, pitch: 0, yaw: 0, roll: 0 };
  private wasPaused = false;
  private unsubscribe: (() => void) | undefined;
  private readonly baseFov = codFovToVertical(COD_FOV);

  constructor() {
    this.scene.add(this.view);
    this.view.add(this.motionPivot);
  }

  /**
   * Draw `weapon` (the player's, built from `rig.def`) with `rig`, lit by
   * `lights` (see copyLights). `overlay` is the scope picture for the weapon as
   * it is fitted, where it has one — the AssetStore's, so the world it belongs
   * to frees it.
   */
  attach(rig: ViewmodelRig, lights: THREE.Light[], weapon: WeaponController, overlay?: THREE.Texture): void {
    this.clear();
    this.rig = rig;

    // CoD's forward (+X, which OAT's axis change leaves as +X) must face the camera's -Z,
    // and the eye sits at the origin: turn a quarter about Y, then pull the eye back to it.
    const holder = new THREE.Group();
    holder.rotation.y = Math.PI / 2;
    rig.root.position.set(0, 0, 0);
    rig.root.updateMatrixWorld(true);
    rig.root.position.copy(rig.root.worldToLocal(rig.eye.getWorldPosition(new THREE.Vector3())).negate());
    holder.add(rig.root);
    this.motionPivot.add(holder);
    this.lights = lights;
    for (const light of lights) {
      this.scene.add(light, ...(light instanceof THREE.DirectionalLight ? [light.target] : []));
    }

    this.mixer = new THREE.AnimationMixer(rig.root);
    const adsClip = rig.def.roles.adsUp ? rig.clips.get(rig.def.roles.adsUp) : undefined;
    if (adsClip) {
      // The ADS clips move tag_ads alone, a joint no other clip keys, so it layers over any of them.
      this.adsAction = this.mixer.clipAction(adsClip);
      this.adsAction.setLoop(THREE.LoopOnce, 1);
      this.adsAction.clampWhenFinished = true;
      this.adsAction.play().paused = true;
    }

    this.motion = new WeaponMotion(rig.def.motion);
    this.scope.use(overlay);
    this.weapon = weapon;
    this.unsubscribe = weapon.on((e) => this.onWeaponEvent(e));
    this.showWeaponClip();
    this.mixer.update(0);
  }

  /** Let go of the rig and stop following the weapon. Its geometry and materials belong to the world's AssetStore. */
  clear(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.rig && this.mixer) {
      this.mixer.stopAllAction();
      this.mixer.uncacheRoot(this.rig.root);
      releaseRig(this.rig.root);
    }
    this.motionPivot.clear();
    this.scope.use(undefined);
    // Not disposed: a sun copy's shadow is the world light's.
    for (const light of this.lights) {
      this.scene.remove(light, ...(light instanceof THREE.DirectionalLight ? [light.target] : []));
    }
    this.lights = [];
    this.actions.clear();
    this.rig = this.mixer = this.current = this.adsAction = this.motion = this.weapon = undefined;
  }

  /**
   * How much the sights zoom the view, as a factor on tan(fov / 2): 1 at the hip.
   *
   * **A scope snaps and a sight ramps**, which is the games' own split rather
   * than two tunings of one thing.
   *
   * A weapon with an `adsOverlay` is looked *through*: at full aim the picture
   * replaces the hands and the gun entirely (`scoped`), and the world behind it
   * is the magnified view its reticle was drawn for. Ramping the field of view
   * up to that over the ADS time would show the receiver filling fifteen degrees
   * on the way, and would put the picture's first frame over a view at some other
   * magnification. So the zoom arrives in the same instant the picture does, and
   * leaves with it.
   *
   * Irons, red dots and holographics have no picture — the gun stays on screen
   * and the eye moves to it — and those zoom along the `ads` ramp, which is what
   * makes a 1.1x sight feel like leaning into it rather than a cut.
   */
  get zoom(): number {
    const fov = this.rig?.def.adsZoomFov;
    if (!this.weapon || !fov) {
      return 1;
    }
    const full = Math.tan(THREE.MathUtils.degToRad(fov / 2)) / Math.tan(THREE.MathUtils.degToRad(COD_FOV / 2));
    if (this.scope.ready) {
      return this.scoped ? full : 1;
    }
    return 1 + (full - 1) * this.weapon.data.ads;
  }

  /** Pose the arms for this frame, after the player has stepped. */
  update(dt: number, frame: ViewFrame): void {
    if (!this.rig || !this.weapon || !this.mixer || !this.motion) {
      return;
    }
    // The weapon ran on while the arms stood still: catch up with the clip it is in.
    if (this.wasPaused && !this.paused) {
      this.showWeaponClip();
    }
    this.wasPaused = this.paused;
    const step = this.paused ? 0 : dt;
    if (this.adsAction) {
      this.adsAction.time = this.weapon.data.ads * this.adsAction.getClip().duration;
    }
    this.mixer.update(step);

    const { movement } = frame;
    const f = this.motionFrame;
    f.dt = step;
    f.turn = this.paused ? NO_TURN : frame.turn;
    f.speed = horizontalSpeed(movement);
    f.grounded = movement.grounded;
    f.climb = movement.velocity.y;
    f.ads = this.weapon.data.ads;
    f.kick = this.weapon.data.kick;
    const pose = this.motion.update(f, this.motionPose);
    this.motionPivot.position.set(pose.x, pose.y, pose.z);
    this.motionPivot.rotation.set(pose.pitch, pose.yaw, pose.roll, "YXZ");

    // The rig hangs off the world camera, which already carries the weapon's
    // *view* kick (`aimAngles`): the gun rises with the view rather than inside
    // it, and adding that kick here as well would apply it twice. The gun kick is
    // the other family and is the one thing this rig does add, above.
    this.view.position.copy(frame.camera.position);
    this.view.quaternion.copy(frame.camera.quaternion);
    this.camera.position.copy(frame.camera.position);
    this.camera.quaternion.copy(frame.camera.quaternion);
    const fov = scaleFov(this.baseFov, this.zoom);
    if (this.camera.aspect !== frame.camera.aspect || this.camera.fov !== fov) {
      this.camera.aspect = frame.camera.aspect;
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }

  /**
   * Whether the player is looking through a scope rather than over the gun.
   *
   * All or nothing at full aim, as the game is: this is the moment the picture
   * replaces the weapon, and a scoped rifle that faded between the two would
   * show the receiver filling a 15° field of view on the way. Not while the
   * picture is still loading, or the player would aim at a blank screen.
   */
  private get scoped(): boolean {
    return this.scope.ready && this.weapon !== undefined && this.weapon.data.ads >= 1;
  }

  /**
   * The pipeline's "viewmodel" pass, last: draws over the finished frame on the
   * canvas with its depth cleared. Scoped, the picture is drawn *instead of* the
   * hands and the gun, multiplied onto that frame — the scope's tube is black in
   * the image, so multiplying is what makes it a tube.
   */
  readonly pass: RenderPass = {
    scene: this.scene,
    render: ({ renderer }) => {
      renderer.setRenderTarget(null);
      this.render(renderer);
    },
    prewarm: async ({ renderer }) => {
      if (this.rig) {
        await renderer.compileAsync(this.scene, this.camera);
        await this.scope.prewarm(renderer);
      }
    },
  };

  private render(renderer: THREE.WebGLRenderer): void {
    if (!this.rig || !this.visible) {
      return;
    }
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    if (this.scoped) {
      this.scope.render(renderer);
    } else {
      renderer.clearDepth();
      renderer.render(this.scene, this.camera);
    }
    renderer.autoClear = autoClear;
  }

  /** One line for the debug readout. */
  describe(): string | undefined {
    const d = this.weapon?.data;
    if (!d || !this.rig) {
      return undefined;
    }
    const { def } = this.rig;
    const ads = d.ads > 0 ? ` · ads ${d.ads.toFixed(2)}` : "";
    const clip = d.clip ? ` · ${def.roles[d.clip.role]} ${d.clip.time.toFixed(2)}s` : "";
    return `${def.weapon} ${d.state} ${d.ammo}/${def.clipSize}${ads}${this.scoped ? " · scoped" : ""}${clip}`;
  }

  private onWeaponEvent(e: WeaponEvent): void {
    if (e.type === "play") {
      this.play(e.clip, e.time, e.rate, e.loop, e.fade);
    }
  }

  /** Cut to the clip the weapon is in, where it is: on attaching, and after a pause. */
  private showWeaponClip(): void {
    const c = this.weapon?.data.clip;
    const name = c && this.rig?.def.roles[c.role];
    if (c && name) {
      this.play(name, c.time, c.rate, c.loop, 0);
    }
  }

  /** Start `name` `time` seconds in, crossfading from the clip before over `fade` seconds (0 cuts). */
  private play(name: string, time: number, rate: number, loop: boolean, fade: number): void {
    const clip = this.rig?.clips.get(name);
    if (!clip || !this.mixer) {
      return;
    }
    let action = this.actions.get(name);
    if (!action) {
      action = this.mixer.clipAction(clip);
      this.actions.set(name, action);
    }
    action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    action.clampWhenFinished = true;
    const previous = this.current;
    action.reset();
    action.time = time;
    action.timeScale = rate;
    action.play();
    if (previous && previous !== action) {
      if (fade > 0) {
        action.crossFadeFrom(previous, fade, false);
      } else {
        previous.stop();
      }
    }
    this.current = action;
  }
}
