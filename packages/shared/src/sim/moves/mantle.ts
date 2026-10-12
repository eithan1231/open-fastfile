// Mantling: the volumes a world declares, the question a step asks of them
// while jump is held, and the move it starts.
//
// The question is the games' own, in three parts (reverse/iw5-mantle/): a thin
// probe swept along the view finds the face of a volume, three sweeps of the
// body's own ball find a ledge to stand on beyond it, and a run past the ledge
// with a drop behind it makes the climb a vault. The volume gives the
// permission and the direction; the world's collision gives the ledge.
//
// The move is not the games'. Theirs follows a clip's root motion with
// collision off; this one goes straight up, across, and for a vault down, along
// a path every position of which was tested clear before it began. A ledge
// with no clear path to it is no mantle.
//
// What a volume means is in dsl/resolved.ts's `ResolvedMantle`.

import type { ResolvedMantle } from "../../dsl/resolved.js";
import { SLOPE_NORMAL_Y, type CapsuleResolution, type CapsuleWorld, type Vec3 } from "../capsule.js";
import type { MovementEnv } from "../movementEnv.js";
import { CROUCHING, WALKING, type MantleMove, type MovementState, type StanceKind } from "../movementState.js";
import { advanceEye, CROUCH_HEIGHT, standFits } from "../stance.js";
import { STEP_HEIGHT } from "../stepSlide.js";
import { UNIT } from "../units.js";

// -- The numbers -------------------------------------------------------------------
//
// Every one is Modern Warfare 3's, in its units: reverse/iw5-mantle/ has where
// each was read.

/** The probe is a line this thick, as tall as the body, swept along the view. */
const PROBE_RADIUS = 0.1 * UNIT;
/** How far past the front of the body the probe reaches for a face. It starts as far behind the feet as the front is ahead. */
const PROBE_REACH = 20 * UNIT;
/** The view must be within 60° of straight in through the face, as a cosine. */
const FACING_COSINE = 0.5;
/** A mantle holds the view's yaw this close to its own direction. */
const VIEW_YAW_CAP = (60 * Math.PI) / 180;

/** The ledge is looked for from this high above the feet, highest first: the lower two find a sill under a lintel. */
const LEDGE_PROBES = [60 * UNIT, 40 * UNIT, 20 * UNIT];
/** The ledge is this far ahead of the feet, along the face's direction. */
const LEDGE_AHEAD = 16 * UNIT;
/** A ledge no higher than a step is the walk's to take, not a mantle's. */
const LEDGE_MIN = STEP_HEIGHT;
/** How finely the ball's way down onto the ledge is searched, as halvings of the height it may fall: to 0.8 of a unit. */
const LEDGE_SEARCH = 6;
/** How far into what stopped it the ball is pushed for the resolver to answer: more than the search leaves it short by. */
const LEDGE_DIP = 1 * UNIT;
/**
 * How far off a surface the resolver may rest a body, generously. Feet this
 * close under a volume's top are standing on it and not in it, and a ledge
 * this much over a height is at it.
 */
const RESTING = 0.5 * UNIT;

/** A vault goes this far past the ledge and ends this far below it, with nothing under it on the way down. */
const OVER_RUN = 31 * UNIT;
const OVER_DROP = 18 * UNIT;

/** The frame rate the games' mantle clips are timed at. */
const CLIP_RATE = 30;

/** How a vault's own clip ends: its length, and the speed it leaves the player with. */
interface OverClip {
  readonly seconds: number;
  /** m/s along the mantle's direction, and downward. */
  readonly forward: number;
  readonly down: number;
  /** The weapon stays in the hands for every row that names this clip, vaulting or not. */
  readonly armed: boolean;
}

function overClip(frames: number, forward: number, down: number, armed: boolean): OverClip {
  return { seconds: frames / CLIP_RATE, forward: forward * UNIT, down: down * UNIT, armed };
}

const OVER_HIGH = overClip(7, 138, 131, false);
const OVER_MID = overClip(12, 78, 79, false);
const OVER_LOW = overClip(14, 67, 80, true);

/** One row of the games' transition table: a ledge height, and everything timed or decided by it. */
export interface MantleRow {
  /** The ledge height this row is for, m. A mantle takes the row nearest its own. */
  readonly height: number;
  /** Seconds onto the ledge. */
  readonly up: number;
  /** m/s along the mantle's direction on arriving there. */
  readonly forward: number;
  readonly over: OverClip;
}

function row(height: number, frames: number, forward: number, over: OverClip): MantleRow {
  return { height: height * UNIT, up: frames / CLIP_RATE, forward: forward * UNIT, over };
}

/** The table, tallest first. A `MantleMove` names its row by index, so the order is part of the wire format. */
export const MANTLE_ROWS: readonly MantleRow[] = [
  row(57, 25, 19.6, OVER_HIGH),
  row(51, 24, 20.4, OVER_HIGH),
  row(45, 18, 34.1, OVER_MID),
  row(39, 18, 34.1, OVER_MID),
  row(33, 15, 39.7, OVER_MID),
  row(27, 13, 38.8, OVER_LOW),
  row(21, 10, 44.2, OVER_LOW),
];

/** The longest any mantle takes, seconds: the bound `MantleMove.left` is sent in. */
export const MANTLE_TIME_MAX = Math.max(...MANTLE_ROWS.map((r) => r.up + r.over.seconds));

/** The row for a ledge `height` above the feet: the nearest, and the taller of two as near. */
export function mantleRow(height: number): number {
  let best = 0;
  for (let i = 1; i < MANTLE_ROWS.length; i++) {
    if (Math.abs(MANTLE_ROWS[i]!.height - height) < Math.abs(MANTLE_ROWS[best]!.height - height)) {
      best = i;
    }
  }
  return best;
}

/** The row a mantle under way is timed by. Held in range, so a state from elsewhere cannot name a row there is not. */
function rowOf(mantle: Readonly<MantleMove>): MantleRow {
  return MANTLE_ROWS[Math.min(mantle.row, MANTLE_ROWS.length - 1)]!;
}

/** Seconds a mantle in `row` takes, onto the ledge and — a vault — over it. */
export function mantleSeconds(row: number, over: boolean): number {
  const times = MANTLE_ROWS[row]!;
  return times.up + (over ? times.over.seconds : 0);
}

// -- The query ---------------------------------------------------------------------

/** The capsule a mantle is asked for: the part of `MovementParams` a query reads. */
export interface MantleBody {
  radius: number;
  height: number;
}

/** A mantle that may start: what `MantleVolumes.find` answers, and a movement step begins. */
export interface MantleFound {
  /** The volume whose face the probe met, for a caller that wants its id. */
  volume: ResolvedMantle;
  /** The way it goes, as a yaw: straight in through that face, whatever the view was. */
  yaw: number;
  /** The feet on the ledge. */
  ledge: Vec3;
  /** Where the feet are left: the ledge, or for a vault past it and below. */
  end: Vec3;
  /** The ledge's surface above the feet it was asked from, m. Feet standing on its edge rest a little under that. */
  height: number;
  /** A vault: on over the ledge and down its far side. */
  over: boolean;
  /** Made crouched, because a standing body does not fit on the ledge or on the way. */
  crouched: boolean;
}

/**
 * Where a segment from `p` along `d` is between -h and h on one axis, as
 * distances along it; null if it never is. A segment parallel to the slab is in
 * it for good or not at all.
 */
function slab(p: number, d: number, h: number): { enter: number; exit: number } | null {
  if (Math.abs(d) < 1e-9) {
    return Math.abs(p) < h ? { enter: -Infinity, exit: Infinity } : null;
  }
  const t0 = (-h - p) / d;
  const t1 = (h - p) / d;
  return { enter: Math.min(t0, t1), exit: Math.max(t0, t1) };
}

// Scratch, so a query that finds nothing allocates nothing. None of it survives a call.
const from: Vec3 = { x: 0, y: 0, z: 0 };
const to: Vec3 = { x: 0, y: 0, z: 0 };
const probe: Vec3 = { x: 0, y: 0, z: 0 };
const shelf: Vec3 = { x: 0, y: 0, z: 0 };
const beyond: Vec3 = { x: 0, y: 0, z: 0 };
const rest: CapsuleResolution = { position: { x: 0, y: 0, z: 0 }, grounded: false, normal: { x: 0, y: 0, z: 0 } };

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

  /** Metres. Comfortably larger than any volume's footprint (the widest imported is 4.4 m). */
  private static readonly CELL = 8;
  /** How far outside its own footprint a volume is registered: past the probe's reach from the feet, 0.89 m for a player. */
  private static readonly REACH = 1;

  constructor(volumes: readonly ResolvedMantle[]) {
    this.volumes = volumes;
    for (let i = 0; i < volumes.length; i++) {
      const v = volumes[i]!;
      // The footprint of a turned box, as scripts/cod/mantle.py's `box_footprint`.
      const c = Math.abs(Math.cos(v.yaw));
      const s = Math.abs(Math.sin(v.yaw));
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
   * The mantle a standing body at `feet` looking along `yaw` may start, or null.
   *
   * Deterministic: a server asks this every step a player's jump is held, and
   * has to reach the answer the client did from the same state and the same
   * world. A world whose collision is not loaded offers nothing to climb.
   */
  find(feet: Vec3, yaw: number, body: MantleBody, world: CapsuleWorld): MantleFound | null {
    if (!world.ready) {
      return null;
    }
    const cell = this.grid.get(cellKey(Math.floor(feet.x / MantleVolumes.CELL), Math.floor(feet.z / MantleVolumes.CELL)));
    if (!cell) {
      return null;
    }
    const face = this.face(cell, feet, yaw, body);
    if (face === null) {
      return null;
    }
    const dirX = -Math.sin(face.yaw);
    const dirZ = -Math.cos(face.yaw);
    const height = ledgeAhead(feet, dirX, dirZ, body, world);
    if (height === null) {
      return null;
    }

    // The tallest hull that makes the way: standing, or crouched where a
    // standing body does not fit on the ledge or under what is over the path.
    const stands = !world.overlapsCapsule(shelf, body.radius, body.height);
    let crouched = !stands;
    // A vault where the map asked for one and there is the room: the run past
    // the ledge and the drop behind it are the last two legs of the path.
    let over = false;
    if (face.volume.kind === "over") {
      beyond.x = shelf.x + dirX * OVER_RUN;
      beyond.y = shelf.y - OVER_DROP;
      beyond.z = shelf.z + dirZ * OVER_RUN;
      if (stands && pathClear(feet, shelf, beyond, body.radius, body.height, world)) {
        over = true;
      } else if (pathClear(feet, shelf, beyond, body.radius, CROUCH_HEIGHT, world)) {
        over = true;
        crouched = true;
      }
    }
    if (!over) {
      if (!(stands && pathClear(feet, shelf, null, body.radius, body.height, world))) {
        if (!pathClear(feet, shelf, null, body.radius, CROUCH_HEIGHT, world)) {
          return null;
        }
        crouched = true;
      }
    }
    const end = over ? beyond : shelf;
    return {
      volume: face.volume,
      yaw: face.yaw,
      ledge: { x: shelf.x, y: shelf.y, z: shelf.z },
      end: { x: end.x, y: end.y, z: end.z },
      height,
      over,
      crouched,
    };
  }

  /**
   * The face the probe meets first: a line as tall as the body, swept along the
   * view from behind the feet to PROBE_REACH past the body's front. The mantle
   * goes straight in through that face, and only if the view is within 60° of
   * that. A probe that starts inside a volume finds nothing at all.
   */
  private face(cell: readonly number[], feet: Vec3, yaw: number, body: MantleBody): { volume: ResolvedMantle; yaw: number } | null {
    const viewX = -Math.sin(yaw);
    const viewZ = -Math.cos(yaw);
    const back = body.radius - PROBE_RADIUS;
    const length = 2 * back + PROBE_REACH;
    const startX = feet.x - viewX * back;
    const startZ = feet.z - viewZ * back;
    const top = feet.y + body.height;

    let nearest = Infinity;
    let hit: ResolvedMantle | null = null;
    let inX = 0;
    let inZ = 0;
    for (const index of cell) {
      const volume = this.volumes[index]!;
      const floor = volume.position.y - volume.size.y / 2;
      if (top <= floor || feet.y >= floor + volume.size.y - RESTING) {
        continue;
      }
      // Into the box's frame (see ResolvedMantle), where the swept probe is a
      // segment against the box grown by the probe's radius.
      const s = Math.sin(-volume.yaw);
      const c = Math.cos(-volume.yaw);
      const ox = startX - volume.position.x;
      const oz = startZ - volume.position.z;
      const px = ox * c + oz * s;
      const pz = -ox * s + oz * c;
      const dx = viewX * c + viewZ * s;
      const dz = -viewX * s + viewZ * c;
      const hx = volume.size.x / 2 + PROBE_RADIUS;
      const hz = volume.size.z / 2 + PROBE_RADIUS;
      if (Math.abs(px) < hx && Math.abs(pz) < hz) {
        return null;
      }
      const x = slab(px, dx, hx);
      const z = slab(pz, dz, hz);
      if (!x || !z) {
        continue;
      }
      const alongX = x.enter >= z.enter;
      const enter = Math.max(x.enter, z.enter);
      if (enter < 0 || enter > Math.min(x.exit, z.exit) || enter > length || enter >= nearest) {
        continue;
      }
      // The side entered, as its inward normal turned back out of the box's frame.
      const sign = (alongX ? dx : dz) > 0 ? 1 : -1;
      const nx = alongX ? sign : 0;
      const nz = alongX ? 0 : sign;
      nearest = enter;
      hit = volume;
      inX = nx * c - nz * s;
      inZ = nx * s + nz * c;
    }
    // A map's own per-face flags belong here, once a world carries them: a
    // face flagged neither to climb onto nor over refuses, and `over` is the
    // face's to say rather than the volume's `kind`. Until then every side climbs.
    if (hit === null || viewX * inX + viewZ * inZ < FACING_COSINE) {
      return null;
    }
    // Plus zero: straight along -Z is a negative zero, which a JSON copy of the state would not keep.
    return { volume: hit, yaw: Math.atan2(-inX, -inZ) + 0 };
  }
}

/**
 * Find the ledge LEDGE_AHEAD of `feet` along the unit (dirX, dirZ), into
 * `shelf`, and answer how high it is above them: null if there is none. From
 * each of LEDGE_PROBES in turn, the body's own ball is carried forward, which
 * must meet nothing, and let down. What it comes to rest on is the ledge if
 * the resolver calls that ground, it is higher than a step and no higher than
 * the ball was carried, and a crouched body has room there.
 *
 * Ground is the resolver's word and not the contact's slope: a ball let down
 * past the edge of a level top rests on its corner, where the games' flat
 * box would be standing on the top itself (`CapsuleResolution.grounded`).
 * The ledge's height is that corner's, which is above where the feet rest.
 */
function ledgeAhead(feet: Readonly<Vec3>, dirX: number, dirZ: number, body: MantleBody, world: CapsuleWorld): number | null {
  const { radius } = body;
  // The lowest the ball's centre can be and still be held by a corner above LEDGE_MIN.
  const low = feet.y + LEDGE_MIN + radius * SLOPE_NORMAL_Y;
  // Where the ball last came to rest on something that was no ledge. Let down
  // from anywhere above that it rests there again, so a probe that would is not made.
  let stopped = Infinity;
  for (const height of LEDGE_PROBES) {
    from.x = feet.x;
    from.y = feet.y + height + radius;
    from.z = feet.z;
    if (from.y >= stopped) {
      continue;
    }
    to.x = feet.x + dirX * LEDGE_AHEAD;
    to.y = from.y;
    to.z = feet.z + dirZ * LEDGE_AHEAD;
    if (world.overlapsSweep(from, to, radius)) {
      continue;
    }
    probe.x = to.x;
    probe.y = low;
    probe.z = to.z;
    if (!world.overlapsSweep(to, probe, radius)) {
      // Nothing under it from here, so nothing under it from lower down either.
      return null;
    }
    // How far down the ball gets, by halving: the sweep to a height meets
    // something or it does not, and whatever is lower meets it too.
    let clear = to.y;
    let blocked = low;
    for (let i = 0; i < LEDGE_SEARCH; i++) {
      probe.y = (clear + blocked) / 2;
      if (world.overlapsSweep(to, probe, radius)) {
        blocked = probe.y;
      } else {
        clear = probe.y;
      }
    }
    stopped = clear;
    // Into it, so the resolver says what it came down on and where it rests.
    probe.y = clear - radius - LEDGE_DIP;
    world.resolveCapsule(probe, radius, 2 * radius, rest);
    if (!rest.grounded) {
      continue;
    }
    // A corner the ball slipped past round its side is higher than the flat
    // underside of the games' box was carried: that box would have met it.
    const top = rest.position.y + radius * (1 - rest.normal.y) - feet.y;
    if (top <= LEDGE_MIN || top > height + RESTING) {
      continue;
    }
    shelf.x = to.x;
    shelf.y = rest.position.y;
    shelf.z = to.z;
    if (!world.overlapsCapsule(shelf, radius, CROUCH_HEIGHT)) {
      return top;
    }
    // Pushed off a corner sideways as well as up, the resolver's height is not
    // clear at this point. Where the ball last was clear is, a little above.
    shelf.y = clear - radius;
    if (!world.overlapsCapsule(shelf, radius, CROUCH_HEIGHT)) {
      return top;
    }
  }
  return null;
}

/**
 * Whether a capsule `height` tall can make the mantle's path without sinking
 * into anything: straight up from `start` to the ledge's height, straight
 * across to it — on to `end`, for a vault — and straight down to `end`.
 *
 * Tested every half radius. Between two capsules that far apart, the most
 * anything can reach into the swept shape unseen is under a centimetre, which
 * is the resolver's own tolerance for a wall.
 */
function pathClear(start: Readonly<Vec3>, ledge: Readonly<Vec3>, end: Readonly<Vec3> | null, radius: number, height: number, world: CapsuleWorld): boolean {
  const step = radius / 2;
  const far = end ?? ledge;
  // The start is where the body already is, so it is not tested: one the
  // resolver left grazing a wall must still be able to climb away from it.
  const up = ledge.y - start.y;
  const risen = Math.ceil(up / step);
  probe.x = start.x;
  probe.z = start.z;
  for (let i = 1; i <= risen; i++) {
    probe.y = start.y + (up * i) / risen;
    if (world.overlapsCapsule(probe, radius, height)) {
      return false;
    }
  }
  const acrossX = far.x - start.x;
  const acrossZ = far.z - start.z;
  const moved = Math.ceil(Math.hypot(acrossX, acrossZ) / step);
  probe.y = ledge.y;
  for (let i = 1; i <= moved; i++) {
    probe.x = start.x + (acrossX * i) / moved;
    probe.z = start.z + (acrossZ * i) / moved;
    if (world.overlapsCapsule(probe, radius, height)) {
      return false;
    }
  }
  const down = ledge.y - far.y;
  const fallen = Math.ceil(down / step);
  probe.x = far.x;
  probe.z = far.z;
  for (let i = 1; i <= fallen; i++) {
    probe.y = ledge.y - (down * i) / fallen;
    if (world.overlapsCapsule(probe, radius, height)) {
      return false;
    }
  }
  return true;
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

// -- The move ----------------------------------------------------------------------

/** Time left under this is none: what subtracting a step at a time leaves of a whole number of them. */
const TIME_SLACK = 1e-9;

/** Where a vault leaves the feet, into `out`: OVER_RUN past the ledge along the mantle and OVER_DROP below it. */
function overEnd(mantle: Readonly<MantleMove>, out: Vec3): Vec3 {
  out.x = mantle.ledge.x - Math.sin(mantle.yaw) * OVER_RUN;
  out.y = mantle.ledge.y - OVER_DROP;
  out.z = mantle.ledge.z - Math.cos(mantle.yaw) * OVER_RUN;
  return out;
}

/**
 * Begin a mantle: from here the player is on rails until `advanceMantle` ends
 * it. A ladder is let go of as by any way but a jump, and a body that must be
 * crouched for it is, from this step.
 */
export function startMantle(s: MovementState, found: MantleFound, dt: number): MantleMove {
  if (s.move.kind === "ladder") {
    s.ladderLock = true;
  }
  const row = mantleRow(found.height);
  const mantle: MantleMove = {
    kind: "mantle",
    ledge: { x: found.ledge.x, y: found.ledge.y, z: found.ledge.z },
    yaw: found.yaw,
    row,
    over: found.over,
    left: mantleSeconds(row, found.over),
  };
  s.move = mantle;
  // Whatever jump brought them here is over; the ledge is not its landing.
  s.jumpFrom = null;
  s.landing = 0;
  s.grounded = false;
  if (found.crouched) {
    s.stance = CROUCHING;
    advanceEye(s, dt, "stand");
  }
  return mantle;
}

/**
 * Move `feet` the share `part` of what is left of two straight legs to `end`:
 * the height first and then the ground (`riseFirst`), or the other way round.
 * Which leg they are on follows from the feet alone, and a leg's end is set
 * rather than added up to, so the next step sees the corner as passed.
 */
function travel(feet: Vec3, end: Readonly<Vec3>, riseFirst: boolean, part: number): void {
  if (part >= 1) {
    feet.x = end.x;
    feet.y = end.y;
    feet.z = end.z;
    return;
  }
  const rise = end.y - feet.y;
  const acrossX = end.x - feet.x;
  const acrossZ = end.z - feet.z;
  const across = Math.hypot(acrossX, acrossZ);
  const first = riseFirst ? Math.abs(rise) : across;
  const second = riseFirst ? across : Math.abs(rise);
  const move = (first + second) * part;
  const share = move < first ? move / first : second > 0 ? (move - first) / second : 0;
  const onRise = riseFirst === move < first;
  if (move >= first) {
    // Round the corner: the first leg is done, and the rest of this step is the second's.
    if (riseFirst) {
      feet.y = end.y;
    } else {
      feet.x = end.x;
      feet.z = end.z;
    }
  }
  if (onRise) {
    feet.y += rise * share;
  } else {
    feet.x += acrossX * share;
    feet.z += acrossZ * share;
  }
}

/**
 * Carry a mantle forward by `dt`, and end it when its time runs out. Returns
 * the stance it holds the player to (`stepMovement`).
 *
 * The path is the one `MantleVolumes.find` tested clear: up to the ledge's
 * height and across onto it, in the row's time for that, and for a vault on
 * past it and down, in the row's time for that. Each step covers the share of
 * what is left of a part that `dt` is of the time left of it, so the way is a
 * function of the feet and the move and not of how it was sliced into steps.
 *
 * It ends as the games' does: onto a ledge, on it with a little speed along
 * the mantle; over one, in the air with the vault's speed forward and down.
 */
export function advanceMantle(s: MovementState, mantle: MantleMove, dt: number, env: MovementEnv): StanceKind | null {
  const row = rowOf(mantle);
  const vault = mantle.over ? row.over.seconds : 0;
  const { feet, velocity } = s;
  from.x = feet.x;
  from.y = feet.y;
  from.z = feet.z;

  let time = dt;
  if (mantle.left > vault) {
    const left = mantle.left - vault;
    const spent = Math.min(time, left);
    const done = left - spent <= TIME_SLACK;
    travel(feet, mantle.ledge, true, done ? 1 : spent / left);
    mantle.left = done ? vault : mantle.left - spent;
    time -= spent;
  }
  if (time > 0 && mantle.left > 0) {
    const spent = Math.min(time, mantle.left);
    const done = mantle.left - spent <= TIME_SLACK;
    travel(feet, overEnd(mantle, to), false, done ? 1 : spent / mantle.left);
    mantle.left = done ? 0 : mantle.left - spent;
  }

  const crouched = s.stance.kind === "crouch";
  if (mantle.left > 0) {
    // The velocity the move is making, so whatever reads the state (a camera's
    // snap test, a peer's animator) sees the motion rather than a still player.
    velocity.x = (feet.x - from.x) / dt;
    velocity.y = (feet.y - from.y) / dt;
    velocity.z = (feet.z - from.z) / dt;
    return crouched ? "crouch" : null;
  }

  const forward = mantle.over ? row.over.forward : row.forward;
  // Plus zero, as the yaw has it: no component is left a negative zero.
  velocity.x = -Math.sin(mantle.yaw) * forward + 0;
  velocity.y = mantle.over ? -row.over.down : 0;
  velocity.z = -Math.cos(mantle.yaw) * forward + 0;
  // On the ledge it was set down on; past one, with nothing under the feet.
  s.grounded = !mantle.over;
  s.move = WALKING;
  // A body it crouched is stood up again where there is the room, by the key this asks for.
  return crouched ? (standFits(s, env) ? "stand" : "crouch") : null;
}

/**
 * The yaw a player in state `s` may look along, asked for `yaw`: mid-mantle, no
 * further than VIEW_YAW_CAP from the way it goes. One of the caps sim/view.ts
 * applies, for the step and the camera alike.
 */
export function mantleYaw(mantle: Readonly<MantleMove>, yaw: number): number {
  const delta = Math.atan2(Math.sin(yaw - mantle.yaw), Math.cos(yaw - mantle.yaw));
  if (Math.abs(delta) <= VIEW_YAW_CAP) {
    return yaw;
  }
  return mantle.yaw + Math.sign(delta) * VIEW_YAW_CAP;
}

/** Whether a mantle takes the weapon out of the hands: all but the two lowest rows do. */
export function mantleStows(mantle: Readonly<MantleMove>): boolean {
  return !rowOf(mantle).over.armed;
}

/**
 * Which of a mantle's two parts a body is in, and how far through it, 0 to 1:
 * what a pose scrubs the part's clip by, so the body arrives when the capsule does.
 */
export function mantleProgress(mantle: Readonly<MantleMove>): { over: boolean; done: number } {
  const row = rowOf(mantle);
  const vault = mantle.over ? row.over.seconds : 0;
  if (mantle.left > vault) {
    return { over: false, done: Math.max(0, 1 - (mantle.left - vault) / row.up) };
  }
  return { over: mantle.over, done: vault > 0 ? 1 - mantle.left / vault : 1 };
}
