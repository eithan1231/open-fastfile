// The mantle volumes a world declares, and the one question a movement step
// asks of them: from here, facing this way, is there something to climb — and
// can the capsule get there without passing through anything?
//
// The volume is the permission and the direction; the collision world is the
// answer. A volume says a climb may start at one of its faces and roughly how
// high it goes, and the map's own collision says where the ledge really is,
// how high it really is, and whether the way up is clear. That split is what
// the exporter assumes (scripts/cod/mantle.py) and what the maps need: an
// imported volume encloses its obstacle with a player's width to spare on every
// side, so neither its far edge nor its top is exactly where anybody lands.
//
// What a volume means is in dsl/resolved.ts's `ResolvedMantle`.

import type { ResolvedMantle } from "../../dsl/resolved.js";
import type { CapsuleWorld, Vec3 } from "../capsule.js";
import { WALKING, type MantleMove, type MovementState } from "../movementState.js";

/**
 * The tallest climb there is, metres.
 *
 * Not a taste decision: the games' own animation set runs `mp_mantle_up_21`
 * through `_57`, named in inches, so 57 in is the highest ledge any of them
 * reaches. A ledge higher than this is refused rather than played at the wrong
 * height — 320 of the 3,006 imported volumes are over 2 m tall, which is a whole
 * wall, and what the map meant by those is still an open question
 * (docs/engine/player.md).
 */
export const MAX_CLIMB = 57 * 0.0254;

/**
 * The shortest climb worth playing, metres. Below this a walk steps onto the
 * ledge (STEP_HEIGHT) or a jump clears it, so a mantle would replace either
 * with a scripted animation.
 */
export const MIN_CLIMB = 0.35;

/**
 * How far the ledge may sit from the volume's top and still be the one it
 * means, metres. The exporter's own check allows 0.08 (brushes are inset a unit
 * from what they back); this is looser because the surface may be soup.
 */
const SURFACE_TOLERANCE = 0.15;

/**
 * How far past the front of the capsule the ledge may begin, metres. A player
 * pressed against the obstacle has it at zero; this is the slack for jumping at
 * one from a step away. A feel number, not one read from the games.
 */
const LEDGE_REACH = 0.3;

/** Spacing of the downward probes that find the ledge and its far edge, metres. */
const PROBE_STEP = 0.05;

/**
 * How far the surface may step under the landing and still be the same ledge,
 * metres: a lip or a seam, not a second level.
 */
const LEDGE_STEP = 0.05;

/** How far past an edge a vault is put down, beyond the player's own radius, metres. */
const LANDING_MARGIN = 0.05;

/**
 * How closely the player must be facing the face they climb, as the cosine of
 * the angle between where they look and straight in through it. 0.5 is 60
 * degrees either side: wide enough that a player running at a wall at an angle
 * still mantles, narrow enough that one running along it does not.
 */
const FACING_COSINE = 0.5;

/** The capsule a climb has to fit: the part of `MovementParams` a query reads. */
export interface MantleBody {
  radius: number;
  height: number;
}

/** Where a mantle ends, and how far it rises: what a movement step needs to run one. */
export interface MantleTarget {
  /** The feet position to arrive at. */
  feet: Vec3;
  /** Metres climbed, from the feet the query was made with. Between MIN_CLIMB and MAX_CLIMB. */
  rise: number;
  /**
   * A vault across the obstacle rather than a climb onto it. The volume's kind
   * asks for one; this says whether there was anywhere to vault to.
   */
  over: boolean;
  /** The volume this came from, for a caller that wants its id. */
  volume: ResolvedMantle;
}

/** Turn `v` about +Y by `theta`. three.js' convention, as `dsl/resolveUtil.ts`'s `rotateY`. */
function rotateY(x: number, z: number, theta: number): { x: number; z: number } {
  const s = Math.sin(theta);
  const c = Math.cos(theta);
  return { x: x * c + z * s, z: -x * s + z * c };
}

/** The face a climb goes in through: which way it goes, and how far to the volume's far side. */
interface Face {
  /** Unit horizontal direction of the climb, world space: straight in through the face. */
  x: number;
  z: number;
  /** Metres from the player's feet to the far face, along that direction. */
  far: number;
}

/**
 * The mantle volumes of one world, in a form a per-tick query can afford.
 *
 * A world has about 70 of these, so the broad phase is a cell grid over their
 * footprints rather than a tree: with cells this size a query tests a handful.
 */
export class MantleVolumes {
  /** Volume indices by grid cell. */
  private readonly grid = new Map<number, number[]>();
  private readonly volumes: readonly ResolvedMantle[];
  /** Where a probe asks from, reused: `find` runs per player per tick while a jump is held. */
  private readonly probe: Vec3 = { x: 0, y: 0, z: 0 };

  /** Metres. Comfortably larger than any volume's footprint (the widest imported is 4.4 m). */
  private static readonly CELL = 8;
  /** How far outside its own footprint a volume is registered. Above any player radius. */
  private static readonly REACH = 0.5;

  constructor(volumes: readonly ResolvedMantle[]) {
    this.volumes = volumes;
    for (let i = 0; i < volumes.length; i++) {
      const v = volumes[i]!;
      // The footprint of a turned box, as scripts/cod/mantle.py's `box_footprint`.
      const c = Math.abs(Math.cos(v.yaw));
      const s = Math.abs(Math.sin(v.yaw));
      // Grown by REACH, to match the radius `face` grows the containment test
      // by: a volume whose own footprint stops just short of the player's cell
      // is still one they can touch from inside it.
      const halfX = (v.size.x / 2) * c + (v.size.z / 2) * s + MantleVolumes.REACH;
      const halfZ = (v.size.x / 2) * s + (v.size.z / 2) * c + MantleVolumes.REACH;
      const minX = Math.floor((v.position.x - halfX) / MantleVolumes.CELL);
      const maxX = Math.floor((v.position.x + halfX) / MantleVolumes.CELL);
      const minZ = Math.floor((v.position.z - halfZ) / MantleVolumes.CELL);
      const maxZ = Math.floor((v.position.z + halfZ) / MantleVolumes.CELL);
      for (let x = minX; x <= maxX; x++) {
        for (let z = minZ; z <= maxZ; z++) {
          const key = cellKey(x, z);
          let cell = this.grid.get(key);
          if (!cell) {
            this.grid.set(key, (cell = []));
          }
          cell.push(i);
        }
      }
    }
  }

  get count(): number {
    return this.volumes.length;
  }

  /**
   * The climb available from `feet` while looking along `yaw`, or null.
   *
   * Deterministic: a server runs this whenever a player's jump is pending, and
   * has to reach the same answer the client did from the same state and the
   * same world. A world whose collision is not loaded offers nothing to climb.
   */
  find(feet: Vec3, yaw: number, body: MantleBody, world: CapsuleWorld): MantleTarget | null {
    if (!world.ready) {
      return null;
    }
    const cell = this.grid.get(cellKey(Math.floor(feet.x / MantleVolumes.CELL), Math.floor(feet.z / MantleVolumes.CELL)));
    if (!cell) {
      return null;
    }

    let best: MantleTarget | null = null;
    for (const index of cell) {
      const found = this.climb(this.volumes[index]!, feet, yaw, body, world);
      // The lowest climb on offer: two volumes overlapping at a stepped ledge
      // should take the player to the near step, not over both.
      if (found && (!best || found.rise < best.rise)) {
        best = found;
      }
    }
    return best;
  }

  /** The climb one volume offers from `feet`, or null if it offers none. */
  private climb(volume: ResolvedMantle, feet: Vec3, yaw: number, body: MantleBody, world: CapsuleWorld): MantleTarget | null {
    const top = volume.position.y + volume.size.y / 2;
    if (top + SURFACE_TOLERANCE - feet.y < MIN_CLIMB || top - SURFACE_TOLERANCE - feet.y > MAX_CLIMB) {
      return null;
    }
    const face = this.face(volume, feet, yaw, body.radius);
    if (!face) {
      return null;
    }

    // The ledge: the first surface near the volume's top straight ahead. It has
    // to begin within reach, and it sets the height rather than the volume.
    const reach = body.radius + LEDGE_REACH;
    const last = Math.floor((face.far + body.radius + LANDING_MARGIN) / PROBE_STEP);
    let edge = -1;
    let ground = 0;
    for (let i = 0; i <= last && i * PROBE_STEP <= reach; i++) {
      const g = this.groundAt(feet, face, i * PROBE_STEP, top, world);
      if (g !== null) {
        edge = i;
        ground = g;
        break;
      }
    }
    const rise = ground - feet.y;
    if (edge < 0 || rise < MIN_CLIMB || rise > MAX_CLIMB) {
      return null;
    }

    // Onto: as far in as the player's radius, so they stand on the ledge rather
    // than balance on its lip — or as far as it goes and they fit, if it is
    // narrower than that.
    let onto: Vec3 | null = null;
    const deepest = Math.min(last, edge + Math.ceil(body.radius / PROBE_STEP));
    for (let i = edge; i <= deepest; i++) {
      const g = this.groundAt(feet, face, i * PROBE_STEP, top, world);
      if (g === null || Math.abs(g - ground) > LEDGE_STEP) {
        break;
      }
      const at = this.along(feet, face, i * PROBE_STEP, g);
      if (!world.overlapsCapsule(at, body.radius, body.height)) {
        onto = { x: at.x, y: at.y, z: at.z };
      }
    }

    // Over: past the ledge's far edge, clear of it by the player's radius, at
    // the ledge's height — gravity takes them down the far side afterwards. With
    // nowhere to vault to, a volume that asked for one is climbed onto instead.
    let over: Vec3 | null = null;
    if (volume.kind === "over") {
      for (let i = edge + 1; i <= last; i++) {
        const g = this.groundAt(feet, face, i * PROBE_STEP, top, world);
        if (g !== null && g >= ground - LEDGE_STEP) {
          continue;
        }
        const at = this.along(feet, face, i * PROBE_STEP + body.radius + LANDING_MARGIN, ground);
        const landing = { x: at.x, y: at.y, z: at.z };
        if (!world.overlapsCapsule(landing, body.radius, body.height) && this.pathClear(feet, landing, body, world)) {
          over = landing;
        }
        break;
      }
    }

    if (over) {
      return { feet: over, rise, over: true, volume };
    }
    const risen = onto ? onto.y - feet.y : 0;
    if (onto && risen >= MIN_CLIMB && risen <= MAX_CLIMB && this.pathClear(feet, onto, body, world)) {
      return { feet: onto, rise: risen, over: false, volume };
    }
    return null;
  }

  /**
   * The face the player would climb in through, or null.
   *
   * Any of the four sides will do: the games trace ahead of the player, and the
   * side the trace hits sets the direction, straight in through it. The player
   * has to be at that side — within their radius of the box, and inside its
   * span — and facing into it. At a corner two sides can qualify; the one they
   * are further outside of is the one they came at.
   */
  private face(volume: ResolvedMantle, feet: Vec3, yaw: number, radius: number): Face | null {
    // Into the box's own frame: turn the offset the other way (see ResolvedMantle).
    const local = rotateY(feet.x - volume.position.x, feet.z - volume.position.z, -volume.yaw);
    const halfX = volume.size.x / 2;
    const halfZ = volume.size.z / 2;
    // Grown by the player's radius: what matters is that their capsule touches
    // the box, and a tenth of the imported ones are under 20 cm thick.
    if (Math.abs(local.x) > halfX + radius || Math.abs(local.z) > halfZ + radius) {
      return null;
    }
    const look = rotateY(-Math.sin(yaw), -Math.cos(yaw), -volume.yaw);

    let best: { alongX: boolean; sign: number; outside: number; half: number } | null = null;
    for (const alongX of [true, false]) {
      const here = alongX ? local.x : local.z;
      const lookAcross = alongX ? look.x : look.z;
      const half = alongX ? halfX : halfZ;
      for (const sign of [1, -1]) {
        // The side whose outward normal is `sign` along this axis: facing it
        // means looking against that normal.
        if (-sign * lookAcross < FACING_COSINE) {
          continue;
        }
        const outside = sign * here - half;
        if (!best || outside > best.outside) {
          best = { alongX, sign, outside, half };
        }
      }
    }
    if (!best) {
      return null;
    }

    const inward = rotateY(best.alongX ? -best.sign : 0, best.alongX ? 0 : -best.sign, volume.yaw);
    return { x: inward.x, z: inward.z, far: best.outside + 2 * best.half };
  }

  /** The point `distance` along the climb from `feet`, at height `y`. Scratch: copy what is kept. */
  private along(feet: Vec3, face: Face, distance: number, y: number): Vec3 {
    this.probe.x = feet.x + face.x * distance;
    this.probe.y = y;
    this.probe.z = feet.z + face.z * distance;
    return this.probe;
  }

  /** The surface under the point `distance` along the climb, if one is within SURFACE_TOLERANCE of `top`. */
  private groundAt(feet: Vec3, face: Face, distance: number, top: number, world: CapsuleWorld): number | null {
    return world.groundBelow(this.along(feet, face, distance, top + SURFACE_TOLERANCE), 2 * SURFACE_TOLERANCE);
  }

  /**
   * Whether the capsule can make the climb's path without sinking into
   * anything: straight up from `from` to the landing's height, then straight
   * across to it — the path `advanceMantle` moves along.
   *
   * Tested at intervals of half a radius. Between two capsules that far apart,
   * the most anything can reach into the swept shape unseen is under a
   * centimetre, which is the resolver's own tolerance for a wall.
   */
  private pathClear(from: Vec3, to: Vec3, body: MantleBody, world: CapsuleWorld): boolean {
    const step = body.radius / 2;
    const up = to.y - from.y;
    const acrossX = to.x - from.x;
    const acrossZ = to.z - from.z;
    const across = Math.hypot(acrossX, acrossZ);
    const probe = this.probe;
    // The start is where the player already is, so it is not tested: a player
    // the resolver left grazing a wall must still be able to climb away from it.
    const risen = Math.ceil(up / step);
    for (let i = 1; i <= risen; i++) {
      probe.x = from.x;
      probe.y = from.y + (up * i) / risen;
      probe.z = from.z;
      if (world.overlapsCapsule(probe, body.radius, body.height)) {
        return false;
      }
    }
    const moved = Math.ceil(across / step);
    for (let i = 1; i <= moved; i++) {
      probe.x = from.x + (acrossX * i) / moved;
      probe.y = to.y;
      probe.z = from.z + (acrossZ * i) / moved;
      if (world.overlapsCapsule(probe, body.radius, body.height)) {
        return false;
      }
    }
    return true;
  }
}

/**
 * One cell as a number rather than a `${x},${z}` string, for the same reason
 * collision/world.ts does it: a per-tick query must not allocate a key.
 */
function cellKey(x: number, z: number): number {
  return x * 0x100000 + z;
}

/** A world with no mantle volumes, so a caller always has one to hold. */
export const NO_MANTLES = new MantleVolumes([]);

// -- The climb ---------------------------------------------------------------------

/**
 * How long a climb takes, seconds, at MIN_CLIMB and at MAX_CLIMB.
 *
 * The games' own numbers: `mp_mantle_up_21` runs 0.33 s and `mp_mantle_up_57`
 * runs 0.83 s, and the seven clips between them rise monotonically, so a climb
 * is timed by interpolating between the two ends rather than by picking a clip.
 * Named here rather than read from an animation because the simulation has to
 * agree across a client and a server that may not have loaded the same models —
 * and because making mantling faster than the original is a change to these two
 * numbers and nothing else.
 */
const MANTLE_TIME_LOW = 0.33;
const MANTLE_TIME_HIGH = 0.83;

/** Seconds a climb of `rise` metres takes. */
export function mantleDuration(rise: number): number {
  const t = (rise - MIN_CLIMB) / (MAX_CLIMB - MIN_CLIMB);
  return MANTLE_TIME_LOW + (MANTLE_TIME_HIGH - MANTLE_TIME_LOW) * Math.max(0, Math.min(1, t));
}

/** Begin a climb: from here the player is on rails until `advanceMantle` finishes it. */
export function startMantle(s: MovementState, target: MantleTarget): void {
  s.move = {
    kind: "mantle",
    target: { x: target.feet.x, y: target.feet.y, z: target.feet.z },
    left: mantleDuration(target.rise),
    rise: target.rise,
    over: target.over,
  };
  // Whatever jump brought them here is over; the ledge is not its landing.
  s.jumpFrom = null;
  s.landing = 0;
  s.velocity.x = 0;
  s.velocity.y = 0;
  s.velocity.z = 0;
  s.grounded = false;
}

/**
 * Carry a climb forward by `dt`, and finish it when its time runs out.
 *
 * The path has two legs: straight up to the target's height, then straight
 * across to it — the path `MantleVolumes` checked clear, and the only one that
 * is: a straight line from the foot of a ledge to its top cuts through its
 * corner. Which leg the player is on follows from their feet alone.
 *
 * Each step covers the share of what is left that `dt` is of the time left, so
 * the whole trajectory is a function of (feet, target, left) and nothing else.
 * That is what lets a server replaying the same inputs from the same state land
 * in the same place, rather than approximately there.
 */
export function advanceMantle(s: MovementState, mantle: MantleMove, dt: number): void {
  if (dt >= mantle.left) {
    s.feet.x = mantle.target.x;
    s.feet.y = mantle.target.y;
    s.feet.z = mantle.target.z;
    s.velocity.x = 0;
    s.velocity.y = 0;
    s.velocity.z = 0;
    s.move = WALKING;
    // Standing on what they climbed; the next walk step says whether it is ground.
    s.grounded = true;
    return;
  }

  const { target } = mantle;
  const up = Math.max(0, target.y - s.feet.y);
  const acrossX = target.x - s.feet.x;
  const acrossZ = target.z - s.feet.z;
  const across = Math.hypot(acrossX, acrossZ);
  const move = (up + across) * (dt / mantle.left);
  let dx = 0;
  let dy = move;
  let dz = 0;
  if (move >= up) {
    // Round the corner: the rest of this step goes across. The height is set
    // rather than added to, so the next step sees the corner as passed.
    dy = target.y - s.feet.y;
    const share = across > 0 ? Math.min(1, (move - up) / across) : 0;
    dx = acrossX * share;
    dz = acrossZ * share;
  }
  s.feet.x += dx;
  s.feet.y = move >= up ? target.y : s.feet.y + dy;
  s.feet.z += dz;
  // The velocity the climb is making, so anything reading the state (a camera's
  // snap test, a peer's animator) sees the motion rather than a still player.
  s.velocity.x = dx / dt;
  s.velocity.y = dy / dt;
  s.velocity.z = dz / dt;
  mantle.left -= dt;
}
