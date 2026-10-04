// The pose fragment: that a link round-trips, and that a fragment it cannot
// trust is refused rather than half-read.

import { describe, expect, it } from "vitest";
import { formatPose, parsePose, poseFrom, poseOrientation, type Pose } from "../src/engine/pose.js";

const POSE: Pose = { slug: "dome-mw3", x: 33.885, y: -6.477, z: -40.789, yaw: 263.893, pitch: -19.928, hold: true };

describe("pose fragments", () => {
  it("round-trips a link", () => {
    expect(formatPose(POSE)).toBe("#dome-mw3@33.885,-6.477,-40.789,263.893,-19.928,hold");
    expect(parsePose(formatPose(POSE))).toEqual(POSE);
  });

  it("treats `hold` as a flag rather than a field, so a link without it still parses", () => {
    expect(parsePose("dome-mw3@1,2,3,4,5")).toMatchObject({ hold: false });
    expect(parsePose("dome-mw3@1,2,3,4,5,hold")).toMatchObject({ hold: true });
  });

  it("takes the engine's radians and gives them back", () => {
    const pose = poseFrom("w", { x: 1, y: 2, z: 3 }, { yaw: 1, pitch: -0.5 }, true);
    const back = poseOrientation(parsePose(formatPose(pose))!);
    expect(back.yaw).toBeCloseTo(1, 4);
    expect(back.pitch).toBeCloseTo(-0.5, 4);
  });

  it("refuses a fragment it cannot trust, so a bad link drops you at the menu", () => {
    expect(parsePose("")).toBeUndefined();
    expect(parsePose("#dome-mw3")).toBeUndefined();
    expect(parsePose("#dome-mw3@1,2,3,4")).toBeUndefined();
    expect(parsePose("#dome-mw3@1,2,3,4,nope")).toBeUndefined();
  });
});
