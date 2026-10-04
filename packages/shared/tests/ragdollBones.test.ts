// Where a box's mass goes. The corpus-wide check is game-server's ragdollTable test;
// this pins the one fold that is not a segment's own bone or its descendant.

import { describe, expect, it } from "vitest";
import { segmentOf } from "../src/sim/ragdollBones.js";

const PARENTS: Record<string, string | undefined> = {
  pelvis: "j_mainroot",
  j_mainroot: "tag_origin",
  tag_origin: undefined,
  j_hip_le: "pelvis",
  j_exohip01_l: "j_hip_le",
};
const parentOf = (bone: string): string | undefined => PARENTS[bone];

describe("segmentOf", () => {
  it("folds a bone onto its nearest segmented ancestor", () => {
    expect(segmentOf("j_exohip01_l", parentOf)).toBe("leftLegUpper");
  });

  // Advanced Warfare roots a costume's pants and gear at `j_mainroot`, on `pelvis` at bind.
  it("counts j_mainroot as the pelvis, and nothing above it as anything", () => {
    expect(segmentOf("j_mainroot", parentOf)).toBe("pelvis");
    expect(segmentOf("tag_origin", parentOf)).toBeUndefined();
  });
});
