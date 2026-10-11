// Climbing an imported map's real ladders, against its real collision.
//
// The unit tests climb a box against boxes. This climbs the ladders an export
// wrote, against the clipmap the same export wrote, because the two ways a
// climb fails quietly both live in the real data: the capsule sinking into
// something on the way up, and a push off the ladder's own triangles that stops
// the climb dead (the resolver's pushes along a wall are not always level).
// Skips when the map has not been exported, as the other imported-map tests do.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { loadResolvedWorld } from "@3d/shared/worlds/load.js";
import type { WorldSource } from "@3d/shared/worlds/source.js";
import type { ResolvedLadder } from "@3d/shared/dsl/resolved.js";
import { idleInput } from "@3d/shared/sim/input.js";
import { createMovement, EMPTY_HANDS, movementEnv, PLAYER_MOVEMENT, RADIUS, STAND_HEIGHT as HEIGHT, stepMovement } from "@3d/shared/sim/movement.js";
import { movementRules } from "@3d/shared/sim/worldRules.js";
import { buildServerCollision } from "../src/collision.js";

/** This world ships its own assets; nothing here comes from the catalogue. */
const noCatalog = () => Promise.resolve(undefined);

const DIR = path.resolve(import.meta.dirname, "../../../worlds/dome-mw3");
const DT = 1 / 60;
/** How far below a ladder's top its landing may be: the exporter's own landing check allows 16 units. */
const LANDING_DROP = 16 * 0.0254;

const source: WorldSource = {
  describe: DIR,
  payload: () =>
    Promise.resolve({
      entryPath: "world.world",
      sources: Object.fromEntries(
        fs
          .readdirSync(DIR)
          .filter((f) => f.endsWith(".world"))
          .map((f) => [f, fs.readFileSync(path.join(DIR, f), "utf8")]),
      ),
    }),
  asset: (rel) => {
    const file = path.join(DIR, rel);
    return Promise.resolve(fs.existsSync(file) ? new Uint8Array(fs.readFileSync(file)) : undefined);
  },
};

const exported = fs.existsSync(path.join(DIR, "assets/collision.glb")) && fs.existsSync(path.join(DIR, "ladder.world"));

/** The outward normals of a ladder's two broad sides, world space: the ones a player climbs. */
function broadSides(ladder: ResolvedLadder): { x: number; z: number }[] {
  const alongX = ladder.size.x < ladder.size.z;
  const c = Math.cos(ladder.yaw);
  const s = Math.sin(ladder.yaw);
  return [1, -1].map((sign) => {
    const lx = alongX ? sign : 0;
    const lz = alongX ? 0 : sign;
    return { x: lx * c + lz * s, z: -lx * s + lz * c };
  });
}

describe.skipIf(!exported)("dome-mw3's ladders", () => {
  it("climb from the foot, over the top and onto the landing, never sinking into anything", async () => {
    const world = (await loadResolvedWorld(source)).world!;
    const collision = (await buildServerCollision(world, source, noCatalog))!.world;
    const env = movementEnv(collision, movementRules(world), PLAYER_MOVEMENT);
    expect(world.ladders.length).toBeGreaterThan(0);

    let climbs = 0;
    for (const ladder of world.ladders) {
      const top = ladder.position.y + ladder.size.y / 2;
      for (const side of broadSides(ladder)) {
        // Half a metre out from the side, on whatever floor is there.
        const out = Math.min(ladder.size.x, ladder.size.z) / 2 + RADIUS + 0.5;
        const x = ladder.position.x + side.x * out;
        const z = ladder.position.z + side.z * out;
        const floor = collision.groundBelow({ x, y: top + 0.5, z }, ladder.size.y + 2);
        // The side with the landing is not a foot to climb from.
        if (floor === null || floor > top - 1) {
          continue;
        }
        climbs++;
        const yaw = Math.atan2(side.x, side.z);
        const state = createMovement({ x, y: floor, z }, yaw, 0);
        // Standing first: a state starts in the air, where a ladder is grabbed from further off.
        for (let i = 0; i < 3; i++) {
          stepMovement(state, idleInput(yaw, 0.6), DT, env, EMPTY_HANDS);
        }
        const input = idleInput(yaw, 0.6);
        input.forward = 1;
        let grabbed = false;
        let sunk = 0;
        let offAt = -1;
        for (let i = 0; i < 12 / DT && (offAt < 0 || i < offAt + 0.5 / DT); i++) {
          stepMovement(state, input, DT, env, EMPTY_HANDS);
          grabbed ||= state.move.kind === "ladder";
          if (grabbed && offAt < 0 && state.move.kind !== "ladder" && state.grounded) {
            offAt = i;
          }
          if (collision.overlapsCapsule(state.feet, RADIUS, HEIGHT)) {
            sunk++;
          }
        }
        const where = `${ladder.name} from (${side.x.toFixed(2)}, ${side.z.toFixed(2)})`;
        expect(grabbed, where).toBe(true);
        expect(sunk, where).toBe(0);
        expect(offAt, where).toBeGreaterThan(0);
        expect(state.move.kind, where).toBe("walk");
        expect(state.grounded, where).toBe(true);
        expect(state.feet.y, where).toBeGreaterThan(top - LANDING_DROP - 0.01);
      }
    }
    expect(climbs).toBeGreaterThan(0);
  }, 60_000);

  it("are got onto from the top by walking backward off the edge, and never held from the landing", async () => {
    // IW5's way down (reverse/iw5-ladders/README.md, "The top of a ladder"):
    // walking forward at a ladder from its landing grabs its back for a moment,
    // and the step-up sets the player on its top, where the grab lets go.
    // Walking backward off the edge, the airborne probe faces the ladder and
    // catches the side that is climbed.
    const world = (await loadResolvedWorld(source)).world!;
    const collision = (await buildServerCollision(world, source, noCatalog))!.world;
    const env = movementEnv(collision, movementRules(world), PLAYER_MOVEMENT);

    let landings = 0;
    for (const ladder of world.ladders) {
      const top = ladder.position.y + ladder.size.y / 2;
      for (const side of broadSides(ladder)) {
        const x = ladder.position.x + side.x * 1.2;
        const z = ladder.position.z + side.z * 1.2;
        const floor = collision.groundBelow({ x, y: top + 1, z }, 3);
        if (floor === null || floor < top - 1) {
          continue; // not a landing
        }
        landings++;
        const facing = Math.atan2(side.x, side.z);
        const into = (normal: { facing: number }) => -Math.sin(normal.facing) * side.x - Math.cos(normal.facing) * side.z;
        for (const backward of [false, true]) {
          const yaw = backward ? facing + Math.PI : facing;
          const state = createMovement({ x, y: floor, z }, yaw, 0);
          const input = idleInput(yaw, 0);
          input.forward = backward ? -1 : 1;
          let heldBack = 0;
          let caught = false;
          for (let i = 0; i < 2 / DT && !caught; i++) {
            stepMovement(state, input, DT, env, EMPTY_HANDS);
            if (state.move.kind === "ladder") {
              // Its normal pointing back at the landing is the back of the ladder.
              if (into(state.move) > 0) {
                heldBack++;
              } else {
                caught = true;
              }
            }
            expect(collision.overlapsCapsule(state.feet, RADIUS, HEIGHT)).toBe(false);
          }
          const where = `${ladder.name} ${backward ? "backward" : "forward"}`;
          expect(heldBack, where).toBeLessThanOrEqual(2);
          expect(caught, where).toBe(backward);
        }
      }
    }
    expect(landings).toBeGreaterThan(0);
  }, 60_000);
});
