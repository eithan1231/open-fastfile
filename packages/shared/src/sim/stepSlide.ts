// The end of every free step: move by the velocity, push the capsule out of the
// world, and step up onto or down off what a walk meets — the games' step-slide
// move, over a resolver rather than a trace.
//
// The capsule's rounded bottom slides up any ledge shorter than its radius; a
// move blocked by a taller one, up to STEP_HEIGHT, is tried again from that much
// higher (`stepUp`). See docs/engine/player.md.

import type { CapsuleResolution, CapsuleWorld, Vec3 } from "./capsule.js";
import type { MovementParams, MovementState } from "./movementState.js";
import { UNIT } from "./units.js";

/**
 * The tallest ledge a blocked move steps onto: IW5's 18 units (0x424a30). A
 * standing player steps; so does one climbing a ladder upward, which is what
 * sets them on its top.
 */
export const STEP_HEIGHT = 18 * UNIT;
/** How finely `stepUp` finds the surface it sets the feet on, as halvings of its drop. */
const STEP_SEARCH = 12;
/**
 * A step that sets the capsule on a ledge's corner is kept if the ledge's top
 * is less than this share of the radius above the feet: low enough for the
 * rounded bottom to climb the rest, as it climbs any kerb.
 */
const STEP_KERB = 0.8;
/** Where along the move, from the capsule's middle, `stepUp` looks for a ledge too tall to step, in radii. */
const STEP_LOOK = [0, 0.5, 1, 1.5];

/**
 * Seconds the ground still counts after leaving it. The resolver's `grounded`
 * flickers off for a frame now and then over imported triangle soup, so a jump
 * and the keys both treat this long after it as standing.
 */
export const COYOTE_TIME = 0.12; // s
/** Seconds a landing from a jump takes to wear off: sim/movement.ts has what it slows. */
export const LAND_RECOVERY = 0.5; // s

/**
 * Move by the velocity, push out of the world, and keep the ground's
 * bookkeeping: the end of every free step. `canStep` lets a blocked move step
 * up (`stepUp`).
 */
export function integrate(s: MovementState, dt: number, world: CapsuleWorld, canStep: boolean, body: MovementParams): void {
  const fromX = s.feet.x;
  const fromY = s.feet.y;
  const fromZ = s.feet.z;
  s.feet.x += s.velocity.x * dt;
  s.feet.y += s.velocity.y * dt;
  s.feet.z += s.velocity.z * dt;
  collide(s, world, body);
  // A step up kept on a kerb's corner is not a walk off a ledge: stepping down
  // after it sets the feet back where they were (`rideKerbs`).
  if (canStep && world.ready && !(stepUp(s, dt, world, fromX, fromY, fromZ, body) && body.rideKerbs)) {
    stepDown(s, world, body);
  }

  // Only ground reached on the way down re-arms the coyote window.
  const landed = s.grounded && s.velocity.y <= 0;
  s.coyote = landed ? COYOTE_TIME : Math.max(0, s.coyote - dt);
  s.landing = Math.max(0, s.landing - dt);
  if (s.jumped && landed) {
    s.jumped = false;
    s.landing = LAND_RECOVERY;
  }
}

/**
 * How far into the ground `stepDown` sets the feet before resolving.
 *
 * The resolver only reports `grounded` where it actually pushed the capsule out
 * of something, so feet placed exactly on a surface come back in the air. A
 * millimetre is enough to be pushed out of and far above float noise; `stepUp`
 * sets its own feet down the same way.
 */
const GROUND_BITE = 1e-3;

/** Where `stepDown` probes, reused: it can run for every player every tick. */
const downProbe: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * Set the feet back down on ground walked off within a step's height.
 *
 * A slope walked *down* leaves the feet in the air every tick: the move along it
 * is horizontal, so it ends above the surface, and gravity needs two or three
 * ticks to bring the capsule back to it. `grounded` flickers for those ticks and
 * the pose blends follow — a body walking down a hill crossfades between falling
 * and walking several times a second — while the player also loses ground
 * acceleration and friction for most of the descent.
 *
 * Every engine of this family answers it the same way (Quake's PM_StepSlideMove
 * step-down, IW5's 0x424a30): a move that *started* on the ground and ended off
 * it, with nothing carrying the player upwards, stands on whatever is within a
 * step below. Walking off a kerb therefore sticks to it, as the games do;
 * anything taller than a step is still a fall.
 *
 * A jump never reaches this — the takeoff clears `grounded` before the move, and
 * `integrate`'s `canStep` is read from it — and a ladder or a mantle is on rails.
 */
function stepDown(s: MovementState, world: CapsuleWorld, body: MovementParams): void {
  if (s.grounded || s.velocity.y > 0 || s.ladder !== null || s.mantle !== null) {
    return;
  }
  downProbe.x = s.feet.x;
  downProbe.y = s.feet.y;
  downProbe.z = s.feet.z;
  const ground = world.groundBelow(downProbe, STEP_HEIGHT);
  if (ground === null) {
    return;
  }
  const keptX = s.feet.x;
  const keptY = s.feet.y;
  const keptZ = s.feet.z;
  const keptRise = s.velocity.y;
  s.feet.y = ground - GROUND_BITE;
  collide(s, world, body);
  // Nothing to stand on after all — a surface the ray found but the capsule
  // cannot rest on. The fall is left exactly as it was.
  if (!s.grounded) {
    s.feet.x = keptX;
    s.feet.y = keptY;
    s.feet.z = keptZ;
    s.velocity.y = keptRise;
  }
}

/** Where `stepUp` tries its positions, reused: it can run for every player every tick. */
const stepProbe: Vec3 = { x: 0, y: 0, z: 0 };
const stepResult: CapsuleResolution = { position: { x: 0, y: 0, z: 0 }, grounded: false };

/**
 * If this step's move along the ground came up short, try it again from
 * STEP_HEIGHT higher and set the feet down on whatever is there — IW5's
 * step-slide move (0x424a30), over a resolver rather than a trace.
 *
 * The stepped move is kept only if it gets further along the ground than the
 * plain one did and ends on the ledge: sliding along a wall gains nothing from
 * a step and keeps the plain result. Every position it keeps was tested clear of
 * the world (`overlapsCapsule`), so a step never puts the capsule inside
 * anything, and the whole of it is a function of the state and the world, so
 * a server replaying it steps the same way. True when it kept the stepped move.
 */
function stepUp(s: MovementState, dt: number, world: CapsuleWorld, fromX: number, fromY: number, fromZ: number, body: MovementParams): boolean {
  const { radius, height } = body;
  const wantedX = s.velocity.x * dt;
  const wantedZ = s.velocity.z * dt;
  const wanted = Math.hypot(wantedX, wantedZ);
  const plain = Math.hypot(s.feet.x - fromX, s.feet.z - fromZ);

  if (wanted < 1e-6 || plain >= wanted - 1e-4) {
    return false;
  }

  // Up, if there is room overhead.
  const p = stepProbe;
  p.x = fromX;
  p.y = fromY + STEP_HEIGHT;
  p.z = fromZ;

  if (world.overlapsCapsule(p, radius, height)) {
    return false;
  }

  // Across, as far as the world lets the raised capsule go: a kerb rider at least
  // a body's radius, so a slow one clears a thin threshold rather than setting
  // down on its corner a centimetre at a time (`rideKerbs`).
  const reach = body.rideKerbs ? Math.max(wanted, radius) / wanted : 1;
  p.x = fromX + wantedX * reach;
  p.z = fromZ + wantedZ * reach;
  const across = world.resolveCapsule(p, radius, height, stepResult).position;
  const x = across.x;
  const top = across.y;
  const z = across.z;

  if (Math.hypot(x - fromX, z - fromZ) <= plain + 1e-4) {
    return false;
  }

  // Nothing taller than a step ahead. The capsule sets down on a ledge's corner
  // and its rounded bottom slides up the rest, so the ledge itself is what
  // must be no taller: looked for straight down, from the capsule's middle to
  // past its front.
  const limit = fromY + STEP_HEIGHT + 1e-3;
  let ledge = -Infinity;

  for (const share of STEP_LOOK) {
    const ahead = share * radius;
    p.x = x + (wantedX / wanted) * ahead;
    p.y = limit + radius;
    p.z = z + (wantedZ / wanted) * ahead;
    const ground = world.groundBelow(p, radius + STEP_HEIGHT);

    if (ground !== null && ground > limit) {
      return false;
    }

    if (ground !== null) {
      ledge = Math.max(ledge, ground);
    }
  }

  // Down onto what is there: the lowest clear height within the step, found by
  // halving. Nothing to stand on within reach keeps the plain move.
  p.x = x;
  p.z = z;
  let clear = top;
  let blocked = fromY - 1e-3;
  p.y = blocked;

  if (!world.overlapsCapsule(p, radius, height)) {
    return false;
  }

  for (let i = 0; i < STEP_SEARCH; i++) {
    p.y = (clear + blocked) / 2;
    if (world.overlapsCapsule(p, radius, height)) {
      blocked = p.y;
    } else {
      clear = p.y;
    }
  }

  const keptX = s.feet.x;
  const keptY = s.feet.y;
  const keptZ = s.feet.z;
  const keptGrounded = s.grounded;
  const keptRise = s.velocity.y;

  // Set just into what is there, so the resolver lifts the feet onto it.
  s.feet.x = x;
  s.feet.y = blocked;
  s.feet.z = z;

  collide(s, world, body);

  // A box, as the game's player is, stands on a ledge with an inch of it
  // underfoot; a capsule set down that far out rests on the ledge's corner, not
  // on its top. That is kept as long as what is left is a kerb the rounded
  // bottom slides up on the next moves. A step is STEP_HEIGHT and no more.
  const onLedge = s.grounded || ledge - s.feet.y < STEP_KERB * radius;

  if (!onLedge || s.feet.y > limit || world.overlapsCapsule(s.feet, radius, height)) {
    s.feet.x = keptX;
    s.feet.y = keptY;
    s.feet.z = keptZ;
    s.grounded = keptGrounded;
    s.velocity.y = keptRise;
    return false;
  }

  // Standing on it, as that box would: an ungrounded capsule on the corner is a
  // falling one next tick, which cannot step, and slides back off the kerb it
  // was meant to ride up — a slow body never gets over a threshold that way.
  if (body.rideKerbs) {
    s.grounded = true;
    s.velocity.y = Math.max(0, s.velocity.y);
  }

  return true;
}

const scratch: Vec3 = { x: 0, y: 0, z: 0 };
/** The resolution `collide` hands the collision world to fill, so a tick allocates nothing. */
const resolution: CapsuleResolution = { position: { x: 0, y: 0, z: 0 }, grounded: false };

/** Push the capsule out of the world; ground stops a fall, and a ceiling ends a jump. */
function collide(s: MovementState, world: CapsuleWorld, body: MovementParams): void {
  if (!world.ready) {
    s.grounded = false;
    return;
  }
  scratch.x = s.feet.x;
  scratch.y = s.feet.y;
  scratch.z = s.feet.z;
  const result = world.resolveCapsule(scratch, body.radius, body.height, resolution);
  // Pushed down while rising, more than sideways: the head hit something, and
  // the jump ends there instead of pressing against it until gravity wins. A
  // wall's push can carry a fraction of a millimetre of down in it (a capsule
  // parallel to a triangle has no unique closest point), which must not end a
  // jump, or a ladder climb, along it.
  const down = s.feet.y - result.position.y;
  const aside = Math.hypot(result.position.x - s.feet.x, result.position.z - s.feet.z);
  const headHit = s.velocity.y > 0 && down > 1e-4 && down > aside;
  s.feet.x = result.position.x;
  s.feet.y = result.position.y;
  s.feet.z = result.position.z;
  s.grounded = result.grounded;
  if ((s.grounded && s.velocity.y < 0) || headHit) {
    s.velocity.y = 0;
  }
}
