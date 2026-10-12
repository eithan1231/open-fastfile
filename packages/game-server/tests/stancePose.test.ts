// A crouched and a lying body, posed from each game's own clips: every body the
// catalogue holds, put where the simulation says a player in that stance is, and
// its head, hips and feet measured against the stance's own numbers.
//
// What this is for is the plausible wrong answer. A set that names a clip its
// GLB does not hold, or a pose that asks for a role the set lacks, leaves a body
// standing in its bind pose with nothing to say about it. Skipped where no
// catalogue has been built.

import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { STANCE_ROLES } from "@3d/shared/sim/characterDef.js";
import { CROUCHING, createMovement, EYE_PATHS, STAND_EYE_HEIGHT, type MovementState } from "@3d/shared/sim/movement.js";
import { CROUCH_EYE_HEIGHT, eyeHeight, eyePathEnds, eyePathSeconds, PRONE_EYE_HEIGHT } from "@3d/shared/sim/stance.js";
import { poseBody, type LoadedBody } from "../src/bodies.js";
import { catalogueBodies, GAMES, type CatalogueBodies } from "./catalogueBodies.js";

/** How far a head may sit from the eye the simulation sees from: a head is a quarter of a metre of bone. */
const HEAD_TO_EYE = 0.25;
/** A lying body's heading, off every axis, so a body lying along the wrong one is caught. */
const HEADING = 0.9;

let loaded: Promise<CatalogueBodies | null> | undefined;

function everyBody(real: CatalogueBodies): LoadedBody[] {
  return GAMES.flatMap((game) => real.catalogue.charactersFor(game).flatMap((entry) => real.bodies.get(game, entry.id) ?? []));
}

function at(over: Partial<MovementState> = {}): MovementState {
  return { ...createMovement({ x: 3, y: 0.5, z: -2 }, 0.2, 0), grounded: true, ...over };
}

const lying = (): MovementState => at({ stance: { kind: "prone", heading: HEADING, torso: 0 } });

function bone(body: LoadedBody, name: string): THREE.Vector3 {
  const found = body.rig.root.getObjectByName(name);
  if (!found) {
    throw new Error(`${body.id} has no ${name}`);
  }
  return found.getWorldPosition(new THREE.Vector3());
}

/** Every bone's world position, which is where a pose that divided by nothing shows. */
function finite(body: LoadedBody): boolean {
  let ok = true;
  body.rig.root.traverse((item) => {
    ok &&= item.matrixWorld.elements.every(Number.isFinite);
  });
  return ok;
}

describe("a stance, posed from each game's own clips", () => {
  it("every game's set has a clip to rest in and to move by, crouched and prone", async () => {
    const real = await (loaded ??= catalogueBodies());
    if (!real) {
      return; // no catalogue built in this checkout
    }
    const seen = new Set<string>();
    for (const body of everyBody(real)) {
      seen.add(body.game);
      const has = (role: string): boolean => body.rig.clips.has(body.rig.set.roles[role as keyof typeof body.rig.set.roles] ?? "");
      for (const kind of ["crouch", "prone"] as const) {
        const clips = STANCE_ROLES[kind];
        for (const role of [clips.idle, clips.fire, clips.reload, ...clips.directions.map(([r]) => r)]) {
          expect(has(role), `${body.game}/${body.id} has no ${role} clip`).toBe(true);
        }
      }
    }
    expect(seen.size).toBeGreaterThan(0);
  }, 300_000);

  it("crouches with its head at the crouched eye, on its feet", async () => {
    const real = await (loaded ??= catalogueBodies());
    if (!real) {
      return;
    }
    for (const body of everyBody(real)) {
      const movement = at({ stance: CROUCHING });
      poseBody(body, movement, null);
      const name = `${body.game}/${body.id}`;
      expect(finite(body), `${name} has a bone at no finite place`).toBe(true);
      const head = bone(body, "j_head").y - movement.feet.y;
      expect(Math.abs(head - CROUCH_EYE_HEIGHT), `${name} crouches with its head at ${head.toFixed(2)} m`).toBeLessThan(HEAD_TO_EYE);
      // On its feet and not through the floor: an ankle is a hand's width above the ground.
      for (const ankle of ["j_ankle_le", "j_ankle_ri"]) {
        const up = bone(body, ankle).y - movement.feet.y;
        expect(up, `${name} crouches with ${ankle} at ${up.toFixed(2)} m`).toBeGreaterThan(-0.05);
        expect(up, `${name} crouches with ${ankle} at ${up.toFixed(2)} m`).toBeLessThan(0.4);
      }
      // Upright: the head is over the feet, not laid out behind them.
      expect(Math.hypot(bone(body, "j_head").x - movement.feet.x, bone(body, "j_head").z - movement.feet.z)).toBeLessThan(0.5);
    }
  }, 300_000);

  it("lies along its heading with its head at the prone eye and its feet on the ground behind it", async () => {
    const real = await (loaded ??= catalogueBodies());
    if (!real) {
      return;
    }
    // Yaw 0 faces -Z, so a body heading `HEADING` has its feet along (sin, cos).
    const back = new THREE.Vector3(Math.sin(HEADING), 0, Math.cos(HEADING));
    for (const body of everyBody(real)) {
      const movement = lying();
      poseBody(body, movement, null);
      const name = `${body.game}/${body.id}`;
      expect(finite(body), `${name} has a bone at no finite place`).toBe(true);
      const head = bone(body, "j_head").y - movement.feet.y;
      expect(head, `${name} lies with its head at ${head.toFixed(2)} m`).toBeGreaterThan(PRONE_EYE_HEIGHT - 0.1);
      expect(head, `${name} lies with its head at ${head.toFixed(2)} m`).toBeLessThan(PRONE_EYE_HEIGHT + HEAD_TO_EYE);
      const pelvis = bone(body, "pelvis").y - movement.feet.y;
      expect(pelvis, `${name} lies with its hips at ${pelvis.toFixed(2)} m`).toBeGreaterThan(0);
      expect(pelvis, `${name} lies with its hips at ${pelvis.toFixed(2)} m`).toBeLessThan(0.35);
      for (const ankle of ["j_ankle_le", "j_ankle_ri"]) {
        const from = bone(body, ankle).sub(new THREE.Vector3(movement.feet.x, movement.feet.y, movement.feet.z));
        expect(from.y, `${name} lies with ${ankle} at ${from.y.toFixed(2)} m`).toBeGreaterThan(-0.05);
        expect(from.y, `${name} lies with ${ankle} at ${from.y.toFixed(2)} m`).toBeLessThan(0.35);
        // Most of a metre behind the point the simulation moves, and further behind than beside:
        // a lying body draws one knee up, which carries that foot two thirds of a metre out.
        expect(from.dot(back), `${name}'s ${ankle} is ${from.dot(back).toFixed(2)} m behind`).toBeGreaterThan(0.9);
        expect(Math.abs(from.clone().cross(back).y), `${name}'s ${ankle} is beside its heading`).toBeLessThan(0.8);
      }
      // The gun points the way the body lies: the firing hand is ahead of the hips.
      const reach = bone(body, "j_wrist_ri").sub(bone(body, "pelvis")).dot(back);
      expect(reach, `${name}'s gun hand is ${(-reach).toFixed(2)} m ahead of its hips`).toBeLessThan(-0.4);
    }
  }, 300_000);

  it("tips a lying body with its torso, about the point the simulation moves", async () => {
    const real = await (loaded ??= catalogueBodies());
    if (!real) {
      return;
    }
    for (const body of everyBody(real)) {
      const flat = lying();
      poseBody(body, flat, null);
      const level = bone(body, "j_ankle_le").y;
      const tipped = at({ stance: { kind: "prone", heading: HEADING, torso: 0.3 } });
      poseBody(body, tipped, null);
      // Head up the slope, so the feet behind it are down it by about their reach times the slope.
      expect(level - bone(body, "j_ankle_le").y, `${body.game}/${body.id}`).toBeGreaterThan(0.25);
    }
  }, 300_000);

  it("goes from each stance to the next between their two heights, following the eye", async () => {
    const real = await (loaded ??= catalogueBodies());
    if (!real) {
      return;
    }
    const rest = { stand: STAND_EYE_HEIGHT, crouch: CROUCH_EYE_HEIGHT, prone: PRONE_EYE_HEIGHT };
    for (const body of everyBody(real)) {
      for (const path of EYE_PATHS) {
        const { from, to } = eyePathEnds(path);
        const heights: number[] = [];
        for (let i = 0; i <= 8; i++) {
          const movement = at({
            stance: to === "prone" ? { kind: "prone", heading: HEADING, torso: 0 } : to === "crouch" ? CROUCHING : { kind: "stand" },
            eyeShift: { path, elapsed: (i / 8) * eyePathSeconds(path) },
          });
          poseBody(body, movement, null);
          expect(finite(body)).toBe(true);
          heights.push(bone(body, "j_head").y - movement.feet.y);
          // The body follows the eye the simulation moves, loosely: a clip made for the game's own timing is scrubbed here.
          expect(Math.abs(heights[i]! - eyeHeight(movement)), `${body.game}/${body.id} ${path} at ${i}/8: head ${heights[i]!.toFixed(2)} m`).toBeLessThan(0.6);
        }
        const low = Math.min(rest[from], rest[to]) - 0.2;
        const high = Math.max(rest[from], rest[to]) + HEAD_TO_EYE;
        expect(Math.min(...heights), `${body.game}/${body.id} ${path}`).toBeGreaterThan(low);
        expect(Math.max(...heights), `${body.game}/${body.id} ${path}`).toBeLessThan(high);
        // It gets there: the ends are the two stances' own heads.
        expect(Math.abs(heights[0]! - heights[8]!), `${body.game}/${body.id} ${path}`).toBeGreaterThan(0.3);
      }
    }
  }, 300_000);
});
