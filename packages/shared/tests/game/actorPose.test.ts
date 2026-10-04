// poseActor: an actor's state and look to its clips, for a synthetic look — every
// action, the gait's own clip, the idle fading in below half its speed, and the
// fallbacks a look missing a role gets.

import { describe, expect, it } from "vitest";
import type { ActorGait, ActorState } from "../../src/game/actors/actor.js";
import type { ActorClip } from "../../src/game/actors/assets.js";
import { poseActor, type ActorPoseState } from "../../src/game/actors/pose.js";
import type { CreatureRole } from "../../src/sim/characterDef.js";

type Clips = Partial<Record<CreatureRole, Pick<ActorClip, "name" | "speed">>>;

const FULL: Clips = {
  idle: { name: "z_idle", speed: 0 },
  walk: { name: "z_walk", speed: 1 },
  run: { name: "z_run", speed: 2 },
  sprint: { name: "z_sprint", speed: 3.6 },
  attack: { name: "z_attack", speed: 0 },
  die: { name: "z_die", speed: 0.4 },
  climb: { name: "z_climb", speed: 0.8 },
  climbRun: { name: "z_climb_run", speed: 1 },
  climbSprint: { name: "z_climb_sprint", speed: 2.4 },
};

const state = (action: ActorState["action"], speed = 0, phase = 0.25, gait: ActorGait = "walk", traversal = 0): ActorPoseState => ({
  action,
  speed,
  phase,
  gait,
  traversal,
});

const weights = (layers: { clip: string; weight: number }[]) => Object.fromEntries(layers.map((l) => [l.clip, l.weight]));
const total = (layers: { weight: number }[]) => layers.reduce((sum, l) => sum + l.weight, 0);

describe("poseActor", () => {
  it("plays the action's own clip at the phase it was sent", () => {
    for (const action of ["idle", "attack", "die"] as const) {
      expect(poseActor(state(action, 0, 0.6), FULL)).toEqual([{ role: action, clip: FULL[action]!.name, weight: 1, phase: 0.6 }]);
    }
  });

  it("moves in the gait's clip, at the cycle's phase", () => {
    expect(poseActor(state("move", 1, 0.8, "walk"), FULL)).toEqual([{ role: "walk", clip: "z_walk", weight: 1, phase: 0.8 }]);
    expect(weights(poseActor(state("move", 2, 0.8, "run"), FULL))).toEqual({ z_run: 1 });
    expect(weights(poseActor(state("move", 3.6, 0.8, "sprint"), FULL))).toEqual({ z_sprint: 1 });
  });

  it("fades the idle in below half the gait clip's speed, summing to one", () => {
    const slow = poseActor(state("move", 0.25, 0.5, "walk"), FULL);
    expect(weights(slow).z_idle).toBeCloseTo(0.5, 9);
    expect(weights(slow).z_walk).toBeCloseTo(0.5, 9);
    for (let speed = 0; speed < 5; speed += 0.1) {
      for (const gait of ["walk", "run", "sprint"] as const) {
        expect(total(poseActor(state("move", speed, 0, gait), FULL))).toBeCloseTo(1, 9);
      }
    }
  });

  it("climbs a traversal in the gait's climb, at the phase along the link", () => {
    expect(poseActor(state("traverse", 1, 0.4, "walk"), FULL)).toEqual([{ role: "climb", clip: "z_climb", weight: 1, phase: 0.4 }]);
    expect(weights(poseActor(state("traverse", 1, 0.4, "run"), FULL))).toEqual({ z_climb_run: 1 });
    expect(weights(poseActor(state("traverse", 1, 0.4, "sprint"), FULL))).toEqual({ z_climb_sprint: 1 });
    // A walker's climb only: every gait climbs in it. None at all: it stands.
    const oneClimb: Clips = { idle: { name: "i", speed: 0 }, climb: { name: "c", speed: 1 } };
    expect(weights(poseActor(state("traverse", 1, 0.4, "sprint"), oneClimb))).toEqual({ c: 1 });
    expect(weights(poseActor(state("traverse", 1, 0.4), { idle: { name: "i", speed: 0 } }))).toEqual({ i: 1 });
  });

  it("plays a link's own clip when the wire names one, and climbs when it names one this end lacks", () => {
    const jumps = [{ name: "jump_40" }, { name: "jump_190" }];
    expect(poseActor(state("traverse", 0, 0.3, "run", 2), FULL, jumps)).toEqual([{ role: "traversal", clip: "jump_190", weight: 1, phase: 0.3 }]);
    expect(weights(poseActor(state("traverse", 0, 0.3, "run", 3), FULL, jumps))).toEqual({ z_climb_run: 1 });
    expect(weights(poseActor(state("traverse", 0, 0.3, "walk", 1), FULL))).toEqual({ z_climb: 1 });
  });

  it("falls back to what the look has", () => {
    const walkOnly: Clips = { idle: { name: "i", speed: 0 }, walk: { name: "w", speed: 1 } };
    expect(weights(poseActor(state("move", 3, 0, "sprint"), walkOnly))).toEqual({ w: 1 });
    expect(poseActor(state("attack"), walkOnly)).toEqual([{ role: "idle", clip: "i", weight: 1, phase: 0 }]);
    expect(poseActor(state("die"), walkOnly)).toEqual([{ role: "idle", clip: "i", weight: 1, phase: 0 }]);
    // A sprint the look lacks is a run before it is a walk.
    expect(weights(poseActor(state("move", 3, 0, "sprint"), { ...walkOnly, run: { name: "r", speed: 2 } }))).toEqual({ r: 1 });
    // No idle to fade from: the gait carries the whole body however slow.
    expect(weights(poseActor(state("move", 0.1, 0, "run"), { run: { name: "r", speed: 2 } }))).toEqual({ r: 1 });
    expect(poseActor(state("move", 2), { idle: { name: "i", speed: 0 } })).toEqual([{ role: "idle", clip: "i", weight: 1, phase: 0.25 }]);
  });
});
