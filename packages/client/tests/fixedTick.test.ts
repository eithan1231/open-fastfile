// The fixed tick in engine/controls/firstPerson.ts: that frames become ticks at
// a rate the display cannot change, and that a tap is neither lost on a frame
// that runs no tick nor spent twice on one that runs two.
//
// DeviceInput is a four-method interface, so none of this needs a browser.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import type { PlayerInput } from "@3d/shared/sim/input.js";
import type { CapsuleResolution, CapsuleWorld, Vec3 } from "@3d/shared/sim/capsule.js";
import { TICK_RATE } from "@3d/shared/net/messages/fields.js";
import { FirstPersonControls, type DeviceInput } from "../src/engine/controls/firstPerson.js";
import { roundInput, type InputPacket } from "@3d/shared/net/messages/input.js";
import { decodePacket, encodePacket, MessageType } from "@3d/shared/net/packet.js";

type Action = "forward" | "back" | "left" | "right" | "run" | "jump" | "fire" | "ads" | "reload" | "use";

/** A floor at y=0: enough for a step to be grounded and for jumps to mean something. */
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

/** A stand-in for InputManager. `takePressed` clears as it reads, exactly as the real one does. */
class FakeDevices implements DeviceInput {
  locked = true;
  private readonly held = new Set<Action>();
  private readonly presses = new Set<Action>();
  private look = { x: 0, y: 0 };

  isHeld(action: Action): boolean {
    return this.held.has(action);
  }

  takePressed(action: Action): boolean {
    const had = this.presses.has(action);
    this.presses.delete(action);
    return had;
  }

  takeLook(): { x: number; y: number } {
    const look = this.look;
    this.look = { x: 0, y: 0 };
    return look;
  }

  press(action: Action): void {
    this.presses.add(action);
  }

  hold(action: Action): void {
    this.held.add(action);
  }

  release(action: Action): void {
    this.held.delete(action);
  }

  move(x: number, y: number): void {
    this.look = { x, y };
  }
}

function setup() {
  const devices = new FakeDevices();
  const controls = new FirstPersonControls(new THREE.PerspectiveCamera(), devices, ground);
  const ticks: PlayerInput[] = [];
  controls.onTick = (input) => ticks.push({ ...input });
  return { devices, controls, ticks };
}

const TICK_DT = 1 / TICK_RATE;

describe("the fixed tick", () => {
  it("runs ticks by elapsed time, not by frames, whatever the frame rate", () => {
    // The same second of play at three refresh rates must be the same number of
    // steps, because the step length is what a server has to agree with. Within
    // one: a second of frame times does not divide into ticks exactly, and the
    // remainder carries into the next second rather than being dropped.
    for (const fps of [30, 60, 144]) {
      const { controls, ticks } = setup();
      for (let i = 0; i < fps; i++) {
        controls.update(1 / fps);
      }
      expect(Math.abs(ticks.length - TICK_RATE)).toBeLessThanOrEqual(1);
    }
  });

  it("runs no tick at all on most frames of a high-refresh display", () => {
    const { controls, ticks } = setup();
    let tickless = 0;
    for (let i = 0; i < 100; i++) {
      const before = ticks.length;
      controls.update(1 / 144);
      if (ticks.length === before) {
        tickless++;
      }
    }
    // The premise of the latching below: this is the common case, not an edge one.
    expect(tickless).toBeGreaterThan(50);
  });

  it("does not lose a press that lands on a frame running no tick", () => {
    const { devices, controls, ticks } = setup();
    // Land exactly on a tick boundary, so the next frame is certain to be tickless.
    controls.update(TICK_DT);
    expect(ticks.length).toBe(1);

    const before = ticks.length;
    devices.press("reload");
    controls.update(1 / 1000); // far too short to produce a tick
    expect(ticks.length).toBe(before); // no tick ran, and the tap must survive it

    // Run frames until the next tick, and it must be carrying the reload.
    while (ticks.length === before) {
      controls.update(1 / 1000);
    }
    expect(ticks[ticks.length - 1]!.reload).toBe(true);
  });

  it("spends a press on exactly one tick, even when a frame runs several", () => {
    const { devices, controls, ticks } = setup();
    devices.press("reload");
    controls.update(TICK_DT * 3.5); // one frame, three ticks
    expect(ticks.length).toBe(3);
    expect(ticks.filter((t) => t.reload)).toHaveLength(1);
    expect(ticks[0]!.reload).toBe(true);
  });

  it("sends the use key as a level — held for every tick it is down, a tap for one — and the wire keeps it", () => {
    const { devices, controls, ticks } = setup();
    devices.hold("use");
    controls.update(TICK_DT * 3);
    devices.release("use");
    controls.update(TICK_DT);
    expect(ticks.map((t) => t.use)).toEqual([true, true, true, false]);
    // A tap between ticks still reaches one: the server wants its rising edge.
    devices.press("use");
    controls.update(TICK_DT * 2);
    expect(ticks.slice(4).map((t) => t.use)).toEqual([true, false]);
    expect(roundInput(ticks[0]!).use).toBe(true);
    const decoded = decodePacket(
      encodePacket(MessageType.input, { seq: 1, dt: TICK_DT, input: ticks[0]!, claim: controls.player.movement.feet, drawn: null, earlier: [] }),
    );
    expect((decoded.message as InputPacket).input.use).toBe(true);
  });

  it("keeps a held key held across every tick, unlike a press", () => {
    const { devices, controls, ticks } = setup();
    devices.hold("forward");
    controls.update(TICK_DT * 3);
    expect(ticks).toHaveLength(3);
    expect(ticks.every((t) => t.forward === 1)).toBe(true);
  });

  it("steps with the wire's rounded values, so a server replaying them agrees", () => {
    const { devices, controls, ticks } = setup();
    devices.move(37, 0); // an angle with no exact 16-bit representation
    controls.update(TICK_DT);

    const sent = ticks[0]!;
    // What was stepped is what was sent: the sim's yaw is the rounded one.
    expect(controls.player.movement.yaw).toBeCloseTo(sent.yaw, 12);
  });

  it("hands each tick the state that tick produced", () => {
    const devices = new FakeDevices();
    const controls = new FirstPersonControls(new THREE.PerspectiveCamera(), devices, ground);
    const claims: number[] = [];
    controls.onTick = (_input, _dt, feet) => claims.push(feet.z);

    devices.hold("forward");
    for (let i = 0; i < 10; i++) {
      controls.update(TICK_DT);
    }
    expect(claims).toHaveLength(10);
    // Walking forward is -Z, and each claim is further along than the last.
    expect(claims[9]!).toBeLessThan(claims[0]!);
    expect(claims[9]!).toBeCloseTo(controls.player.movement.feet.z, 10);
  });

  it("follows the server's tick rate when told one", () => {
    const { controls, ticks } = setup();
    controls.setTickRate(30);
    controls.update(1); // one second
    expect(ticks.length).toBe(5); // capped at MAX_TICKS_PER_FRAME, not 30
    ticks.length = 0;
    for (let i = 0; i < 30; i++) {
      controls.update(1 / 30);
    }
    expect(ticks.length).toBe(30);
  });

  it("does not accumulate a backlog while a pose is held", () => {
    const { controls, ticks } = setup();
    controls.setFrozen(true);
    for (let i = 0; i < 100; i++) {
      controls.update(TICK_DT);
    }
    expect(ticks).toHaveLength(0);

    controls.setFrozen(false);
    controls.update(TICK_DT);
    // One frame's worth, not the hundred that went by while it was held.
    expect(ticks).toHaveLength(1);
  });
});
