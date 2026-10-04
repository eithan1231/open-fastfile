// Being inside a trigger (game/volumes.ts): the one test occupancy runs per player
// per tick, and the overlap a `touch` use is judged by.

import { describe, expect, it } from "vitest";
import { inside, touches, volumeBounds, volumeCentre, type VolumeShape } from "../../src/game/volumes.js";

const at = (x: number, y: number, z: number) => ({ x, y, z });

describe("inside", () => {
  it("is a box centred on its position, faces included", () => {
    const box: VolumeShape = { position: at(10, 2, -4), yaw: 0, size: at(2, 4, 6) };
    expect(inside(box, at(10, 2, -4))).toBe(true);
    expect(inside(box, at(11, 0, -1))).toBe(true); // a corner
    expect(inside(box, at(11.01, 2, -4))).toBe(false);
    expect(inside(box, at(10, -0.01, -4))).toBe(false);
    expect(inside(box, at(10, 2, -7.01))).toBe(false);
  });

  it("turns a box by its yaw, as resolve places one", () => {
    // A long thin box, 4 m along its own x, turned a quarter: now long along -z.
    const box: VolumeShape = { position: at(0, 0, 0), yaw: Math.PI / 2, size: at(4, 1, 0.5) };
    expect(inside(box, at(1.9, 0, 0))).toBe(false);
    expect(inside(box, at(0, 0, 1.9))).toBe(true);
    expect(inside(box, at(0, 0, -1.9))).toBe(true);
    // At 45° a unit box reaches 0.707 along each axis.
    const diamond: VolumeShape = { position: at(0, 0, 0), yaw: Math.PI / 4, size: at(1, 1, 1) };
    expect(inside(diamond, at(0.69, 0, 0))).toBe(true);
    expect(inside(diamond, at(0.5, 0, 0.5))).toBe(false);
  });

  it("stands a cylinder on its position and raises it by its height", () => {
    const flag: VolumeShape = { position: at(5, 1, 5), yaw: 0, radius: 2, height: 3 };
    expect(inside(flag, at(5, 1, 5))).toBe(true); // the base itself
    expect(inside(flag, at(6.9, 4, 5))).toBe(true); // the rim at the top
    expect(inside(flag, at(5, 0.99, 5))).toBe(false); // under it
    expect(inside(flag, at(5, 4.01, 5))).toBe(false); // over it
    expect(inside(flag, at(6.5, 2, 6.5))).toBe(false); // outside the round, inside its square
    expect(volumeCentre(flag)).toEqual(at(5, 2.5, 5));
  });

  it("centres a sphere on its position", () => {
    const well: VolumeShape = { position: at(0, 10, 0), yaw: 0, radius: 4 };
    expect(inside(well, at(0, 14, 0))).toBe(true);
    expect(inside(well, at(2.9, 12.9, 0))).toBe(false);
    expect(inside(well, at(0, 5.99, 0))).toBe(false);
    expect(volumeCentre(well)).toEqual(at(0, 10, 0));
  });

  it("is bounded by what it reports as its bounds", () => {
    const shapes: VolumeShape[] = [
      { position: at(1, 2, 3), yaw: 0.6, size: at(3, 1, 2) },
      { position: at(1, 2, 3), yaw: 0, radius: 2, height: 1 },
      { position: at(1, 2, 3), yaw: 0, radius: 2 },
    ];
    for (const shape of shapes) {
      const { min, max } = volumeBounds(shape);
      for (let i = 0; i < 400; i++) {
        const p = at(-3 + (i % 20) * 0.4, -1 + Math.floor(i / 20) * 0.3, 3 + Math.sin(i) * 3);
        if (inside(shape, p)) {
          expect(p.x >= min.x && p.x <= max.x && p.y >= min.y && p.y <= max.y && p.z >= min.z && p.z <= max.z).toBe(true);
        }
      }
    }
  });
});

describe("touches", () => {
  const box: VolumeShape = { position: at(0, 1, 0), yaw: 0, size: at(2, 2, 2) };

  it("counts a body whose side meets the volume without its feet being in it", () => {
    expect(touches(box, at(1.25, 0, 0), 0.3, 1.7)).toBe(true);
    expect(touches(box, at(1.35, 0, 0), 0.3, 1.7)).toBe(false);
    // Past a corner, the rounded body reaches less far than a square one would.
    expect(touches(box, at(1.25, 0, 1.25), 0.3, 1.7)).toBe(false);
  });

  it("needs the heights to overlap", () => {
    expect(touches(box, at(0, -1.69, 0), 0.3, 1.7)).toBe(true); // head just into it
    expect(touches(box, at(0, -1.8, 0), 0.3, 1.7)).toBe(false);
    expect(touches(box, at(0, 2.1, 0), 0.3, 1.7)).toBe(false);
  });

  it("meets a cylinder and a sphere too", () => {
    expect(touches({ position: at(0, 0, 0), yaw: 0, radius: 1, height: 2 }, at(1.29, 0.5, 0), 0.3, 1.7)).toBe(true);
    expect(touches({ position: at(0, 0, 0), yaw: 0, radius: 1, height: 2 }, at(1.31, 0.5, 0), 0.3, 1.7)).toBe(false);
    expect(touches({ position: at(0, 3, 0), yaw: 0, radius: 1 }, at(0, 0.5, 0), 0.3, 1.7)).toBe(true); // head in it
    expect(touches({ position: at(0, 3, 0), yaw: 0, radius: 1 }, at(0, 0, 0), 0.3, 1.7)).toBe(false);
  });
});
