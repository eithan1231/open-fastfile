// The other players: a character from the world's own `characters` kit where it
// has one, and a capsule where it does not.
//
// The capsule is still the fallback and not a leftover. A world whose export
// found no bodies ships none, and a capsule at the simulation's own radius and
// height is the honest thing to draw there — it is also what shows, when
// something looks wrong, whether the state arriving over the wire or the rig on
// top of it is at fault.
//
// -- Why this is not in the world's scene graph -------------------------------
//
// A built world does not move. WorldSession's "freeze matrices" step sets
// `matrixAutoUpdate = false` on every node under the world root, and
// engine/viewer.ts sets `scene.matrixWorldAutoUpdate = false` on top of that, so
// nothing recomputes a world matrix per frame. Anything that does move has to
// opt out and drive itself — engine/animator.ts does the same for animated
// props. So this owns a root added straight to the scene, beside the world
// rather than inside it, and calls `updateMatrixWorld` itself.
//
// Shadows are off for the same reason: `shadowMap.autoUpdate = false`, so a
// moving caster would leave its shadow behind.

import * as THREE from "three";
import { createMovement, HEIGHT, RADIUS, type MovementState } from "@3d/shared/sim/movement.js";
import { lerpMovement, teleported } from "@3d/shared/sim/interpolate.js";
import { bodyIndex } from "@3d/shared/game/cast.js";
import { releaseRig } from "@3d/shared/rig/release.js";
import { TICK_RATE } from "@3d/shared/net/messages/fields.js";
import type { PlayerSnapshot } from "@3d/shared/net/messages/snapshot.js";
import type { WeaponData } from "@3d/shared/sim/weapon.js";
import { bodyYaw, CharacterAnimator } from "../engine/characterAnimator.js";
import { MODEL_FACING, type CharacterKit, type CharacterRig } from "../scene/character.js";

/**
 * How far behind the newest snapshot a body is drawn, as a multiple of the
 * server's tick. Snapshots arrive at the tick rate, which is slower than the
 * display and jittery over UDP, so drawing at the newest one leaves nothing to
 * interpolate towards and a body moves in visible steps.
 *
 * Exactly one tick, and no more, because only two samples are kept. Drawing at
 * `newest - oneTick` puts the draw time between them, which is the whole span
 * available: ask for longer and the time named is older than both samples, the
 * factor clamps to zero, and every frame pins to the older one — no
 * interpolation at all, and a snap on each arrival. That is the failure this
 * constant was introduced with, and a larger value cannot be bought without
 * buffering more samples to spend it on.
 *
 * The cost is one tick of latency (17 ms at 60 Hz) on *other* players only. The
 * local player is simulated here and is never drawn from a snapshot.
 */
const INTERPOLATION_TICKS = 1;

/**
 * One tick as it arrived: the whole movement state, the server tick it belongs to,
 * and when it reached us.
 *
 * It holds the entire state rather than a position and a yaw because the body is
 * posed from it, and a pose is a function of velocity, stance and the stride
 * clock. It holds `tick` because a shot has to name the moment it was aimed at in
 * the *server's* clock — `at` is this machine's and means nothing to anyone else.
 */
interface Sample {
  /** Local arrival, ms. What the draw time is measured against, since snapshots jitter. */
  at: number;
  /** The server tick this state is from (`SnapshotMessage.tick`). */
  tick: number;
  state: MovementState;
}

/** One peer as the last frame drew it: who they are, and the rig they were posed on. */
export interface DrawnBody {
  id: string;
  rig: CharacterRig;
}

interface Remote {
  /** The capsule, or the character's root. Placed at the feet either way. */
  object: THREE.Object3D;
  /** Absent for a capsule, which has nothing to pose. */
  rig?: { rig: CharacterRig; animator: CharacterAnimator };
  /** The two most recent samples, oldest first. Two is all interpolation needs. */
  from: Sample;
  to: Sample;
  /**
   * The state actually drawn this frame: `from` and `to` blended.
   *
   * Reused rather than allocated per frame, and it is what the rig is posed from.
   * It used to be the *newest* snapshot, which was invisible while nothing was
   * shot at: a body drawn at one moment and posed at another. Once a server
   * rewinds to reproduce what a shooter saw, that gap becomes a hit registered
   * against a pose nobody was ever shown.
   */
  drawn: MovementState;
  weapon: WeaponData | null;
}

export class RemotePlayers {
  readonly root = new THREE.Group();
  private readonly players = new Map<string, Remote>();
  /**
   * Players whose body is now a corpse, and who must not be drawn as living.
   *
   * Cleared when a snapshot says they are alive again, which spawns them a fresh
   * rig — exactly right, since the old one is on the floor.
   */
  private readonly handedOver = new Set<string>();
  private readonly geometry: THREE.CapsuleGeometry;
  private readonly material: THREE.Material;
  /** The world's characters, if it ships any. Set on mount and cleared on leaving. */
  private kit: CharacterKit | undefined;
  /** Milliseconds between snapshots, which is the server's tick. */
  private snapshotInterval = 1000 / TICK_RATE;
  private lastFrame = 0;
  /** The newest server tick any snapshot has carried, so a shot can be placed behind it. */
  private newestTick = 0;
  /** Where the last frame was drawn, in the server's clock. Undefined before anyone is drawn. */
  private drawnAt: { tick: number; frac: number } | undefined;

  constructor() {
    this.root.name = "remote-players";
    // The capsule's own maths: a segment of HEIGHT - 2*RADIUS with a cap at each
    // end, so what is drawn is what the collision resolves.
    this.geometry = new THREE.CapsuleGeometry(RADIUS, HEIGHT - 2 * RADIUS, 4, 12);
    // Unlit on purpose. A lit material would depend on the world's lighting, and
    // an imported map is lightmapped — its dynamic lights barely touch a dynamic
    // object, so a Lambert capsule renders near-black and reads as "not drawn".
    // A placeholder has to be visible in every world or it is not a placeholder.
    this.material = new THREE.MeshBasicMaterial({ color: 0xff5a1f });
  }

  /**
   * Dress everyone in `kit`'s characters, or in capsules with none. Anyone
   * already standing is rebuilt, so this may be called after a hot reload.
   */
  setKit(kit: CharacterKit | undefined): void {
    if (kit === this.kit) {
      return;
    }
    this.kit = kit;
    for (const [id, remote] of this.players) {
      this.release(remote);
      const { object, rig } = this.spawn(id);
      remote.object = object;
      remote.rig = rig;
    }
  }

  /** Match the server's tick, from `joined`: it sets how far apart snapshots arrive, and so how far back to draw. */
  setTickRate(hz: number): void {
    if (hz > 0 && Number.isFinite(hz)) {
      this.snapshotInterval = 1000 / hz;
    }
  }

  /**
   * Take one tick's worth of other players. Membership follows the snapshot:
   * anyone missing from it is gone, which is what lets a lost `leave` heal
   * itself rather than leave a body standing in the map.
   */
  apply(players: PlayerSnapshot[], tick: number, now: number): void {
    this.newestTick = Math.max(this.newestTick, tick);
    for (const { id, state } of players) {
      // Their body is on the floor. **A dead player keeps arriving in every
      // snapshot** — frozen where they fell, counting down to a respawn — so
      // without this the next snapshot after a hand-over spawns them a fresh rig
      // and the map holds two of them: one standing, one falling.
      if (this.handedOver.has(id)) {
        if (!state.dead) {
          this.handedOver.delete(id); // respawned: draw them again, from a new rig
        } else {
          continue;
        }
      }
      const sample: Sample = { at: now, tick, state: state.movement };
      const existing = this.players.get(id);
      if (existing) {
        existing.from = existing.to;
        existing.to = sample;
        existing.weapon = state.weapon;
      } else {
        const { object, rig } = this.spawn(id);
        this.players.set(id, {
          object,
          rig,
          from: sample,
          to: sample,
          drawn: createMovement(state.movement.feet, state.movement.yaw, state.movement.pitch),
          weapon: state.weapon,
        });
      }
    }

    // Membership is still the snapshot's, but a handed-over player is *present*
    // and deliberately not drawn, so they must not count as having left.
    if (players.length - this.handedOver.size !== this.players.size) {
      const present = new Set(players.map((p) => p.id));
      for (const [id, remote] of this.players) {
        if (!present.has(id)) {
          this.release(remote);
          this.players.delete(id);
        }
      }
    }
  }

  /** Draw between the last two samples. Called every frame, not every tick. */
  update(now: number): void {
    const dt = this.lastFrame ? Math.min((now - this.lastFrame) / 1000, 0.1) : 0;
    this.lastFrame = now;
    // Before the early return: with nobody left, a shot must not name the last peer's tick.
    this.drawnAt = undefined;
    if (this.players.size === 0) {
      return;
    }
    const at = now - this.snapshotInterval * INTERPOLATION_TICKS;
    for (const remote of this.players.values()) {
      const { object, from, to } = remote;
      const span = to.at - from.at;
      const t = span > 0 && !teleported(from.state, to.state) ? clamp((at - from.at) / span, 0, 1) : 1;
      const drawn = lerpMovement(from.state, to.state, t, remote.drawn);

      // Where this frame sits in the *server's* clock, which is what a shot has to
      // name for the server to rewind to it. Taken from a peer rather than kept as
      // a clock of our own precisely because it must be the same number the body
      // was drawn at: one interpolation, one answer. Every peer is drawn at the
      // same `at`, so the first is as good as any.
      if (this.drawnAt === undefined) {
        // `t` is a fraction of the *span*, which is two ticks wide when a snapshot
        // was dropped — so the render point is split into a whole tick and the
        // remainder rather than assuming the span is one.
        const exact = from.tick + t * (to.tick - from.tick);
        const whole = Math.floor(exact);
        this.drawnAt = { tick: whole, frac: exact - whole };
      }

      // A character stands on its feet, where the state's origin already is; a
      // capsule's origin is its middle, so it is lifted by half its height.
      const lift = remote.rig ? 0 : HEIGHT / 2;
      object.position.set(drawn.feet.x, drawn.feet.y + lift, drawn.feet.z);
      object.rotation.y = bodyYaw(drawn) + (remote.rig ? MODEL_FACING : 0);
      remote.rig?.animator.update(drawn, remote.weapon, dt);
    }
    // The scene does not do this for us; see the note at the top of the file.
    this.root.updateMatrixWorld(true);
  }

  /**
   * The server tick, and the fraction past it, that the last frame drew other
   * players at — what a shot fired now was aimed at.
   *
   * Undefined when nobody has been drawn: no peers, or no snapshot yet. A caller
   * with no answer here must not invent one; the server clamps a rewind it cannot
   * place, and saying "the newest tick" would ask it to rewind to now.
   */
  renderTick(): { tick: number; frac: number } | undefined {
    return this.drawnAt;
  }

  /** The newest tick seen on the wire, which is the ceiling on any rewind we may ask for. */
  get tick(): number {
    return this.newestTick;
  }

  /**
   * Everyone wearing a body right now, as the last `update` posed them.
   *
   * The rig itself, not the state it was posed from: a caller reading a bone off
   * this sees the pose on screen, where anything re-deriving a pose of its own
   * would be reading a different body. Peers drawn as capsules have no bones and
   * are left out.
   */
  drawnBodies(): DrawnBody[] {
    const out: DrawnBody[] = [];
    for (const [id, remote] of this.players) {
      if (remote.rig) {
        out.push({ id, rig: remote.rig.rig });
      }
    }
    return out;
  }

  /**
   * Give this player's body away, and stop drawing them.
   *
   * What a death looks like from here. The rig is **handed over rather than
   * rebuilt**: `CharacterKit.build` is a `SkeletonUtils.clone` of a whole body, and
   * the one in hand is already wearing the right one — the body `bodyIndex` chose
   * from this player's id, which is the body the server traced the killing round
   * against. Building a second would be a corpse in a different body from the one
   * that died.
   *
   * The animator is disposed, because a corpse is not posed by clips any more. The
   * rig itself is the caller's from here, and so is releasing it (`releaseRig`).
   *
   * Their respawn comes back through `apply` and spawns them a fresh rig, which is
   * exactly right — the old one is on the floor. Returns nothing for a peer drawn
   * as a capsule, which has no bones to fall over.
   */
  handOver(id: string): CharacterRig | undefined {
    const remote = this.players.get(id);
    const held = remote?.rig;
    if (!remote || !held) {
      return undefined;
    }
    const rig = held.rig;
    held.animator.dispose();
    remote.rig = undefined;
    this.root.remove(remote.object);
    this.players.delete(id);
    this.handedOver.add(id);
    return rig;
  }

  /**
   * Take a handed-over player back.
   *
   * For the one case the hand-over could not be completed — a world with no
   * physics, or a body whose hit boxes have not arrived — where the body has left
   * here and nothing else took it. Without this they would be invisible until they
   * respawned, which is worse than the standing corpse this replaced.
   */
  takeBack(id: string): void {
    this.handedOver.delete(id);
  }

  /** Everyone leaves: a world change, or the connection going away. */
  clear(): void {
    for (const remote of this.players.values()) {
      this.release(remote);
    }
    this.players.clear();
    this.handedOver.clear();
    this.drawnAt = undefined;
    this.newestTick = 0;
  }

  dispose(): void {
    this.clear();
    this.kit = undefined;
    this.geometry.dispose();
    this.material.dispose();
  }

  /**
   * The body for one player id.
   *
   * The *choice* is `bodyIndex` in `@3d/shared`, not here, and that is the point:
   * this used to hash the id with a 31-multiplier of its own, which made "everyone
   * dresses this player the same" true within a browser and nowhere else. A server
   * traces a bullet against whichever body it thinks someone is wearing, and each
   * body has its own box sizes — a head derived from a ghillie hood is 0.49 m across
   * against 0.29 for an ordinary one.
   *
   * A snapshot carries `team` now, so this *could* narrow the cast by side — and
   * deliberately does not yet. The gametype does not reach the browser until the
   * `joined` handshake carries it, and until both ends resolve the same cast from
   * the same gametype, dressing by side here would disagree with the server.
   */
  private spawn(id: string): { object: THREE.Object3D; rig?: { rig: CharacterRig; animator: CharacterAnimator } } {
    if (this.kit) {
      try {
        const rig = this.kit.build(bodyIndex(id, this.kit.names.length));
        this.root.add(rig.root);
        return { object: rig.root, rig: { rig, animator: new CharacterAnimator(rig) } };
      } catch (e) {
        console.warn(`[characters] ${e instanceof Error ? e.message : String(e)}; falling back to capsules`);
        this.kit = undefined;
      }
    }
    const mesh = new THREE.Mesh(this.geometry, this.material);
    // It moves, so it keeps its own matrices; it must not cast, because the
    // shadow map is not redrawn per frame.
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    this.root.add(mesh);
    return { object: mesh };
  }

  /**
   * Take one body out of the scene. A rig's geometry, materials and textures are
   * the AssetStore's and are freed when the world is left, not here — only the
   * mixer and the rig's own skeletons are this object's to let go of.
   */
  private release(remote: Remote): void {
    this.root.remove(remote.object);
    if (remote.rig) {
      remote.rig.animator.dispose();
      releaseRig(remote.rig.rig.root);
      remote.rig = undefined;
    }
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
