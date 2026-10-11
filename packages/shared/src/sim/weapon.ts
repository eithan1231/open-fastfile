// A held weapon's gameplay state: what it is doing, its ammunition, its aim
// (ADS), and which clip should be playing and how fast. Commands in (`setInput`,
// `reload`, ...), events out (`on`), and no three.js: input drives it now and
// scripts will drive it the same way. engine/viewmodel.ts turns its `play`
// events into mixer actions. States last as long as the weapon file says
// (`reloadTime`, ...), and a clip plays at whatever rate fits it into its state.
// So a weapon's rate of fire is `fireTime`, plus `rechamberTime` where it has an
// action to work between shots — never the length of its fire clip.

import type { ClipRole, WeaponDef, WeaponTimes } from "./weaponDef.js";
import {
  addKick,
  addViewKick,
  stepViewKick,
  decayKick,
  restingKick,
  restingViewKick,
  shotStream,
  stepSpread,
  HOLDER_AT_REST,
  type Holder,
  type KickState,
  type ViewKick,
} from "./recoil.js";
import type { DeepReadonly } from "./readonly.js";

/**
 * Every state a weapon can be in. A list rather than a bare union because the
 * wire format encodes a state as its index here (net/messages/player.ts): the order is
 * part of the protocol, so append rather than insert.
 */
export const WEAPON_STATES = [
  "lowered",
  "raising",
  "idle",
  "firing",
  "reloading",
  "sprintIn",
  "sprinting",
  "sprintOut",
  "dropping",
  "rechambering",
  "reloadStart",
  "reloadEnd",
] as const;

export type WeaponState = (typeof WEAPON_STATES)[number];

/** What the holder is asking for, held from frame to frame: the part of the state a client sends. */
export interface WeaponInput {
  trigger: boolean;
  ads: boolean;
  /** Run held while moving forward. */
  sprint: boolean;
}

/**
 * A held weapon's whole state, as plain JSON-safe data: what a network sends and
 * a test compares. The controller keeps nothing else (tests/weapon.test.ts checks
 * that a copy runs in lockstep), and what the weapon file fixes (clip names and
 * lengths, notes, fire type) is looked up in the WeaponDef, not copied in.
 */
export interface WeaponData {
  state: WeaponState;
  input: WeaponInput;
  /** Seconds left in a timed state (raising, reloading, sprint in/out, dropping). */
  timer: number;
  /**
   * What `timer` started at when this state was entered.
   *
   * Carried because a countdown alone cannot say how far through anything is, and
   * a third-person body has to: the torso plays a reload clip stretched to fit
   * `reloadTime`, so `(span - timer) / span` is the only way to place it. Nothing
   * else needs it — a viewmodel plays its own clip and times itself.
   */
  span: number;
  ammo: number;
  /** Seconds until the next shot may fire. */
  cooldown: number;
  /** The trigger went down since the last shot it paid for: single-shot and burst weapons fire once per press. */
  pressed: boolean;
  burstLeft: number;
  /** How far into the sights, 0 (hip) to 1. */
  ads: number;
  /** A reload was asked for while the weapon could not start one (a shot not yet interruptible, a raise); it starts when it can. */
  reloadQueued: boolean;
  /** Counting down through a reload, the `timer` at which the magazine refills; null once it has. */
  refillAt: number | null;
  /**
   * How many rounds this weapon has fired, counted in 16 bits and wrapping.
   *
   * State rather than an event, because **this is what tells a server a shot
   * happened**: it replays a client's input and sees the counter advance, so the
   * state machine here — rate of fire, magazine, reload, burst — is the only
   * thing that can authorize one, and there is no "I fired" message to forge. A
   * listener could not stand in for it: `Player.equip`/`equipById`/`restore`
   * each replace the controller and would drop the subscription in silence.
   *
   * A count rather than a flag because the number identifies the shot, which is
   * what a seeded spread cone and recoil key on, and because a reader takes the
   * difference across a step: one `update` fires at most one round today, but
   * nothing downstream has to assume that.
   */
  fired: number;
  /**
   * How hot this weapon has become, 0 (settled) to 1 (as wide as it opens):
   * `fireAdd` a shot and `moveAdd` while moving, decaying at `decayRate`, and
   * neither add while fully aimed (sim/recoil.ts).
   *
   * A fraction and **not** an angle. The cone in degrees is `shotSpread`, which
   * reads this against the weapon's own min and max — the weapon files write all
   * three of those rates as fractions of that range, so keeping degrees here
   * would mean converting back and forth around a number nothing else wants.
   */
  spread: number;
  /**
   * Where the *model* has been kicked to in the hands, and how fast it is still
   * moving. A drawing effect: engine/weaponMotion.ts rocks the viewmodel with it
   * and nothing judges a shot by it. Still state rather than a client's own, so
   * that a corrected client rocks the gun the way the tick it was given did.
   */
  kick: KickState;
  /**
   * Where the **aim** has been punched to, and what a shot's direction is bent by
   * (`aimAngles`). This is the recoil a player fights, and the one the server has
   * to agree about. It is never added into `movement.yaw`: an input carrying its
   * own kick is read back as intent on the next step and climbs.
   */
  viewKick: ViewKick;
  /** The clip playing, by role (the WeaponDef names the clip), and seconds into it. */
  clip: { role: ClipRole; time: number; rate: number; loop: boolean } | null;
}

export type WeaponEvent =
  /** Start `clip` `time` seconds in: at `rate`, looping or holding its last frame, crossfading over `fade` seconds (0 cuts). */
  | { type: "play"; clip: string; role: ClipRole; time: number; rate: number; loop: boolean; fade: number }
  /** A notetrack in the playing clip: a sound cue, a rumble, or an event such as `interruptible`. */
  | { type: "note"; name: string; clip: string }
  | { type: "shot"; ammo: number }
  | { type: "reloaded"; ammo: number }
  | { type: "state"; state: WeaponState; previous: WeaponState };

export type WeaponListener = (event: WeaponEvent) => void;

/** Seconds a clip change blends over. The game's blend times are not in the weapon file. */
export const CROSSFADE = 0.12;
/** Seconds into or out of the sights when the weapon file gives no `adsTransInTime`/`adsTransOutTime`. */
const FALLBACK_ADS_TIME = 0.3;
/** What the sights take to drop for a reload with aim still held, where the weapon file gives no `adsReloadTransTime`. */
const FALLBACK_ADS_RELOAD_OUT = 0.3;
/** Where the sights can come up. Coming out of a sprint counts, so aiming from a run is one motion, not two. */
const ADS_STATES: readonly WeaponState[] = ["idle", "firing", "sprintOut", "rechambering"];
const FIRE_ROLES: readonly ClipRole[] = ["fire", "lastShot", "adsFire", "adsLastShot"];
const SPRINT_STATES: readonly WeaponState[] = ["sprintIn", "sprinting", "sprintOut"];
/**
 * Where a trigger press can still be spent.
 *
 * Anywhere else a press is *dropped* rather than banked: holding or tapping fire
 * through a reload, a bolt or a weapon coming up must not loose a round the
 * instant it ends, which is what `pressed` surviving those states did. The games
 * make you press again. Full automatic fire is unaffected — it reads the
 * trigger's level (`perPress === 0`) and so does resume on its own.
 */
const FIRE_STATES: readonly WeaponState[] = ["idle", "firing", "sprintIn", "sprinting", "sprintOut"];
/** Where a reload can start. `update` calls `reload` every frame while one is queued, so this is not rebuilt per call. */
const RELOAD_FROM: readonly WeaponState[] = ["idle", "firing", "sprintIn", "sprinting", "sprintOut", "rechambering"];
/** The three halves of a segmented reload, and the one state a magazine reload uses (`reloading`). */
const RELOAD_STATES: readonly WeaponState[] = ["reloadStart", "reloading", "reloadEnd"];

/** Shots one trigger press fires: every shot while held (0), one, or a burst. */
function shotsPerPress(fireType: string): number {
  if (/full auto/i.test(fireType)) {
    return 0;
  }
  const burst = /(\d+)-round burst/i.exec(fireType);
  return burst ? Number(burst[1]) : 1;
}

/**
 * What `WeaponData` may hold, which is what the wire carries it in
 * (net/messages/player.ts builds its fields from these). A weapon file outside
 * them is refused where it is loaded (`checkWeaponLimits`), because the
 * alternative is a snapshot that throws or saturates in the middle of a match.
 */
export const MAX_CLIP_SIZE = 1023;
export const MAX_BURST = 15;
/** Seconds: the longest a timed state, or the clip that times one, may last. */
export const MAX_STATE_TIME = 16;
/** Seconds between two shots. */
export const MAX_FIRE_TIME = 4;
/** How far a clip may be sped up to fit its state. A faster one plays at this and is cut short. */
export const MAX_CLIP_RATE = 8;

/**
 * Throw, naming `who`, for a weapon file — or the part of one an attachment
 * overrides — holding a number `WeaponData` cannot carry.
 */
export function checkWeaponLimits(def: Partial<Pick<WeaponDef, "clipSize" | "fireType" | "times" | "clips">>, who: string): void {
  if (def.clipSize !== undefined && !(Number.isInteger(def.clipSize) && def.clipSize >= 0 && def.clipSize <= MAX_CLIP_SIZE)) {
    throw new Error(`weapon "${who}" has a magazine of ${def.clipSize}; a whole number up to ${MAX_CLIP_SIZE} can be carried`);
  }
  if (def.fireType !== undefined && shotsPerPress(def.fireType) > MAX_BURST) {
    throw new Error(`weapon "${who}" fires a "${def.fireType}"; a burst of up to ${MAX_BURST} can be carried`);
  }
  for (const [name, time] of Object.entries(def.times ?? {})) {
    const max = name === "fire" ? MAX_FIRE_TIME : MAX_STATE_TIME;
    if (typeof time === "number" && !(time <= max)) {
      throw new Error(`weapon "${who}" has a ${name} time of ${time} s; up to ${max} s can be carried`);
    }
  }
  for (const [name, clip] of Object.entries(def.clips ?? {})) {
    if (!(clip.duration <= MAX_STATE_TIME)) {
      throw new Error(`weapon "${who}" has a clip "${name}" ${clip.duration} s long; up to ${MAX_STATE_TIME} s can be carried`);
    }
  }
}

export class WeaponController {
  private d: WeaponData;
  private readonly listeners = new Set<WeaponListener>();
  private readonly perPress: number;

  constructor(readonly def: WeaponDef) {
    this.perPress = shotsPerPress(def.fireType);
    this.d = {
      state: "lowered",
      input: { trigger: false, ads: false, sprint: false },
      timer: 0,
      span: 0,
      ammo: def.clipSize,
      cooldown: 0,
      pressed: false,
      burstLeft: 0,
      ads: 0,
      reloadQueued: false,
      refillAt: null,
      fired: 0,
      spread: 0,
      kick: restingKick(),
      viewKick: restingViewKick(),
      clip: null,
    };
  }

  /** The whole state (see WeaponData). Read it to send it; change it only through commands or `restore`. */
  get data(): DeepReadonly<WeaponData> {
    return this.d;
  }

  /**
   * In a sprint, so the holder moves at run speed (App wires it to movement).
   * Reloading, working a bolt, aiming or firing takes the weapon out of it, and
   * a held sprint comes back once they are done.
   */
  get sprinting(): boolean {
    return this.d.state === "sprintIn" || this.d.state === "sprinting";
  }

  /** Aimed at all, or firing: what holds a lying body where it is (`Carry.braced`). */
  get braced(): boolean {
    return this.d.ads > 0 || this.d.state === "firing";
  }

  on(listener: WeaponListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // -- Commands -------------------------------------------------------------------

  /** What the holder is asking for: all of it each frame, or only what changed. */
  setInput(input: Partial<WeaponInput>): void {
    const d = this.d;
    // Only the two edges below are compared, so there is nothing to copy: this
    // runs every frame, and the caller may hand in one object over and over.
    const wasTrigger = d.input.trigger;
    const wasSprint = d.input.sprint;
    Object.assign(d.input, input);
    if (d.input.trigger && !wasTrigger) {
      d.pressed = true;
    }
    // A held sprint waits for a reload to finish; a new press cancels it.
    if (d.input.sprint && !wasSprint && RELOAD_STATES.includes(d.state) && this.wantsSprint()) {
      this.startSprint();
    }
  }

  /** Take over a state from elsewhere (a server's correction, a hot reload), cutting to its clip where it is. */
  restore(data: WeaponData): void {
    const previous = this.d.state;
    this.d = structuredClone(data);
    if (previous !== this.d.state) {
      this.emit({ type: "state", state: this.d.state, previous });
    }
    const c = this.d.clip;
    const clip = c && this.def.roles[c.role];
    if (c && clip) {
      this.emit({ type: "play", clip, role: c.role, time: c.time, rate: c.rate, loop: c.loop, fade: 0 });
    }
  }

  /** Start a reload, or queue it until the weapon can; returns whether it started now. */
  reload(): boolean {
    const d = this.d;
    d.reloadQueued = d.ammo < this.def.clipSize && !RELOAD_STATES.includes(d.state);
    if (!d.reloadQueued || !RELOAD_FROM.includes(d.state) || !this.interruptible()) {
      return false;
    }
    d.reloadQueued = false;
    if (this.def.roundsPerLoad > 0) {
      this.startSegment("reloadStart", "reloadStartAdd");
      return true;
    }
    const role: ClipRole = d.ammo === 0 && this.def.roles.reloadEmpty ? "reloadEmpty" : "reload";
    const time = this.stateTime(role);
    d.refillAt = time - Math.min(this.def.times.reloadAdd ?? time, time);
    this.enter("reloading", time);
    this.play(role, { time });
    return true;
  }

  /** Bring the weapon up: `first` for the first draw (it chambers a round), then idle. */
  raise(options: { first?: boolean; quick?: boolean } = {}): void {
    if (this.d.state !== "lowered" && this.d.state !== "dropping") {
      return;
    }
    const role: ClipRole = options.first && this.def.roles.firstRaise ? "firstRaise" : options.quick && this.def.roles.quickRaise ? "quickRaise" : "raise";
    const time = this.stateTime(role);
    this.enter("raising", time);
    this.play(role, { time });
  }

  /** Put the weapon away; it ends `lowered`, holding the clip's last frame. */
  drop(options: { quick?: boolean } = {}): void {
    if (this.d.state === "lowered" || this.d.state === "dropping") {
      return;
    }
    this.d.reloadQueued = false;
    const role: ClipRole = options.quick && this.def.roles.quickDrop ? "quickDrop" : "drop";
    const time = this.stateTime(role);
    this.enter("dropping", time);
    this.play(role, { time });
  }

  /** Straight to idle with no raise: a held screenshot pose, or a hot reload. */
  ready(): void {
    this.enter("idle", 0);
    this.play(this.idleRole(), { fade: 0 });
  }

  // -- Time -----------------------------------------------------------------------

  /**
   * One step. `holder` is what the man behind the gun is doing — his shot stream
   * and his speed — which only spread and recoil read; a caller with neither
   * (a held pose, a test of the state machine) may leave it out.
   */
  update(dt: number, holder: Holder = HOLDER_AT_REST): void {
    const d = this.d;
    const firedBefore = d.fired;
    this.advanceClip(dt);
    d.cooldown = Math.max(0, d.cooldown - dt);
    this.updateAds(dt);
    // A press this state cannot spend is forgotten here rather than at the moment
    // it would have fired: see FIRE_STATES.
    if (!FIRE_STATES.includes(d.state) || d.reloadQueued) {
      d.pressed = false;
    }
    if (d.reloadQueued) {
      this.reload();
    }

    switch (d.state) {
      case "raising":
      case "dropping":
      case "sprintOut":
        if ((d.timer -= dt) <= 0) {
          if (d.state === "dropping") {
            this.enter("lowered", 0);
          } else if (d.state === "sprintOut" && d.ammo > 0 && d.cooldown <= 0 && this.wantsFire()) {
            // Sprint to fire: the shot has waited the weapon's own `sprintOut`
            // out and leaves on the tick that ends it, rather than a tick later
            // through `idle` — the trigger is already down, and the arms are
            // already blending up out of the sprint (see `shoot`).
            this.shoot();
          } else {
            this.toIdle();
          }
        }
        break;
      case "sprintIn":
        if (!this.wantsSprint()) {
          this.leaveSprint();
        } else if ((d.timer -= dt) <= 0) {
          this.enter("sprinting", 0);
          this.play("sprintLoop", { time: this.def.times.sprintLoop, loop: true });
        }
        break;
      case "sprinting":
        if (!this.wantsSprint()) {
          this.leaveSprint();
        }
        break;
      case "rechambering":
        if ((d.timer -= dt) <= 0) {
          this.toIdle();
        }
        break;
      case "reloadStart":
      case "reloading":
        d.timer -= dt;
        if (d.refillAt !== null && d.timer <= d.refillAt) {
          d.refillAt = null;
          d.ammo = this.def.roundsPerLoad > 0 ? Math.min(this.def.clipSize, d.ammo + this.def.roundsPerLoad) : this.def.clipSize;
          this.emit({ type: "reloaded", ammo: d.ammo });
        }
        if (d.timer <= 0) {
          if (this.def.roundsPerLoad > 0) {
            this.nextLoad();
          } else {
            this.toIdle();
          }
        }
        break;
      case "reloadEnd":
        if ((d.timer -= dt) <= 0) {
          this.toIdle();
        }
        break;
      case "firing":
      case "idle":
        if (d.state === "firing" && d.cooldown <= 0) {
          if (this.rechambers()) {
            this.startRechamber();
            break;
          }
          // Held automatic fire goes shot to shot without passing through idle.
          if (!(this.wantsFire() && d.ammo > 0)) {
            this.enter("idle", 0);
          }
        }
        this.idleOrFiring();
        break;
      case "lowered":
        break;
    }

    this.stepRecoil(dt, firedBefore, holder);
  }

  /**
   * The kick and the cone, after the state machine has decided what fired.
   *
   * Each shot draws from its own ordinal's stream rather than from a counter
   * carried along, so a step that fired more than one round would draw exactly
   * what that many steps firing once each did. The ordinal is the value `fired`
   * reached on that shot, which is the same number `Shots.fire` puts on the
   * round it traces.
   *
   * Run after the state machine, so the shot this step fired has thrown the view
   * before the step's own fall back toward the aim is integrated — a round's own
   * bounce therefore starts on the tick that fired it (`stepViewKick`).
   *
   * A round's own view kick therefore lands here, inside the step that fired it.
   * Whoever traces that round must use the kick from *before* the step
   * (docs/engine/player.md#trace-then-kick); a bullet is away before the gun moves.
   */
  private stepRecoil(dt: number, firedBefore: number, holder: Holder): void {
    const d = this.d;
    let shots = 0;
    for (let n = firedBefore; n !== d.fired; n = (n + 1) & 0xffff) {
      const stream = shotStream(holder.seed, (n + 1) & 0xffff);
      addKick(d.kick, this.def.motion, d.ads, stream);
      addViewKick(d.viewKick, this.def.motion, d.ads, stream);
      shots++;
    }
    decayKick(d.kick, this.def.motion, d.ads, dt);
    stepViewKick(d.viewKick, this.def.motion, d.ads, dt);
    d.spread = stepSpread(d.spread, this.def.spread, shots, holder, dt, d.ads);
  }

  private idleOrFiring(): void {
    if (this.d.ammo === 0) {
      if (this.d.cooldown <= 0) {
        this.reload();
      } // the game reloads an emptied magazine by itself
      return;
    }
    if (this.wantsFire()) {
      if (this.d.cooldown <= 0) {
        this.shoot();
      }
      return;
    }
    if (this.wantsSprint() && this.interruptible()) {
      this.startSprint();
    }
  }

  private wantsFire(): boolean {
    if (this.d.reloadQueued) {
      return false;
    } // or held automatic fire would never let the reload in
    if (this.d.burstLeft > 0) {
      return true;
    }
    return this.perPress === 0 ? this.d.input.trigger : this.d.pressed;
  }

  private wantsSprint(): boolean {
    const { sprint, trigger, ads } = this.d.input;
    return sprint && !trigger && !ads;
  }

  private shoot(): void {
    const d = this.d;
    if (this.perPress > 0) {
      if (d.burstLeft === 0) {
        d.burstLeft = this.perPress;
      }
      d.burstLeft--;
      d.pressed = false;
    }
    d.ammo--;
    // Here and nowhere else: a round leaves the barrel exactly where one leaves
    // the magazine, so nothing can fire without being counted (`WeaponData.fired`).
    d.fired = (d.fired + 1) & 0xffff;
    d.cooldown = this.def.times.fire ?? 0.1;
    // Out of a sprint the arms blend up into the shot; shot to shot cuts.
    const fade = SPRINT_STATES.includes(d.state) ? CROSSFADE : 0;
    this.enter("firing", 0);
    const last = d.ammo === 0;
    const aimed = d.ads > 0.5;
    const role: ClipRole = aimed ? (last && this.def.roles.adsLastShot ? "adsLastShot" : "adsFire") : last && this.def.roles.lastShot ? "lastShot" : "fire";
    // Every shot restarts the fire clip from its first frame, as the game does.
    this.play(this.def.roles[role] ? role : "fire", { fade, restart: true });
    this.emit({ type: "shot", ammo: d.ammo });
    if (last) {
      d.burstLeft = 0;
    }
  }

  /**
   * Whether the shot just fired is followed by working the action: a bolt, a
   * pump or a lever, with a round left to chamber.
   *
   * An empty magazine is not one of them. The reload does the bolt itself —
   * MW3's `viewmodel_msr_reload_empty` carries the chamber-open and
   * chamber-close cues its rechamber clip does — so cycling first would play it
   * twice on an already empty rifle.
   */
  private rechambers(): boolean {
    return this.def.boltAction && this.d.ammo > 0 && this.stateTime("rechamber") > 0;
  }

  /**
   * Work the action, which is as blocking as a reload: no shot and no sprint
   * until it is done, and the sights stay up (every bolt-action weapon measured
   * in either game sets `rechamberWhileAds`).
   */
  private startRechamber(): void {
    const time = this.stateTime("rechamber");
    const aimed = this.d.ads > 0.5;
    const role: ClipRole = aimed && this.def.roles.adsRechamber ? "adsRechamber" : "rechamber";
    this.enter("rechambering", time);
    this.play(role, { time });
  }

  /**
   * One half of a segmented reload: the start, or one load. `add` names the time
   * within it at which the rounds go in.
   */
  private startSegment(role: "reloadStart" | "reload", add: "reloadStartAdd" | "reloadAdd"): void {
    const time = this.stateTime(role);
    this.d.refillAt = time - Math.min(this.def.times[add] ?? time, time);
    this.enter(role === "reloadStart" ? "reloadStart" : "reloading", time);
    this.play(role, { time, restart: true });
  }

  /**
   * After a load goes in: another, or out of the reload.
   *
   * The break-out is the point of a segmented reload — a shotgun is loaded a
   * shell at a time so that the trigger can take it back off the player mid-way,
   * with however many shells are already in it. A *held* sprint does not break
   * out, for the same reason it does not cut a magazine reload short; a fresh
   * press does, in `setInput`.
   */
  private nextLoad(): void {
    if (this.d.ammo < this.def.clipSize && !this.wantsFire()) {
      this.startSegment("reload", "reloadAdd");
      return;
    }
    const time = this.stateTime("reloadEnd");
    this.d.refillAt = null;
    this.enter("reloadEnd", time);
    this.play("reloadEnd", { time });
  }

  /** Also cancels a reload: before reloadAddTime the magazine stays as it was, after it it is already full. */
  private startSprint(): void {
    this.d.refillAt = null;
    const time = this.stateTime("sprintIn");
    this.enter("sprintIn", time);
    this.play("sprintIn", { time });
  }

  private leaveSprint(): void {
    const time = this.stateTime("sprintOut");
    this.enter("sprintOut", time);
    this.play("sprintOut", { time });
  }

  private toIdle(): void {
    this.enter("idle", 0);
    this.play(this.idleRole());
  }

  private idleRole(): ClipRole {
    return this.d.ammo === 0 && this.def.roles.emptyIdle ? "emptyIdle" : "idle";
  }

  /** A fire clip holds the weapon until its `fireInterruptible` time; anything else can be cut at once. */
  private interruptible(): boolean {
    const c = this.d.clip;
    if (!c || !FIRE_ROLES.includes(c.role)) {
      return true;
    }
    return c.time / c.rate >= (this.def.times.fireInterruptible ?? 0) || c.time >= this.clipInfo(c.role).duration;
  }

  private updateAds(dt: number): void {
    const d = this.d;
    const target = d.input.ads && ADS_STATES.includes(d.state) ? 1 : 0;
    if (target === d.ads) {
      return;
    }
    // Forced down: the weapon needs the sights out of the way (a reload) with aim
    // still held, which the weapon file times separately and is not always quicker
    // — an MSR drops them in 0.6 s either way, an ACR in 0.5 s against 0.2 s.
    const forced = target === 0 && d.input.ads;
    const time =
      target > d.ads
        ? (this.def.times.adsIn ?? FALLBACK_ADS_TIME)
        : forced
          ? (this.def.times.adsReloadOut ?? FALLBACK_ADS_RELOAD_OUT)
          : (this.def.times.adsOut ?? FALLBACK_ADS_TIME);
    const step = time > 0 ? dt / time : 1;
    d.ads = target > d.ads ? Math.min(1, d.ads + step) : Math.max(0, d.ads - step);
  }

  // -- Clips ----------------------------------------------------------------------

  private clipInfo(role: ClipRole): { name: string; duration: number; notes: [string, number][] } {
    const name = this.def.roles[role] ?? "";
    const info = this.def.clips[name];
    return { name, duration: info?.duration ?? 0, notes: info?.notes ?? [] };
  }

  /** Seconds the state for `role` lasts: the weapon file's time, else the clip's length. */
  private stateTime(role: ClipRole): number {
    const time = this.def.times[role as keyof WeaponTimes];
    if (time !== undefined && time > 0) {
      return time;
    }
    return this.clipInfo(role).duration;
  }

  /**
   * Start the clip for `role`, if the weapon has one, scaled to last `time` seconds.
   * Restarting the clip that is already playing only happens when asked (a shot).
   */
  private play(role: ClipRole, options: { time?: number; loop?: boolean; fade?: number; restart?: boolean } = {}): void {
    const { name, duration } = this.clipInfo(role);
    if (!name) {
      return;
    }
    const loop = options.loop ?? (role === "idle" || role === "emptyIdle");
    const now = this.d.clip;
    if (now && this.def.roles[now.role] === name && now.loop === loop && !options.restart) {
      return;
    }
    const rate = options.time && options.time > 0 && duration > 0 ? Math.min(MAX_CLIP_RATE, duration / options.time) : 1;
    this.d.clip = { role, time: 0, rate, loop };
    this.emit({ type: "play", clip: name, role, time: 0, rate, loop, fade: options.fade ?? CROSSFADE });
    this.emitNotes(-1, 0);
  }

  private advanceClip(dt: number): void {
    const c = this.d.clip;
    if (!c || dt <= 0) {
      return;
    }
    const { duration } = this.clipInfo(c.role);
    if (duration <= 0) {
      return;
    }
    const before = c.time;
    let after = before + dt * c.rate;
    if (c.loop) {
      if (after <= duration) {
        c.time = after;
        this.emitNotes(before, after);
      } else {
        this.emitNotes(before, duration);
        c.time = after % duration;
        this.emitNotes(-1, c.time);
      }
      return;
    }
    if (before >= duration) {
      return;
    }
    after = Math.min(after, duration);
    c.time = after;
    this.emitNotes(before, after);
    // A shot's clip ends in the idle pose; put the idle back once it has run out.
    if (after >= duration && (this.d.state === "idle" || this.d.state === "firing")) {
      this.play(this.idleRole());
    }
  }

  /** Emit the playing clip's notes in (from, to]. */
  private emitNotes(from: number, to: number): void {
    const c = this.d.clip;
    if (!c) {
      return;
    }
    const { name, notes } = this.clipInfo(c.role);
    for (const [note, at] of notes) {
      if (at > from && at <= to) {
        this.emit({ type: "note", name: note, clip: name });
      }
    }
  }

  private enter(state: WeaponState, timer: number): void {
    const previous = this.d.state;
    this.d.state = state;
    this.d.timer = timer;
    this.d.span = timer;
    if (previous !== state) {
      this.emit({ type: "state", state, previous });
    }
  }

  private emit(event: WeaponEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
