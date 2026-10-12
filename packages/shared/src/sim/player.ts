// One player: how they move and the weapon in their hands, stepped together on
// one PlayerInput. Everything that changes as they play is plain data, which
// `snapshot` copies out and `restore` takes back: what a server sends to peers,
// and what a client adopts when the server corrects it. No devices and no
// camera: engine/controls/firstPerson.ts drives the local player, and a remote
// one would step on the inputs a server relays. docs/engine/player.md.

import type { PlayerInput } from "./input.js";
import { LOADOUT_SLOTS, loadoutWeapons, type Loadout, type LoadoutWeapon } from "./loadout.js";
import { mayCarry } from "./weaponCategory.js";
import {
  clampPitch,
  createMovement,
  horizontalSpeed,
  movementEnv,
  NO_CLIMBS,
  PLAYER_MOVEMENT,
  STAND_EYE_HEIGHT,
  stepMovement,
  stowsWeapon,
  wantsSprint,
  type CapsuleWorld,
  type MovementEnv,
  type MovementRules,
  type MovementState,
  type StanceKind,
  type Vec3,
} from "./movement.js";
import { capPitch, capYaw } from "./view.js";
import type { Holder } from "./recoil.js";
import type { WeaponController, WeaponData } from "./weapon.js";
import { fittedSlots, NOTHING_FITTED, sameFitted, type Fitted, type WeaponId, type WeaponRegistry } from "./weaponRegistry.js";
import type { DeepReadonly } from "./readonly.js";

/**
 * A player's whole changing state, JSON-safe.
 *
 * The weapon is named by its **catalogue index**, not its id: this is what goes
 * on the wire every tick for every player, where a name costs ~72 bits and an
 * index costs 9. Both ends fetch the same catalogue over HTTP and a game server
 * refuses a join whose `catalogHash` disagrees, so the index is resolvable —
 * `Player`'s own API stays in ids, and only the state is in indices.
 */
export interface PlayerState {
  movement: MovementState;
  /** Index into the catalogue's order; null empty-handed, or holding a weapon it does not list. */
  weaponIndex: number | null;
  /** The slots the fitted attachments occupy in the weapon's own list (sim/weaponRegistry.ts). Empty is the bare weapon. */
  attachments: number[];
  /** The held weapon's state; null empty-handed. */
  weapon: WeaponData | null;
  /** Which of the two carried weapons is in hand: 0 the primary, 1 the secondary. */
  slot: 0 | 1;
  /** The weapon on their back, as `weaponIndex` names the one in hand. */
  spareIndex: number | null;
  spareAttachments: number[];
  /**
   * How many times they have been handed weapons, wrapping at `ARMED_WRAP`.
   *
   * What lets a server re-arm somebody mid-life without the client guessing: a
   * spawn, a class taking effect and a script's `arm` all count, and a client
   * seeing a count it has not rebuilt for rebuilds both weapons from this state
   * rather than keeping a spare whose magazine the server has just refilled.
   */
  armed: number;
  /**
   * A swap is under way: when this weapon's putaway finishes, the other one in
   * the class comes up.
   *
   * Here because it is simulation state and nothing else can stand in for it. A
   * peer's own swap needs no help — `weaponIndex` names the new weapon the
   * moment it is in hand — but a **server replaying the local player's input**
   * has to arrive at the same weapon the client predicted, and "this putaway is
   * a swap" is not derivable from anything else in the state. One bit.
   */
  swapping: boolean;
  /**
   * The weapon was put away for a climb (a ladder, or a mantle that takes it)
   * and comes back up when it ends. State for the same reason as `swapping`: nothing else says
   * that a lowered weapon is waiting for the climb rather than lowered for good.
   */
  stowed: boolean;
  /**
   * The side they are on, as an **index into the gametype's `teams`**, or null in
   * a free-for-all.
   *
   * An index rather than the `TeamId` string the scripts use, for the reason
   * `weaponIndex` is an index: this is in every snapshot for every player, and
   * both ends already hold the same `GametypeDecl` to resolve it against. Three
   * bits against a name's ~48.
   */
  team: number | null;
  /**
   * What is left of them, out of the match's `CombatRules.maxHealth`.
   *
   * A whole number, always: damage rounds it (`hurt`) and regeneration — the one
   * thing that can leave a fraction behind — is rounded out again by `snapshot`.
   * The ceiling is not here because it does not change during a match: it reaches
   * a client once, in `joined`, with the rest of the rules.
   */
  health: number;
  /** Down, and waiting on `respawnIn`. Not derivable from `health`: a corpse regenerates nothing. */
  dead: boolean;
  /** Seconds left of the respawn countdown; 0 for anyone alive. */
  respawnIn: number;
  /**
   * Their purse, in a gametype that keeps one (`GametypeDecl.points`); 0
   * otherwise. The server's to change (`ServerContext.addPoints`), and state
   * rather than an event so a HUD and a price agree on every snapshot.
   */
  points: number;
}

/**
 * Full health before a match says otherwise.
 *
 * A hundred is Call of Duty's, and `CombatRules.maxHealth` is what actually sets
 * it — but a `Player` is built by tests and by a browser with no game server, and
 * neither has any rules to hand it.
 */
export const DEFAULT_HEALTH = 100;

/** The most `CombatRules.maxHealth` may be: health travels in ten bits (net/messages/player.ts). */
export const MAX_HEALTH = 1023;

/**
 * The ceiling on both combat clocks, seconds.
 *
 * `respawnIn` is never set past it, so the value the simulation holds is the
 * value the wire carries — `combatTimer` in net/messages/fields.ts quantizes over
 * exactly this range, and a countdown longer than it would saturate on the wire
 * while the server kept counting. The time since the last hit stops here too,
 * though it travels nowhere: ten seconds covers the longest regeneration the
 * games use (five to wait, two to fill) with room over.
 */
export const COMBAT_TIMER_MAX = 10;

/** Where `PlayerState.armed` wraps: three bits. Eight re-arms inside one snapshot's flight is not a thing. */
export const ARMED_WRAP = 8;

/**
 * What passing the world's kill plane does.
 *
 * `respawn` puts them back on their spawn, which is all a world walked with no
 * server can do. `die` holds them where they fell — nothing further is stepped —
 * for a game server to kill: in a match it is a death, `outOfWorld`, and nobody's.
 * Both ends of a match hold, so the prediction and the replay stop at one place.
 */
export type FallOut = "respawn" | "die";

/** One of the two weapons a player carries: what it is, what is on it, and its state machine. */
interface Carried {
  /**
   * The catalogue address. Tracked rather than read back off the weapon, because
   * a `WeaponDef` carries the game's own name for it and two games ship an
   * `at4_mp` — only `<game>/<name>` says which.
   */
  id: WeaponId | null;
  /** Which slots are filled on it; part of the state, so a peer rebuilds the same weapon. */
  fitted: Fitted;
  weapon: WeaponController | undefined;
}

function carriedNothing(): Carried {
  return { id: null, fitted: NOTHING_FITTED, weapon: undefined };
}

export class Player {
  private readonly body: MovementState = createMovement({ x: 0, y: 0, z: 0 }, 0, 0);
  /** Primary then secondary, in the order they are held (sim/loadout.ts). */
  private readonly carried: [Carried, Carried] = [carriedNothing(), carriedNothing()];
  /** Which of the two is in hand. */
  private slot: 0 | 1 = 0;
  /** A swap is waiting on the held weapon's putaway to finish. */
  private swapping = false;
  /** The held weapon went away for a climb, and comes back when it ends. */
  private stowed = false;
  /** Which side, as an index into the gametype's `teams`; null in a free-for-all. */
  private team: number | null = null;
  /** Full health for this player, as the match's rules set it. */
  private maxHealth = DEFAULT_HEALTH;
  private hp = DEFAULT_HEALTH;
  private down = false;
  /**
   * Since the last hit. Starts at the ceiling rather than at zero, so a player who
   * has never been shot is not spending their first five seconds "recovering".
   */
  private since = COMBAT_TIMER_MAX;
  private waiting = 0;
  private purse = 0;
  private spawn = { feet: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0 };
  /** Below this y the world has given up on them: nothing catches them past its edge. */
  private killPlaneY = -Infinity;
  private fallOut: FallOut = "respawn";
  /** See `PlayerState.armed`. */
  private arming = 0;
  /** Where a step happens: the collision, this body, and the climbs the world allows (`setClimbs`). */
  private env: MovementEnv;
  /** What the held weapon says about each step, refilled in place. */
  private readonly stepCarry = { sprint: true, braced: false };
  /** What the last step returned (`stepMovement`). Not state: only whoever made that step may act on it. */
  private forced: StanceKind | null = null;
  /** What the held weapon is asked for each step, refilled in place; `setInput` copies what it keeps. */
  private readonly weaponInput = { trigger: false, ads: false, sprint: false };
  /** What the held weapon is told about its holder each step, refilled in place (sim/recoil.ts). */
  private readonly holder: Holder = { seed: 0, speed: 0 };

  /**
   * Without a `weapons` registry a player can still hold whatever it is handed,
   * but `restore` cannot rebuild one it is not already holding — so a peer's
   * weapon change is not followed. That is the pre-catalogue behaviour, kept for
   * the callers that have no catalogue to give (tests, and a world with none).
   */
  constructor(
    world: CapsuleWorld,
    private weapons?: WeaponRegistry,
  ) {
    this.env = movementEnv(world, NO_CLIMBS, PLAYER_MOVEMENT);
  }

  /**
   * Hand this player a catalogue it was built without.
   *
   * The local player is built when the page is, and the catalogue arrives over
   * HTTP a moment later — so the client has no registry to pass to the
   * constructor. Without this its snapshots would name no weapon while it
   * visibly holds one, which is the kind of wrong value nothing complains about.
   */
  setWeapons(weapons: WeaponRegistry): void {
    this.weapons = weapons;
  }

  /**
   * The stream this player's shots draw their kick from.
   *
   * `hashString(playerId)` on both ends — the id is a net-layer name that `sim/`
   * has no business knowing, and `game/random.ts` is a layer this one may not
   * import. Left at 0 a player still kicks; they just kick the same way as
   * everybody else, which is what an offline browser with no id gets.
   */
  setSeed(seed: number): void {
    this.holder.seed = seed | 0;
  }

  /**
   * The stream this player's shots draw from. Read by whoever traces a round, so
   * that the cone it lands in comes off the same seed the recoil already does
   * rather than off a second hash of the id that could disagree with it.
   */
  get seed(): number {
    return this.holder.seed;
  }

  /** The live movement state, for the camera and the viewmodel to follow. `snapshot` for a copy to keep. */
  get movement(): DeepReadonly<MovementState> {
    return this.body;
  }

  get weapon(): WeaponController | undefined {
    return this.held;
  }

  /**
   * Hold `weapon`, or nothing. Its state becomes part of the player's.
   *
   * `id` is its catalogue address, and a snapshot cannot name the weapon without
   * one — `equipById` is the ordinary way in, and passes it for you.
   */
  equip(weapon: WeaponController | undefined, id: WeaponId | null = null, attachments: Fitted = NOTHING_FITTED): void {
    this.carry({ id: weapon ? id : null, fitted: weapon ? attachments : NOTHING_FITTED, weapon }, carriedNothing());
  }

  /** Hold the weapon this id names, from the registry this player was built with. */
  equipById(id: WeaponId | null, attachments: Fitted = NOTHING_FITTED): void {
    this.equip(this.weapons?.build(id, attachments), id, attachments);
  }

  /**
   * Carry a whole class: both weapons built from the catalogue, primary in hand.
   *
   * The class names its attachments and this turns them into the slots the
   * simulation and the wire use (sim/loadout.ts) — the one place the two
   * spellings meet. A weapon the catalogue does not hold leaves its slot empty
   * rather than substituting one.
   */
  equipLoadout(loadout: Loadout): void {
    const [primary, secondary] = loadoutWeapons(loadout).map((choice, i) => {
      const entry = this.weapons?.entry(choice.weapon);
      // Checked here rather than trusted from wherever the class came from, so a
      // game server and the client predicting it equip by the one rule: a weapon
      // of another game, or of the other slot's category, is an empty slot.
      return entry && mayCarry(entry, LOADOUT_SLOTS[i]!, loadout.game) ? this.build(choice) : carriedNothing();
    });
    this.carry(primary!, secondary!);
  }

  /**
   * Carry these two weapons, primary in hand — a script's choice rather than a
   * class, so nothing checks which game or category either is from. A weapon the
   * catalogue does not hold is an empty slot, as it is in a class.
   */
  equipWeapons(primary: LoadoutWeapon | null, secondary: LoadoutWeapon | null): void {
    this.carry(primary ? this.build(primary) : carriedNothing(), secondary ? this.build(secondary) : carriedNothing());
  }

  /** One weapon of a class, built from the catalogue with its attachments turned into slots. */
  private build(choice: LoadoutWeapon): Carried {
    const entry = this.weapons?.entry(choice.weapon);
    if (!entry) {
      return carriedNothing();
    }
    const fitted = fittedSlots(entry, choice.attachments);
    return { id: choice.weapon, fitted, weapon: this.weapons!.build(choice.weapon, fitted) };
  }

  /** Hand over two weapons, the first one in hand if there is one, and count it (`PlayerState.armed`). */
  private carry(primary: Carried, secondary: Carried): void {
    this.carried[0] = primary;
    this.carried[1] = secondary;
    this.slot = primary.weapon || !secondary.weapon ? 0 : 1;
    this.swapping = false;
    this.stowed = false;
    this.arming = (this.arming + 1) % ARMED_WRAP;
    this.draw();
  }

  /** How many times this player has been handed weapons, as `PlayerState.armed` counts it. */
  get armed(): number {
    return this.arming;
  }

  /**
   * Bring the weapon just handed over up, as a spawn does — `firstRaise` is the
   * games' own clip for it, and it chambers a round. Nothing else raises one, and
   * a weapon left `lowered` never sprints, so equipping is where this belongs.
   * The one in hand only: the other is on the player's back, already lowered.
   */
  private draw(): void {
    this.held?.raise({ first: true });
  }

  /** Which weapon is held, by catalogue id. */
  get weaponId(): WeaponId | null {
    return this.carried[this.slot]!.id;
  }

  /** What is fitted to the held weapon, as slots. Live: a caller that keeps it must copy it. */
  get fitted(): Fitted {
    return this.carried[this.slot]!.fitted;
  }

  /**
   * Both slots, primary first — what this player is carrying, not just holding.
   *
   * For a client fetching the models: the weapon on their back is one keypress
   * from their hands, and fetching it then would show as a swap into thin air.
   */
  get carrying(): readonly { readonly id: WeaponId | null; readonly fitted: Fitted }[] {
    return this.carried;
  }

  /** Whether the class carries a second weapon to swap to. */
  get canSwap(): boolean {
    return this.carried[this.other]!.weapon !== undefined;
  }

  private get held(): WeaponController | undefined {
    return this.carried[this.slot]!.weapon;
  }

  private get other(): 0 | 1 {
    return this.slot === 0 ? 1 : 0;
  }

  /**
   * Start a swap: the held weapon goes away, and the other comes up when its
   * putaway finishes (`step`). Nothing happens without a second weapon, and a
   * second press while one is running is ignored — the state machine is what
   * decides when the hands are free, not the player.
   */
  swap(): void {
    if (this.swapping || !this.canSwap || !this.held) {
      return;
    }
    this.swapping = true;
    this.held.drop({ quick: true });
  }

  /**
   * One step of play. The weapon goes first: it reads only the input, and
   * movement then asks it whether a sprint may run (see stepMovement).
   *
   * A climb takes the weapon away where the move says so (`stowsWeapon`): no
   * trigger, no sights, no reload and no swap until it ends, and then the same
   * weapon comes back. It is decided on the state the step starts from, so a
   * server replaying the same inputs reaches the same hand.
   */
  step(input: PlayerInput, dt: number): void {
    // Held where they fell, for a server to kill. Derived from where they are
    // rather than kept, so a client replaying from a corrected state stops at
    // exactly the step the server did.
    if (this.fallOut === "die" && this.outOfWorld) {
      this.forced = null;
      return;
    }
    const climbing = stowsWeapon(this.body.move);
    const weapon = this.held;
    // From the state the step *starts* from, like `advanceStride`: a replay of
    // the same input has the same speed here only if it is read before the move.
    this.holder.speed = horizontalSpeed(this.body);
    if (weapon) {
      this.weaponInput.trigger = input.fire && !climbing;
      this.weaponInput.ads = input.ads && !climbing;
      this.weaponInput.sprint = wantsSprint(this.body, input, this.env);
      weapon.setInput(this.weaponInput);
      if (climbing) {
        this.stow();
      } else if (input.reload) {
        weapon.reload();
      }
      weapon.update(dt, this.holder);
    }
    if (!climbing) {
      if (input.swap) {
        this.swap();
      }
      this.finishSwap();
      this.unstow();
    }
    this.stepCarry.sprint = this.held?.sprinting ?? true;
    this.stepCarry.braced = this.held?.braced ?? false;
    this.forced = stepMovement(this.body, input, dt, this.env, this.stepCarry);
    if (this.fallOut === "respawn" && this.outOfWorld) {
      this.respawn();
      // Put back standing, whatever the keys had asked for.
      this.forced = "stand";
    }
  }

  /**
   * The stance the last step held this player to against the keys it was
   * given, or null. For whoever turns a key into `PlayerInput.crouch` and
   * `prone`, straight after a step of its own: a toggle falls back to this.
   */
  get forcedStance(): StanceKind | null {
    return this.forced;
  }

  /**
   * The view this player may hold, asked for `yaw` and `pitch` (sim/view.ts):
   * what a camera shows of mouse movement no step has spent yet.
   */
  viewYaw(yaw: number): number {
    return capYaw(this.body, yaw, this.env);
  }

  viewPitch(pitch: number): number {
    return capPitch(this.body, pitch);
  }

  /** Past the world's kill plane. With `die`, held there until somebody deals with it. */
  get outOfWorld(): boolean {
    return this.body.feet.y < this.killPlaneY;
  }

  /** Put the held weapon away for a climb. A swap already under way is putting it away anyway. */
  private stow(): void {
    if (this.stowed) {
      return;
    }
    this.stowed = true;
    if (!this.swapping) {
      this.held?.drop({ quick: true });
    }
  }

  /**
   * Bring the weapon back after a climb. After a swap that the climb held up,
   * `finishSwap` has already raised the other one, or will when the putaway
   * ends; raising here too would cut that putaway short and leave the swap
   * waiting for a `lowered` that never comes.
   */
  private unstow(): void {
    if (!this.stowed) {
      return;
    }
    this.stowed = false;
    if (!this.swapping) {
      this.held?.raise({ quick: true });
    }
  }

  /** A deep copy of everything that changes as they play. */
  snapshot(): PlayerState {
    return structuredClone({
      movement: this.body,
      // Null without a registry even while holding a weapon: there is no
      // catalogue to take an index from, and inventing one would name the wrong
      // gun on the far end.
      weaponIndex: this.weapons?.indexOf(this.carried[this.slot]!.id) ?? null,
      attachments: [...this.carried[this.slot]!.fitted],
      weapon: this.held?.data ?? null,
      slot: this.slot,
      spareIndex: this.weapons?.indexOf(this.carried[this.other]!.id) ?? null,
      spareAttachments: [...this.carried[this.other]!.fitted],
      armed: this.arming,
      swapping: this.swapping,
      stowed: this.stowed,
      team: this.team,
      // Rounded because the wire carries a whole number and regeneration is the
      // one thing that leaves a fraction. It cannot round a survivor down to
      // zero: damage already rounds, so health below 1 means dead.
      health: Math.round(this.hp),
      dead: this.down,
      respawnIn: this.waiting,
      points: this.purse,
    });
  }

  /**
   * Hand the other weapon over once the putaway has played out.
   *
   * Run inside `step` rather than off a weapon event, because a server replaying
   * a client's inputs steps the same player through the same ticks and must
   * reach the same hand — an event fired from `restore` would swap a peer twice.
   */
  private finishSwap(): void {
    if (!this.swapping || this.held?.data.state !== "lowered") {
      return;
    }
    this.swapping = false;
    this.slot = this.other;
    this.held?.raise({ quick: true });
  }

  /**
   * Take over `state`, weapon included: a player who has changed weapon since the
   * last one is rebuilt from the catalogue before their weapon state is applied,
   * so a snapshot describes a peer completely. Without a registry the weapon in
   * hand is kept and only its state applied, which is what this did before the
   * catalogue existed.
   */
  restore(state: PlayerState): void {
    this.reanchor(state.movement);

    this.slot = state.slot;
    if (this.weapons) {
      // Both weapons, each rebuilt only when it is not the one already carried in
      // that slot — so a mispredicted swap corrects by `slot` alone and keeps both
      // magazines. A new `armed` count rebuilds both whatever they are: the server
      // handed over fresh weapons, even if they are the same two.
      const rearmed = state.armed !== this.arming;
      this.follow(this.slot, state.weaponIndex, state.attachments, rearmed);
      this.follow(this.other, state.spareIndex, state.spareAttachments, rearmed);
      this.arming = state.armed;
    }
    this.swapping = state.swapping;
    this.stowed = state.stowed;
    this.team = state.team;
    this.hp = state.health;
    this.down = state.dead;
    this.waiting = state.respawnIn;
    this.purse = state.points;
    if (state.weapon && this.held) {
      this.held.restore(state.weapon);
    }
  }

  /** Rebuild one carried weapon from a snapshot's account of it, where it differs or `fresh` says to. */
  private follow(slot: 0 | 1, index: number | null, attachments: number[], fresh: boolean): void {
    const wanted = this.weapons!.idAt(index);
    const carried = this.carried[slot]!;
    if (!fresh && wanted === carried.id && sameFitted(attachments, carried.fitted)) {
      return;
    }
    const rebuilt = this.weapons!.build(wanted, attachments);
    this.carried[slot] = { id: rebuilt ? wanted : null, fitted: rebuilt ? attachments : NOTHING_FITTED, weapon: rebuilt };
  }

  /**
   * Take over a movement state alone, leaving the weapon exactly as it is.
   *
   * A client's claim says where it ended up and nothing else, so a server
   * re-anchoring to one has no weapon half to restore. Passing a made-up
   * `PlayerState` instead would disarm the player every tick, now that `restore`
   * rebuilds the weapon from the state it is given — which is why this is its
   * own method rather than a convention at the call site.
   */
  reanchor(movement: MovementState): void {
    Object.assign(this.body, structuredClone(movement));
  }

  /** Face `yaw`/`pitch` without stepping: looking around while held still. */
  look(yaw: number, pitch: number): void {
    this.body.yaw = yaw;
    this.body.pitch = clampPitch(pitch);
  }

  /** Stand at `feet` facing `yaw`/`pitch`, at rest: an arrival or a teleport. */
  place(feet: Vec3, yaw: number, pitch: number): void {
    Object.assign(this.body, createMovement(feet, yaw, pitch));
  }

  /** Where `respawn` puts the player: an eye position and a point it looks at, as a world's `spawn` gives them. */
  setSpawn(eye: Vec3, lookAt: Vec3): void {
    const dx = lookAt.x - eye.x;
    const dy = lookAt.y - eye.y;
    const dz = lookAt.z - eye.z;
    this.spawn = {
      feet: { x: eye.x, y: eye.y - STAND_EYE_HEIGHT, z: eye.z },
      yaw: Math.atan2(-dx, -dz),
      pitch: Math.atan2(dy, Math.hypot(dx, dz)),
    };
  }

  respawn(): void {
    this.place(this.spawn.feet, this.spawn.yaw, this.spawn.pitch);
  }

  setKillPlane(y: number): void {
    this.killPlaneY = y;
  }

  /** What passing the kill plane does. See `FallOut`: `die` in a match, on both ends. */
  setFallOut(fate: FallOut): void {
    this.fallOut = fate;
  }

  /**
   * Put them on a side, by its index in the gametype's `teams`.
   *
   * The server's to set — a script reaches it through `ServerContext.setTeam` and
   * a client only ever reads it out of a snapshot.
   */
  setTeam(team: number | null): void {
    this.team = team;
  }

  /** Which side, as an index into the gametype's `teams`; null in a free-for-all. */
  get side(): number | null {
    return this.team;
  }

  /** The mantle volumes and ladders this world lets them climb. Set by `applyWorldRules`. */
  setClimbs(rules: MovementRules): void {
    this.env = movementEnv(this.env.world, rules, this.env.body);
  }

  /** Whether a climb is under way, for a caller that must not interrupt one. */
  get mantling(): boolean {
    return this.body.move.kind === "mantle";
  }

  // -- Health ------------------------------------------------------------------------
  //
  // The field and its arithmetic are here; the *rules* are not. How long before
  // health comes back, how fast, and how long a body lies there are a match's
  // (`game/rules.ts`), so each is passed in by the caller that holds them rather
  // than read from here — which is what keeps `sim/` free of `game/`, the way it
  // is already free of `collision/`.
  //
  // None of this is stepped by `step`: a client never predicts its own health, so
  // there is nothing for the two ends to agree about. The server applies every
  // change and a client adopts it through `restore`.

  get health(): number {
    return this.hp;
  }

  get dead(): boolean {
    return this.down;
  }

  /** Seconds since the last hit, capped at `COMBAT_TIMER_MAX`. What `regenDelay` is measured against. */
  get sinceDamage(): number {
    return this.since;
  }

  /** Seconds left of the respawn countdown; 0 for anyone alive. */
  get respawnIn(): number {
    return this.waiting;
  }

  /** Their purse (`PlayerState.points`). */
  get points(): number {
    return this.purse;
  }

  /** Set the purse. The bounds and the arithmetic are the match's, which holds the rules. */
  setPoints(points: number): void {
    this.purse = points;
  }

  /**
   * Take `amount` off. True on the hit that killed them, which is the one tick a
   * caller may announce a death on.
   *
   * The result is rounded, which is what keeps health a whole number: damage
   * arrives as a float — a falloff between two ranges times a location multiplier
   * times a scale — and a health of 87.4000000001 would differ from the wire's own
   * value every tick of a match. Nothing at or below zero is damage, so this is
   * not a back door to healing.
   */
  hurt(amount: number, respawnDelay: number): boolean {
    if (this.down || !(amount > 0)) {
      return false;
    }
    this.since = 0;
    this.hp = Math.max(0, Math.round(this.hp - amount));
    if (this.hp > 0) {
      return false;
    }
    this.down = true;
    this.waiting = Math.min(COMBAT_TIMER_MAX, Math.max(0, respawnDelay));
    return true;
  }

  /**
   * A tick of recovery: the clock since the last hit, and `rate` health a second
   * of it back.
   *
   * The caller decides whether `regenDelay` has passed and hands over 0 until it
   * has — the delay is a rule of the match, and reading the clock before
   * advancing it is what makes "starts after the delay, not before" a fact about
   * one tick rather than about rounding.
   */
  recover(dt: number, rate: number): void {
    if (this.down) {
      return;
    }
    this.hp = Math.min(this.maxHealth, this.hp + Math.max(0, rate) * dt);
    this.since = Math.min(COMBAT_TIMER_MAX, this.since + dt);
  }

  /** Count a dead player down. True on the tick they are due back, and only that tick. */
  countdown(dt: number): boolean {
    if (!this.down) {
      return false;
    }
    this.waiting = Math.max(0, this.waiting - dt);
    return this.waiting === 0;
  }

  /** Back on their feet with `max` health, that being what a spawn gives. Placement is the caller's. */
  revive(max: number = this.maxHealth): void {
    this.maxHealth = max;
    this.hp = max;
    this.down = false;
    this.since = COMBAT_TIMER_MAX;
    this.waiting = 0;
  }
}
