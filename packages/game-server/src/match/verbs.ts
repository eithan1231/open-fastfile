// The verbs a server hook is handed (`ServerContext`), each over the module that
// carries it out. The whole of what a script may change is this table.

import type { PlayerId } from "@3d/shared/net/messages/fields.js";
import type { WorldIndex } from "@3d/shared/worlds/worldIndex.js";
import type { Actors } from "../actors.js";
import type { MatchParts } from "../parts.js";
import type { MatchBots } from "./bots.js";
import type { Classes } from "./classes.js";
import type { ServerVerbs } from "./context.js";
import type { Damage } from "./damage.js";
import type { MatchNav } from "./nav.js";
import type { Announcements } from "./outbox.js";
import type { Member, Roster } from "./roster.js";
import type { Scores } from "./scores.js";
import type { Spawns } from "./spawns.js";
import type { Zones } from "./zones.js";

export interface VerbParts {
  readonly index: WorldIndex;
  readonly roster: Roster;
  readonly parts: MatchParts;
  readonly spawns: Spawns;
  readonly damage: Damage;
  readonly classes: Classes;
  readonly scores: Scores;
  readonly announcements: Announcements;
  readonly bots: MatchBots;
  readonly zones: Zones;
  readonly actors: Actors;
  readonly nav: MatchNav;
  /** `endMatch`: the first reason given stands. */
  end(reason: string): void;
}

export function serverVerbs(m: VerbParts): ServerVerbs {
  const { roster, classes, scores, nav, actors, damage } = m;
  /** Run `act` on a member, if `id` is one: a verb naming nobody does nothing. */
  const on = (id: PlayerId, act: (member: Member) => void): void => {
    const member = roster.get(id);
    if (member) {
      act(member);
    }
  };
  return {
    world: {
      ...m.index,
      setPresent: (tagOrName, present) => m.parts.request(tagOrName, present, (part) => roster.occupied(part)),
      isPresent: (tagOrName) => m.parts.isPresent(tagOrName),
    },
    setTeam: (id, team) => roster.setTeam(id, team),
    spawn: (id, at) => on(id, (member) => m.spawns.placeAt(member, at)),
    damage: (id, amount, by, cause = "script") => damage.hurt({ id, amount, by, cause }),
    arm: (id, weapons) => on(id, (member) => classes.armNow(member, weapons)),
    setLoadout: (id, weapons) => on(id, (member) => classes.force(member, weapons)),
    setClassChange: (id, timing) => on(id, (member) => void (member.kit.change = timing ?? undefined)),
    score: (team, delta) => scores.score(team, delta),
    points: (id) => roster.get(id)?.player.points ?? 0,
    addPoints: (id, delta) => scores.addPoints(id, delta),
    setCounter: (name, value) => scores.setCounter(name, value),
    respawn: (id) => {
      const member = roster.get(id);
      if (!member?.player.dead) {
        return false;
      }
      m.spawns.respawn(member);
      return true;
    },
    endMatch: (reason) => m.end(reason),
    publish: (event) => m.announcements.publish(event),
    // Throws rather than doing nothing, because it is not built and a silent
    // no-op would let a script believe it had been heard.
    send: (): never => {
      throw new Error("a script called send(), which is declared but not built");
    },
    bots: {
      add: (spec) => m.bots.addScripted(spec),
      remove: (id) => m.bots.remove(id),
      order: (id, objective) => m.bots.order(id, objective),
      ids: () => roster.botIds(),
    },
    state: (id) => roster.stateOf(id),
    zonesOf: (id) => m.zones.zonesOf(id),
    occupants: (tag) => m.zones.occupants(tag),
    actors: {
      spawn: (spec) => actors.spawn(spec),
      remove: (id) => actors.remove(id),
      order: (id, objective) => actors.order(id, objective),
      damage: (id, amount, by, cause = "script") => damage.hurt({ kind: "actor", actor: id, amount, by, cause }),
      ids: () => actors.ids(),
      state: (id) => actors.state(id),
    },
    nav: {
      get ready() {
        return nav.ready;
      },
      nearestNode: (point, maxDy) => nav.nearestNode(point, maxDy),
      addBlocker: (id, shape, blocked = true) => nav.addBlocker(id, shape, blocked),
      setBlocked: (id, blocked) => nav.setBlocked(id, blocked),
    },
  };
}
