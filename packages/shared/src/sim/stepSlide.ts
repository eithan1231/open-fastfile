// The end of every free step: move the capsule by its velocity, keep it out of
// the world, step it up onto what the move met and down onto what it left, and
// say whether it ends on the ground — the games' step-slide move and ground
// trace, over a resolver rather than a trace.
//
// One entry per kind of move that ends here: `groundSlide` for a walk on the
// ground, `airSlide` for a jump or a fall, `ladderSlide` for a ladder. The rules
// and where they come from are in docs/engine/player.md and reverse/iw5-pmove/.
//
// Two things hold above every rule. A step never leaves the capsule inside the
// world: every position kept was tested clear. And all of it is a function of
// the state, the world and the move, so a server replaying it steps the same way.

import { SLOPE_NORMAL_Y, WALKABLE_NORMAL_Y, type CapsuleResolution, type CapsuleWorld, type Vec3 } from "./capsule.js";
import type { MovementEnv } from "./movementEnv.js";
import { GRAVITY, JUMP_HEIGHT, type MovementParams, type MovementState } from "./movementState.js";
import { UNIT } from "./units.js";

/** The tallest ledge a blocked move steps onto. */
export const STEP_HEIGHT = 18 * UNIT;
/** A lift shorter than this is no step: there is no head room for one. */
const STEP_MIN = 1 * UNIT;
/** How much taller than the lift a ledge may measure and still be stepped onto: what finding it by halving leaves. */
const LEDGE_SLACK = 0.5 * UNIT;
/** How much further along its velocity a stepped move must get than the plain one to be kept. */
const STEP_GAIN = 0.001 * UNIT;
/** How far past where it was stopped a step onto a ledge goes, as a share of the radius: what puts the corner under a rounded bottom. */
const STEP_ACROSS = 0.1;
/** ...and the most that lengthens the move by: a body barely moving does not lurch onto a ledge. */
const STEP_STRETCH = 4;
/** A walk that leaves the ground stays on whatever is within this below it. Further is a fall. */
const STICK_DOWN = 9 * UNIT;
/** Ground is what is within this of the feet. */
const GROUND_REACH = 0.25 * UNIT;
/** A step or a drop taller than this costs speed (`stepCost`). */
const STEP_COST_MIN = 0.5 * UNIT;
/** Rising off ground faster than this along its normal is leaving it, not standing on it. */
const LEAVING_SPEED = 10 * UNIT;
/** A push sideways of less than this is float residue, not something the move met. */
const BUMP = 1e-4;
/** How finely a step finds its head room and where it sets down, as halvings of the height searched. */
const LIFT_SEARCH = 5;
const SET_DOWN_SEARCH = 8;

/** The normal of nothing at all. */
const NOTHING: Readonly<Vec3> = { x: 0, y: 0, z: 0 };

// Scratch, so a tick allocates nothing. None of it survives a call.
const probe: Vec3 = { x: 0, y: 0, z: 0 };
const start: Vec3 = { x: 0, y: 0, z: 0 };
const startVelocity: Vec3 = { x: 0, y: 0, z: 0 };
const move: Vec3 = { x: 0, y: 0, z: 0 };
const plain: Vec3 = { x: 0, y: 0, z: 0 };
/** Where the capsule came to rest after a move, and what it rests on. */
const rest: CapsuleResolution = { position: { x: 0, y: 0, z: 0 }, grounded: false, normal: { x: 0, y: 0, z: 0 } };
/** What a query that only asks what is under a position found there. */
const under: CapsuleResolution = { position: { x: 0, y: 0, z: 0 }, grounded: false, normal: { x: 0, y: 0, z: 0 } };

function copy(to: Vec3, from: Readonly<Vec3>): void {
  to.x = from.x;
  to.y = from.y;
  to.z = from.z;
}

/**
 * Move by `move` and push the capsule out of the world. True if it was pushed
 * aside: the move met something. A ceiling met while rising ends the rise.
 *
 * `reach` is how far under the feet ground still counts (GROUND_REACH for a
 * walk on it, 0 otherwise): the move ends that much lower, so the one
 * resolution lifts the feet back onto ground that is there and says so in `rest`.
 */
function collide(s: MovementState, world: CapsuleWorld, body: MovementParams, reach: number): boolean {
  s.feet.x += move.x;
  s.feet.y += move.y - reach;
  s.feet.z += move.z;
  const at = world.resolveCapsule(s.feet, body.radius, body.height, rest).position;
  // Pushed down while rising, more than sideways: the head hit something. A
  // wall's push can carry a fraction of a millimetre of down in it, which must
  // not end a jump, or a ladder climb, along it.
  const down = s.feet.y - at.y;
  const aside = Math.hypot(at.x - s.feet.x, at.z - s.feet.z);
  if (s.velocity.y > 0 && down > 1e-4 && down > aside) {
    s.velocity.y = 0;
  }
  copy(s.feet, at);
  return aside > BUMP;
}

/** Whether what the capsule came to rest on is ground to this body: walkable, or under it and as steep as its footing takes. */
function stands(on: Readonly<CapsuleResolution>, body: MovementParams): boolean {
  return on.grounded || on.normal.y >= body.footing;
}

/** What is under a capsule with its feet at `feet`, within GROUND_REACH: written to `under`, and whether it is ground. */
function groundAt(feet: Readonly<Vec3>, world: CapsuleWorld, body: MovementParams): boolean {
  probe.x = feet.x;
  probe.y = feet.y - GROUND_REACH;
  probe.z = feet.z;
  return stands(world.resolveCapsule(probe, body.radius, body.height, under), body);
}

/** `v` laid onto the plane of `normal` along its own heading, at the speed it had. */
export function alongGround(v: Vec3, normal: Readonly<Vec3>): void {
  const flat = v.x * v.x + v.z * v.z;
  if (flat === 0 || normal.y < SLOPE_NORMAL_Y) {
    return;
  }
  const y = -(v.x * normal.x + v.z * normal.z) / normal.y;
  const scale = Math.sqrt((flat + v.y * v.y) / (flat + y * y));
  v.x *= scale;
  v.y = y * scale;
  v.z *= scale;
}

/** Take out of `v` what goes into the plane of `normal`. */
function clip(v: Vec3, normal: Readonly<Vec3>): void {
  const into = v.x * normal.x + v.y * normal.y + v.z * normal.z;
  if (into < 0) {
    v.x -= normal.x * into;
    v.y -= normal.y * into;
    v.z -= normal.z * into;
  }
}

/** Whether a step ending at (x, z) got further along the way the move was going than the plain move did. */
function gains(x: number, z: number, speed: number): boolean {
  return (x - plain.x) * startVelocity.x + (z - plain.z) * startVelocity.z > STEP_GAIN * speed;
}

/** What became of a step: not worth taking, refused by what it would land on, or kept — in the air, or on ground. */
const enum Step {
  None,
  Refused,
  Kept,
  KeptOnGround,
}

/**
 * Make the move again from as high as the head room allows, up to `height`, and
 * set the feet down on what is there. Called with the plain move made: `start`,
 * `move` and `plain` hold it, and a step not kept leaves the capsule at `plain`.
 *
 * `fromGround` reaches STICK_DOWN further down, as a walk does. `ceiling` is
 * for a step in a jump, which only walkable ground below that height may end;
 * null for any other. `mount` is a plain move stopped with nothing under it:
 * against a ledge, not yet on its corner.
 */
function step(s: MovementState, world: CapsuleWorld, body: MovementParams, height: number, fromGround: boolean, ceiling: number | null, mount: boolean): Step {
  const { radius, height: tall } = body;

  // Up, as far as there is room overhead.
  probe.x = start.x;
  probe.y = start.y + height;
  probe.z = start.z;
  let lift = height;
  if (world.overlapsCapsule(probe, radius, tall)) {
    let clear = 0;
    let blocked = height;
    for (let i = 0; i < LIFT_SEARCH; i++) {
      probe.y = start.y + (clear + blocked) / 2;
      if (world.overlapsCapsule(probe, radius, tall)) {
        blocked = probe.y - start.y;
      } else {
        clear = probe.y - start.y;
      }
    }
    lift = clear;
  }
  if (lift < STEP_MIN) {
    return Step.None;
  }

  // Across: the same move, from that much higher. A box is on a ledge with any
  // of itself over it; a rounded bottom is held by the corner only once that is
  // some way under it, so a move stopped short of that goes that far past
  // where it was stopped.
  const length = Math.hypot(move.x, move.z);
  let stretch = 1;
  if (mount && length > 0) {
    const stopped = ((plain.x - start.x) * move.x + (plain.z - start.z) * move.z) / length;
    stretch = Math.min(STEP_STRETCH, Math.max(1, (stopped + STEP_ACROSS * radius) / length));
  }
  probe.x = start.x + move.x * stretch;
  probe.y = start.y + lift + move.y;
  probe.z = start.z + move.z * stretch;
  const across = world.resolveCapsule(probe, radius, tall, under).position;
  let x = across.x;
  const top = across.y;
  let z = across.z;

  // Worth it only if it got further along the way the move was going: sliding
  // sideways along a ledge gains nothing from a step. Asked here, before the
  // way down is looked for, and again of where that ends.
  const speed = Math.hypot(startVelocity.x, startVelocity.z);
  if (speed === 0 || !gains(x, z, speed)) {
    return Step.None;
  }
  probe.x = x;
  probe.y = top;
  probe.z = z;
  if (world.overlapsCapsule(probe, radius, tall)) {
    return Step.None;
  }

  // Down: the lowest clear height within reach, found by halving.
  const reach = lift + (fromGround ? STICK_DOWN : 0);
  let y = top - lift;
  let landed = false;
  probe.y = top - reach;
  if (world.overlapsCapsule(probe, radius, tall)) {
    let clear = top;
    let blocked = top - reach;
    for (let i = 0; i < SET_DOWN_SEARCH; i++) {
      probe.y = (clear + blocked) / 2;
      if (world.overlapsCapsule(probe, radius, tall)) {
        blocked = probe.y;
      } else {
        clear = probe.y;
      }
    }
    y = clear;
    landed = true;
  } else {
    // Nothing underfoot within reach: the feet go back to the height the move
    // was made from, and the gain already decided it.
    probe.y = y;
    if (world.overlapsCapsule(probe, radius, tall)) {
      return Step.None;
    }
  }

  let onGround = false;
  // How high what it landed on stands: the feet, or the ledge whose corner holds them.
  let ledge = y;
  if (landed) {
    probe.y = y;
    onGround = groundAt(probe, world, body);
    // Where the resolver rests it, which the halving only came close to.
    x = under.position.x;
    y = under.position.y;
    z = under.position.z;
    if (!gains(x, z, speed)) {
      return Step.None;
    }
    const up = under.normal.y;
    if (onGround) {
      // A rounded bottom rests on a ledge's corner with the feet below its top.
      // The step is as tall as the ledge, as a box's would be: no taller than the lift.
      ledge = y + radius * (1 - up);
      if (ledge - start.y > lift + LEDGE_SLACK) {
        return Step.None;
      }
    } else if (ceiling !== null || up < SLOPE_NORMAL_Y || y - Math.max(plain.y, start.y) > 2 * height * up) {
      // Too steep to stand on: only a walk takes it, and only as high as its steepness allows.
      return Step.Refused;
    }
  }
  if (ceiling !== null && Math.max(y, ledge) >= ceiling) {
    return Step.None;
  }

  s.feet.x = x;
  s.feet.y = y;
  s.feet.z = z;
  if (fromGround) {
    // The next walk step lays it along whatever ground this one reached.
    copy(s.velocity, startVelocity);
  } else if (landed && !onGround) {
    clip(s.velocity, under.normal);
  }
  return onGround ? Step.KeptOnGround : Step.Kept;
}

/**
 * Stay on ground the move walked off: a slope's crest, a kerb, a stair down.
 * True if there was ground within STICK_DOWN to stand on.
 */
function stickDown(s: MovementState, world: CapsuleWorld, body: MovementParams): boolean {
  probe.x = s.feet.x;
  probe.y = s.feet.y + GROUND_REACH;
  probe.z = s.feet.z;
  const ground = world.groundBelow(probe, STICK_DOWN + GROUND_REACH);
  if (ground === null) {
    return false;
  }
  // Just into it, so the resolver lifts the feet onto it and says what it is.
  probe.y = ground - GROUND_REACH;
  let at = world.resolveCapsule(probe, body.radius, body.height, under);
  if (stands(at, body) && world.overlapsCapsule(at.position, body.radius, body.height)) {
    // Pushed off the ground into something beside it: once more, from there.
    copy(probe, at.position);
    at = world.resolveCapsule(probe, body.radius, body.height, under);
  }
  if (!stands(at, body) || world.overlapsCapsule(at.position, body.radius, body.height)) {
    return false;
  }
  // Down, and on the way it was going: ground the capsule does not fit onto
  // pushes it back the way it came, and a walk held there never gets past. It
  // may come to rest short of that ground, on the corner of what it walked off.
  const aside = Math.hypot(at.position.x - s.feet.x, at.position.z - s.feet.z);
  const onward = (at.position.x - s.feet.x) * s.velocity.x + (at.position.z - s.feet.z) * s.velocity.z;
  if ((aside > LEDGE_SLACK && onward <= 0) || at.position.y > s.feet.y + LEDGE_SLACK) {
    return false;
  }
  copy(s.feet, at.position);
  clip(s.velocity, at.normal);
  return true;
}

/**
 * The end of a walk step that started on the ground: the move along it, a step
 * up where the move was blocked or `sloped` says the ground is steep enough to
 * hide one, and a step down onto ground it walked off. No gravity: a walk that
 * finds no ground within reach ends in the air, and the next step falls.
 */
export function groundSlide(s: MovementState, dt: number, env: MovementEnv, sloped: boolean): void {
  const { world, body } = env;
  const v = s.velocity;
  copy(start, s.feet);
  copy(startVelocity, v);
  move.x = v.x * dt;
  move.y = v.y * dt;
  move.z = v.z * dt;
  if (!world.ready) {
    s.feet.x += move.x;
    s.feet.y += move.y;
    s.feet.z += move.z;
    s.grounded = false;
    return;
  }
  let bumped = collide(s, world, body, GROUND_REACH);
  if (!stands(rest, body) && rest.normal.y > 0) {
    // Something too steep to stand on pushes a capsule up it. To a walk it is a
    // wall, as it is to a box: the feet stay level and stand off it sideways.
    const flat = rest.normal.x * rest.normal.x + rest.normal.z * rest.normal.z;
    probe.x = start.x + move.x;
    probe.y = start.y + move.y - GROUND_REACH;
    probe.z = start.z + move.z;
    probe.x += (s.feet.x - probe.x) / flat;
    probe.z += (s.feet.z - probe.z) / flat;
    copy(s.feet, world.resolveCapsule(probe, body.radius, body.height, rest).position);
    bumped = true;
  }
  const onGround = stands(rest, body);
  copy(plain, s.feet);

  const stepped = bumped || sloped ? step(s, world, body, STEP_HEIGHT, true, null, bumped && !onGround) : Step.None;
  if (stepped === Step.None || stepped === Step.Refused) {
    s.grounded = onGround || stickDown(s, world, body);
  } else {
    s.grounded = stepped === Step.KeptOnGround;
  }

  // Every step up or down costs speed, by how far it is of a whole step.
  if (Math.abs(s.feet.y - plain.y) > STEP_COST_MIN) {
    const cost = 0.2 + 0.8 * Math.max(0, 1 - Math.abs(s.feet.y - start.y) / STEP_HEIGHT);
    v.x *= cost;
    v.y *= cost;
    v.z *= cost;
  }
}

/**
 * Whether the contact `rest` holds a capsule in the air by is a ledge's corner
 * met from beside, rather than ground under it: too far round the bottom to be
 * a slope, or — in a jump — the corner of something taller than the jump.
 */
function besideLedge(s: Readonly<MovementState>, body: MovementParams): boolean {
  const up = rest.normal.y;
  return up < WALKABLE_NORMAL_Y || (s.jumpFrom !== null && s.feet.y + body.radius * (1 - up) > s.jumpFrom + JUMP_HEIGHT + LEDGE_SLACK);
}

/**
 * The end of a walk step in the air: gravity, the move, and — in a jump, where
 * the move was blocked — a step onto what is under the jump's own height.
 * `grounded` afterwards is a landing; the velocity is left as it arrived, for
 * the caller to take the landing's cost from.
 */
export function airSlide(s: MovementState, dt: number, env: MovementEnv): void {
  const { world, body } = env;
  const v = s.velocity;
  copy(start, s.feet);
  // The move is made at the mean of the vertical speed before and after
  // gravity, so a jump's height does not depend on the tick rate.
  const rise = v.y;
  v.y -= GRAVITY * dt;
  copy(startVelocity, v);
  move.x = v.x * dt;
  move.y = ((rise + v.y) / 2) * dt;
  move.z = v.z * dt;
  if (!world.ready) {
    s.feet.x += move.x;
    s.feet.y += move.y;
    s.feet.z += move.z;
    s.grounded = false;
    return;
  }
  let bumped = collide(s, world, body, 0);
  if (rest.grounded && s.feet.y + body.radius * (1 - rest.normal.y) > start.y + LEDGE_SLACK && besideLedge(s, body)) {
    // A ledge's corner on the rounded bottom is ground to land on only if the
    // feet came down onto the ledge, as a box's would. Met from beside it is
    // the top of a wall, and the capsule stands off it at the height it reached.
    const flat = Math.hypot(rest.normal.x, rest.normal.z);
    const off = (body.radius * (1 - flat)) / flat;
    probe.x = s.feet.x + rest.normal.x * off;
    probe.y = start.y + move.y;
    probe.z = s.feet.z + rest.normal.z * off;
    copy(s.feet, world.resolveCapsule(probe, body.radius, body.height, rest).position);
    bumped = true;
  }
  copy(plain, s.feet);
  let grounded = stands(rest, body);
  let normal: Readonly<Vec3> = rest.normal;

  if (bumped && s.jumpFrom !== null) {
    // A step in a jump never lifts the feet past the jump's own height.
    const ceiling = s.jumpFrom + JUMP_HEIGHT;
    const height = Math.min(STEP_HEIGHT, ceiling - s.feet.y);
    const stepped = height >= STEP_MIN ? step(s, world, body, height, false, ceiling, !grounded) : Step.Refused;
    if (stepped === Step.Kept || stepped === Step.KeptOnGround) {
      grounded = stepped === Step.KeptOnGround;
      normal = grounded ? under.normal : NOTHING;
    }
    if (stepped !== Step.Refused) {
      // And never leaves it rising faster than gets it back up there.
      const room = ceiling - s.feet.y;
      v.y = Math.min(v.y, room > 0.1 * UNIT ? Math.sqrt(2 * GRAVITY * room) : 0);
    }
  }

  if (!grounded && normal.y > 0) {
    // On something too steep to stand on: slide down it, and the jump is over.
    clip(v, normal);
    s.jumpFrom = null;
  }
  // Rising off the ground it touches is not a landing.
  const leaving = v.y > 0 && v.x * normal.x + v.y * normal.y + v.z * normal.z > LEAVING_SPEED;
  s.grounded = grounded && !leaving;
}

/**
 * The end of a ladder step: the move, and with `canStep` a step onto what it
 * met, which is what sets a climber on the ladder's top.
 */
export function ladderSlide(s: MovementState, dt: number, env: MovementEnv, canStep: boolean): void {
  const { world, body } = env;
  const v = s.velocity;
  copy(start, s.feet);
  copy(startVelocity, v);
  move.x = v.x * dt;
  move.y = v.y * dt;
  move.z = v.z * dt;
  if (!world.ready) {
    s.feet.x += move.x;
    s.feet.y += move.y;
    s.feet.z += move.z;
    s.grounded = false;
    return;
  }
  const bumped = collide(s, world, body, 0);
  copy(plain, s.feet);
  const stepped = canStep && bumped ? step(s, world, body, STEP_HEIGHT, false, null, !stands(rest, body)) : Step.None;
  s.grounded = stepped === Step.KeptOnGround || (stepped !== Step.Kept && groundAt(s.feet, world, body));
}

/** Whether a capsule standing still at `s.feet` is on the ground: what a walk step with nowhere to go ends with. */
export function standing(s: Readonly<MovementState>, env: MovementEnv): boolean {
  return env.world.ready && groundAt(s.feet, env.world, env.body);
}

/** Whether there is ground to stand on within `reach` under the feet, which need not be on it. */
export function groundWithin(s: Readonly<MovementState>, env: MovementEnv, reach: number): boolean {
  if (!env.world.ready) {
    return false;
  }
  probe.x = s.feet.x;
  probe.y = s.feet.y - reach;
  probe.z = s.feet.z;
  return stands(env.world.resolveCapsule(probe, env.body.radius, env.body.height, under), env.body);
}
