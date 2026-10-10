// Who is in a match, and what a match keeps about each of them. A member is a
// simulated player plus the parts that hang off one: the inputs that drive it,
// its recent past, its class and, for a bot, what thinks for it.

import type { PlayerId } from "@3d/shared/net/messages/fields.js";
import type { PlayerSnapshot } from "@3d/shared/net/messages/snapshot.js";
import type { PlayerStateView, PlayerView } from "@3d/shared/game/context.js";
import type { GametypeDecl, TeamId } from "@3d/shared/game/gametypes/declaration.js";
import type { CapsuleWorld } from "@3d/shared/sim/capsule.js";
import type { Player } from "@3d/shared/sim/player.js";
import type { LoadedBody } from "../bodies.js";
import type { PlayerHistory } from "../history.js";
import { capsuleIn } from "../parts.js";
import type { BotState } from "./bots.js";
import type { ClassState } from "./classes.js";
import type { InputQueue } from "./inputs.js";

export interface Member {
  readonly id: PlayerId;
  /** Ours: the same input, re-simulated. This is the state a snapshot carries. */
  readonly player: Player;
  readonly inputs: InputQueue;
  /** What this player was doing, tick by tick, so a shot can be judged against it. */
  readonly history: PlayerHistory;
  /**
   * The newest tick whose snapshot has gone out to them.
   *
   * A client cannot have been drawing a tick it has not been sent, so this is the
   * ceiling on any moment it may ask us to rewind to — and asking for one past it
   * is the cheapest lie there is to catch.
   */
  sentTick: number;
  /**
   * Which engine they predict in, from their join. Reported beside the drift and
   * never acted on — see `JoinMessage.engine`.
   */
  readonly engine: string;
  /**
   * The match clock when they joined, which is what `PlayerView.since` carries.
   * A script with no state of its own derives its clock from this.
   */
  readonly since: number;
  /**
   * The body a bullet is traced against, or undefined where this instance cannot
   * build one (no catalogue, a hand-written world, a body that would not load).
   *
   * Resolved once, at join. Per shot would mean running the gametype's scripts
   * for every bullet, and a player must not change body mid-game in any case:
   * the browser dressed them once too.
   */
  readonly body: LoadedBody | undefined;
  /** Their class, and what scripts have said about their weapons. */
  readonly kit: ClassState;
  /** Set for a bot: what writes its input, since no client sends any. */
  readonly bot: BotState | undefined;
}

export class Roster {
  private readonly members = new Map<PlayerId, Member>();
  /** Members that are bots, so `humans` is a subtraction rather than a walk of the roster every tick. */
  private botCount = 0;

  constructor(private readonly gametype: GametypeDecl) {}

  /** Everyone in the match, bots included: everyone a snapshot carries. */
  get size(): number {
    return this.members.size;
  }

  /** The members who are people: a bot keeps no game alive and takes nobody's place. */
  get humans(): number {
    return this.members.size - this.botCount;
  }

  get bots(): number {
    return this.botCount;
  }

  get(id: PlayerId): Member | undefined {
    return this.members.get(id);
  }

  has(id: PlayerId): boolean {
    return this.members.has(id);
  }

  /** In the order they joined, which is the order everything per member runs in. */
  values(): IterableIterator<Member> {
    return this.members.values();
  }

  add(member: Member): void {
    this.members.set(member.id, member);
    if (member.bot) {
      this.botCount++;
    }
  }

  remove(id: PlayerId): void {
    if (this.members.get(id)?.bot) {
      this.botCount--;
    }
    this.members.delete(id);
  }

  ids(): PlayerId[] {
    return [...this.members.keys()];
  }

  botIds(): PlayerId[] {
    return [...this.members.values()].filter((member) => member.bot !== undefined).map((member) => member.id);
  }

  /**
   * Which side the next player joins: the smallest, and the earliest of those on a
   * tie.
   *
   * Deterministic on purpose, so a test can assert it and two runs of the same
   * joins produce the same sides. Null in a free-for-all, which is a gametype
   * declaring no `teams` — not the same thing as a gametype whose sides are full,
   * which cannot happen because the smallest side always has room.
   *
   * A script overrides it through `ServerContext.setTeam`; this is only the
   * default, the way `Spawns` is only the default placement.
   */
  sideFor(): number | null {
    const sides = this.gametype.teams;
    if (sides.length === 0) {
      return null;
    }
    const counts = sides.map(() => 0);
    for (const member of this.members.values()) {
      const side = member.player.side;
      if (side !== null && side < counts.length) {
        counts[side]!++;
      }
    }
    let best = 0;
    for (let i = 1; i < counts.length; i++) {
      if (counts[i]! < counts[best]!) {
        best = i;
      }
    }
    return best;
  }

  /** The side `team` names, or a throw: a gametype's `teams` is the whole vocabulary. */
  side(team: TeamId, who: string): number {
    const side = this.gametype.teams.indexOf(team);
    if (side < 0) {
      throw new Error(`${who} "${team}", which gametype "${this.gametype.id}" does not have`);
    }
    return side;
  }

  /**
   * Put a player on a side, as `ServerContext.setTeam` does. An unknown side
   * throws: quietly putting a misspelled side on index 0 would be a wrong answer
   * that looks like an ordinary assignment for the rest of the match.
   */
  setTeam(id: PlayerId, team: TeamId): void {
    const side = this.side(team, "a script put a player on");
    this.members.get(id)?.player.setTeam(side);
  }

  /** A player's side as the scripts name it, or undefined in a free-for-all. */
  teamOf(id: PlayerId): TeamId | undefined {
    const side = this.members.get(id)?.player.side;
    return side == null ? undefined : this.gametype.teams[side];
  }

  view(member: Member): PlayerView {
    return { id: member.id, team: this.teamOf(member.id), since: member.since, bot: member.bot !== undefined, points: member.player.points };
  }

  views(): PlayerView[] {
    return [...this.members.values()].map((member) => this.view(member));
  }

  /** Where a player is and how they are, as a script or a brain reads it. A copy: nothing written to it moves anybody. */
  stateOf(id: PlayerId): PlayerStateView | undefined {
    const member = this.members.get(id);
    if (!member) {
      return undefined;
    }
    const { feet, yaw } = member.player.movement;
    return { feet: { x: feet.x, y: feet.y, z: feet.z }, yaw, alive: !member.player.dead, health: member.player.health, team: this.teamOf(id) };
  }

  /** Whether a living member is standing inside `part`. */
  occupied(part: CapsuleWorld): boolean {
    for (const member of this.members.values()) {
      if (!member.player.dead && capsuleIn(part, member.player.movement.feet)) {
        return true;
      }
    }
    return false;
  }

  /** Everyone's state, as every snapshot of this tick carries it. */
  snapshot(): PlayerSnapshot[] {
    return [...this.members.values()].map((member) => ({ id: member.id, state: member.player.snapshot() }));
  }
}
