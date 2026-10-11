// The local player's controls: keyboard and mouse become a PlayerInput, the
// player steps on it at a fixed rate, and the camera goes to their eye. What a
// player can do lives in @3d/shared/sim/; this is only the device side and the
// camera, so a remote player needs none of it.
//
// -- Why a fixed tick --------------------------------------------------------
//
// Friction and gravity integrate per step, so the same input stepped at 60 Hz
// and at 144 Hz does not land in the same place. A server re-simulating a
// client has to take the same steps it did, so the step length cannot be
// whatever the display happened to manage. Frames accumulate into ticks; the
// camera interpolates between the last two so a high refresh rate still looks
// like one.
//
// Two consequences that are easy to get wrong, and are handled below:
//
//   * Most frames run no tick at all. At 144 Hz with a 60 Hz tick, well over
//     half of them do. So devices are polled every frame and presses are
//     latched until a tick spends them — reading them inside the tick would
//     throw away any tap that landed on a tickless frame.
//   * The camera interpolates position only. Interpolating the view angles too
//     would add up to a tick of latency to aiming, which is felt immediately.

import * as THREE from "three";
import { idleInput, type PlayerInput } from "@3d/shared/sim/input.js";
import { clampPitch, EYE_HEIGHT, type CapsuleWorld, type Vec3 } from "@3d/shared/sim/movement.js";
import { ladderYaw } from "@3d/shared/sim/moves/ladder.js";
import { roundDt, roundInput } from "@3d/shared/net/messages/input.js";
import { TICK_RATE } from "@3d/shared/net/messages/fields.js";
import { Player, type PlayerState } from "@3d/shared/sim/player.js";
import { aimAngles, type Aim } from "@3d/shared/sim/recoil.js";
import { DEFAULT_SENSITIVITY, radiansPerCount } from "../../input/sensitivity.js";

type PlayerAction = "forward" | "back" | "left" | "right" | "run" | "jump" | "fire" | "ads" | "reload" | "swap" | "use";

const PLAYER_ACTIONS: readonly PlayerAction[] = ["forward", "back", "left", "right", "run", "jump", "fire", "ads", "reload", "swap", "use"];

/** The devices this reads. Satisfied by input/InputManager. */
export interface DeviceInput {
  readonly locked: boolean;
  isHeld(action: PlayerAction): boolean;
  takePressed(action: PlayerAction): boolean;
  takeLook(): { x: number; y: number };
}

/**
 * What a tick stepped on and where it left the feet, for whatever wants to send
 * it. Both objects are the simulation's own and are refilled next tick: a
 * listener copies what it wants to keep.
 */
export type TickListener = (input: PlayerInput, dt: number, feet: Readonly<Vec3>) => void;

/**
 * Ticks one frame may run. The frame dt is already capped at 1/20 s
 * (engine/viewer.ts), so three is the real ceiling at 60 Hz; this only stops a
 * pathological dt from turning into a spiral where catching up costs more time
 * than it recovers.
 */
const MAX_TICKS_PER_FRAME = 5;

/**
 * Metres a tick may move the feet before the camera stops interpolating and
 * snaps. A sprint covers under 0.1 m in a tick, so anything past this is a
 * respawn or a teleport, and lerping it would fly the camera across the map.
 */
const TELEPORT_DISTANCE = 1;

/**
 * How quickly a correction is absorbed into the camera, as an exponential time
 * constant in seconds.
 *
 * The simulation takes the server's answer *immediately* — there is no argument
 * about where the player is. What decays is only the difference between where
 * this client had drawn them and where they turn out to be, added to the camera
 * so a correction reads as a slight settle rather than a snap. A tenth of a
 * second is about two frames at 60 Hz of visible motion and is under the
 * threshold where it reads as lag.
 */
const SMOOTH_TAU = 0.1;

/** Below this a "correction" is f32 rounding on the wire, not a disagreement. Metres. */
const SMOOTH_FLOOR = 0.001;

export class FirstPersonControls {
  readonly player: Player;
  /** Radians the view turned this frame, yaw left and pitch up positive: the weapon's sway follows it. */
  readonly turn = { yaw: 0, pitch: 0 };
  /** Called when a movement key releases a held pose. */
  onUnfreeze: (() => void) | undefined;
  /** Called once per tick with what it stepped on. The net client sends it; nothing else listens. */
  onTick: TickListener | undefined;
  /** Whether this controller owns the camera; false while the dollhouse view does. */
  private active = true;
  private frozen = false;
  /**
   * This tick's command, refilled in place. Nothing holds a PlayerInput past the
   * step that reads it — `onTick` must copy what it wants to keep — and this runs
   * every tick.
   */
  private readonly command: PlayerInput = idleInput(0, 0);
  /**
   * The turn the mouse has asked for since the last tick spent it, in radians.
   *
   * Radians rather than the counts it arrives as, converted where it is read off
   * the device: the scale can change between a poll and the tick that spends it
   * (a scope coming up), and movement already made must not be re-scaled by it.
   */
  private readonly pending = { yaw: 0, pitch: 0 };
  /** Radians of view per count of mouse movement. See input/sensitivity.ts. */
  private radiansPerCount = radiansPerCount(DEFAULT_SENSITIVITY);
  /**
   * How far the view is zoomed in, as a factor on tan(fov / 2): 1 at the hip, and
   * under 1 down the sights. The aim is scaled by it.
   *
   * So the hand movement that sweeps the crosshair across the screen is the same
   * whatever the field of view — a 4x scope turns a quarter as fast, because it
   * covers a quarter as much world with the same pixels. Without it every gain in
   * magnification is a loss of the same factor in precision, which is exactly
   * backwards from what a scope is for. (CoD's "relative" ADS sensitivity, and a
   * monitor-distance coefficient of zero elsewhere.)
   */
  private zoom = 1;
  /** Presses seen on any frame since the last tick, so a tap between ticks is not lost. */
  private readonly pressed = new Set<PlayerAction>();
  private accumulator = 0;
  private tickDt = 1 / TICK_RATE;
  /** The feet before the most recent tick, and how far through to the next one we are drawing. */
  private readonly previousFeet: Vec3 = { x: 0, y: 0, z: 0 };
  /**
   * The view kick as the tick before last left it, and the kick the camera is
   * actually drawn with — interpolated between the two the way the feet are.
   *
   * Without this the kick is a **staircase**: it is simulation and moves once a
   * tick, but the camera is placed every frame, so at any refresh rate above the
   * tick rate the view holds still for two or three frames and then jumps. A
   * round's whole upward throw lasts about a tick and a half (`sim/recoil.ts`),
   * which is exactly the range where a staircase reads as a stutter rather than
   * as a kick.
   *
   * The player's own angles are deliberately *not* interpolated — a tick of
   * latency on the mouse is felt immediately and position is not. This is the
   * other case: the kick is not something the player is doing, and a round is
   * already traced along the kick as it stood *before* its own step
   * (docs/engine/player.md#trace-then-kick), so a camera drawn a fraction of a
   * tick behind the simulation is if anything closer to where the round went.
   */
  private readonly previousKick = { pitch: 0, yaw: 0 };
  private readonly drawnKick = { pitch: 0, yaw: 0 };
  private interpolating = false;
  /**
   * Where the camera still is relative to where the simulation says it should be,
   * decaying to nothing. Only ever added to the drawn position — never to the
   * state, which is exactly the server's.
   */
  private readonly smoothing: Vec3 = { x: 0, y: 0, z: 0 };
  /** Where the camera actually points: the view plus the gun's kick, refilled each frame. */
  private readonly aim: Aim = { yaw: 0, pitch: 0 };

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly input: DeviceInput,
    world: CapsuleWorld,
  ) {
    this.camera.rotation.order = "YXZ";
    this.player = new Player(world);
  }

  /** Whether the player is steering (the pointer is locked). */
  get enabled(): boolean {
    return this.active && this.input.locked;
  }

  setActive(active: boolean): void {
    this.active = active;
  }

  /** The player's mouse sensitivity, in the units `input/sensitivity.ts` defines. */
  setSensitivity(sensitivity: number): void {
    this.radiansPerCount = radiansPerCount(sensitivity);
  }

  /** The view's current zoom, which the aim is scaled by. See `zoom`. */
  setZoom(zoom: number): void {
    this.zoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  }

  /**
   * Match a server's tick. It sends its rate in `joined` rather than both ends
   * compiling one in, so that a server may run at something other than 60 Hz
   * without a client rebuild.
   */
  setTickRate(hz: number): void {
    if (hz > 0 && Number.isFinite(hz)) {
      this.tickDt = 1 / hz;
    }
  }

  /** The rate the simulation is stepped at, whatever the server said. */
  get tickRate(): number {
    return 1 / this.tickDt;
  }

  /**
   * Hold the player exactly still (no input, gravity, collision or weapon), so
   * a captured pose renders identically every run. Looking around is allowed;
   * any movement key releases it.
   */
  setFrozen(frozen: boolean): void {
    this.frozen = frozen;
  }

  get isFrozen(): boolean {
    return this.frozen;
  }

  /**
   * The player has just been placed: a world mounted, a pose link, a teleport.
   *
   * Everything measured against the old position is dropped. The interpolation
   * state, or the camera slides in across the map from wherever it last was.
   * And any input the devices are holding: the frame loop is stopped while a
   * world loads, so nothing drains `takeLook()` in that time, and the first
   * frame after it starts would otherwise turn the view by every pixel the
   * mouse moved over the loading screen.
   */
  arrive(): void {
    this.accumulator = 0;
    this.interpolating = false;
    this.smoothing.x = this.smoothing.y = this.smoothing.z = 0;
    this.pending.yaw = this.pending.pitch = 0;
    this.pressed.clear();
    this.input.takeLook();
    this.previousFeet.x = this.player.movement.feet.x;
    this.previousFeet.y = this.player.movement.feet.y;
    this.previousFeet.z = this.player.movement.feet.z;
    this.holdKick();
  }

  /** Put the camera at the player now rather than on the next frame. */
  snapCamera(): void {
    this.placeCamera(1);
  }

  /**
   * Take the server's answer, and redo everything it has not seen yet.
   *
   * The whole `PlayerState`, not just the movement: the server owns the ammo, the
   * weapon in hand and (soon) the health, so adopting half of it would leave this
   * client predicting a magazine nobody else believes in.
   *
   * Then every input sent since the server's `ack`, in order, with the `dt` it was
   * sent with — the same `player.step` the original prediction used, so replaying
   * is not a second implementation of anything. At 100 ms that is about six steps
   * a snapshot; `stepMovement` is microseconds and already runs sixty times a
   * second.
   *
   * What is *not* special-cased is the view angles, and that is worth knowing:
   * replaying re-applies this client's own `yaw`/`pitch` from its own inputs, so
   * after a correction the player is looking exactly where they were looking. A
   * correction cannot fight the mouse. With nothing left to replay the server's
   * angles stand, and they came from this client's last input anyway.
   */
  reconcile(state: PlayerState, pending: readonly { input: PlayerInput; dt: number }[]): void {
    const before = this.player.movement.feet;
    const predicted = { x: before.x, y: before.y, z: before.z };

    this.player.restore(state);
    for (const { input, dt } of pending) {
      this.player.step(input, dt);
    }

    const { feet } = this.player.movement;
    const error = { x: predicted.x - feet.x, y: predicted.y - feet.y, z: predicted.z - feet.z };

    // Past this it is a placement, not a correction: a respawn, a teleport, or a
    // client that has been out of touch long enough to be somewhere else
    // entirely. Sliding the camera across the map is worse than cutting to it.
    if (Math.abs(error.x) > TELEPORT_DISTANCE || Math.abs(error.y) > TELEPORT_DISTANCE || Math.abs(error.z) > TELEPORT_DISTANCE) {
      this.arrive();
      return;
    }

    // Accumulated, not replaced: corrections arrive faster than this decays, and
    // overwriting would make each one restart the settle from wherever the last
    // had got to.
    this.smoothing.x += error.x;
    this.smoothing.y += error.y;
    this.smoothing.z += error.z;

    // The tick's own interpolation is measured from here, and `feet` has just
    // moved: leaving it would slide the camera from the old prediction to the new
    // answer, which is the very motion `smoothing` exists to own.
    this.previousFeet.x = feet.x;
    this.previousFeet.y = feet.y;
    this.previousFeet.z = feet.z;
  }

  update(dt: number): void {
    this.turn.yaw = this.turn.pitch = 0;
    if (!this.active) {
      return;
    }

    this.poll();

    // A held pose looks around and does nothing else, including not accumulating
    // time: releasing it should not spend a backlog of ticks all at once.
    if (this.frozen) {
      if (
        this.pressed.has("forward") ||
        this.pressed.has("back") ||
        this.pressed.has("left") ||
        this.pressed.has("right") ||
        this.pressed.has("jump") ||
        this.movementHeld()
      ) {
        this.frozen = false;
        this.onUnfreeze?.();
      } else {
        this.player.look(this.viewYaw(), this.viewPitch());
        this.pending.yaw = this.pending.pitch = 0;
        this.pressed.clear();
        this.decaySmoothing(dt);
        this.placeCamera(0);
        return;
      }
    }

    // Per frame rather than per tick: it is a drawing quantity, and a frame that
    // runs no tick should still see it settle.
    this.decaySmoothing(dt);

    this.accumulator += dt;
    let ticks = 0;
    while (this.accumulator >= this.tickDt && ticks < MAX_TICKS_PER_FRAME) {
      this.accumulator -= this.tickDt;
      this.tick();
      ticks++;
    }
    if (ticks === MAX_TICKS_PER_FRAME) {
      this.accumulator = 0; // gave up catching up; better a lost moment than a spiral
    }

    this.placeCamera(this.accumulator / this.tickDt);
  }

  /**
   * Devices into latches, every frame. Presses are edges and would be lost on a
   * frame that runs no tick; held keys are levels and are read at tick time.
   */
  private poll(): void {
    const look = this.input.takeLook();
    const before = this.viewPitch();
    const scale = this.radiansPerCount * this.zoom;
    this.pending.yaw += look.x * scale;
    this.pending.pitch += look.y * scale;
    this.turn.yaw = -look.x * scale;
    // From the clamped angles, so looking into the ceiling stops the gun too.
    this.turn.pitch = this.viewPitch() - before;

    for (const action of PLAYER_ACTIONS) {
      if (this.input.takePressed(action)) {
        this.pressed.add(action);
      }
    }
    if (!this.enabled) {
      this.pressed.clear();
    }
  }

  /** One fixed step: build the command, round it to what the wire would carry, step, hand it on. */
  private tick(): void {
    const input = this.readInput();

    // The symmetry rule (@3d/shared/net/packet.ts): quantized fields are lossy,
    // so a client must predict with the value the server will decode, not with
    // the one the mouse produced. Done whether or not anything is connected, so
    // that being online never changes how the game plays.
    const rounded = roundInput(input);
    const dt = roundDt(this.tickDt);

    this.previousFeet.x = this.player.movement.feet.x;
    this.previousFeet.y = this.player.movement.feet.y;
    this.previousFeet.z = this.player.movement.feet.z;
    this.holdKick();

    this.player.step(rounded, dt);

    this.pending.yaw = this.pending.pitch = 0;
    this.pressed.clear();
    this.interpolating = true;

    this.onTick?.(rounded, dt, this.player.movement.feet);
  }

  /**
   * The view angles as of now: the player's, plus the mouse movement no tick has
   * spent yet. Derived from the player rather than tracked separately so that a
   * respawn or a teleport, which moves the sim's angles, carries the view with it.
   *
   * **This is intent, and the gun's kick is not in it.** `readInput` sends it as
   * `PlayerInput.yaw`, `stepMovement` assigns that straight to `movement.yaw`,
   * and this reads `movement.yaw` back — so a kick added here would be read as
   * intent on the next tick and climb until the gun pointed at the ceiling. The
   * kick is added once, at the camera, in `placeCamera`.
   */
  private viewYaw(): number {
    const movement = this.player.movement;
    return ladderYaw(movement, movement.yaw - this.pending.yaw);
  }

  private viewPitch(): number {
    return clampPitch(this.player.movement.pitch - this.pending.pitch);
  }

  /** This tick's keys and mouse as a PlayerInput; nothing held while the pointer is free. */
  private readInput(): PlayerInput {
    const c = this.command;
    c.yaw = this.viewYaw();
    c.pitch = this.viewPitch();
    if (!this.enabled) {
      c.forward = c.right = 0;
      c.run = c.jump = c.fire = c.ads = c.reload = c.swap = c.use = false;
      return c;
    }
    c.forward = this.axis("forward", "back");
    c.right = this.axis("right", "left");
    c.run = this.down("run");
    c.jump = this.down("jump");
    c.fire = this.down("fire");
    c.ads = this.down("ads");
    c.reload = this.pressed.has("reload"); // an edge, never a level
    c.swap = this.pressed.has("swap"); // likewise: holding the key swaps once
    c.use = this.down("use"); // a level: the server takes its rising edge, so a tap between ticks still counts
    return c;
  }

  /** A press counts even when released before this tick: a quick tap is not lost between ticks. */
  private down(action: PlayerAction): boolean {
    return this.pressed.has(action) || this.input.isHeld(action);
  }

  /** Only while steering: a key pressed with the pointer free is not the player asking to move. */
  private movementHeld(): boolean {
    return (
      this.enabled &&
      (this.input.isHeld("forward") || this.input.isHeld("back") || this.input.isHeld("left") || this.input.isHeld("right") || this.input.isHeld("jump"))
    );
  }

  private axis(plus: PlayerAction, minus: PlayerAction): number {
    return Number(this.down(plus)) - Number(this.down(minus));
  }

  /**
   * `alpha` is how far past the last tick this frame is drawing. Position is
   * interpolated; the angles are the live ones, so aiming never lags the mouse.
   */
  /** Exponential, and snapped to zero once it is under the wire's own rounding. */
  private decaySmoothing(dt: number): void {
    const s = this.smoothing;
    if (s.x === 0 && s.y === 0 && s.z === 0) {
      return;
    }
    const k = Math.exp(-dt / SMOOTH_TAU);
    s.x *= k;
    s.y *= k;
    s.z *= k;
    if (Math.abs(s.x) < SMOOTH_FLOOR && Math.abs(s.y) < SMOOTH_FLOOR && Math.abs(s.z) < SMOOTH_FLOOR) {
      s.x = s.y = s.z = 0;
    }
  }

  /** The kick as it stands now, kept so the next frame can draw between it and the next tick's. */
  private holdKick(): void {
    const kick = this.player.weapon?.data.viewKick;
    this.previousKick.pitch = kick?.pitch ?? 0;
    this.previousKick.yaw = kick?.yaw ?? 0;
  }

  private placeCamera(alpha: number): void {
    const { feet } = this.player.movement;
    const previous = this.previousFeet;
    const far =
      Math.abs(feet.x - previous.x) > TELEPORT_DISTANCE ||
      Math.abs(feet.y - previous.y) > TELEPORT_DISTANCE ||
      Math.abs(feet.z - previous.z) > TELEPORT_DISTANCE;
    const t = this.interpolating && !far ? Math.min(alpha, 1) : 1;

    // Plus whatever is left of the last correction, which is the only place it is
    // ever applied: the simulation is already exactly what the server said.
    this.camera.position.set(
      previous.x + (feet.x - previous.x) * t + this.smoothing.x,
      previous.y + (feet.y - previous.y) * t + EYE_HEIGHT + this.smoothing.y,
      previous.z + (feet.z - previous.z) * t + this.smoothing.z,
    );
    // The one place the *view* kick is applied on this end — the gun kick is not
    // the aim and belongs to the viewmodel. It never reaches the input: a client
    // sends its *intent* and nothing else, which is what leaves the server owning
    // the half of the aim it can own — it cannot reproduce a mouse, so it bounds
    // intent and computes the kick itself.
    const kick = this.player.weapon?.data.viewKick;
    // Between the tick before last and this one, on the same `t` the feet use, so
    // a frame that ran no tick still draws the kick moving. `t` is 1 after a
    // teleport or before the first tick, which is the live value either way.
    this.drawnKick.pitch = this.previousKick.pitch + ((kick?.pitch ?? 0) - this.previousKick.pitch) * t;
    this.drawnKick.yaw = this.previousKick.yaw + ((kick?.yaw ?? 0) - this.previousKick.yaw) * t;
    const aim = aimAngles({ yaw: this.viewYaw(), pitch: this.viewPitch() }, kick ? this.drawnKick : null, this.aim);
    this.camera.rotation.set(aim.pitch, aim.yaw, 0);
  }
}
