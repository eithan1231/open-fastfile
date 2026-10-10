// The rounds a tick's replay fired: which way each went, what it met — the map,
// a player as the shooter saw them, or an actor — and what it cost them.

import type { PlayerId } from "@3d/shared/net/messages/fields.js";
import type { InputMessage } from "@3d/shared/net/messages/input.js";
import type { ActorId } from "@3d/shared/game/actors/actor.js";
import { shotDamage, type CombatRules } from "@3d/shared/game/rules.js";
import { couldHit, POSE_MARGIN } from "@3d/shared/rig/hitboxes.js";
import type { CapsuleWorld, RayHit, Vec3 } from "@3d/shared/sim/capsule.js";
import type { HitLocation } from "@3d/shared/sim/hitLocations.js";
import { createMovement, EYE_HEIGHT, HEIGHT, RADIUS, type MovementState } from "@3d/shared/sim/movement.js";
import { aimAngles, aimDirection, coneSample, shotSpread, shotStream, spreadDirection, type Aim, type ReadKick } from "@3d/shared/sim/recoil.js";
import { DEFAULT_SURFACE } from "@3d/shared/sim/surfaces.js";
import type { WeaponController } from "@3d/shared/sim/weapon.js";
import { BULLET_RANGE } from "@3d/shared/sim/weaponDef.js";
import type { Actors } from "../actors.js";
import { poseBody } from "../bodies.js";
import type { MatchClock } from "./clock.js";
import type { Damage } from "./damage.js";
import type { EventOutbox } from "./outbox.js";
import type { Rewinder, RewindTarget } from "./rewind.js";
import type { Member, Roster } from "./roster.js";

/**
 * A shot one tick's replay fired, and what it found.
 *
 * **No client ever sends one of these.** It exists because this server stepped
 * that client's own input through the same weapon state machine and the shot
 * counter advanced (`WeaponData.fired`), which is what makes rate of fire,
 * ammunition, burst discipline and reload gating unforgeable: there is nothing
 * to forge.
 */
export interface FiredShot {
  shooter: PlayerId;
  /** `WeaponData.fired` after this round left: which shot of this weapon's life it was. */
  ordinal: number;
  /** Where it came from and which way it went, for whoever has to draw or explain it. */
  from: Vec3;
  direction: Vec3;
  /** Null where the bullet reached its range without meeting anything. */
  result: ShotResult | null;
}

/** A shot that stopped on the map. */
export interface WorldShot {
  kind: "world";
  /** Metres from the shot's origin. */
  distance: number;
  normal: Vec3;
  /** Which clipmap tree answered, as `RayHit.kind` means it. */
  surface: "map" | "prop";
}

/** A shot that landed on somebody. Damage is the caller's: this says what was hit, not what it cost. */
export interface PlayerShot {
  kind: "player";
  id: PlayerId;
  /** The joint whose box the bullet entered. `location` is what a hit on it counts as. */
  bone: string;
  location: HitLocation;
  distance: number;
}

/** A shot that landed on an actor (actors.ts). */
export interface ActorShot {
  kind: "actor";
  id: ActorId;
  /** The joint whose box it entered, or "" for a kind shot as its capsule. */
  bone: string;
  location: HitLocation;
  distance: number;
}

/** What a shot found. Null is a shot that reached its range without meeting anything. */
export type ShotResult = WorldShot | PlayerShot | ActorShot;

/** How hot a weapon was before the step that fired: the cone's width comes from it. */
export interface Heat {
  spread: number;
  ads: number;
}

export class Shots {
  /** Every shot this tick's replay fired, in the order they left. Cleared at the top of each tick. */
  readonly fired: FiredShot[] = [];
  /**
   * One shot's scratch: where a player was, what the map answered, and the far end
   * of the segment. A burst of pellets allocates its answers and nothing else.
   */
  private readonly rewound: MovementState = createMovement({ x: 0, y: 0, z: 0 }, 0, 0);
  private readonly mapHit: RayHit = { distance: 0, normal: { x: 0, y: 0, z: 0 }, kind: "map", surface: DEFAULT_SURFACE };
  private readonly shotEnd: Vec3 = { x: 0, y: 0, z: 0 };
  /** Where a shot leaves along, refilled per round: the shooter's intent plus the kick. */
  private readonly shotAim: Aim = { yaw: 0, pitch: 0 };
  private readonly shotDirection: Vec3 = { x: 0, y: 0, z: 0 };
  /** Where in this round's cone it goes, refilled per round (sim/recoil.ts). */
  private readonly shotCone = { angle: 0, radius: 0 };

  constructor(
    private readonly clock: MatchClock,
    private readonly collision: CapsuleWorld,
    private readonly roster: Roster,
    private readonly actors: Actors,
    private readonly rewinder: Rewinder,
    private readonly damage: Damage,
    private readonly outbox: EventOutbox,
    private readonly rules: () => CombatRules,
  ) {}

  clear(): void {
    this.fired.length = 0;
  }

  /**
   * The shots the replay of `message` fired, traced, recorded and paid for: the
   * damage is queued as each round is traced, so a target killed by the first
   * round of a burst does not take the rest of it.
   *
   * `weapon` is the controller that was held *before* the step. A swap that
   * completed inside it hands back a different one, counting from its own
   * total: subtracting across the two would invent a burst out of nothing, or
   * 65535 of them. Neither weapon can have fired on such a step — the one going
   * away is `dropping` and the one arriving is `raising` — so identity is the
   * whole check, and the same check covers a respawn that rebuilt the weapon.
   *
   * `kick` is the view kick as it stood *before* the step. A step that fired more
   * than one round — a sprint cut short by the trigger, on a weapon whose
   * `fireTime` is 0 — traces all of them along it: they left within one step of
   * each other, and it is the last aim their shooter saw.
   */
  fire(member: Member, weapon: WeaponController | undefined, before: number, kick: ReadKick | null, heat: Heat | null, message: InputMessage): void {
    const held = member.player.weapon;
    if (held === undefined || held !== weapon) {
      return;
    }
    // Wrap-safe: `fired` is a uint16 on both ends, and the difference is the
    // count however many times it has been round.
    const count = (held.data.fired - before) & 0xffff;
    if (count === 0) {
      return;
    }

    // Where they ended the step, not where they started it: a client turns and
    // fires on one input, and `roundInput` means both ends turned by the same
    // quantized amount before stepping.
    //
    // Their intent **plus the view kick they had already taken** — the aim's own
    // recoil, not the gun's, which rocks the model and decides nothing. It is the
    // half of the aim this server owns outright: it cannot reproduce a mouse, so
    // it takes the client's word for where they were looking and bounds it, while
    // the kick is its own arithmetic off a seed derived from the player's id and
    // the shot's own ordinal. A client that sent a finished aim could hide a kick
    // it never took — so it sends intent and nothing else.
    const shooter = member.id;
    const movement = member.player.movement;
    const { feet } = movement;
    const eye = { x: feet.x, y: feet.y + EYE_HEIGHT, z: feet.z };
    // Degrees wide, from how hot the weapon was before this step and how far into
    // the sights they had got. **This server decides it**: the width is the
    // weapon's own numbers, and where in it each round lands is drawn from the
    // same seeded stream the recoil is, so a client has nothing to send and
    // nothing to bend. It predicts the identical cone from the identical seed.
    const cone = heat ? shotSpread(held.def, heat.spread, heat.ads) : 0;
    for (let i = 0; i < count; i++) {
      const ordinal = (before + i + 1) & 0xffff;
      // Per round rather than per step: two rounds of a burst share an aim and
      // must not share a deviation.
      const aim = aimDirection(aimAngles(movement, kick, this.shotAim), this.shotDirection);
      spreadDirection(aim, cone, coneSample(shotStream(member.player.seed, ordinal), this.shotCone));
      const result = this.trace(shooter, eye, aim, BULLET_RANGE, message);
      this.fired.push({ shooter, ordinal, from: { ...eye }, direction: { ...aim }, result });
      if (result?.kind === "player") {
        // `held.def` rather than the entry's: it is the definition with this
        // player's attachments already merged into it (`resolveWeapon`), so a
        // silencer's damage penalty is in the number without being looked up
        // twice.
        const amount = shotDamage(held.def, result.location, result.distance, this.rules());
        const victim = this.roster.get(result.id);
        const was = victim?.player.health ?? 0;
        this.damage.hurt({ id: result.id, amount, by: shooter, cause: "bullet", location: result.location, along: { ...aim } });
        // **After** the damage, and only if it cost them something. A marker is
        // this server's answer about its own trace, so a round a teammate absorbs
        // with friendly fire off, or one a script ignored, or one that met a
        // location the weapon file scores at zero, draws nothing.
        if (victim && victim.player.health < was) {
          this.outbox.push({ kind: "hit", location: result.location, lethal: victim.player.dead }, shooter, 0);
        }
      } else if (result?.kind === "actor") {
        const amount = shotDamage(held.def, result.location, result.distance, this.rules());
        const was = this.actors.health(result.id);
        this.damage.hurt({ kind: "actor", actor: result.id, amount, by: shooter, cause: "bullet", location: result.location });
        // A marker only for a round that cost it something, as for a player.
        if (this.actors.health(result.id) < was) {
          this.outbox.push({ kind: "hit", location: result.location, lethal: !this.actors.alive(result.id) }, shooter, 0);
        }
      }
    }
  }

  /**
   * What a shot from `shooter` hits: nothing, the map, or somebody.
   *
   * `direction` is a unit vector and `range` the bullet's reach in metres;
   * `message` is the input the shot came with, whose `renderTick`/`renderFrac`
   * name the moment the shooter was drawing — every other player is judged there
   * rather than here, and the moment is worked out once for the whole shot.
   *
   * **The nearest of everything wins**, and the map is one of the candidates: a
   * bullet that meets a wall before reaching a body is a miss, and the two are
   * compared as fractions of one segment because a bone's box answers in those.
   * The map's own trace is the `"shots"` channel, which is not the geometry a
   * capsule walks into — `clip_player` over a window stops a player and not a
   * bullet.
   *
   * Applies no damage and records nothing. What was hit is the whole answer.
   */
  trace(shooter: PlayerId, from: Vec3, direction: Vec3, range: number, message: InputMessage): ShotResult | null {
    if (!(range > 0)) {
      return null;
    }
    const to = this.shotEnd;
    to.x = from.x + direction.x * range;
    to.y = from.y + direction.y * range;
    to.z = from.z + direction.z * range;
    const at = this.targetFor(shooter, message);

    // The map first, so a body behind a wall is rejected by a fraction rather than
    // by a second trace per player.
    const map = this.collision.traceRay(from, direction, range, "shots", this.mapHit);
    let nearest = map === null ? 1 : map.distance / range;
    let best: ShotResult | null = map === null ? null : { kind: "world", distance: map.distance, normal: { ...map.normal }, surface: map.kind };

    for (const member of this.roster.values()) {
      // Nobody shoots themselves: the origin is inside the shooter's own body, so
      // every one of their shots would stop on their own chest. A body waiting to
      // respawn is not there to be shot either — it would stop a round meant for
      // whoever is behind it.
      if (member.id === shooter || member.body === undefined || member.player.dead) {
        continue;
      }
      const rewound = this.rewinder.sample(member.history, at, this.rewound);
      if (rewound === null) {
        continue;
      }

      // The broad phase, against the capsule rather than a pose — posing is the
      // expensive half and almost nobody survives this. The capsule is dropped as
      // well as widened by `POSE_MARGIN`: a vaulting body hangs its legs below the
      // feet the simulation moves, and the boxes there are hittable.
      const feet = rewound.feet;
      const envelope = { x: feet.x, y: feet.y - POSE_MARGIN, z: feet.z };
      if (couldHit(from, to, envelope, RADIUS, HEIGHT + POSE_MARGIN, POSE_MARGIN) === null) {
        continue;
      }

      // The weapon in their hands now rather than the one they held at the moment
      // rewound to, which is what the client draws a peer with as well: the pose
      // needs a weapon's state and the history keeps only a `MovementState`.
      poseBody(member.body, rewound, member.player.weapon?.data ?? null);
      const hit = member.body.boxes.trace(from, to);
      if (hit !== null && hit.fraction < nearest) {
        nearest = hit.fraction;
        best = { kind: "player", id: member.id, bone: hit.bone, location: hit.location, distance: hit.fraction * range };
      }
    }
    if (this.actors.size > 0) {
      const actor = this.actors.trace(from, to, at, this.clock.tick, nearest);
      if (actor !== null) {
        best = { kind: "actor", id: actor.id, bone: actor.bone, location: actor.location, distance: actor.fraction * range };
      }
    }
    return best;
  }

  /** The moment `shooter` was drawing when they sent `message`: counted once, whoever it is judged against. */
  targetFor(shooter: PlayerId, message: InputMessage): RewindTarget {
    return this.rewinder.target(this.roster.get(shooter)?.sentTick ?? -1, message);
  }
}
