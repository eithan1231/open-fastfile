// SHOTTRACE — a temporary diagnostic (docs/engine/diagnostics-shottrace.md).
// Delete this file with the rest of it.
//
// The view draws two lines and says how far apart they ended. Everything it is
// worth having rests on the client's line being the round the game actually
// fired, so that is what this file pins, and it pins it three ways a wrong one
// would still look plausible:
//
//   * **Nothing here is symmetric about zero.** The shooter stands off the
//     origin, yaw and pitch are unequal and of opposite sign, and the view kick
//     is unequal and of opposite sign again — so a swapped pair, a dropped term
//     or a flipped sign is a different vector rather than the same one.
//   * **The kick is never zero where the kick is under test.** A ray built from
//     the raw view angles instead of `aimAngles` agrees with one built properly
//     on a resting gun, and only a gun that has been kicked can tell them apart.
//   * **The peer's box is not a cube and its rig is not at rest.** The bone hangs
//     off a root that is moved, turned a quarter and scaled by the 0.0254 a CoD
//     body hangs from; the box is longer one way than the other, so the face the
//     ray enters names which transform was applied.
//
// One thing about the harness matters: `armed()` hands back **one** weapon object
// and mutates its `fired`, because the view watches controller identity the way
// `Shots.fire` does. A fixture that built a fresh object per frame would
// look like a swap every frame and record nothing at all — which is how the first
// draft of this file passed nothing.

import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import type { ShotTraceMessage } from "@3d/shared/net/messages/shotTrace.js";
import { HITBOX_FORMAT_VERSION } from "@3d/shared/rig/hitboxes.js";
import { bindPoseOf } from "@3d/shared/rig/character.js";
import type { CapsuleWorld, RayHit, Vec3 } from "@3d/shared/sim/capsule.js";
import { EYE_HEIGHT } from "@3d/shared/sim/movement.js";
import { aimAngles, aimDirection } from "@3d/shared/sim/recoil.js";
import type { CharacterSet } from "../src/scene/character.js";
import type { SidecarSource } from "../src/engine/hitboxView.js";
import { ShotTraceView, type Shooter, type TracedBody } from "../src/engine/shotTraceView.js";
import { BULLET_RANGE } from "@3d/shared/sim/weaponDef.js";
import { weaponDef } from "@3d/shared/testing/weaponDef.js";
import { DEFAULT_SURFACE } from "@3d/shared/sim/surfaces.js";

const INCH = 0.0254;
const DEG = Math.PI / 180;

/** A shooter who is not at the origin, not facing an axis, and whose gun has been kicked. */
/** A weapon with no `spread` block at all, so its cone is nothing: see `armed`. */
const BARE = weaponDef({ clipSize: 30 });

const AWKWARD = { feet: { x: 3, y: 1, z: -7 }, yaw: 0.7, pitch: -0.2, kickPitch: 4, kickYaw: -3, def: BARE, seed: 0 };

/**
 * Level, still, and at the origin: what the peer cases need, since they put a box
 * on a known point of a known ray. Everything else is `AWKWARD`, which is where
 * the conventions are pinned.
 */
const SQUARE_ON = { feet: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, kickPitch: 0, kickYaw: 0, def: BARE, seed: 0 };

interface Armed {
  shooter: Shooter;
  /** Advance `fired`, as the weapon state machine does. One object throughout: the view watches identity. */
  fire(rounds?: number): void;
  /** Move the kick where a shot's own impulse would, in place — which is how `WeaponData` carries it. */
  kicked(pitch: number, yaw: number): void;
}

function armed(over: Partial<typeof AWKWARD> = {}): Armed {
  const it = { ...AWKWARD, ...over };
  // No `spread` block, so this weapon's cone is nothing and a round leaves dead
  // along the aim: what every assertion below is about is the *ray*, and a cone
  // would only add a deviation both ends already agree on (recoil.test.ts covers
  // that agreement). `coned` is the fixture for tests that do want one.
  const weapon = { def: it.def, data: { fired: 0, viewKick: { pitch: it.kickPitch, yaw: it.kickYaw }, spread: 0, ads: 0 } };
  return {
    shooter: { movement: { feet: it.feet, yaw: it.yaw, pitch: it.pitch }, weapon, seed: it.seed },
    fire: (rounds = 1) => {
      weapon.data.fired = (weapon.data.fired + rounds) & 0xffff;
    },
    kicked: (pitch: number, yaw: number) => {
      weapon.data.viewKick.pitch = pitch;
      weapon.data.viewKick.yaw = yaw;
    },
  };
}

/** Open air unless a test asks for a wall, and then at that many metres. */
function ground(wallAt: number | null = null): CapsuleWorld {
  return {
    ready: true,
    resolveCapsule: (position: Vec3, _r: number, _h: number, out?: { position: Vec3; grounded: boolean }) => {
      const result = out ?? { position: { x: 0, y: 0, z: 0 }, grounded: false };
      result.position = { ...position };
      result.grounded = false;
      return result;
    },
    overlapsCapsule: () => false,
    groundBelow: () => null,
    // Nothing here has a surface; a flat test floor is `default` either way.
    surfaceAt: () => null,
    traceRay: (_f: Vec3, _d: Vec3, distance: number, _c: string, out?: RayHit): RayHit | null => {
      if (wallAt === null || wallAt > distance) {
        return null;
      }
      const hit = out ?? { distance: 0, normal: { x: 0, y: 0, z: 0 }, kind: "map" as const, surface: DEFAULT_SURFACE };
      hit.distance = wallAt;
      hit.normal = { x: 0, y: 0, z: 1 };
      hit.kind = "map";
      return hit;
    },
  };
}

function set(game = "iw5"): CharacterSet {
  return { game, weapon: "", animType: "", roles: { idle: "idle" }, torsoRoles: [], aimJoint: "", clips: {} };
}

/**
 * A peer ten metres down −z, on a rig that is moved, turned a quarter, and scaled
 * by the inch a CoD body hangs from — so a view that used the rig root, or that
 * skipped the rotation, or that read the box in metres, meets a different face or
 * nothing at all.
 */
function peer(id = "peer"): TracedBody {
  const root = new THREE.Object3D();
  root.position.set(0, 0, -10);
  root.rotation.y = Math.PI / 2;
  root.scale.setScalar(INCH);
  const head = new THREE.Bone();
  head.name = "j_head";
  head.position.set(0, 60, 0); // 60 inches up the body, in the rig's own units
  root.add(head);
  root.updateMatrixWorld(true);
  return { id, rig: { name: "mp_body_test", root, aim: undefined, clips: new Map(), bind: bindPoseOf(root), set: set() } };
}

/**
 * A box 16 inches along the bone's own +x and only 4 across it, so the face the
 * ray enters says which transform reached it.
 *
 * `Ry(90°)` sends the bone's +x to world −z, so the near face is the box's own
 * `min.x` — four inches nearer the shooter than the rig's origin, where its
 * `min.z` would be two.
 */
const HEAD_BOX = { bone: "j_head", location: "head", min: [-4, -6, -2], max: [12, 6, 2] };

function sidecars(bones: unknown[] = [HEAD_BOX]): SidecarSource & { json: ReturnType<typeof vi.fn> } {
  return { json: vi.fn(() => Promise.resolve({ version: HITBOX_FORMAT_VERSION, bones })) };
}

/** A view already showing, with every peer's sidecar read: one frame to ask, a tick, and it is there. */
async function opened(who: Armed, bodies: readonly TracedBody[] = [], source?: SidecarSource, world = ground()): Promise<ShotTraceView> {
  const view = new ShotTraceView();
  view.setVisible(true);
  view.update(who.shooter, world, bodies, source, 0);
  await new Promise((resolve) => setTimeout(resolve, 0));
  return view;
}

describe("the client's own trace", () => {
  it("leaves the eye, not the feet", async () => {
    const who = armed();
    const view = await opened(who);
    who.fire();
    view.update(who.shooter, ground(), [], undefined, 1 / 60);

    expect(view.held[0]!.from).toEqual({ x: 3, y: 1 + EYE_HEIGHT, z: -7 });
    view.dispose();
  });

  it("points where the camera does: yaw 0 faces −z, pitch is up positive", async () => {
    const straight = armed(SQUARE_ON);
    const level = await opened(straight);
    straight.fire();
    level.update(straight.shooter, ground(), [], undefined, 0);
    expect(level.held[0]!.direction.x).toBeCloseTo(0, 12);
    expect(level.held[0]!.direction.y).toBeCloseTo(0, 12);
    expect(level.held[0]!.direction.z).toBeCloseTo(-1, 12);

    // A quarter turn left goes to −x, not +x: the sign of the yaw rotation.
    const left = armed({ ...SQUARE_ON, yaw: Math.PI / 2 });
    const turned = await opened(left);
    left.fire();
    turned.update(left.shooter, ground(), [], undefined, 0);
    expect(turned.held[0]!.direction.x).toBeCloseTo(-1, 12);
    expect(turned.held[0]!.direction.z).toBeCloseTo(0, 12);

    // Looking up sends the round up.
    const up = armed({ ...SQUARE_ON, pitch: 0.3 });
    const raised = await opened(up);
    up.fire();
    raised.update(up.shooter, ground(), [], undefined, 0);
    expect(raised.held[0]!.direction.y).toBeCloseTo(Math.sin(0.3), 12);

    level.dispose();
    turned.dispose();
    raised.dispose();
  });

  it("bends the round by the view kick, which the raw view angles do not carry", async () => {
    // The gun alone: no intent at all, and a kick of five degrees up and two across.
    const who = armed({ ...SQUARE_ON, kickPitch: 5, kickYaw: -2 });
    const view = await opened(who);
    who.fire();
    view.update(who.shooter, ground(), [], undefined, 0);

    const { direction } = view.held[0]!;
    // Worked from the convention rather than from `aimAngles`: positive view-kick
    // pitch is up, the kick is in degrees, and the yaw is added to intent.
    expect(direction.y).toBeCloseTo(Math.sin(5 * DEG), 12);
    expect(direction.x).toBeCloseTo(-Math.sin(-2 * DEG) * Math.cos(5 * DEG), 12);
    // And it is emphatically not the ray the raw angles would have given, which
    // with no intent at all is (0, 0, −1).
    expect(direction.y).toBeGreaterThan(0.08);
    expect(direction.x).toBeGreaterThan(0.03);
    view.dispose();
  });

  it("leaves along the kick the gun already had, not the one that round is adding", async () => {
    // A gun a degree off centre, and a round that throws it to six. Both land on
    // this end between one frame and the next, because the simulation fires the
    // round and adds its own impulse inside the same step (`stepRecoil`) — so the
    // kick a frame reads is already the one *after* whatever it is about to trace.
    const who = armed({ ...SQUARE_ON, kickPitch: 1, kickYaw: -0.5 });
    const view = await opened(who);
    who.fire();
    who.kicked(6, -4);
    view.update(who.shooter, ground(), [], undefined, 1 / 60);

    const { direction } = view.held[0]!;
    expect(direction.y).toBeCloseTo(Math.sin(1 * DEG), 12);
    expect(direction.x).toBeCloseTo(-Math.sin(-0.5 * DEG) * Math.cos(1 * DEG), 12);
    // Five degrees away from the kicked line, which over the range a round travels
    // is the whole of this bug: the server traces the same round the same way.
    expect(direction.y).toBeLessThan(Math.sin(6 * DEG) - 0.05);

    // And the next round does take it: the view moved, which is what view kick is
    // for — a trace that simply ignored the kick would be on (0, 0, −1) here.
    who.fire();
    view.update(who.shooter, ground(), [], undefined, 1 / 60);
    expect(view.held[1]!.direction.y).toBeCloseTo(Math.sin(6 * DEG), 12);
    expect(view.held[1]!.direction.x).toBeCloseTo(-Math.sin(-4 * DEG) * Math.cos(6 * DEG), 12);
    view.dispose();
  });
});

describe("the peers", () => {
  it("stops on a bone's box, through that bone's own world matrix", async () => {
    const who = armed(SQUARE_ON);
    const body = peer();
    const source = sidecars();
    const view = await opened(who, [body], source);
    who.fire();
    view.update(who.shooter, ground(), [body], source, 0);

    const client = view.held[0]!.client!;
    expect(client.met).toBe("player");
    expect(client.target).toBe("peer");
    // The rig is at z = −10 and the box reaches four inches towards the shooter:
    // its own −x, which the root's quarter turn sends to world −z. Read without
    // that turn the near face would be the box's −z, two inches, and this would
    // be 9.9492; read in metres the bone would be sixty metres up and missed.
    expect(client.distance).toBeCloseTo(10 - 4 * INCH, 6);
    expect(client.end.z).toBeCloseTo(-(10 - 4 * INCH), 6);
    view.dispose();
  });

  it("takes the nearest of the map and the peers, in both directions", async () => {
    const wall = sidecars();
    const nearWho = armed(SQUARE_ON);
    const near = await opened(nearWho, [peer()], wall, ground(5));
    nearWho.fire();
    near.update(nearWho.shooter, ground(5), [peer()], wall, 0);
    expect(near.held[0]!.client!.met).toBe("world");
    expect(near.held[0]!.client!.distance).toBeCloseTo(5, 6);

    // The same body with the wall pushed past it: the peer wins again, so the
    // case above is the comparison and not "the map always wins".
    const behind = sidecars();
    const farWho = armed(SQUARE_ON);
    const body = peer();
    const far = await opened(farWho, [body], behind, ground(20));
    farWho.fire();
    far.update(farWho.shooter, ground(20), [body], behind, 0);
    expect(far.held[0]!.client!.met).toBe("player");
    expect(far.held[0]!.client!.distance).toBeCloseTo(10 - 4 * INCH, 6);

    near.dispose();
    far.dispose();
  });

  it("reports open air as open air, at the weapon's whole range", async () => {
    const who = armed(SQUARE_ON);
    const view = await opened(who);
    who.fire();
    view.update(who.shooter, ground(), [], undefined, 0);
    expect(view.held[0]!.client!.met).toBe("none");
    expect(view.held[0]!.client!.distance).toBeCloseTo(BULLET_RANGE, 6);
    view.dispose();
  });
});

describe("pairing the two answers", () => {
  /** The server's account of the round `AWKWARD` fires, built its own way rather than copied from the client's. */
  function serverSaid(over: Partial<ShotTraceMessage> = {}): ShotTraceMessage {
    const direction = aimDirection(aimAngles({ yaw: AWKWARD.yaw, pitch: AWKWARD.pitch }, { pitch: AWKWARD.kickPitch, yaw: AWKWARD.kickYaw }), {
      x: 0,
      y: 0,
      z: 0,
    });
    return {
      ordinal: 1,
      from: { x: AWKWARD.feet.x, y: AWKWARD.feet.y + EYE_HEIGHT, z: AWKWARD.feet.z },
      direction,
      distance: BULLET_RANGE,
      met: "none",
      target: null,
      ...over,
    };
  }

  it("agrees with a server that traced the same ray, to the millimetre", async () => {
    const who = armed();
    const view = await opened(who);
    who.fire();
    view.update(who.shooter, ground(), [], undefined, 0);
    view.serverTrace(serverSaid());

    const { paired, divergence } = view.counts;
    expect(paired).toBe(1);
    expect(divergence).not.toBeNull();
    // Over 208 m. The kick is 4° and 3°, so a client that dropped it would be
    // some fifteen metres out here rather than under a millimetre.
    expect(divergence!).toBeLessThan(1e-3);
    expect(view.held).toHaveLength(1);
    view.dispose();
  });

  it("pairs by ordinal, so one round's answer is never drawn against another's", async () => {
    const who = armed();
    const view = await opened(who);
    who.fire();
    view.update(who.shooter, ground(), [], undefined, 0);
    // The same ray, attributed to the next round. It must not pair: a burst puts
    // several of these in flight over an unreliable channel, and pairing on
    // arrival would report one round's gap as another's.
    view.serverTrace(serverSaid({ ordinal: 2 }));

    expect(view.counts.paired).toBe(0);
    expect(view.counts.divergence).toBeNull();
    // Kept rather than dropped: "the server fired a round we did not" is a reading.
    expect(view.held.map((trace) => trace.ordinal)).toEqual([1, 2]);
    expect(view.held[0]!.server).toBeUndefined();
    expect(view.held[1]!.client).toBeUndefined();
    view.dispose();
  });

  it("measures the gap between the two far ends", async () => {
    const who = armed(SQUARE_ON);
    const view = await opened(who);
    who.fire();
    view.update(who.shooter, ground(), [], undefined, 0);
    // A server that stopped the same round at 30 m where this end saw open air.
    const from = { x: 0, y: EYE_HEIGHT, z: 0 };
    view.serverTrace(serverSaid({ from, direction: { x: 0, y: 0, z: -1 }, distance: 30, met: "world" }));

    expect(view.counts.divergence).toBeCloseTo(BULLET_RANGE - 30, 4);
    view.dispose();
  });
});

describe("counting the rounds", () => {
  it("takes one trace per advance of `fired`", async () => {
    const who = armed();
    const view = await opened(who);
    who.fire(3); // a three-round burst inside one frame
    view.update(who.shooter, ground(), [], undefined, 0);
    expect(view.held.map((trace) => trace.ordinal)).toEqual([1, 2, 3]);

    view.update(who.shooter, ground(), [], undefined, 0); // a frame with no shot
    expect(view.held).toHaveLength(3);
    view.dispose();
  });

  it("does not read a swap as a burst", async () => {
    const first = armed();
    const view = await opened(first);
    first.fire(40);
    view.update(first.shooter, ground(), [], undefined, 0);
    expect(view.held).toHaveLength(8); // the ring is eight deep

    // A different controller, counting from its own total and kicked its own way.
    // Subtracting across the two would invent 65_496 rounds, or a burst of forty
    // on the new gun.
    const second = armed({ kickPitch: -2, kickYaw: 5 });
    view.update(second.shooter, ground(), [], undefined, 0);
    expect(view.held).toHaveLength(8);
    expect(view.held[7]!.ordinal).toBe(40);

    // And it keeps counting on the new one, from its own zero.
    second.fire();
    view.update(second.shooter, ground(), [], undefined, 0);
    expect(view.held[7]!.ordinal).toBe(1);

    // Along the new gun's kick, too: the kick is sampled off whichever controller
    // is being watched, so the first round on a weapon just raised does not leave
    // along the recoil of the one that was put away.
    const own = aimDirection(aimAngles({ yaw: AWKWARD.yaw, pitch: AWKWARD.pitch }, { pitch: -2, yaw: 5 }), { x: 0, y: 0, z: 0 });
    const gone = aimDirection(aimAngles({ yaw: AWKWARD.yaw, pitch: AWKWARD.pitch }, { pitch: AWKWARD.kickPitch, yaw: AWKWARD.kickYaw }), { x: 0, y: 0, z: 0 });
    expect(view.held[7]!.direction.x).toBeCloseTo(own.x, 12);
    expect(view.held[7]!.direction.y).toBeCloseTo(own.y, 12);
    expect(view.held[7]!.direction.x).not.toBeCloseTo(gone.x, 3);
    expect(view.held[7]!.direction.y).not.toBeCloseTo(gone.y, 3);
    view.dispose();
  });

  it("costs nothing while it is off, and does not replay what it missed", () => {
    const who = armed();
    const view = new ShotTraceView();
    who.fire(5);
    view.update(who.shooter, ground(), [], undefined, 0);
    expect(view.held).toHaveLength(0);

    view.setVisible(true);
    view.update(who.shooter, ground(), [], undefined, 0);
    expect(view.held).toHaveLength(0); // the five fired while it was off are gone

    who.fire();
    view.update(who.shooter, ground(), [], undefined, 0);
    expect(view.held.map((trace) => trace.ordinal)).toEqual([6]);
    view.dispose();
  });
});
