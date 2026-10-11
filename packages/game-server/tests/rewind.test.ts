// Lag compensation: putting the world back the way the shooter saw it.
//
// This is the test the whole combat milestone rests on, and it is checkable with
// no socket, no renderer and no clock — which is why it is written before anything
// fires a bullet.
//
// The claim being tested is precise. A client draws other players one tick behind
// the newest snapshot, interpolated between the last two it received, so when it
// puts a crosshair on someone it is aiming at where they *were*. It reports that
// moment as a server tick plus a fraction (`InputStep.drawn`).
// Given those two numbers, this server must reproduce the position the client
// drew — not approximately, but by running the same interpolation over the same
// recorded states.
//
// So the test reconstructs the client's view from the snapshots the match actually
// produced, using the same `lerpMovement` the client draws with, and asserts the
// rewind agrees. Then it asserts the negative, because a rewind that quietly
// returned the present would pass every "is it close" check at walking pace: the
// same shot resolved against now must give a *different* answer.

import { describe, expect, it } from "vitest";
import type { InputMessage } from "@3d/shared/net/messages/input.js";
import type { ResolvedWorld } from "@3d/shared/dsl/resolved.js";
import { idleInput, type PlayerInput } from "@3d/shared/sim/input.js";
import { createMovement, STAND_EYE_HEIGHT, WALKING, type MovementState } from "@3d/shared/sim/movement.js";
import { lerpMovement } from "@3d/shared/sim/interpolate.js";
import { TICK_RATE } from "@3d/shared/net/messages/fields.js";
import { Match } from "../src/match/match.js";
import { PlayerHistory } from "../src/history.js";

const DT = 1 / TICK_RATE;

/** A floor at y=0 and nothing else, so the maths stays checkable. */
const ground = {
  ready: true,
  resolveCapsule(
    position: { x: number; y: number; z: number },
    _r: number,
    _h: number,
    out?: { position: { x: number; y: number; z: number }; grounded: boolean; normal: { x: number; y: number; z: number } },
  ) {
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
  overlapsCapsule: (position: { y: number }) => position.y < 0,
  overlapsSweep: (from: { y: number }, to: { y: number }, radius: number) => Math.min(from.y, to.y) < radius,
  groundBelow: (from: { y: number }, distance: number, normal?: { x: number; y: number; z: number }) => {
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
  traceRay: () => null,
};

function world(): ResolvedWorld {
  return {
    spawn: { position: { x: 0, y: STAND_EYE_HEIGHT, z: 0 }, look: { x: 0, y: STAND_EYE_HEIGHT, z: -1 } },
    spawnPoints: [],
    triggers: [],
    mantles: [],
    ladders: [],
    points: [],
    solids: [],
    rooms: [],
    topLevelObjects: [],
  } as unknown as ResolvedWorld;
}

const forward: PlayerInput = { ...idleInput(0, 0), forward: 1, run: true };

function input(seq: number, command: PlayerInput, renderTick = 0, renderFrac = 0): InputMessage {
  return { seq, dt: DT, input: command, claim: { x: 0, y: 0, z: 0 }, drawn: { tick: renderTick, frac: renderFrac } };
}

const scratch = (): MovementState => createMovement({ x: 0, y: 0, z: 0 }, 0, 0);

/**
 * A match with a runner and a shooter, run for `ticks`, keeping every snapshot the
 * way a client would receive it.
 *
 * The snapshots are the *only* thing the reconstruction below is allowed to use:
 * they are all a real client ever gets, so anything derived from them is something
 * the client could also have derived.
 */
function played(ticks: number) {
  const m = new Match(ground, world(), TICK_RATE, 4);
  m.join("runner");
  m.join("shooter");
  const seen: { tick: number; runner: MovementState }[] = [];
  for (let i = 1; i <= ticks; i++) {
    m.receive("runner", input(i, forward));
    m.receive("shooter", input(i, idleInput(0, 0)));
    const snapshot = m.step();
    // Exactly what `snapshotFor` hands each player, which also marks the tick as
    // sent — without which every rewind below would be clamped as implausible.
    m.snapshotFor("shooter", snapshot.players);
    m.snapshotFor("runner", snapshot.players);
    const runner = snapshot.players.find((p) => p.id === "runner")!;
    seen.push({ tick: m.tick, runner: runner.state.movement });
  }
  return { m, seen };
}

describe("a rewind", () => {
  it("reproduces the position the shooter's client drew, to the bit", () => {
    const { m, seen } = played(40);

    // What the client would have drawn: one tick behind the newest, part way
    // between the two samples it holds. This is `RemotePlayers.update` in the two
    // numbers it comes down to.
    const target = seen[seen.length - 3]!;
    const next = seen[seen.length - 2]!;
    const frac = 0.375; // exact in 8 bits, so the wire does not round it
    const drawn = lerpMovement(target.runner, next.runner, frac, scratch());

    const rewound = m.rewind("runner", input(99, forward, target.tick & 0xffff, frac), "shooter", scratch());
    expect(rewound).not.toBeNull();
    // Not `toBeCloseTo`: both sides ran the same interpolation over the same
    // recorded states, so anything but equality means the history is not holding
    // what the snapshots said.
    expect(rewound!.feet.x).toBe(drawn.feet.x);
    expect(rewound!.feet.y).toBe(drawn.feet.y);
    expect(rewound!.feet.z).toBe(drawn.feet.z);
  });

  it("is not the present, which is the whole point of it", () => {
    const { m, seen } = played(40);
    const target = seen[seen.length - 3]!;
    const now = seen[seen.length - 1]!;
    // Measured from the snapshots rather than assumed from RUN_SPEED: what matters
    // is that the rewind moves by as much as the runner actually moved, whatever
    // acceleration and friction made that be.
    const perTick = Math.abs(now.runner.feet.z - seen[seen.length - 2]!.runner.feet.z);
    expect(perTick).toBeGreaterThan(0.01);

    const rewound = m.rewind("runner", input(99, forward, target.tick & 0xffff, 0.5), "shooter", scratch())!;

    // `target` is two ticks before the newest, and the fraction carries half a tick
    // forward from it — so the moment named is one and a half ticks in the past,
    // and the rewind should be one and a half ticks of travel behind the present.
    const gap = Math.abs(rewound.feet.z - now.runner.feet.z);
    expect(gap).toBeCloseTo(perTick * 1.5, 3);
    // And in the right direction: the past is behind where they are now.
    expect(rewound.feet.z).toBeGreaterThan(now.runner.feet.z);
  });

  it("walks back further the further back it is asked to look", () => {
    const { m, seen } = played(40);
    const newest = seen[seen.length - 1]!.tick;
    let previous = -Infinity;
    for (const back of [1, 3, 6, 10]) {
      const rewound = m.rewind("runner", input(99, forward, (newest - back) & 0xffff, 0), "shooter", scratch())!;
      // Running towards -z, so an older sample is always a larger z.
      expect(rewound.feet.z).toBeGreaterThan(previous);
      previous = rewound.feet.z;
    }
  });

  it("interpolates between two ticks rather than snapping to one", () => {
    const { m, seen } = played(40);
    const target = seen[seen.length - 4]!;
    const at = (frac: number) => m.rewind("runner", input(99, forward, target.tick & 0xffff, frac), "shooter", scratch())!.feet.z;

    const zs = [0, 0.25, 0.5, 0.75].map(at);
    // Strictly monotonic within one tick: a rewind that ignored `frac` would
    // return the same number four times, and would still pass a test that only
    // checked it was in the past.
    for (let i = 1; i < zs.length; i++) {
      expect(zs[i]!).toBeLessThan(zs[i - 1]!);
    }
    // And the quarter-tick steps are even, because the runner is at a steady pace.
    const steps = [zs[1]! - zs[0]!, zs[2]! - zs[1]!, zs[3]! - zs[2]!];
    expect(steps[1]!).toBeCloseTo(steps[0]!, 6);
    expect(steps[2]!).toBeCloseTo(steps[0]!, 6);
  });
});

describe("a rewind that cannot be honoured as asked", () => {
  it("clamps a tick it has computed but not yet sent, and says so", () => {
    const { m, seen } = played(20);
    const newest = seen[seen.length - 1]!.tick;
    expect(m.rewindReport().implausible).toBe(0);

    // Step without sending: the clock has moved on but this player has not been
    // told, so they cannot have been drawing it. Narrow, and the only way to reach
    // this branch — see the test below for why "ahead of the clock" does not.
    m.step();
    const unsent = m.rewind("runner", input(99, forward, (newest + 1) & 0xffff, 0), "shooter", scratch())!;
    expect(m.rewindReport().implausible).toBe(1);

    const atNewest = m.rewind("runner", input(99, forward, newest & 0xffff, 0), "shooter", scratch())!;
    expect(unsent.feet.z).toBe(atNewest.feet.z);
  });

  it("reads a tick ahead of its own clock as ancient, and clamps it as such", () => {
    // Worth pinning, because it is a property of the encoding rather than a
    // decision. `drawn.tick` is 16 bits of an *always past* number, recovered as
    // `current - ((current - tick) & 0xffff)` — so a client naming a tick
    // ahead of the clock does not come out ahead, it comes out ~65536 behind, and
    // the window catches it. There is no way to express "the future" at all, which
    // is a better guarantee than a check.
    const { m, seen } = played(20);
    const newest = seen[seen.length - 1]!.tick;
    const before = m.rewindReport();

    const ahead = m.rewind("runner", input(99, forward, (newest + 500) & 0xffff, 0), "shooter", scratch())!;
    expect(m.rewindReport().clamped).toBe(before.clamped + 1);
    expect(m.rewindReport().implausible).toBe(before.implausible);

    // And it lands at the oldest a shot may reach, not at the newest.
    const atLimit = m.rewind("runner", input(99, forward, Math.max(0, newest - m.maxRewindTicks) & 0xffff, 0), "shooter", scratch())!;
    expect(ahead.feet.z).toBe(atLimit.feet.z);
  });

  it("clamps a tick further back than a shot may reach, and says so", () => {
    // Run longer than the window, so there is a tick in the ring that is still too
    // old to be shot at. The ring is deliberately four times the rewind limit, so
    // these two failure modes stay distinguishable.
    const { m, seen } = played(50);
    const newest = seen[seen.length - 1]!.tick;
    const tooOld = newest - m.maxRewindTicks - 5;
    expect(tooOld).toBeGreaterThan(0);
    expect(m.rewindReport().clamped).toBe(0);

    const clamped = m.rewind("runner", input(99, forward, tooOld & 0xffff, 0), "shooter", scratch())!;
    expect(m.rewindReport().clamped).toBe(1);
    const atLimit = m.rewind("runner", input(99, forward, (newest - m.maxRewindTicks) & 0xffff, 0), "shooter", scratch())!;
    expect(clamped.feet.z).toBe(atLimit.feet.z);
  });

  it("never refuses the shot", () => {
    // A refused shot is indistinguishable from a miss to the player who fired it,
    // and impossible to account for afterwards. Every one of these is answered.
    const { m } = played(30);
    for (const tick of [0, 1, 7, 12345, 65535]) {
      expect(m.rewind("runner", input(99, forward, tick, 0.5), "shooter", scratch())).not.toBeNull();
    }
  });

  it("judges a shooter who drew nobody one tick back, and counts nothing against them", () => {
    // No moment to rewind to is not a bad moment: a client with one snapshot, or
    // alone until now, has nothing to name and is neither clamped nor implausible.
    const { m, seen } = played(20);
    const newest = seen[seen.length - 1]!.tick;
    const before = m.rewindReport();

    const unnamed = m.rewind("runner", { ...input(99, forward), drawn: null }, "shooter", scratch())!;
    expect(m.rewindReport()).toEqual(before);

    const named = m.rewind("runner", input(99, forward, (newest - 1) & 0xffff, 0), "shooter", scratch())!;
    expect(unnamed.feet.z).toBe(named.feet.z);
    expect(unnamed.feet.z).not.toBe(seen[seen.length - 1]!.runner.feet.z);
  });

  it("gives nothing for a player who is not here", () => {
    const { m } = played(10);
    expect(m.rewind("nobody", input(99, forward, 5, 0), "shooter", scratch())).toBeNull();
  });

  it("answers for a player who joined after the moment asked about", () => {
    const { m, seen } = played(30);
    const newest = seen[seen.length - 1]!.tick;
    m.join("latecomer");
    m.step();

    // They have one tick of history and the shot reaches back before it. Their
    // earliest is the earliest they can be judged at — not null, which would read
    // as "no such player".
    const rewound = m.rewind("latecomer", input(99, forward, (newest - 10) & 0xffff, 0), "shooter", scratch());
    expect(rewound).not.toBeNull();
  });
});

describe("the 16 bits a render tick travels in", () => {
  it("survives the wrap, so a long match does not aim into the far past", () => {
    // `drawn.tick` is the low 16 bits and the server recovers the rest from its own
    // clock. A plain comparison is right for eighteen minutes and then points at a
    // tick 65536 in the past — which the window would clamp, silently turning every
    // shot in the match into a clamped one.
    const m = new Match(ground, world(), TICK_RATE, 4);
    m.join("runner");
    m.join("shooter");
    const wrap = 65536;
    for (let i = 1; i <= wrap + 4; i++) {
      m.receive("runner", input(i & 0xffff, forward));
      const snapshot = m.step();
      m.snapshotFor("shooter", snapshot.players);
    }

    // Tick 65538 is two past the wrap; its low bits are 2.
    const before = m.rewindReport();
    const rewound = m.rewind("runner", input(99, forward, 65538 & 0xffff, 0), "shooter", scratch());
    expect(rewound).not.toBeNull();
    // Neither clamp fired, which is the assertion: the tick was understood as two
    // past the wrap and not as 65534 before it.
    expect(m.rewindReport()).toEqual(before);
  }, 60_000);
});

describe("the ring itself", () => {
  it("keeps a fixed window and forgets in order", () => {
    const h = new PlayerHistory(4);
    const at = (tick: number, z: number): MovementState => {
      const m = createMovement({ x: 0, y: 0, z }, 0, 0);
      h.record(tick, m);
      return m;
    };
    at(10, 0);
    at(11, -1);
    at(12, -2);
    at(13, -3);
    expect(h.oldest).toBe(10);
    expect(h.latest).toBe(13);

    // The fifth overwrites the first, and the window slides rather than growing.
    at(14, -4);
    expect(h.oldest).toBe(11);
    expect(h.latest).toBe(14);
    expect(h.at(10)).toBeUndefined();
    expect(h.at(14)!.feet.z).toBe(-4);
  });

  it("does not mistake a stale slot for the tick that now maps to it", () => {
    // The bug a ring invites: tick 10 and tick 14 share a slot in a ring of four,
    // so a slot has to remember *which* tick it holds. Without that, asking for a
    // tick that has aged out returns the one that replaced it — a rewind four ticks
    // wrong, with nothing to indicate it.
    const h = new PlayerHistory(4);
    h.record(10, createMovement({ x: 0, y: 0, z: 0 }, 0, 0));
    expect(h.at(10)).toBeDefined();
    expect(h.at(14)).toBeUndefined();
    h.record(14, createMovement({ x: 0, y: 0, z: -9 }, 0, 0));
    expect(h.at(10)).toBeUndefined();
    expect(h.at(14)!.feet.z).toBe(-9);
  });

  it("holds a copy, so the live state moving on does not rewrite the past", () => {
    // `record` is handed the player's live movement, which the next step mutates in
    // place. Keeping the reference would make every slot the present.
    const h = new PlayerHistory(4);
    const live = createMovement({ x: 0, y: 0, z: 0 }, 0, 0);
    h.record(1, live);
    live.feet.z = -100;
    h.record(2, live);
    expect(h.at(1)!.feet.z).toBe(0);
    expect(h.at(2)!.feet.z).toBe(-100);
  });

  it("carries a climb into the past and out of it again", () => {
    // The move is the only thing `copyMovement` allocates, and the only thing
    // that can be stale: a player who has stopped climbing must not still be on
    // a ladder in a slot that is reused.
    const h = new PlayerHistory(3);
    const live = createMovement({ x: 0, y: 0, z: 0 }, 0, 0);
    live.move = { kind: "ladder", facing: 1.25 };
    h.record(1, live);
    live.move = WALKING;
    h.record(2, live);
    expect(h.at(1)!.move).toEqual({ kind: "ladder", facing: 1.25 });
    expect(h.at(2)!.move.kind).toBe("walk");
  });

  it("samples a single tick when there is no next one to reach towards", () => {
    const h = new PlayerHistory(4);
    h.record(7, createMovement({ x: 0, y: 0, z: -5 }, 0, 0));
    // The newest tick a client can name: nothing to interpolate towards, and the
    // client's own draw clamped the same way.
    expect(h.sample(7, 0.5, createMovement({ x: 0, y: 0, z: 0 }, 0, 0))!.feet.z).toBe(-5);
    expect(h.sample(8, 0, createMovement({ x: 0, y: 0, z: 0 }, 0, 0))).toBeNull();
  });
});
