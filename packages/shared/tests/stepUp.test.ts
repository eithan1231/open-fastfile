// The step-up: a move along the ground blocked by a ledge no taller than
// STEP_HEIGHT is made again from that much higher, and the feet set down on the
// ledge. What would be quiet if it broke: a step that puts the capsule inside
// something, and a step taken where the game takes none (in the air, or along a
// wall).

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { CollisionWorld } from "../src/collision/world.js";
import { idleInput } from "../src/sim/input.js";
import { createMovement, HEIGHT, RADIUS, stepMovement } from "../src/sim/movement.js";
import { STEP_HEIGHT } from "../src/sim/stepSlide.js";

const DT = 1 / 60;

function collider(size: [number, number, number], at: [number, number, number]): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size));
  mesh.position.set(...at);
  mesh.userData.collide = true;
  return mesh;
}

/** A floor, and a block of height `rise` from z = -2 back, with a player facing it from z = 0. */
function setup(rise: number, extra: THREE.Mesh[] = []) {
  const root = new THREE.Group();
  root.add(collider([40, 1, 40], [0, -0.5, 0]), collider([40, rise, 8], [0, rise / 2, -6]), ...extra);
  const world = new CollisionWorld();
  world.rebuild(root);
  const state = createMovement({ x: 0, y: 0, z: 0 }, 0, 0);
  const input = idleInput(0, 0);
  let sunk = 0;
  const run = (seconds: number) => {
    for (let t = 0; t < seconds - 1e-9; t += DT) {
      stepMovement(state, input, DT, world, true);
      if (world.overlapsCapsule(state.feet, RADIUS, HEIGHT)) {
        sunk++;
      }
    }
  };
  run(0.3);
  return { state, input, run, sunk: () => sunk };
}

describe("step-up", () => {
  it("walks onto a ledge taller than the capsule's rounded bottom climbs, up to 18 units", () => {
    for (const rise of [0.35, 0.44]) {
      const ctx = setup(rise);
      ctx.input.forward = 1;
      ctx.run(1.5);
      expect(ctx.state.feet.z, `${rise} m`).toBeLessThan(-2.2);
      expect(ctx.state.feet.y, `${rise} m`).toBeCloseTo(rise, 2);
      expect(ctx.state.grounded).toBe(true);
      expect(ctx.sunk()).toBe(0);
    }
  });

  it("stops at a taller one", () => {
    const ctx = setup(STEP_HEIGHT + 0.03);
    ctx.input.forward = 1;
    ctx.run(1.5);
    expect(ctx.state.feet.z).toBeGreaterThan(-2);
    expect(ctx.state.feet.y).toBeCloseTo(0, 2);
  });

  it("needs room overhead", () => {
    // A slab 1.9 m up over the ledge's edge: a capsule 1.7 m tall on a 0.4 m step does not fit.
    const ctx = setup(0.4, [collider([40, 0.2, 2], [0, 2.0, -2])]);
    ctx.input.forward = 1;
    ctx.run(1.5);
    expect(ctx.state.feet.z).toBeGreaterThan(-2);
    expect(ctx.sunk()).toBe(0);
  });

  it("is not taken on a takeoff", () => {
    // Pressed against the ledge: a step on the jump's own tick would put the feet
    // on top at once, where the jump has only just begun to rise.
    const ctx = setup(0.44);
    ctx.state.feet.z = -2 + RADIUS + 0.01;
    ctx.input.forward = 1;
    ctx.input.jump = true;
    ctx.run(DT);
    expect(ctx.state.feet.y).toBeLessThan(0.2);
    expect(ctx.state.feet.z).toBeGreaterThan(-2);
  });

  it("changes nothing along a wall", () => {
    // Walking diagonally into a wall too tall to step: the slide along it is the plain move.
    const ctx = setup(2);
    ctx.state.feet.z = -2 + RADIUS + 0.01;
    ctx.input.yaw = Math.PI / 4;
    ctx.input.forward = 1;
    ctx.run(1);
    expect(ctx.state.feet.y).toBeCloseTo(0, 3);
    expect(ctx.state.feet.x).toBeLessThan(-1);
  });
});
