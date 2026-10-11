// Health: the one queue every hit is drained through, a player's or an actor's,
// what a death is worth and the body it leaves; and the tick of health itself —
// the dead counted down, the living regenerating, the fallen killed.

import type { PlayerId } from "@3d/shared/net/messages/fields.js";
import type { ActorId } from "@3d/shared/game/actors/actor.js";
import { isSuicide } from "@3d/shared/game/damage.js";
import type { DamageEvent, DamageVerdict } from "@3d/shared/game/hooks.js";
import { DEFAULT_COMBAT_RULES, type CombatRules } from "@3d/shared/game/rules.js";
import { poseFromRig } from "@3d/shared/rig/ragdollPose.js";
import type { Vec3 } from "@3d/shared/sim/capsule.js";
import type { HitLocation } from "@3d/shared/sim/hitLocations.js";
import type { MovementState } from "@3d/shared/sim/movement.js";
import { MAX_HEALTH } from "@3d/shared/sim/player.js";
import { bodyKnock, localKnock, RAGDOLL_SEGMENTS, SEGMENT_FOR_LOCATION } from "@3d/shared/sim/ragdollBones.js";
import type { Actors } from "../actors.js";
import { poseBody } from "../bodies.js";
import type { MatchClock } from "./clock.js";
import { KILL_FEED_REPEAT_SECONDS, type EventOutbox } from "./outbox.js";
import type { Member, Roster } from "./roster.js";
import type { Scores } from "./scores.js";
import type { ScriptHost } from "./scripts.js";

/**
 * Damage applications one drain may make before it is a script in a loop.
 *
 * A hook may damage somebody, and *their* death hook somebody else; that is the
 * point of a queue, and it terminates on its own because a dead player takes no
 * more damage. A cycle that does not terminate is a bug in a script, and it would
 * otherwise take this match's tick with it. Sixty-four is far more than a chain
 * of real deaths can be and far less than a loop needs to hurt.
 */
const MAX_DAMAGE_PER_DRAIN = 64;

/**
 * A hit on its way to somebody's health, plus what the *corpse* will need.
 *
 * `DamageEvent` is what a script sees and is deliberately about health alone. A
 * ragdoll needs the round itself — which way it was going, and how hard — and that
 * is known only where the shot was traced. So it rides along here rather than
 * being looked up again from something that no longer exists.
 */
export type PendingDamage = DamageEvent & {
  /** Unit, along the round that caused it. Absent for damage no bullet caused. */
  readonly along?: Vec3;
  /**
   * Past a script's say: no `playerDamage` verdict. What the world does when it
   * gives up on somebody — a player held under the kill plane whose death a
   * script refused would hang there for the rest of the match.
   */
  readonly certain?: boolean;
};

/** A hit on its way to an actor: the same queue as a player's, told apart by `kind`. */
export interface PendingActorDamage {
  readonly kind: "actor";
  readonly actor: ActorId;
  readonly amount: number;
  readonly by: PlayerId | null;
  readonly cause: DamageEvent["cause"];
  readonly location?: HitLocation;
  /** Past a script's say, as a player's fall out of the world is. */
  readonly certain?: boolean;
}

export class Damage {
  /** Damage asked for and not yet applied. See `hurt`: this drains, it does not recurse. */
  private readonly queue: (PendingDamage | PendingActorDamage)[] = [];
  private draining = false;
  /** What combat costs here. Asked of the scripts once, at match start, and fixed after. */
  private ruled: CombatRules = DEFAULT_COMBAT_RULES;
  /** Entity ids, 12 bits, counting up for the life of the match: a corpse is one. */
  private lastEntityId = 0;

  constructor(
    private readonly clock: MatchClock,
    private readonly roster: Roster,
    private readonly actors: Actors,
    private readonly scripts: ScriptHost,
    private readonly outbox: EventOutbox,
    private readonly scores: Scores,
    /** Put a dead member back, when their countdown runs out. */
    private readonly respawn: (member: Member) => void,
  ) {}

  get rules(): CombatRules {
    return this.ruled;
  }

  /**
   * Ask the gametype's scripts for the rules, once. The first with an opinion
   * wins, over the defaults. At match start, which for a match is the moment it
   * exists: the rules reach every client in `joined` and are read on every hit,
   * so there is no later point at which asking again would be safe. A full
   * health the wire cannot carry throws here, where the match is made, rather
   * than out of the first snapshot of somebody who has it.
   */
  askRules(): void {
    const wanted = this.scripts.first((hooks, ctx) => hooks.combatRules?.(ctx));
    const rules = wanted ? { ...DEFAULT_COMBAT_RULES, ...wanted } : DEFAULT_COMBAT_RULES;
    if (!Number.isInteger(rules.maxHealth) || rules.maxHealth < 1 || rules.maxHealth > MAX_HEALTH) {
      throw new Error(`a script's combatRules set maxHealth to ${rules.maxHealth}: it has to be a whole number from 1 to ${MAX_HEALTH}`);
    }
    this.ruled = rules;
  }

  /**
   * Take health off somebody — eventually.
   *
   * **A queue, never a stack.** The hit is pushed, and drained only by whichever
   * call is not already draining: a `playerDamage` hook that damages a second
   * player, whose `playerDeath` hook damages a third, is one loop here rather than
   * three frames of recursion. It is why a hook may damage freely without knowing
   * what it is being called from.
   */
  hurt(hit: PendingDamage | PendingActorDamage): void {
    this.queue.push(hit);
    if (this.draining) {
      return;
    }
    this.draining = true;
    try {
      for (let applied = 0; this.queue.length > 0; applied++) {
        if (applied >= MAX_DAMAGE_PER_DRAIN) {
          this.queue.length = 0;
          throw new Error(`a script's damage did not stop after ${MAX_DAMAGE_PER_DRAIN} applications`);
        }
        const next = this.queue.shift()!;
        if ("kind" in next) {
          this.applyToActor(next);
        } else {
          this.apply(next);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  /**
   * Everybody the last inputs carried past the kill plane dies of it: nobody's
   * doing, so a suicide, and past any script's say (`PendingDamage.certain`).
   * `Player.step` has already held them where they fell, on this end and on
   * theirs.
   */
  fallOut(): void {
    for (const member of this.roster.values()) {
      if (!member.player.dead && member.player.outOfWorld) {
        this.hurt({ id: member.id, amount: member.player.health, by: null, cause: "outOfWorld", certain: true });
      }
    }
  }

  /**
   * A tick of health: the dead counted down, the living regenerating.
   *
   * The delay is read **before** the clock advances, so "regeneration starts after
   * `regenDelay`" is a fact about one tick rather than about which side of an
   * increment it was asked on.
   */
  health(): void {
    const dt = this.clock.dt;
    for (const member of this.roster.values()) {
      const player = member.player;
      if (player.dead) {
        // Null: the gametype's own `respawn`, and never the clock's.
        if (this.ruled.respawnDelay !== null && player.countdown(dt)) {
          this.respawn(member);
        }
      } else {
        player.recover(dt, player.sinceDamage >= this.ruled.regenDelay ? this.ruled.regenRate : 0);
      }
    }
  }

  /**
   * One hit, all the way through: who is allowed to land it, what the scripts say
   * it costs, what it takes off, and what a death that follows is worth.
   */
  private apply(hit: PendingDamage): void {
    const member = this.roster.get(hit.id);
    // A body takes no more damage, which is also what makes `playerDeath` fire
    // exactly once: nothing can take the same player below zero twice.
    if (!member || member.player.dead || !this.mayHurt(hit.id, hit.by)) {
      return;
    }

    const verdict = hit.certain ? undefined : this.scripts.first((hooks, ctx) => hooks.playerDamage?.(ctx, hit));
    if (verdict?.ignore) {
      return;
    }
    const amount = verdict?.amount ?? hit.amount;
    // No delay at all where the gametype brings the dead back itself: `health`
    // does not count them down.
    if (!member.player.hurt(amount, this.ruled.respawnDelay ?? 0)) {
      return;
    }

    this.awardKill(hit.id, hit.by);
    // Before the hooks, so that a death a hook causes is announced after the one
    // that caused it: the ids are the order, and a feed reads top to bottom.
    this.outbox.push({ kind: "death", victim: hit.id, killer: hit.by, cause: hit.cause }, null, KILL_FEED_REPEAT_SECONDS);
    // Nobody is there to see a body fall out of the bottom of the world.
    if (hit.cause !== "outOfWorld") {
      this.announceCorpse(hit, member);
    }
    this.scripts.each((hooks, ctx) => hooks.playerDeath?.(ctx, hit.id, hit.by, hit.cause, hit.actor));
  }

  /**
   * One hit on an actor, all the way through: `actorDamage` has the last word on
   * what it costs, and `actorDeath` hears the death, once. Nothing is scored: what
   * an actor is worth is the gametype's to say.
   */
  private applyToActor(hit: PendingActorDamage): void {
    if (!this.actors.alive(hit.actor)) {
      return;
    }
    const verdict: DamageVerdict | undefined = hit.certain
      ? undefined
      : this.scripts.first((hooks, ctx) => hooks.actorDamage?.(ctx, hit.actor, hit.amount, hit.by, hit.location, hit.cause));
    if (verdict?.ignore || !this.actors.hurt(hit.actor, verdict?.amount ?? hit.amount, this.clock.tick)) {
      return;
    }
    this.scripts.each((hooks, ctx) => hooks.actorDeath?.(ctx, hit.actor, hit.by, hit.cause, hit.location));
  }

  /**
   * Whether `by` may take health off `id`.
   *
   * Only a **teammate** is stopped. A player may always hurt themselves — their
   * own grenade is the usual way, and a rule that stopped it would make a
   * gametype's own kill volume unusable too — and `by` being null is the world
   * rather than a person. In a free-for-all nobody has a side, so nobody is a
   * teammate.
   */
  private mayHurt(id: PlayerId, by: PlayerId | null): boolean {
    if (this.ruled.friendlyFire || by === null || by === id) {
      return true;
    }
    const shooter = this.roster.get(by)?.player.side ?? null;
    return shooter === null || shooter !== (this.roster.get(id)?.player.side ?? null);
  }

  /**
   * A point to whoever earned it.
   *
   * Not a suicide and not a teamkill: neither is a kill, and a mode with friendly
   * fire on would otherwise reward one. A free-for-all scores nothing at all,
   * because a score is keyed by side and a free-for-all has none.
   *
   * The two refusals overlap today: somebody is always on their own side, so the
   * teamkill test already refuses every suicide. The first clause is written
   * anyway, because it is the reason — and because the day a free-for-all keeps a
   * score, it is the only one left.
   */
  private awardKill(victim: PlayerId, killer: PlayerId | null): void {
    if (killer === null || isSuicide(victim, killer)) {
      return;
    }
    const side = this.roster.teamOf(killer);
    if (side === undefined || side === this.roster.teamOf(victim)) {
      return;
    }
    this.scores.score(side, 1);
  }

  /**
   * Describe the body this death left behind, for every client to build.
   *
   * **The pose is what makes this worth sending.** Every end runs the same
   * simulation, so the only thing that has to travel is where the body started —
   * but it has to travel exactly, and the pose cannot be recomputed at the far end
   * to the precision a rigid-body sim needs (net/messages/entities.ts says why).
   *
   * The impulse is the round's own: `direction * impulseFor(amount)`, at the
   * segment the hit location names. A death no bullet caused pushes nothing, and
   * the body simply falls.
   *
   * Silent where this instance has no body for the player — a hand-written world,
   * a missing catalogue — which is the same condition that already means it cannot
   * trace a bullet against them.
   */
  private announceCorpse(hit: PendingDamage, member: Member): void {
    const body = member.body;
    if (!body) {
      return;
    }
    // Posed exactly as a shot poses it, because a corpse that starts anywhere
    // other than where the body was drawn is a body that jumps as it dies.
    const movement = member.player.movement as MovementState;
    poseBody(body, movement, member.player.weapon?.data ?? null);
    const pose = poseFromRig(body.rig);
    if (!pose) {
      return; // not a body with a skeleton to fall over; the death still stands
    }

    // A round does two things and they travel as two fields — see `bodyKnock` and
    // `localKnock`. The **body** knock carries the whole corpse along the round,
    // and is sent apart from the victim's own velocity because the far end shares
    // the two out differently: momentum to every segment equally, knock weighted by
    // height so the body topples about its feet. The **local** knock stays an
    // impulse at the bone that was hit, which is the snap on top.
    const segment = hit.location ? SEGMENT_FOR_LOCATION[hit.location] : "chest";
    const along = hit.along;
    const carry = along ? bodyKnock(hit.amount) : 0;
    const push = along ? localKnock(hit.amount, segment) : 0;

    this.outbox.push(
      {
        kind: "spawn",
        entity: (this.lastEntityId = (this.lastEntityId + 1) & 0xfff),
        what: "ragdoll",
        tick: this.clock.tick & 0xffff,
        ragdoll: {
          victim: hit.id,
          origin: pose[0]!.position,
          rotations: pose.map((at) => at.rotation),
          // A copy: this event is held and re-sent for half a second, and what it says must not move.
          velocity: { ...movement.velocity },
          knock: along ? { x: along.x * carry, y: along.y * carry, z: along.z * carry } : { x: 0, y: 0, z: 0 },
          segment: RAGDOLL_SEGMENTS.indexOf(segment),
          impulse: along ? { x: along.x * push, y: along.y * push, z: along.z * push } : { x: 0, y: 0, z: 0 },
        },
      },
      null,
      KILL_FEED_REPEAT_SECONDS,
    );
  }
}
