// The strafe axes (src/net/messages/fields.ts): that holding nothing crosses the
// wire as nothing.
//
// A quantizer that keeps both ends of its range spaces an odd number of steps
// across it, so a symmetric range has no step on its midpoint — and 0 is the
// commonest value either axis ever carries. Both ends round alike, so the drift
// costs no prediction error and surfaces only as a player who walks by himself.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { decodePacket, encodePacket, MessageType } from "../src/net/packet.js";
import { roundDt, roundInput, type InputPacket } from "../src/net/messages/input.js";
import { CollisionWorld } from "../src/collision/world.js";
import { idleInput } from "../src/sim/input.js";
import { createMovement } from "../src/sim/movement.js";
import { Player } from "../src/sim/player.js";

/** A player on a floor wide enough to crawl about on. */
function standing(): Player {
  const root = new THREE.Group();
  const floor = new THREE.Mesh(new THREE.BoxGeometry(400, 1, 400));
  floor.position.set(0, -0.5, 0);
  floor.userData.collide = true;
  root.add(floor);
  const collision = new CollisionWorld();
  collision.rebuild(root);
  const player = new Player(collision);
  player.place({ x: 0, y: 0, z: 0 }, 0, 0);
  return player;
}

describe("a strafe axis", () => {
  it("carries standing still as exactly zero, on the wire and through the sim", () => {
    const still = roundInput(idleInput(1.2345678, -0.4));
    expect(still.forward).toBe(0);
    expect(still.right).toBe(0);

    const claim = createMovement({ x: 0, y: 0, z: 0 }, 1.2345678, -0.4);
    const message: InputPacket = { seq: 3, dt: roundDt(1 / 60), input: still, claim, renderTick: 0, renderFrac: 0, earlier: [] };
    const back = decodePacket(encodePacket(MessageType.input, message)).message as InputPacket;
    expect(back.input.forward).toBe(0);
    expect(back.input.right).toBe(0);
  });

  /**
   * What the drift was: a minute of holding nothing walked a player 18 cm
   * forward-right, and would have kept going. The sim is here because that is
   * where an encoding's rounding stops being a rounding.
   */
  it("leaves a player who holds nothing where he stood", () => {
    const player = standing();
    for (let i = 0; i < 3600; i++) {
      player.step(roundInput(idleInput(0, 0)), 1 / 60);
    }
    const { feet, velocity } = player.snapshot().movement;
    expect(Math.hypot(feet.x, feet.z)).toBe(0);
    expect(Math.hypot(velocity.x, velocity.z)).toBe(0);
  });

  /**
   * Zero alone can be bought by accident, so: the ends survive, ties break away
   * from zero rather than rightward, and left and right are one field.
   */
  it("is symmetric about zero, ends included", () => {
    expect(roundInput({ ...idleInput(0, 0), forward: 1, right: -1 })).toMatchObject({ forward: 1, right: -1 });

    for (let held = 0; held <= 1.0001; held += 1 / 512) {
      const both = roundInput({ ...idleInput(0, 0), forward: held, right: -held });
      expect(both.forward + both.right, `held ${held}`).toBe(0);
      // Half a step of the 127 either side, which is what 8 bits buys once one
      // code is spent on the midpoint.
      expect(Math.abs(both.forward - Math.min(1, held)), `held ${held}`).toBeLessThan(1 / 254 + 1e-9);
    }
  });

  /** Out of range clamps, including the one code the count leaves over. */
  it("clamps a claim of more than full deflection", () => {
    const over = roundInput({ ...idleInput(0, 0), forward: 4, right: -4 });
    expect(over).toMatchObject({ forward: 1, right: -1 });
  });
});
