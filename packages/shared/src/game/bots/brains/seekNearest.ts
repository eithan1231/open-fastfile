// The first brain: chase the nearest opponent it can reach.
//
// A zombie's, and nothing more — it never fires, so it deals no damage; what it
// does is arrive. Twice a second it lists the living players it is hunting,
// nearest first in a straight line, and asks the graph for a path to each of the
// first few in turn; the first it can reach is its quarry, and the motor tracks
// their feet between thinks and walks the last leg straight to them. With nobody
// reachable it stands where it is.
//
// A player the motor could not get to (`noPath`, or `stuck` short of them) is
// passed over for a few seconds, so one quarry on a ledge with no way up does not
// hold the whole horde at its foot.
//
// Every objective means something here, because a script may order any bot
// anything: `none` is its instinct (hunt everyone), `hunt` narrows who, `goto`
// and `hold` are places, and `follow` is a chase that stops a little way off.

import type { PlayerId } from "../../../net/messages/fields.js";
import type { Vec3 } from "../../../sim/capsule.js";
import type { PlayerStateView } from "../../context.js";
import { defineBrain, IDLE, type BotSelf, type BrainContext, type Goal } from "../brain.js";

export const SEEK_NEAREST = "seek-nearest";

/** Seconds between thinks. */
export const SEEK_PERIOD = 0.5;
/** How many of the nearest are tried for a path before it gives up, per think. */
export const SEEK_TRIES = 3;
/** It stops this close to its quarry, m, and faces them. */
export const SEEK_ARRIVE = 1.5;
/** A quarry the motor could not reach is passed over for this long, s. */
export const SEEK_GIVE_UP = 3;
/** `follow` keeps this far off, m. */
export const FOLLOW_DISTANCE = 2.5;

/** What a seeker remembers. Exported for the brains built on it (zombie.ts). */
export interface SeekMemory {
  /** Who it chased last, to hold it to account for what the motor said. */
  quarry: PlayerId | null;
  /** Passed over until this `ctx.now`, per player. */
  avoid: Map<PlayerId, number>;
}

/** How a chase is run: how close it stops, and whether it runs there. */
export interface Chase {
  readonly arrive: number;
  readonly run: boolean;
}

const SEEK_CHASE: Chase = { arrive: SEEK_ARRIVE, run: true };

export const seekNearest = defineBrain<SeekMemory>({
  id: SEEK_NEAREST,
  period: SEEK_PERIOD,
  init: () => ({ quarry: null, avoid: new Map() }),
  think: (ctx, self, memory) => seek(ctx, self, memory, SEEK_CHASE),
});

/**
 * The whole of the seeker's think, with the chase as a parameter: every
 * objective, and a quarry the motor could not reach passed over for a while.
 */
export function seek(ctx: BrainContext, self: BotSelf, memory: SeekMemory, chase: Chase): Goal {
  const status = self.motor.status;
  if (memory.quarry !== null && (status === "noPath" || status === "stuck")) {
    memory.avoid.set(memory.quarry, ctx.now + SEEK_GIVE_UP);
  }
  memory.quarry = null;

  const objective = self.objective;
  switch (objective.kind) {
    case "none":
      return hunt(ctx, self, memory, undefined, null, chase);
    case "hunt":
      return hunt(ctx, self, memory, objective.targets, null, chase);
    case "goto":
      return travel(ctx, self, "point" in objective ? objective.point : ctx.nav.nodeFeet(objective.node), chase.run);
    case "hold": {
      const { point, radius } = objective;
      if (horizontal(self.movement.feet, point) > radius) {
        return travel(ctx, self, point, chase.run, radius / 2);
      }
      // Inside its ground: whoever comes into it.
      return hunt(ctx, self, memory, undefined, { point, radius }, chase);
    }
    case "follow": {
      const leader = ctx.state(objective.id);
      if (!leader?.alive) {
        return IDLE;
      }
      const route = ctx.nav.route(self.movement.feet, leader.feet);
      return route ? { kind: "moveTo", point: leader.feet, run: chase.run, arrive: FOLLOW_DISTANCE, track: objective.id, route } : IDLE;
    }
  }
}

/**
 * The living players it is hunting, nearest first in a straight line: every
 * opponent, or `targets`, less the ones it is passing over, and within `within`
 * where that is given. Roster order, and a stable sort, so two at one distance go
 * in the order they joined.
 */
export function quarries(
  ctx: BrainContext,
  self: BotSelf,
  memory: SeekMemory,
  targets: readonly PlayerId[] | undefined,
  within: { point: Vec3; radius: number } | null,
): { id: PlayerId; state: PlayerStateView; distance: number }[] {
  const feet = self.movement.feet;
  const candidates: { id: PlayerId; state: PlayerStateView; distance: number }[] = [];
  // Roster order, and a stable sort: two at the same distance go in the order they joined.
  for (const player of ctx.players) {
    if (player.id === self.id || (targets ? !targets.includes(player.id) : isTeammate(self, player.team))) {
      continue;
    }
    const until = memory.avoid.get(player.id);
    if (until !== undefined && until > ctx.now) {
      continue;
    }
    const state = ctx.state(player.id);
    if (!state?.alive || (within && horizontal(state.feet, within.point) > within.radius)) {
      continue;
    }
    candidates.push({ id: player.id, state, distance: Math.hypot(state.feet.x - feet.x, state.feet.y - feet.y, state.feet.z - feet.z) });
  }
  return candidates.sort((a, b) => a.distance - b.distance);
}

/** The nearest reachable of the players it is hunting, as a chase; idle if none. */
function hunt(
  ctx: BrainContext,
  self: BotSelf,
  memory: SeekMemory,
  targets: readonly PlayerId[] | undefined,
  within: { point: Vec3; radius: number } | null,
  chase: Chase,
): Goal {
  const feet = self.movement.feet;
  for (const { id, state } of quarries(ctx, self, memory, targets, within).slice(0, SEEK_TRIES)) {
    const route = ctx.nav.route(feet, state.feet);
    if (route) {
      memory.quarry = id;
      return { kind: "moveTo", point: state.feet, run: chase.run, arrive: chase.arrive, track: id, route };
    }
  }
  return IDLE;
}

/** Go to a point and stay; idle where there is no way there. */
function travel(ctx: BrainContext, self: BotSelf, point: Vec3, run: boolean, arrive?: number): Goal {
  const route = ctx.nav.route(self.movement.feet, point);
  return route ? { kind: "moveTo", point, run, arrive, route } : IDLE;
}

/** On its side: the same team, where there are teams. In a free-for-all nobody is. */
function isTeammate(self: BotSelf, team: string | undefined): boolean {
  return self.team !== undefined && team === self.team;
}

function horizontal(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}
