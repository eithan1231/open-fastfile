// A bot's three layers on small made-up maps: the brain choosing whom to chase
// and where to go, the motor carrying a goal out over a real floor and around a
// wall the graph did not know about, and the driver deciding when to think.
// A real map is packages/game-server/tests/bots.test.ts's.

import { describe, expect, it } from "vitest";
import type { BrainContext, Goal } from "../../src/game/bots/brain.js";
import { defineBrain } from "../../src/game/bots/brain.js";
import { SEEK_ARRIVE, SEEK_PERIOD, seekNearest } from "../../src/game/bots/brains/seekNearest.js";
import { zombie, ZOMBIE } from "../../src/game/bots/brains/zombie.js";
import { BotDriver, type BotTurn } from "../../src/game/bots/driver.js";
import { Motor } from "../../src/game/bots/motor.js";
import type { Objective } from "../../src/game/bots/objective.js";
import { NavPlanner } from "../../src/game/bots/planner.js";
import { BRAINS, brainFor } from "../../src/game/bots/registry.js";
import type { PlayerStateView, PlayerView } from "../../src/game/context.js";
import { NavMatchState } from "../../src/nav/dynamic.js";
import { allocateGraph, LINK_STATUS, NavGraph } from "../../src/nav/graph.js";
import { ABILITIES, LINK_KINDS } from "../../src/nav/vocab.js";
import type { Vec3 } from "../../src/sim/capsule.js";
import { idleInput } from "../../src/sim/input.js";
import { createMovement, RUN_SPEED, stepMovement, type MovementState } from "../../src/sim/movement.js";
import { boxWorld, FLOOR, navFile, type Box } from "../navWorld.js";

const DT = 1 / 60;

/** A graph over these feet, each pair linked both ways as a walk, costing the distance at a run. */
function graphOf(positions: [number, number, number][], pairs: [number, number][]): NavGraph {
  const edges = pairs.flatMap(([a, b]) => [
    { from: a, to: b },
    { from: b, to: a },
  ]);
  edges.sort((a, b) => a.from - b.from || a.to - b.to);
  const g = allocateGraph(positions.length, edges.length);
  positions.forEach((p, i) => g.feet.set(p, i * 3));
  g.usable.fill(1);
  edges.forEach((e, l) => {
    g.first[e.from + 1]!++;
    g.source[l] = e.from;
    g.target[l] = e.to;
    g.kind[l] = LINK_KINDS.WALK;
    g.status[l] = LINK_STATUS.VALID;
    const [a, b] = [positions[e.from]!, positions[e.to]!];
    g.cost[l] = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) / RUN_SPEED;
    g.requires[l] = ABILITIES.WALK;
  });
  for (let i = 0; i < positions.length; i++) {
    g.first[i + 1]! += g.first[i]!;
  }
  return new NavGraph(g, navFile(positions.map((at) => ({ at }))));
}

const planner = (graph: NavGraph) => new NavPlanner(graph, new NavMatchState(graph));

const at = (p: [number, number, number]): Vec3 => ({ x: p[0], y: p[1], z: p[2] });

interface Someone {
  id: string;
  team?: string;
  feet: Vec3;
  alive?: boolean;
  bot?: boolean;
}

/** What a brain sees of these players, over this planner. */
function contextOf(nav: NavPlanner, people: Someone[], now = 0): BrainContext {
  const views: PlayerView[] = people.map((p) => ({ id: p.id, team: p.team, bot: p.bot ?? false, points: 0 }));
  return {
    now,
    seed: 7,
    players: views,
    player: (id: string) => views.find((v) => v.id === id),
    state: (id: string): PlayerStateView | undefined => {
      const p = people.find((q) => q.id === id);
      return p && { feet: { ...p.feet }, yaw: 0, alive: p.alive ?? true, health: 100, team: p.team };
    },
    nav,
  } as unknown as BrainContext;
}

/** Ask seek-nearest once, as bot `me` standing at `feet`. */
function seek(nav: NavPlanner, people: Someone[], objective: Objective = { kind: "hunt" }): Goal {
  const me = people.find((p) => p.id === "me")!;
  const self = {
    id: "me",
    index: 1,
    team: me.team,
    objective,
    movement: createMovement(me.feet, 0, 0),
    motor: new Motor(),
  };
  const memory = seekNearest.init(self, () => 0, {});
  return seekNearest.think(contextOf(nav, people), self, memory);
}

/**
 * A line of five nodes 4 m apart along -Z, and two more off to the side that
 * nothing links: a player standing by one is near and unreachable.
 */
const LINE: [number, number, number][] = [
  [0, 0, 0],
  [0, 0, -4],
  [0, 0, -8],
  [0, 0, -12],
  [0, 0, -16],
  [3, 0, 0],
  [3, 0, -4],
];
const lineGraph = () =>
  graphOf(LINE, [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 4],
  ]);

/** Ask the zombie brain once, as `me` (no side, as an actor has none) with these params. */
function zombieThinks(nav: NavPlanner, people: Someone[], params: Record<string, number | boolean> = {}, objective: Objective = { kind: "none" }): Goal {
  const me = people.find((p) => p.id === "me")!;
  const self = { id: "me", index: 1, team: undefined, objective, movement: createMovement(me.feet, 0, 0), motor: new Motor() };
  return zombie.think(
    contextOf(
      nav,
      people.filter((p) => p !== me),
    ),
    self,
    zombie.init(self, () => 0, params),
  );
}

describe("zombie", () => {
  it("attacks the nearest quarry within its reach, on its floor", () => {
    const nav = planner(lineGraph());
    const me = { id: "me", feet: { x: 0, y: 0, z: -4 } };
    expect(zombieThinks(nav, [me, { id: "p", feet: { x: 0.8, y: 0, z: -4 } }, { id: "q", feet: { x: 0, y: 0, z: -4.5 } }])).toEqual({
      kind: "attack",
      target: "q",
    });
    // Out of reach: a chase that stops inside it.
    const chase = zombieThinks(nav, [me, { id: "p", feet: { x: 0, y: 0, z: -12 } }]);
    expect(chase).toMatchObject({ kind: "moveTo", track: "p", run: true });
    expect((chase as { arrive: number }).arrive).toBeLessThan(1);
    // Within reach across, but a floor up: chased, not hit.
    expect(zombieThinks(nav, [me, { id: "p", feet: { x: 0, y: 3, z: -4.5 } }]).kind).not.toBe("attack");
    // Dead is nobody.
    expect(zombieThinks(nav, [me, { id: "p", feet: { x: 0, y: 0, z: -4.5 }, alive: false }])).toEqual({ kind: "idle" });
  });

  it("takes its reach and its gait from the params its actor is spawned with", () => {
    const nav = planner(lineGraph());
    const me = { id: "me", feet: { x: 0, y: 0, z: -4 } };
    const two = { id: "p", feet: { x: 0, y: 0, z: -5.8 } };
    expect(zombieThinks(nav, [me, two]).kind).toBe("moveTo");
    expect(zombieThinks(nav, [me, two], { reach: 2 })).toEqual({ kind: "attack", target: "p" });
    expect(zombieThinks(nav, [me, { id: "p", feet: { x: 0, y: 0, z: -12 } }], { run: false })).toMatchObject({ run: false });
  });

  it("goes where it is sent before it hunts", () => {
    const nav = planner(lineGraph());
    const goal = zombieThinks(
      nav,
      [
        { id: "me", feet: { x: 0, y: 0, z: -4 } },
        { id: "p", feet: { x: 0, y: 0, z: -4.5 } },
      ],
      {},
      { kind: "goto", point: { x: 0, y: 0, z: -16 } },
    );
    expect(goal).toMatchObject({ kind: "moveTo", point: { x: 0, y: 0, z: -16 } });
    expect(brainFor(ZOMBIE)).toBe(zombie);
  });
});

describe("seek-nearest", () => {
  it("chases the nearest opponent it can reach, tracking their feet", () => {
    const nav = planner(lineGraph());
    const goal = seek(nav, [
      { id: "me", team: "horde", feet: at(LINE[0]!) },
      { id: "far", team: "survivors", feet: at(LINE[4]!) },
      { id: "near", team: "survivors", feet: at(LINE[2]!) },
    ]);
    expect(goal).toMatchObject({ kind: "moveTo", track: "near", arrive: SEEK_ARRIVE, run: true, point: at(LINE[2]!) });
    expect(goal.kind === "moveTo" && goal.route?.end).toBe(2);
  });

  it("passes over the nearest when there is no path to them, for the next", () => {
    const nav = planner(lineGraph());
    const goal = seek(nav, [
      { id: "me", team: "horde", feet: at(LINE[0]!) },
      { id: "cut-off", team: "survivors", feet: at(LINE[5]!) },
      { id: "also", team: "survivors", feet: at(LINE[6]!) },
      { id: "reachable", team: "survivors", feet: at(LINE[3]!) },
    ]);
    expect(goal).toMatchObject({ kind: "moveTo", track: "reachable" });
  });

  it("tries only the three nearest, and stands when none of them can be reached", () => {
    const nav = planner(lineGraph());
    const people: Someone[] = [
      { id: "me", team: "horde", feet: at(LINE[0]!) },
      { id: "a", team: "survivors", feet: at(LINE[5]!) },
      { id: "b", team: "survivors", feet: at(LINE[6]!) },
      { id: "c", team: "survivors", feet: { x: 3, y: 0, z: -5 } },
      { id: "d", team: "survivors", feet: at(LINE[4]!) },
    ];
    expect(seek(nav, people)).toEqual({ kind: "idle" });
    // Nobody at all is the same answer.
    expect(seek(nav, [people[0]!])).toEqual({ kind: "idle" });
  });

  it("hunts nobody on its own side, and nobody dead", () => {
    const nav = planner(lineGraph());
    const goal = seek(nav, [
      { id: "me", team: "horde", feet: at(LINE[0]!) },
      { id: "friend", team: "horde", feet: at(LINE[1]!) },
      { id: "corpse", team: "survivors", feet: at(LINE[2]!), alive: false },
      { id: "quarry", team: "survivors", feet: at(LINE[3]!) },
    ]);
    expect(goal).toMatchObject({ kind: "moveTo", track: "quarry" });
  });

  it("hunts only the targets it was given", () => {
    const nav = planner(lineGraph());
    const goal = seek(
      nav,
      [
        { id: "me", team: "horde", feet: at(LINE[0]!) },
        { id: "near", team: "survivors", feet: at(LINE[1]!) },
        { id: "named", team: "survivors", feet: at(LINE[4]!) },
      ],
      { kind: "hunt", targets: ["named"] },
    );
    expect(goal).toMatchObject({ kind: "moveTo", track: "named" });
  });

  it("goes where it is sent, to a point or a node, and stands where there is no way there", () => {
    const nav = planner(lineGraph());
    const people = [{ id: "me", feet: at(LINE[0]!) }];
    expect(seek(nav, people, { kind: "goto", point: at(LINE[3]!) })).toMatchObject({ kind: "moveTo", point: at(LINE[3]!) });
    expect(seek(nav, people, { kind: "goto", node: 4 })).toMatchObject({ kind: "moveTo", point: at(LINE[4]!) });
    expect(seek(nav, people, { kind: "goto", point: at(LINE[6]!) })).toEqual({ kind: "idle" });
  });

  it("gives up for a while on a quarry the motor could not reach", () => {
    const nav = planner(lineGraph());
    const people: Someone[] = [
      { id: "me", team: "horde", feet: at(LINE[0]!) },
      { id: "near", team: "survivors", feet: at(LINE[1]!) },
      { id: "far", team: "survivors", feet: at(LINE[4]!) },
    ];
    const motor = new Motor();
    const self = { id: "me", index: 1, team: "horde", objective: { kind: "hunt" } as Objective, movement: createMovement(people[0]!.feet, 0, 0), motor };
    const memory = seekNearest.init(self, () => 0, {});
    expect(seekNearest.think(contextOf(nav, people, 0), self, memory)).toMatchObject({ track: "near" });
    motor.status = "stuck";
    expect(seekNearest.think(contextOf(nav, people, 0.5), self, memory)).toMatchObject({ track: "far" });
    motor.status = "moving";
    expect(seekNearest.think(contextOf(nav, people, 1), self, memory)).toMatchObject({ track: "far" });
    expect(seekNearest.think(contextOf(nav, people, 4), self, memory)).toMatchObject({ track: "near" });
  });

  it("is in the table under its own name", () => {
    expect(brainFor("seek-nearest")).toBe(seekNearest);
    expect(brainFor("toString")).toBeUndefined();
    for (const [id, brain] of Object.entries(BRAINS)) {
      expect(brain.id).toBe(id);
    }
  });
});

/** A bot on a real floor, driven by `driver`, among people who stand still. */
class Sim {
  readonly m: MovementState;
  readonly nav: NavPlanner;
  tick = 0;
  ordered = 0;
  objective: Objective = { kind: "none" };
  readonly trail: Vec3[] = [];
  private readonly world;

  constructor(
    readonly driver: BotDriver,
    graph: NavGraph,
    boxes: Box[],
    start: Vec3,
    readonly people: Someone[],
  ) {
    this.world = boxWorld([FLOOR, ...boxes]);
    this.nav = planner(graph);
    this.m = createMovement(start, 0, 0);
    this.m.grounded = true;
  }

  step(ticks = 1): void {
    for (let i = 0; i < ticks; i++) {
      this.tick++;
      const everyone = [{ id: "#b1", team: "horde", feet: this.m.feet, bot: true }, ...this.people];
      const turn: BotTurn = {
        id: "#b1",
        index: 1,
        tick: this.tick,
        dt: DT,
        movement: this.m,
        alive: true,
        nav: this.nav,
        ordered: this.ordered,
        objective: () => this.objective,
        context: () => contextOf(this.nav, everyone, this.tick * DT),
        feetOf: (id) => everyone.find((p) => p.id === id)?.feet,
      };
      const input = idleInput(this.m.yaw, this.m.pitch);
      this.driver.think(turn, input);
      stepMovement(this.m, input, DT, this.world, true);
      this.trail.push({ ...this.m.feet });
    }
  }

  order(objective: Objective): void {
    this.objective = objective;
    this.ordered++;
  }
}

const horizontal = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.z - b.z);

describe("a bot driven by a brain", () => {
  it("runs down its quarry and stops short, facing them", () => {
    const sim = new Sim(new BotDriver(seekNearest), lineGraph(), [], at(LINE[0]!), [{ id: "p", team: "survivors", feet: { x: 0.5, y: 0, z: -15 } }]);
    sim.step(6 * 60);
    const d = horizontal(sim.m.feet, sim.people[0]!.feet);
    expect(d).toBeLessThanOrEqual(SEEK_ARRIVE + 0.1);
    expect(d).toBeGreaterThan(0.4);
    expect(sim.driver.motor.status).toBe("arrived");
    // Facing them: the player faces (-sin yaw, -cos yaw).
    const toward = Math.atan2(-(0.5 - sim.m.feet.x), -(-15 - sim.m.feet.z));
    expect(Math.abs(Math.atan2(Math.sin(sim.m.yaw - toward), Math.cos(sim.m.yaw - toward)))).toBeLessThan(0.05);
  });

  it("follows a quarry that moves, rather than calling it stuck", () => {
    const quarry = { id: "p", team: "survivors", feet: { x: 0, y: 0, z: -16 } };
    const sim = new Sim(new BotDriver(seekNearest), lineGraph(), [], at(LINE[0]!), [quarry]);
    sim.step(60);
    // Walks back up the line, towards the bot, slower than it runs.
    for (let i = 0; i < 4 * 60 && quarry.feet.z < -6; i++) {
      quarry.feet = { ...quarry.feet, z: quarry.feet.z + 0.03 };
      sim.step();
      expect(sim.driver.motor.status === "stuck" || sim.driver.motor.status === "noPath").toBe(false);
    }
    sim.step(60);
    expect(horizontal(sim.m.feet, quarry.feet)).toBeLessThanOrEqual(SEEK_ARRIVE + 0.1);
  });

  it("stands still when it can reach nobody", () => {
    const sim = new Sim(new BotDriver(seekNearest), lineGraph(), [], at(LINE[0]!), [{ id: "p", team: "survivors", feet: at(LINE[6]!) }]);
    sim.step(3 * 60);
    expect(horizontal(sim.m.feet, at(LINE[0]!))).toBeLessThan(0.01);
    expect(sim.driver.motor.status).toBe("idle");
  });

  it("thinks every half second, at once on an order, and does what it is told", () => {
    const driver = new BotDriver(seekNearest);
    const sim = new Sim(driver, lineGraph(), [], at(LINE[0]!), []);
    sim.step(2 * 60);
    // Once on arrival, then every SEEK_PERIOD: at 60 Hz, ticks 1, 29, 59, 89, 119.
    expect(driver.thinks).toBe(1 + Math.floor((2 * 60 + 1) / (SEEK_PERIOD * 60)));
    const before = driver.thinks;
    sim.order({ kind: "goto", point: at(LINE[3]!) });
    sim.step();
    expect(driver.thinks).toBe(before + 1);
    expect(driver.objective).toEqual({ kind: "goto", point: at(LINE[3]!) });
    sim.step(4 * 60);
    expect(horizontal(sim.m.feet, at(LINE[3]!))).toBeLessThanOrEqual(0.4);

    sim.order({ kind: "goto", node: 1 });
    sim.step(3 * 60);
    expect(horizontal(sim.m.feet, at(LINE[1]!))).toBeLessThanOrEqual(0.4);
  });

  it("shuts a link it gets stuck on for the match, and goes round", () => {
    // 0 → 1 → 2 straight down -Z, with a wall across 1 → 2 the graph was never
    // told about; 0 → 3 → 2 swings out to the side and is clear, and longer.
    const feet: [number, number, number][] = [
      [0, 0, 0],
      [0, 0, -4],
      [0, 0, -8],
      [4.5, 0, -4],
    ];
    const graph = graphOf(feet, [
      [0, 1],
      [1, 2],
      [0, 3],
      [3, 2],
    ]);
    const wall: Box = { size: [2, 3, 0.4], at: [0, 1.5, -6] };
    const sim = new Sim(new BotDriver(seekNearest), graph, [wall], at(feet[0]!), []);
    sim.order({ kind: "goto", point: at(feet[2]!) });
    sim.step(10 * 60);
    expect(horizontal(sim.m.feet, at(feet[2]!))).toBeLessThanOrEqual(0.4);
    const across = [...Array(graph.linkCount).keys()].find((l) => graph.source[l] === 1 && graph.target[l] === 2)!;
    expect(sim.nav.state.blocked[across]).toBe(1);
    // Went round: somewhere on the way it was well out to the side.
    expect(Math.max(...sim.trail.map((p) => p.x))).toBeGreaterThan(3);
  });

  it("walks back to its path's start when the straight line onto the graph is a wall, and blames the link it finds shut from there", () => {
    // It stands in a pocket open to +Z. Node 0 is outside the mouth and nearest;
    // 0 → 1 runs straight through the pocket's back wall, which the graph was
    // never told; 0 → 2 → 3 → 1 goes round. The straight line from the pocket to
    // node 1 is pinned against that wall head on, so no slide gets it anywhere.
    const feet: [number, number, number][] = [
      [0, 0, 3],
      [0, 0, -5],
      [4, 0, 3],
      [4, 0, -5],
    ];
    const graph = graphOf(feet, [
      [0, 1],
      [0, 2],
      [2, 3],
      [3, 1],
    ]);
    const pocket: Box[] = [
      { size: [3.4, 3, 0.4], at: [0, 1.5, -1.2] },
      { size: [0.4, 3, 3.2], at: [-1.5, 1.5, 0.2] },
      { size: [0.4, 3, 3.2], at: [1.5, 1.5, 0.2] },
    ];
    const sim = new Sim(new BotDriver(seekNearest), graph, pocket, { x: 0, y: 0, z: 0 }, []);
    const direct = [...Array(graph.linkCount).keys()].find((l) => graph.source[l] === 0 && graph.target[l] === 1)!;
    // Planned from its own feet, the route starts at node 0 and goes straight through.
    expect(sim.nav.route(sim.m.feet, at(feet[1]!))?.links).toEqual([direct]);
    sim.order({ kind: "goto", point: at(feet[1]!) });
    sim.step(20 * 60);
    expect(horizontal(sim.m.feet, at(feet[1]!))).toBeLessThanOrEqual(0.4);
    // Out of the pocket to node 0 first, then 0 → 1 tried from its start, shut, and gone round.
    expect(Math.min(...sim.trail.map((p) => horizontal(p, at(feet[0]!))))).toBeLessThan(0.5);
    expect(sim.nav.state.blocked[direct]).toBe(1);
    expect(Math.max(...sim.trail.map((p) => p.x))).toBeGreaterThan(3);
  });

  it("keeps the link it is on when a quarry on the move changes its path, rather than turning back and forth", () => {
    // Round a pillar to either of two far nodes side by side: 0 → 1 → 2 to the
    // east, 0 → 3 → 4 to the west, 2 — 4 across. A quarry swaying between them
    // changes which is nearest, and so which side is the shorter way, twice a second.
    const feet: [number, number, number][] = [
      [0, 0, 0],
      [7, 0, -7],
      [1.5, 0, -14],
      [-7, 0, -7],
      [-1.5, 0, -14],
    ];
    const graph = graphOf(feet, [
      [0, 1],
      [1, 2],
      [0, 3],
      [3, 4],
      [2, 4],
    ]);
    const quarry = { id: "p", team: "survivors", feet: { x: 1.5, y: 0, z: -14.5 } };
    const sim = new Sim(new BotDriver(seekNearest), graph, [{ size: [8, 3, 8], at: [0, 1.5, -7] }], at(feet[0]!), [quarry]);
    for (let i = 0; i < 2 * 60; i++) {
      quarry.feet = { ...quarry.feet, x: Math.floor(i / 30) % 2 === 0 ? 1.5 : -1.5 };
      sim.step();
    }
    // Two seconds at a run is most of the way to a side node; turning back and
    // forth at the start, it would still be by node 0.
    expect(horizontal(sim.m.feet, at(feet[0]!))).toBeGreaterThan(6);
  });

  it("plays out the same way twice", () => {
    const run = () => {
      const sim = new Sim(new BotDriver(seekNearest), lineGraph(), [], at(LINE[0]!), [
        { id: "a", team: "survivors", feet: { x: 0.3, y: 0, z: -9 } },
        { id: "b", team: "survivors", feet: { x: -0.2, y: 0, z: -9 } },
      ]);
      sim.step(4 * 60);
      return sim.trail;
    };
    expect(run()).toEqual(run());
  });

  it("hands each bot its own random stream, the same every run", () => {
    const draws: Record<string, number[]> = {};
    const brain = defineBrain<null>({
      id: "dice",
      init: (self, rng) => {
        draws[self.id] = [rng(), rng(), rng()];
        return null;
      },
      think: () => ({ kind: "idle" }),
    });
    const once = (id: string) => {
      const sim = new Sim(new BotDriver(brain), lineGraph(), [], at(LINE[0]!), []);
      const turn = { id, index: 1, tick: 1, dt: DT, movement: sim.m, alive: true, nav: sim.nav, ordered: 0 };
      new BotDriver(brain).think(
        { ...turn, objective: () => ({ kind: "none" }), context: () => contextOf(sim.nav, []), feetOf: () => undefined },
        idleInput(0, 0),
      );
      return draws[id]!;
    };
    const a = once("#b1");
    expect(once("#b1")).toEqual(a);
    expect(once("#b2")).not.toEqual(a);
  });
});
