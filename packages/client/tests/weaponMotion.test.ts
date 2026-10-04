// The weapon's procedural motion (engine/weaponMotion.ts). The formulas are
// approximations; these pin what must hold whatever the tuning: rest is still,
// the gun trails the view within swayMaxAngle, and bob needs walking.
//
// The gun kick is here — it rocks the model in the hands and nothing else — but
// it is integrated in the simulation (@3d/shared/sim/recoil.ts) and only read
// here. The *view* kick, which decides where a bullet goes, is never in this
// pose: it is on the camera this rig hangs off, and adding it twice would double
// every shot's rise. That is what the last test below holds.

import { describe, expect, it } from "vitest";
import { WeaponMotion, type MotionFrame } from "../src/engine/weaponMotion.js";

const M4 = {
  hipIdleAmount: 15,
  hipIdleSpeed: 5,
  swayMaxAngle: 20,
  swayLerpSpeed: 4,
  swayPitchScale: -1,
  swayYawScale: -1,
  swayHorizScale: 0.3,
  swayVertScale: 0.1,
  adsViewBobMult: 0.2,
};
const STILL: MotionFrame = { dt: 1 / 60, turn: { yaw: 0, pitch: 0 }, speed: 0, grounded: true, climb: 0, ads: 0, kick: { pitch: 0, yaw: 0 } };

function run(motion: WeaponMotion, seconds: number, frame: Partial<MotionFrame> = {}) {
  let pose = motion.update({ ...STILL, dt: 0 });
  for (let t = 0; t < seconds; t += STILL.dt) {
    pose = motion.update({ ...STILL, ...frame });
  }
  return pose;
}

describe("WeaponMotion", () => {
  it("is exactly at rest before time moves, so a held pose renders the same", () => {
    expect(new WeaponMotion(M4).update({ ...STILL, dt: 0 })).toEqual({ x: 0, y: 0, z: 0, pitch: 0, yaw: 0, roll: 0 });
  });

  it("trails a turn to the left, bounded by swayMaxAngle", () => {
    const motion = new WeaponMotion({ ...M4, hipIdleAmount: 0 });
    const turning = run(motion, 1, { turn: { yaw: 0.2, pitch: 0 } }); // a very fast turn
    expect(turning.yaw).toBeLessThan(0);
    expect(turning.x).toBeGreaterThan(0);
    expect(Math.abs(turning.yaw)).toBeLessThanOrEqual((20 * Math.PI) / 180);
    const stopped = run(motion, 2);
    expect(Math.abs(stopped.yaw)).toBeLessThan(Math.abs(turning.yaw) * 0.01);
  });

  it("swings after a flick rather than jumping with it", () => {
    const motion = new WeaponMotion({ ...M4, hipIdleAmount: 0 });
    const first = motion.update({ ...STILL, turn: { yaw: 0.3, pitch: 0 } }); // 17° in one frame
    const later = run(motion, 0.15);
    expect(Math.abs(first.x)).toBeLessThan(Math.abs(later.x) * 0.5);
  });

  it("bobs only while walking on the ground, and less in the sights", () => {
    const peak = (frame: Partial<MotionFrame>) => {
      const motion = new WeaponMotion({ ...M4, hipIdleAmount: 0 });
      run(motion, 1, frame);
      let most = 0;
      for (let t = 0; t < 1; t += STILL.dt) {
        most = Math.max(most, Math.abs(motion.update({ ...STILL, ...frame }).x));
      }
      return most;
    };
    expect(peak({ speed: 3.2 })).toBeGreaterThan(0.003);
    expect(peak({ speed: 3.2, grounded: false })).toBeLessThan(1e-4);
    expect(peak({ speed: 3.2, ads: 1 })).toBeCloseTo(peak({ speed: 3.2 }) * 0.2, 3);
  });

  it("dips on a takeoff and a landing, harder the harder it lands, and settles", () => {
    const dip = (fall: number) => {
      const motion = new WeaponMotion({ ...M4, hipIdleAmount: 0 });
      run(motion, 0.5, { climb: -fall, grounded: false });
      let lowest = 0;
      for (let t = 0; t < 0.3; t += STILL.dt) {
        lowest = Math.min(lowest, motion.update(STILL).y);
      }
      return { lowest, settled: run(motion, 1) };
    };
    const soft = dip(3);
    const hard = dip(6);
    expect(soft.lowest).toBeLessThan(-0.003);
    expect(hard.lowest).toBeLessThan(soft.lowest * 1.5);
    expect(Math.abs(hard.settled.y)).toBeLessThan(1e-4);

    const takeoff = new WeaponMotion({ ...M4, hipIdleAmount: 0 });
    const up = run(takeoff, 0.05, { climb: 5.5, grounded: false });
    expect(up.y).toBeLessThan(0);
    expect(up.pitch).toBeLessThan(0);
  });

  /**
   * The gun kick's only job now, and the one place it may appear. Read straight
   * off the simulation rather than integrated here, so this is the whole of it:
   * a pose that ignored `frame.kick` would draw a gun that never moves when it is
   * fired, and nothing else in this build would notice.
   */
  it("rocks the model by the gun kick, and by nothing else", () => {
    const motion = new WeaponMotion({ ...M4, hipIdleAmount: 0, swayMaxAngle: 0 });
    // Asymmetric on purpose: the same number in both would not say which of the
    // two the pose read, and a shared magnitude would not catch a swap.
    const kicked = motion.update({ ...STILL, kick: { pitch: -3, yaw: 1 } });
    // Negative gun-kick pitch is the muzzle up, and `pose.pitch` positive is up.
    expect(kicked.pitch).toBeCloseTo(3 * (Math.PI / 180), 9);
    expect(kicked.yaw).toBeCloseTo(1 * (Math.PI / 180), 9);
    // And it is the only thing moving: the same frame with no kick is still.
    expect(motion.update({ ...STILL, dt: 0 })).toEqual({ x: 0, y: 0, z: 0, pitch: 0, yaw: 0, roll: 0 });
  });
});
