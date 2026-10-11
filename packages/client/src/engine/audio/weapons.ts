// Playing what a weapon's own state says it did: a round leaving, a magazine
// changing, a bullet arriving, and somebody going down.
//
// The *deciding* is `@3d/shared/sim/weaponSounds.ts` — whether a round left,
// which notetrack the clip crossed, which alias that is — because it is a
// function of simulation state and both ends have to reach the same answer.
// This half is the browser's: which stream the clip and pitch are drawn from,
// whether it is played at the listener or out in the world, and the one thing
// only a client can do, which is trace the round it has just predicted to find
// out what it hit.
//
// **Your own rifle and everybody else's are different aliases and different
// paths**, as your boots and theirs are. `weap_m4carbine_fire_plr` goes through
// `playAtListener`: it is one of the 63 km non-positional rows the game writes
// for a weapon in your own hands, and the listener path makes that irrelevant
// rather than something to remember. `weap_m4carbine_fire_npc` goes through
// `playAt` at the shooter and is culled by its own 50.8 m — past which the only
// thing left is its `with` layer, `weap_medium_fardist_6`, which reaches 508 m.
// **That is the distant report, and it is data rather than a mechanism**: the
// tail is already a layer on the shot, `requests.ts` already gives a layer its
// own range, and nothing here swaps anything by distance.

import { hashString, seeded } from "@3d/shared/game/random.js";
import type { CapsuleWorld, RayHit, Vec3 } from "@3d/shared/sim/capsule.js";
import type { MovementState } from "@3d/shared/sim/movement.js";
import { eyeHeight } from "@3d/shared/sim/stance.js";
import { aimAngles, aimDirection, coneSample, shotSpread, shotStream, spreadDirection, type Aim } from "@3d/shared/sim/recoil.js";
import { DEFAULT_SURFACE, type SurfaceType } from "@3d/shared/sim/surfaces.js";
import type { WeaponData } from "@3d/shared/sim/weapon.js";
import { BULLET_RANGE, type WeaponDef } from "@3d/shared/sim/weaponDef.js";
import { impactAliases, WeaponWatcher, weaponStream } from "@3d/shared/sim/weaponSounds.js";
import type { AudioSystem } from "./system.js";

/**
 * The hit marker, which is the one feedback sound the bank has a name for.
 *
 * Feedback and not diegetic: it is not in the world, it must not attenuate and
 * it must not pan when the player turns their head — so `ui`, flat, through
 * `THREE.Audio` (docs/engine/audio.md#the-three-kinds-which-want-opposite-things).
 * The catalogue holds it because this asks for it by name; nothing else in the
 * game's announcement bank is raised by anything here yet, and a root nothing
 * asks for is how 161 MB of voiceover gets shipped.
 */
const HIT_ALERT = "mp_hit_alert";

/** The layers one round draws from its own stream, so a shot and its impact are not the same draw. */
const FIRE_LAYER = 0;
const IMPACT_LAYER = 1;
const NOTE_LAYER = 2;

/**
 * Where the surface probe under a fallen body starts, and how far down it looks.
 *
 * Above the feet for the reason `sim/footsteps.ts` gives: the resolver leaves a
 * body a millimetre clear of what it stands on, and a ray cast from inside a
 * triangle finds nothing.
 */
const PROBE_UP = 0.05;
const PROBE_DOWN = 0.5;

/**
 * A body arriving on the floor, which is what a death sounds like here.
 *
 * The bank has **no player death vocalisation at all** — every one of the 73
 * rows with `death` in the name is an announcer line, in six languages — so
 * this is the game's own answer rather than a stand-in: `bodyfall_<surface>_large`
 * is the weight of a body hitting what it fell on. Raised by the event rather
 * than by a ragdoll settling, because the event is the thing every client agrees
 * about.
 */
function bodyfallAlias(surface: SurfaceType): string {
  return `bodyfall_${surface}_large`;
}

/** The local player, narrowed to what a shot is derived from. `@3d/shared`'s `Player` satisfies it structurally. */
export interface SoundingShooter {
  readonly movement: Readonly<MovementState>;
  readonly weapon: { readonly def: WeaponDef; readonly data: Readonly<WeaponData> } | undefined;
  /** The stream this player's rounds are deviated by; the server uses the same one. */
  readonly seed: number;
}

/** One peer, as a snapshot describes them. Structural, so this stays clear of the wire's own types. */
export interface SoundingPeer {
  id: string;
  state: {
    dead: boolean;
    movement: Readonly<MovementState>;
    weaponIndex: number | null;
    attachments: readonly number[];
    weapon: Readonly<WeaponData> | null;
  };
}

/** What a peer's weapon index means. Handed in, so this holds no catalogue of its own. */
export interface WeaponSource {
  defAt(index: number | null, attachments: readonly number[]): WeaponDef | undefined;
}

interface Tracked {
  watcher: WeaponWatcher;
  /** `hashString(id)`: the same number the server would mix, and the same one everywhere. */
  seed: number;
}

export class WeaponAudio {
  private readonly own = new WeaponWatcher();
  private ownSeed = 0;
  private readonly peers = new Map<string, Tracked>();

  /**
   * The view kick as of the previous frame, and where this one is putting it.
   *
   * **Trace, then kick**, as `Shots.fire` and `ShotTraceView` both do it: a
   * round leaves before its own recoil moves the view, so the impact this end
   * predicts is along the kick that was on the gun when the trigger went. The
   * other way round, a held burst puts its impacts a frame up the wall from
   * where the server puts them.
   */
  private readonly drawnKick = { pitch: 0, yaw: 0 };
  private readonly sampledKick = { pitch: 0, yaw: 0 };
  private readonly drawnHeat = { spread: 0, ads: 0 };
  private readonly sampledHeat = { spread: 0, ads: 0 };

  /** Scratch, so a round of full auto allocates nothing but the voices it starts. */
  private readonly aim: Aim = { yaw: 0, pitch: 0 };
  private readonly direction: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly cone = { angle: 0, radius: 0 };
  private readonly mapHit: RayHit = { distance: 0, normal: { x: 0, y: 0, z: 0 }, kind: "map", surface: DEFAULT_SURFACE };
  private readonly eye: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly where: Vec3 = { x: 0, y: 0, z: 0 };

  constructor(
    private readonly audio: AudioSystem,
    private readonly world: CapsuleWorld,
  ) {}

  /** The seed this player's own rounds draw from: the recoil's, so one id gives one stream. */
  setSeed(seed: number): void {
    this.ownSeed = seed | 0;
  }

  /**
   * The local player, every frame.
   *
   * Per frame and not per tick, because the watcher compares the state it last
   * saw with the state now and catches every round and every notetrack between
   * them, however many ticks that was.
   */
  local(shooter: SoundingShooter): void {
    const weapon = shooter.weapon;
    // Sampled whether or not anything fired, so the first round of a burst is
    // traced along a kick that is one frame old rather than along zero.
    this.drawnKick.pitch = this.sampledKick.pitch;
    this.drawnKick.yaw = this.sampledKick.yaw;
    this.sampledKick.pitch = weapon?.data.viewKick.pitch ?? 0;
    this.sampledKick.yaw = weapon?.data.viewKick.yaw ?? 0;
    this.drawnHeat.spread = this.sampledHeat.spread;
    this.drawnHeat.ads = this.sampledHeat.ads;
    this.sampledHeat.spread = weapon?.data.spread ?? 0;
    this.sampledHeat.ads = weapon?.data.ads ?? 0;

    if (weapon) {
      this.audio.prepare(weapon.def.game);
    }
    for (const event of this.own.observe(weapon, weapon?.def, weapon?.data, true)) {
      const layer = event.kind === "fire" ? FIRE_LAYER : NOTE_LAYER;
      this.audio.playAtListener(event.alias, { channel: "sfx", game: weapon?.def.game }, seeded(weaponStream(this.ownSeed, event.ordinal, layer)));
      if (event.kind === "fire" && weapon) {
        this.impact(shooter, weapon.def, event.ordinal);
      }
    }
  }

  /**
   * Everybody else, once per snapshot.
   *
   * Driven by the snapshot rather than by the frame, for the reason a peer's
   * footsteps are: these are the server's own tick states, arriving identically
   * at every client, so the same round draws the same recording in every
   * browser — and the ordinal it draws on is the shot's own, which every end
   * already agrees about. Membership follows the snapshot, so a peer who leaves
   * stops being watched.
   */
  remote(players: readonly SoundingPeer[], weapons: WeaponSource): void {
    for (const { id, state } of players) {
      let tracked = this.peers.get(id);
      if (!tracked) {
        tracked = { watcher: new WeaponWatcher(), seed: hashString(id) };
        this.peers.set(id, tracked);
      }
      // A dead player keeps arriving in every snapshot, frozen where they fell.
      // Forgotten rather than skipped, so a respawn starts again rather than
      // reporting the magazine the counter went round while they were down.
      if (state.dead) {
        tracked.watcher.reset();
        continue;
      }
      // The **index** is the identity and the definition is not: `resolveWeapon`
      // builds a fresh object for a weapon with an attachment on it, so a watcher
      // keyed on that would reset every snapshot and a peer with a silencer would
      // never be heard at all.
      const def = weapons.defAt(state.weaponIndex, state.attachments);
      if (def) {
        this.audio.prepare(def.game);
      }
      const feet = state.movement.feet;
      this.eye.x = feet.x;
      this.eye.y = feet.y + eyeHeight(state.movement);
      this.eye.z = feet.z;
      for (const event of tracked.watcher.observe(state.weaponIndex, def, state.weapon ?? undefined, false)) {
        const layer = event.kind === "fire" ? FIRE_LAYER : NOTE_LAYER;
        this.audio.playAt(event.alias, this.eye, { channel: "sfx", game: def?.game }, seeded(weaponStream(tracked.seed, event.ordinal, layer)));
      }
    }
    if (this.peers.size !== players.length) {
      const present = new Set(players.map((p) => p.id));
      for (const id of [...this.peers.keys()]) {
        if (!present.has(id)) {
          this.peers.delete(id);
        }
      }
    }
  }

  /** A round of this player's counted. Feedback: flat, on `ui`, and repeated by nothing. */
  hitMarker(): void {
    this.audio.playAtListener(HIT_ALERT, { channel: "ui" });
  }

  /** Somebody went down with their feet here. Diegetic, so it is placed and it attenuates. */
  death(feet: Readonly<Vec3>): void {
    this.where.x = feet.x;
    this.where.y = feet.y + PROBE_UP;
    this.where.z = feet.z;
    const surface = this.world.surfaceAt(this.where, PROBE_UP + PROBE_DOWN) ?? DEFAULT_SURFACE;
    this.audio.playAt(bodyfallAlias(surface), feet, { channel: "sfx" });
  }

  /** Everyone leaves: a world change, or the connection going away. */
  clear(): void {
    this.peers.clear();
    this.own.reset();
  }

  /**
   * What the round this client has just predicted arrives on, and the noise it
   * makes there.
   *
   * The same ray the server will trace — the aim plus the kick from before this
   * round, deviated inside the weapon's own cone by the same seeded stream — so
   * the surface this picks is the surface the server found, bar the divergence
   * `ShotTraceView` exists to show.
   *
   * **The map only.** A round that stopped in a body still marks what was behind
   * them, because the hit position is not on the wire and reproducing the
   * server's rewound hitbox test here would be a second hit model; two of those
   * is how the two ends stop agreeing about what a round did.
   */
  private impact(shooter: SoundingShooter, def: WeaponDef, ordinal: number): void {
    if (def.sounds?.impact === undefined || !this.world.ready) {
      return;
    }
    const movement = shooter.movement;
    const feet = movement.feet;
    const up = eyeHeight(movement);
    this.eye.x = feet.x;
    this.eye.y = feet.y + up;
    this.eye.z = feet.z;
    const cone = shotSpread(def, this.drawnHeat.spread, this.drawnHeat.ads, up);
    const direction = aimDirection(aimAngles(movement, this.drawnKick, this.aim), this.direction);
    spreadDirection(direction, cone, coneSample(shotStream(shooter.seed, ordinal), this.cone));
    const hit = this.world.traceRay(this.eye, direction, BULLET_RANGE, "shots", this.mapHit);
    if (hit === null) {
      return;
    }
    const alias = impactAliases(def.sounds, hit.surface).find((name) => this.audio.knows(name, def.game));
    if (alias === undefined) {
      return;
    }
    this.where.x = this.eye.x + direction.x * hit.distance;
    this.where.y = this.eye.y + direction.y * hit.distance;
    this.where.z = this.eye.z + direction.z * hit.distance;
    this.audio.playAt(alias, this.where, { channel: "sfx", game: def.game }, seeded(weaponStream(this.ownSeed, ordinal, IMPACT_LAYER)));
  }
}
