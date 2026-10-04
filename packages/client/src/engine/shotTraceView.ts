// SHOTTRACE — a temporary diagnostic. Every touch point it has is listed in
// docs/engine/diagnostics-shottrace.md, whose last section is how to remove it.
//
// Shot trace view (`G`): where a round went **as this client sees it** and
// **as the server says it went**, drawn side by side, so the gap between the two
// is a thing you can look at rather than infer from a hit marker that did or did
// not appear.
//
// The two halves are not expected to agree, and where they do not is the point:
// the server rewinds every peer to the moment the shooter was drawing them
// (`Match.rewind`), while this end traces the bodies as they are drawn *now* —
// one tick behind the newest snapshot and interpolated. A steady divergence on
// peers and none on walls is that, working as designed; a divergence on a wall
// is two different collision worlds, which is a bug.
//
// Three things make the client's half worth trusting, and each is a way it could
// have lied:
//
//   the ray      `aimAngles` then `aimDirection`, off the simulation's own
//                angles and the weapon's *view* kick as of the previous frame —
//                the same two calls in the same order as `Match.fireShots`, on
//                the same kick: a round leaves before its own recoil moves the
//                view (docs/engine/player.md#trace-then-kick). Built from the raw
//                view angles instead, it would agree with the server on a resting
//                gun and drift by the whole recoil on a held burst.
//   the channel  `"shots"`, not the capsule's geometry: most of a map's clipmap
//                stops a player and not a bullet
//                (docs/engine/collision.md#a-bullet-and-a-player-collide-with-different-things).
//   the bodies   `BoundHitboxes` over the rigs `RemotePlayers` just posed — the
//                server's own class, over the same boxes, so a difference here
//                cannot be this file's arithmetic.
//
// The shot itself is detected by watching `WeaponData.fired` advance, exactly as
// the server detects one. **Not** by subscribing to `WeaponController`'s `shot`
// event: `Player.equip`/`equipById`/`restore` each replace the controller, so a
// subscription is dropped in silence on every weapon change and every
// correction. A controller that is not the one watched resets the watermark
// rather than reporting a burst, which is what `Match.fireShots` does with the
// same case.

import * as THREE from "three";
import type { ShotTraceMessage, ShotTraceMet } from "@3d/shared/net/messages/shotTrace.js";
import type { CharacterRig } from "@3d/shared/rig/character.js";
import { BoundHitboxes, readHitboxes, type Hitbox } from "@3d/shared/rig/hitboxes.js";
import type { CapsuleWorld, RayHit, Vec3 } from "@3d/shared/sim/capsule.js";
import { EYE_HEIGHT } from "@3d/shared/sim/movement.js";
import { aimAngles, aimDirection, coneSample, shotSpread, shotStream, spreadDirection, type Aim } from "@3d/shared/sim/recoil.js";
import { BULLET_RANGE, type WeaponDef } from "@3d/shared/sim/weaponDef.js";
import { hitboxUrl, type SidecarSource } from "./hitboxView.js";
import { DEFAULT_SURFACE } from "@3d/shared/sim/surfaces.js";

/** How many shots are kept, so a burst can be compared round by round. */
const MAX_TRACES = 8;

/** Seconds a trace is drawn for before it expires. Long enough to stop and look at a burst. */
const TRACE_SECONDS = 6;

/** How dim the oldest trace is drawn, as a fraction: expiring, not vanishing. */
const FAINTEST = 0.2;

/** Arm length of the cross drawn at an impact, metres. */
const MARKER = 0.12;

/** Line segments one half of a trace writes: the shot itself, then the three arms of its marker. */
const SEGMENTS_PER_HALF = 4;
const VERTICES_PER_HALF = SEGMENTS_PER_HALF * 2;

const CLIENT_COLOUR = 0x2ad4ff;
const SERVER_COLOUR = 0xff3ec8;

/** One peer as the last frame posed them. `RemotePlayers.drawnBodies()` satisfies this. */
export interface TracedBody {
  id: string;
  rig: CharacterRig;
}

/**
 * The local player, narrowed to the two things a shot is derived from.
 *
 * `@3d/shared`'s `Player` satisfies it structurally. Narrowed rather than named
 * so that a test can fire a shot without standing a whole player up — and so
 * that this file cannot reach for anything else about them.
 */
export interface Shooter {
  readonly movement: { readonly feet: Readonly<Vec3>; readonly yaw: number; readonly pitch: number };
  readonly weapon:
    | {
        /** For the cone's width, which is the weapon's own `spread` block read against how hot it is. */
        readonly def: WeaponDef;
        readonly data: {
          readonly fired: number;
          readonly viewKick: { readonly pitch: number; readonly yaw: number };
          readonly spread: number;
          readonly ads: number;
        };
      }
    | undefined;
  /** The stream this player's rounds are deviated by; the server uses the same one. */
  readonly seed: number;
}

/** One end's account of one round: where it stopped, and on what. */
export interface Answer {
  /** Metres travelled. `BULLET_RANGE` where it met nothing. */
  distance: number;
  met: ShotTraceMet;
  /** Who was hit, where `met` is `player`. */
  target: string | null;
  /** Where it stopped, in the world. What the divergence measures. */
  end: Vec3;
}

/** One round, as both ends tell it. `server` is absent until its packet lands, and may never. */
export interface Trace {
  ordinal: number;
  age: number;
  from: Vec3;
  direction: Vec3;
  client: Answer | undefined;
  server: Answer | undefined;
}

export class ShotTraceView {
  /** Every held trace, both halves, one draw call. Vertex-coloured, so the two colours cost no material each. */
  readonly object = new THREE.LineSegments(
    new THREE.BufferGeometry(),
    // Through walls: half of what this is for is a shot that stopped inside
    // something, and depth-testing it would hide exactly those.
    new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95, depthTest: false }),
  );

  private shown = false;
  /** Newest last. Never longer than `MAX_TRACES`. */
  private readonly traces: Trace[] = [];

  /**
   * The controller whose `fired` is being watched, and the count it was last at.
   *
   * A different controller resets the count instead of reporting the difference:
   * `fired` starts at zero on a new weapon, so subtracting across a swap would
   * invent either a burst or 65535 of them.
   */
  private watched: Shooter["weapon"] = undefined;
  private counted = 0;

  /**
   * The view kick as of the previous sample, and where this one is putting it.
   *
   * **Trace, then kick**, as `Match.fireShots` does it: a round leaves before its
   * own recoil moves the view, so it is traced along the kick that was on the gun
   * when the trigger went and not the one this frame's step has just added.
   * Sampled per frame where the server samples per step, so a frame that ran
   * several ticks traces the later ones along a kick that is a tick or two stale
   * — under a tenth of a degree, against the whole impulse this is fixing.
   */
  private readonly drawnKick = { pitch: 0, yaw: 0 };
  private readonly sampledKick = { pitch: 0, yaw: 0 };
  /** How hot the gun was, and how far into the sights, on the same one-frame delay and for the same reason. */
  private readonly drawnHeat = { spread: 0, ads: 0 };
  private readonly sampledHeat = { spread: 0, ads: 0 };

  /** The divergence of the most recently paired round, metres; null until one is. */
  private diverged: number | null = null;
  private paired = 0;

  /** A body's boxes by sidecar URL: `null` where it could not be read, absent while in flight. */
  private readonly boxes = new Map<string, Hitbox[] | null>();
  private readonly pending = new Set<string>();
  /** Bound once per rig, as `HitboxView` binds its own: a name lookup over ~124 bones is not a per-shot cost. */
  private readonly bound = new WeakMap<CharacterRig, BoundHitboxes>();

  /** Scratch, so tracing a shot allocates only the trace it keeps. */
  private readonly aim: Aim = { yaw: 0, pitch: 0 };
  private readonly direction: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly far: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly mapHit: RayHit = { distance: 0, normal: { x: 0, y: 0, z: 0 }, kind: "map", surface: DEFAULT_SURFACE };
  private readonly cone = { angle: 0, radius: 0 };
  private readonly colour = new THREE.Color();

  constructor() {
    this.object.name = "shot-trace-view";
    this.object.visible = false;
    this.object.frustumCulled = false; // one object spanning the whole map
    this.object.renderOrder = 999;
    const vertices = MAX_TRACES * 2 * VERTICES_PER_HALF;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(vertices * 3), 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(vertices * 3), 3));
    geometry.setDrawRange(0, 0);
    this.object.geometry = geometry;
  }

  get visible(): boolean {
    return this.shown;
  }

  /** What the stats line reads: how many rounds are held, and how far apart the two answers were on the last paired one. */
  get counts(): { traces: number; paired: number; divergence: number | null } {
    return { traces: this.traces.length, paired: this.paired, divergence: this.diverged };
  }

  /** The traces as they stand, newest last. For the tests and the readout; nothing draws off this. */
  get held(): readonly Trace[] {
    return this.traces;
  }

  setVisible(visible: boolean): void {
    this.shown = visible;
    this.object.visible = visible;
    if (!visible) {
      this.clear();
    }
  }

  /** Forget everything: leaving a world, or turning the view off. */
  clear(): void {
    this.traces.length = 0;
    this.diverged = null;
    this.paired = 0;
    this.boxes.clear();
    this.pending.clear();
    this.object.geometry.setDrawRange(0, 0);
  }

  dispose(): void {
    this.object.geometry.dispose();
    this.object.material.dispose();
  }

  /**
   * One frame. Detect whatever the local player fired since the last one, trace
   * it here, and redraw.
   *
   * The watermark is kept **whether or not the view is shown**, so that turning it
   * on does not draw a magazine's worth of shots fired while it was off; nothing
   * else runs, and nothing is allocated, until it is shown.
   *
   * Called after `FirstPersonControls.update` and `RemotePlayers.update`, which is
   * where `DevTools.update` already sits: the angles are the ones the last tick
   * stepped, and every peer's bone matrices are the ones this frame drew.
   */
  update(shooter: Shooter, collision: CapsuleWorld, bodies: readonly TracedBody[], sidecars: SidecarSource | undefined, dt: number): void {
    const weapon = shooter.weapon;
    const fired = weapon?.data.fired ?? 0;
    const kick = weapon?.data.viewKick;
    if (weapon !== this.watched) {
      this.watched = weapon;
      this.counted = fired;
    }
    // Wrap-safe, as `Match.fireShots` is: `fired` is a uint16 on both ends.
    const count = (fired - this.counted) & 0xffff;
    const before = this.counted;
    this.counted = fired;
    // Kept whether or not the view is shown, for the same reason the watermark is:
    // the first round after it opens must be traced along a real kick. A swap
    // needs no case of its own — the count it resets is what stops a round being
    // recorded on the frame the new weapon is first seen, and by the next frame
    // this has sampled that weapon's own kick.
    this.drawnKick.pitch = this.sampledKick.pitch;
    this.drawnKick.yaw = this.sampledKick.yaw;
    this.sampledKick.pitch = kick?.pitch ?? 0;
    this.sampledKick.yaw = kick?.yaw ?? 0;
    this.drawnHeat.spread = this.sampledHeat.spread;
    this.drawnHeat.ads = this.sampledHeat.ads;
    this.sampledHeat.spread = weapon?.data.spread ?? 0;
    this.sampledHeat.ads = weapon?.data.ads ?? 0;
    if (!this.shown) {
      return;
    }
    this.expire(dt);
    // Ask for each peer's sidecar while nothing is being fired, so the *first*
    // round after the view opens is traced against bodies rather than against the
    // map alone. Cached after the first frame, so this is a map lookup per peer.
    for (const body of bodies) {
      this.boxesFor(body.rig, sidecars);
    }
    if (count > 0 && weapon) {
      this.record(shooter, this.drawnKick, before, count, collision, bodies, sidecars);
    }
    this.fill();
  }

  /**
   * The server's account of one round, paired with ours by its ordinal.
   *
   * By ordinal and never by arrival order: a burst puts several of these in
   * flight over an unreliable channel, so pairing on order would draw one round's
   * divergence against another round's — a wrong number that looks entirely
   * plausible. An ordinal this end has no trace for is kept on its own, because
   * "the server fired a round we did not" is worth seeing rather than dropping.
   */
  serverTrace(message: ShotTraceMessage): void {
    if (!this.shown) {
      return;
    }
    const answer: Answer = {
      distance: message.distance,
      met: message.met,
      target: message.target,
      end: along(message.from, message.direction, message.distance),
    };
    const existing = this.traces.find((trace) => trace.ordinal === message.ordinal);
    const trace =
      existing ??
      this.push({ ordinal: message.ordinal, age: 0, from: { ...message.from }, direction: { ...message.direction }, client: undefined, server: undefined });
    trace.server = answer;
    if (trace.client) {
      this.paired++;
      this.diverged = distance(trace.client.end, answer.end);
    }
  }

  /** The rounds the local player fired since the last frame, traced against this end's world. */
  private record(
    shooter: Shooter,
    kick: { readonly pitch: number; readonly yaw: number },
    before: number,
    count: number,
    collision: CapsuleWorld,
    bodies: readonly TracedBody[],
    sidecars: SidecarSource | undefined,
  ): void {
    const movement = shooter.movement;
    const weaponDef = shooter.weapon?.def;
    // The shooter's intent **plus the view kick they had already taken**, which is
    // what bends a bullet; the gun kick rocks the model and decides nothing
    // (@3d/shared/sim/recoil.ts). These are the two calls `Match.fireShots` makes,
    // in this order and on the same kick — the one from before this shot's own.
    const feet = movement.feet;
    const from = { x: feet.x, y: feet.y + EYE_HEIGHT, z: feet.z };
    // And the cone the round is allowed to wander in, which is the third of the
    // three things a server judges a shot by. Predicted here off the same seed
    // and the same ordinal, so a client that draws this ray is drawing the one
    // the server will trace — a diagnostic that ignored the cone would report a
    // divergence on every round of every weapon that has one.
    const cone = weaponDef ? shotSpread(weaponDef, this.drawnHeat.spread, this.drawnHeat.ads) : 0;
    for (let i = 0; i < count; i++) {
      const ordinal = (before + i + 1) & 0xffff;
      const direction = aimDirection(aimAngles(movement, kick, this.aim), this.direction);
      spreadDirection(direction, cone, coneSample(shotStream(shooter.seed, ordinal), this.cone));
      const answer = this.resolve(from, direction, collision, bodies, sidecars);
      const existing = this.traces.find((trace) => trace.ordinal === ordinal && trace.client === undefined);
      const trace = existing ?? this.push({ ordinal, age: 0, from: { ...from }, direction: { ...direction }, client: undefined, server: undefined });
      trace.from = { ...from };
      trace.direction = { ...direction };
      trace.client = answer;
      if (trace.server) {
        this.paired++;
        this.diverged = distance(answer.end, trace.server.end);
      }
    }
  }

  /**
   * What this end says one round met: the nearest of the map and the peers, which
   * is the order `Match.traceShot` takes them in.
   *
   * The peers are traced as they are *drawn* — no rewind — because that is the
   * half of the disagreement worth seeing. Dropping them would leave a view that
   * never disagrees about a body, which is the only thing it is for.
   */
  private resolve(from: Vec3, direction: Vec3, collision: CapsuleWorld, bodies: readonly TracedBody[], sidecars: SidecarSource | undefined): Answer {
    const map = collision.traceRay(from, direction, BULLET_RANGE, "shots", this.mapHit);
    let nearest = map === null ? BULLET_RANGE : map.distance;
    let met: ShotTraceMet = map === null ? "none" : "world";
    let target: string | null = null;

    const to = this.far;
    to.x = from.x + direction.x * BULLET_RANGE;
    to.y = from.y + direction.y * BULLET_RANGE;
    to.z = from.z + direction.z * BULLET_RANGE;
    for (const body of bodies) {
      const boxes = this.boxesFor(body.rig, sidecars);
      if (boxes === undefined) {
        continue;
      }
      const hit = boxes.trace(from, to);
      // A fraction of the segment, which is what `BoundHitboxes` answers in.
      const reached = hit === null ? null : hit.fraction * BULLET_RANGE;
      if (reached !== null && reached < nearest) {
        nearest = reached;
        met = "player";
        target = body.id;
      }
    }
    return { distance: nearest, met, target, end: along(from, direction, nearest) };
  }

  /**
   * This rig's boxes, bound to its bones, or undefined while the sidecar is in
   * flight or after it would not read.
   *
   * `BoundHitboxes` is the server's own class over the server's own sidecar, so
   * the binding rule is not restated here. `HitboxView` keeps a parallel binding
   * of its own only because it draws each box individually; this needs the trace
   * and nothing else.
   */
  private boxesFor(rig: CharacterRig, sidecars: SidecarSource | undefined): BoundHitboxes | undefined {
    const held = this.bound.get(rig);
    if (held) {
      return held;
    }
    const url = hitboxUrl(rig);
    const boxes = this.boxes.get(url);
    if (boxes === undefined) {
      if (sidecars) {
        this.request(url, sidecars);
      }
      return undefined;
    }
    if (boxes === null) {
      return undefined;
    }
    const built = new BoundHitboxes(rig, boxes);
    this.bound.set(rig, built);
    return built;
  }

  /** Read a sidecar once. A missing or unparseable one is remembered and warned about once; a debug view may never take a frame down. */
  private request(url: string, sidecars: SidecarSource): void {
    if (this.pending.has(url)) {
      return;
    }
    this.pending.add(url);
    void Promise.resolve()
      .then(() => sidecars.json(url))
      .then(readHitboxes)
      .then(
        (boxes) => {
          this.boxes.set(url, boxes);
        },
        (e: unknown) => {
          this.boxes.set(url, null);
          console.warn(`[shottrace] ${url}: ${e instanceof Error ? e.message : String(e)}; this body is not traced against`);
        },
      )
      .finally(() => this.pending.delete(url));
  }

  private push(trace: Trace): Trace {
    this.traces.push(trace);
    if (this.traces.length > MAX_TRACES) {
      this.traces.shift();
    }
    return trace;
  }

  private expire(dt: number): void {
    for (let i = this.traces.length - 1; i >= 0; i--) {
      const trace = this.traces[i]!;
      trace.age += dt;
      if (trace.age > TRACE_SECONDS) {
        this.traces.splice(i, 1);
      }
    }
  }

  /** Write every held trace into the buffer. Fixed capacity: the geometry is built once, in the constructor. */
  private fill(): void {
    const geometry = this.object.geometry;
    const position = geometry.getAttribute("position") as THREE.BufferAttribute;
    const colour = geometry.getAttribute("color") as THREE.BufferAttribute;
    const points = position.array as Float32Array;
    const colours = colour.array as Float32Array;
    let at = 0;
    for (const trace of this.traces) {
      const fade = Math.max(FAINTEST, 1 - trace.age / TRACE_SECONDS);
      at = this.half(points, colours, at, trace, trace.client, CLIENT_COLOUR, fade);
      at = this.half(points, colours, at, trace, trace.server, SERVER_COLOUR, fade);
    }
    position.needsUpdate = true;
    colour.needsUpdate = true;
    geometry.setDrawRange(0, at / 3);
  }

  /** One end's line, and a cross at its impact. A round that met nothing gets the line and no cross. */
  private half(points: Float32Array, colours: Float32Array, at: number, trace: Trace, answer: Answer | undefined, hex: number, fade: number): number {
    if (!answer) {
      return at;
    }
    this.colour.setHex(hex).convertSRGBToLinear();
    const write = (a: Vec3, b: Vec3): void => {
      for (const point of [a, b]) {
        points[at] = point.x;
        points[at + 1] = point.y;
        points[at + 2] = point.z;
        colours[at] = this.colour.r * fade;
        colours[at + 1] = this.colour.g * fade;
        colours[at + 2] = this.colour.b * fade;
        at += 3;
      }
    };
    const { end } = answer;
    write(trace.from, end);
    if (answer.met !== "none") {
      write({ x: end.x - MARKER, y: end.y, z: end.z }, { x: end.x + MARKER, y: end.y, z: end.z });
      write({ x: end.x, y: end.y - MARKER, z: end.z }, { x: end.x, y: end.y + MARKER, z: end.z });
      write({ x: end.x, y: end.y, z: end.z - MARKER }, { x: end.x, y: end.y, z: end.z + MARKER });
    }
    return at;
  }
}

/** A point `distance` along `direction` from `from`. */
function along(from: Readonly<Vec3>, direction: Readonly<Vec3>, distance: number): Vec3 {
  return { x: from.x + direction.x * distance, y: from.y + direction.y * distance, z: from.z + direction.z * distance };
}

function distance(a: Readonly<Vec3>, b: Readonly<Vec3>): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
