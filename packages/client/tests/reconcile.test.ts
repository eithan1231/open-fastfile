// Prediction and correction: the client's half of an authoritative server.
//
// The server owns the player now. A client still predicts, so it never waits for
// its own ping, but every snapshot carries our authoritative state and we take it
// — then redo whatever the server had not seen yet, and settle what is left into
// the camera rather than into the simulation.
//
// The properties below are what make that invisible when the two agree and honest
// when they do not. DeviceInput is a four-method interface, so none of this needs
// a browser.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import type { PlayerInput } from "@3d/shared/sim/input.js";
import { idleInput } from "@3d/shared/sim/input.js";
import type { CapsuleResolution, CapsuleWorld, Vec3 } from "@3d/shared/sim/capsule.js";
import { STAND_EYE_HEIGHT } from "@3d/shared/sim/movement.js";
import { Player, type PlayerState } from "@3d/shared/sim/player.js";
import { TICK_RATE } from "@3d/shared/net/messages/fields.js";
import { FirstPersonControls, type DeviceInput } from "../src/engine/controls/firstPerson.js";

const ground: CapsuleWorld = {
  ready: true,
  resolveCapsule(position: Vec3, _r: number, _h: number, out?: CapsuleResolution): CapsuleResolution {
    const result = out ?? { position: { x: 0, y: 0, z: 0 }, grounded: false, normal: { x: 0, y: 0, z: 0 } };
    result.position.x = position.x;
    result.position.y = Math.max(position.y, 0);
    result.position.z = position.z;
    result.grounded = position.y <= 0;
    result.normal.x = 0;
    result.normal.y = result.grounded ? 1 : 0;
    result.normal.z = 0;
    return result;
  },
  overlapsCapsule: (position: Vec3) => position.y < 0,
  overlapsSweep: (from: Vec3, to: Vec3, radius: number) => Math.min(from.y, to.y) < radius,
  groundBelow: (from: Vec3, distance: number, normal?: Vec3) => {
    if (from.y < 0 || from.y - distance > 0) {
      return null;
    }
    if (normal) {
      normal.x = 0;
      normal.y = 1;
      normal.z = 0;
    }
    return 0;
  },
  // Nothing here has a surface; a flat test floor is `default` either way.
  surfaceAt: () => null,
  // Nothing here shoots; the floor is for standing on.
  traceRay: () => null,
};

class FakeDevices implements DeviceInput {
  locked = true;
  private readonly held = new Set<string>();
  private readonly presses = new Set<string>();
  private look = { x: 0, y: 0 };
  isHeld(action: string): boolean {
    return this.held.has(action);
  }
  takePressed(action: string): boolean {
    const had = this.presses.has(action);
    this.presses.delete(action);
    return had;
  }
  takeLook(): { x: number; y: number } {
    const look = this.look;
    this.look = { x: 0, y: 0 };
    return look;
  }
  hold(action: string): void {
    this.held.add(action);
  }
  move(x: number, y: number): void {
    this.look = { x, y };
  }
}

const TICK_DT = 1 / TICK_RATE;
const forward: PlayerInput = { ...idleInput(0, 0), forward: 1 };

function setup() {
  const devices = new FakeDevices();
  // Held here rather than read back off the controls: the camera is theirs to
  // drive and nobody else's to reach into.
  const camera = new THREE.PerspectiveCamera();
  const controls = new FirstPersonControls(camera, devices as unknown as DeviceInput, ground);
  const sent: { seq: number; input: PlayerInput; dt: number }[] = [];
  let seq = 0;
  controls.onTick = (input, dt) => sent.push({ seq: ++seq, input: { ...input }, dt });
  return { devices, controls, camera, sent };
}

/** What the server would say, having applied everything up to and including `ack`. */
function serverState(sent: readonly { seq: number; input: PlayerInput; dt: number }[], ack: number): PlayerState {
  const authority = new Player(ground);
  authority.place({ x: 0, y: 0, z: 0 }, 0, 0);
  for (const s of sent) {
    if (s.seq <= ack) {
      authority.step(s.input, s.dt);
    }
  }
  return authority.snapshot();
}

describe("reconciliation", () => {
  it("lands on the server's answer once the unacked inputs are replayed", () => {
    const { devices, controls, sent } = setup();
    devices.hold("forward");
    for (let i = 0; i < 10; i++) {
      controls.update(TICK_DT);
    }
    expect(sent).toHaveLength(10);

    // The server is four inputs behind — an ordinary amount of ping.
    const ack = 6;
    const state = serverState(sent, ack);
    const pending = sent.filter((s) => s.seq > ack);
    controls.reconcile(state, pending);

    // Server's state, plus the four it had not seen: exactly where this client
    // already was. An agreeing correction is a no-op, which is the point.
    const authority = new Player(ground);
    authority.restore(state);
    for (const { input, dt } of pending) {
      authority.step(input, dt);
    }
    expect(controls.player.movement.feet.z).toBeCloseTo(authority.movement.feet.z, 10);
    expect(controls.player.movement.feet.x).toBeCloseTo(authority.movement.feet.x, 10);
  });

  it("replays with each input's own dt, not with one of its own", () => {
    const { controls } = setup();
    const state = serverState([], 0);
    // Two steps of very different lengths. Replaying both at a nominal tick would
    // land somewhere neither input asked for.
    const pending = [
      { seq: 1, input: forward, dt: TICK_DT },
      { seq: 2, input: forward, dt: TICK_DT * 2 },
    ];
    controls.reconcile(state, pending);

    const authority = new Player(ground);
    authority.restore(state);
    authority.step(forward, TICK_DT);
    authority.step(forward, TICK_DT * 2);
    expect(controls.player.movement.feet.z).toBeCloseTo(authority.movement.feet.z, 10);
  });

  it("leaves the player looking where they were looking", () => {
    // A correction must never fight the mouse. Replaying re-applies this client's
    // own yaw and pitch, because they travel *in* the inputs being replayed.
    const { devices, controls, sent } = setup();
    devices.hold("forward");
    devices.move(400, 0);
    controls.update(TICK_DT);
    devices.move(400, 0);
    controls.update(TICK_DT);
    const looking = controls.player.movement.yaw;
    expect(looking).not.toBe(0);

    // The server is a tick behind and still has them facing forward.
    const state = serverState(sent, 1);
    controls.reconcile(
      state,
      sent.filter((s) => s.seq > 1),
    );
    expect(controls.player.movement.yaw).toBeCloseTo(looking, 10);
  });

  it("puts the disagreement in the camera and not in the simulation", () => {
    const { devices, controls, camera } = setup();
    devices.hold("forward");
    controls.update(TICK_DT);

    // The server has them 30 cm to one side: a real disagreement, well under a
    // teleport.
    const state = serverState([], 0);
    state.movement.feet.x = 0.3;
    controls.reconcile(state, []);

    // The state is the server's, exactly and immediately — there is no argument
    // about where the player is.
    expect(controls.player.movement.feet.x).toBe(0.3);

    // But the camera has not jumped there: it is still near where it was drawn.
    controls.update(0);
    expect(camera.position.x).toBeCloseTo(0, 2);
  });

  it("settles onto the simulation, without ever overshooting it", () => {
    // Measured against the player's *own* feet rather than a fixed number,
    // because the feet do not stand still even with nothing pressed:
    // `PlayerInput.right` is `quant(-1, 1, 8)`, which has no exact zero — 0 rounds
    // to 0.0039 — so an untouched strafe axis walks everyone very slowly to the
    // right. Both ends round identically (the symmetry rule in net/packet.ts), so
    // it costs no prediction error and is invisible in play; it would just make
    // this test about the wrong thing.
    const { controls, camera } = setup();
    controls.update(TICK_DT);

    const state = serverState([], 0);
    state.movement.feet.x = 0.3;
    controls.reconcile(state, []);

    const gap = () => controls.player.movement.feet.x - camera.position.x;
    expect(gap()).toBeGreaterThan(0.29); // the whole correction is still to be paid

    let previous = Infinity;
    for (let i = 0; i < 60; i++) {
      controls.update(1 / 60);
      // Monotonic, and always on the same side: a correction that wobbled or
      // overshot would read as the world shaking rather than as a settle. The
      // tolerance is the sub-tick interpolation, which is ~1e-4 of ordinary
      // movement and has nothing to do with the correction.
      expect(gap()).toBeLessThanOrEqual(previous + 1e-3);
      expect(gap()).toBeGreaterThan(-1e-3);
      previous = gap();
    }

    // A second is ten time constants: arrived, to well under a millimetre.
    expect(Math.abs(gap())).toBeLessThan(1e-3);
  });

  it("cuts rather than slides when the server has moved them somewhere else", () => {
    const { devices, controls, camera } = setup();
    devices.hold("forward");
    controls.update(TICK_DT);

    // A respawn, or a client that has been out of touch. Sliding the camera
    // across the map is worse than cutting to it.
    const state = serverState([], 0);
    state.movement.feet.x = 40;
    controls.reconcile(state, []);
    controls.update(0);
    expect(camera.position.x).toBe(40);
    expect(camera.position.y).toBe(STAND_EYE_HEIGHT);
  });
});
