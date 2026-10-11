// One shot, judged: the rewind, the boxes and the map, joined.
//
// `rewind.test.ts` proves this server can put a player back where the shooter was
// drawing them, and `bodies.test.ts` proves the boxes hang off bones a real body
// has. This is the claim that needs both: a bullet fired at a *moment* lands on the
// body that was there then, on the part of it the ray went through, and only if the
// map let it past.
//
// Against the real catalogue, for the reason bodies.test.ts is: a stub rig would
// agree with itself, where what is worth proving is that boxes derived from a real
// skeleton, posed by that game's real clips, end up where the client draws them.
// Skipped where no catalogue has been built — it is gitignored.

import "reflect-metadata";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { testApp } from "@3d/api/testing/app.js";
import type { ResolvedWorld } from "@3d/shared/dsl/resolved.js";
import { bodyFor, castFor, type CastCharacter } from "@3d/shared/game/cast.js";
import { catalogueViewOf, type CatalogueView } from "@3d/shared/game/catalogueView.js";
import { defaultGametype } from "@3d/shared/game/gametypes/default.js";
import type { InputMessage } from "@3d/shared/net/messages/input.js";
import { createApiClient, type ApiClient } from "@3d/shared/protocol/api.js";
import type { HttpFetch } from "@3d/shared/protocol/http.js";
import type { RayHit, Vec3 } from "@3d/shared/sim/capsule.js";
import { idleInput, type PlayerInput } from "@3d/shared/sim/input.js";
import { EYE_HEIGHT } from "@3d/shared/sim/movement.js";
import { aimAngles, aimDirection, coneSample, shotStream, type ViewKick } from "@3d/shared/sim/recoil.js";
import { hashString } from "@3d/shared/game/random.js";
import { WeaponRegistry, type WeaponEntry } from "@3d/shared/sim/weaponRegistry.js";
import type { Api } from "../src/api.js";
import { Bodies, type LoadedBody } from "../src/bodies.js";
import { Match } from "../src/match/match.js";
import type { PlayerShot, ShotResult } from "../src/match/shots.js";
import type { Weapons } from "../src/weapons.js";
import { DEFAULT_SURFACE } from "@3d/shared/sim/surfaces.js";

const TICK_RATE = 60;
const DT = 1 / TICK_RATE;
const GAME = "iw5";
/** The shot is fired from five metres to the target's left, along +x. */
const STANDOFF = 5;
/**
 * Degrees a hip-fired round may leave off the line of sight before something
 * other than the cone is bending it. Clears the catalogue's widest `hipStandMax`
 * (18) with room to spare, so this catches a kick leaking into the aim rather
 * than policing any particular weapon's spread.
 */
const HIP_CONE_CEILING = 20;

/** A floor at y=0, and a wall in front of the shooter when one is asked for. */
class Ground {
  readonly ready = true;
  /** Where along a shot the map stops it, metres; null is open air, which is what most of these want. */
  wallAt: number | null = null;

  resolveCapsule(position: Vec3, _r: number, _h: number, out?: { position: Vec3; grounded: boolean; normal: Vec3 }) {
    const result = out ?? { position: { x: 0, y: 0, z: 0 }, grounded: false, normal: { x: 0, y: 0, z: 0 } };
    result.position.x = position.x;
    result.position.y = Math.max(position.y, 0);
    result.position.z = position.z;
    result.grounded = position.y <= 0;
    result.normal.x = 0;
    result.normal.y = result.grounded ? 1 : 0;
    result.normal.z = 0;
    return result;
  }

  overlapsCapsule(position: { y: number }): boolean {
    return position.y < 0;
  }

  groundBelow(from: { y: number }, distance: number, normal?: Vec3): number | null {
    if (from.y < 0 || from.y - distance > 0) {
      return null;
    }
    if (normal) {
      normal.x = 0;
      normal.y = 1;
      normal.z = 0;
    }
    return 0;
  }

  // Nothing here has a surface; a flat test floor is `default` either way.
  surfaceAt(): null {
    return null;
  }

  traceRay(_from: Vec3, _direction: Vec3, distance: number, _channel: string, out?: RayHit): RayHit | null {
    if (this.wallAt === null || this.wallAt > distance) {
      return null;
    }
    const hit = out ?? { distance: 0, normal: { x: 0, y: 0, z: 0 }, kind: "map" as const, surface: DEFAULT_SURFACE };
    hit.distance = this.wallAt;
    hit.normal.x = -1;
    hit.normal.y = 0;
    hit.normal.z = 0;
    hit.kind = "map";
    return hit;
  }
}

function world(): ResolvedWorld {
  return {
    game: GAME,
    spawn: { position: { x: 0, y: 1.6, z: 0 }, look: { x: 0, y: 1.6, z: -1 } },
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

const running: PlayerInput = { ...idleInput(0, 0), forward: 1, run: true };

function input(seq: number, renderTick: number, renderFrac = 0): InputMessage {
  return { seq, dt: DT, input: running, claim: { x: 0, y: 0, z: 0 }, drawn: { tick: renderTick, frac: renderFrac } };
}

interface Real {
  client: ApiClient;
  catalogue: CatalogueView;
  weapons: WeaponRegistry;
}

/** The catalogue this checkout holds, or null where none has been built. */
async function realCatalogue(): Promise<Real | null> {
  const { app } = testApp();
  const client = createApiClient({ fetch: app.request.bind(app) as HttpFetch });
  const index = await client.catalogIndex();
  const weapons = new WeaponRegistry(index.weapons as WeaponEntry[]);
  const catalogue = catalogueViewOf(index, weapons);
  return catalogue.charactersFor(GAME).length === 0 ? null : { client, catalogue, weapons };
}

/** The bones this test watches: one per limb, so a pose that moved none of them is not a pose. */
const WATCHED = ["j_head_end", "j_wrist_ri", "j_knee_le"];

interface Loaded extends Real {
  bodies: Bodies;
  target: string;
  body: LoadedBody;
  /** The target's bones before anything posed them, in the rig's own frame. */
  bind: Map<string, THREE.Vector3>;
}

/**
 * One real load of every body, shared: it is 26 GLBs, and posing one leaves nothing
 * behind in it.
 *
 * The bind pose is read here and nowhere else, because a rig keeps the last pose
 * anybody put it in — read it in a second test and what comes back is the first
 * test's pose, which is a control that controls nothing.
 */
let loaded: Promise<Loaded | null> | undefined;

function realBodies(): Promise<Loaded | null> {
  loaded ??= realCatalogue().then(async (real) => {
    if (!real) {
      return null;
    }
    const bodies = new Bodies({ client: real.client } as unknown as Api, { catalogue: real.catalogue } as unknown as Weapons);
    await bodies.load();
    const cast = castFor({ game: GAME, gametype: defaultGametype }, real.catalogue)!;
    const target = riflemanId(cast.characters);
    const body = bodies.get(GAME, bodyFor(target, cast.characters)!.id)!;
    body.rig.root.updateMatrixWorld(true);
    return { ...real, bodies, target, body, bind: new Map(WATCHED.map((bone) => [bone, inRig(body, bone)])) };
  });
  return loaded;
}

/**
 * A player id that is dressed in an ordinary body.
 *
 * Which body a player wears is a hash of their id over the catalogue's own order
 * (`bodyFor`), so the id decides the shape being shot at. The three ghillies skin a
 * hood to `j_head` and derive a 0.49 m head box, which swallows the twenty
 * centimetres `the part of the body a ray went through` asserts about.
 */
function riflemanId(characters: readonly CastCharacter[]): string {
  for (let i = 0; i < 100; i++) {
    const id = i === 0 ? "target" : `target-${i}`;
    if (!bodyFor(id, characters)!.id.includes("ghillie")) {
      return id;
    }
  }
  throw new Error("this catalogue dresses every id in a ghillie");
}

/** Where a bone sits in its own rig's frame, which is what two poses of it can be compared in. */
function inRig(body: LoadedBody, bone: string): THREE.Vector3 {
  const at = new THREE.Vector3();
  body.rig.root.getObjectByName(bone)!.getWorldPosition(at);
  return body.rig.root.worldToLocal(at);
}

function worldPosition(body: LoadedBody, bone: string): THREE.Vector3 {
  const at = new THREE.Vector3();
  body.rig.root.getObjectByName(bone)!.getWorldPosition(at);
  return at;
}

interface Played {
  match: Match;
  ground: Ground;
  target: string;
  /** The body the target is dressed in, by the same call the browser dresses them with. */
  body: LoadedBody;
  /** Every snapshot, as the shooter received it. */
  seen: { tick: number; feet: Vec3 }[];
  /** The target's bones before anything posed them, in the rig's own frame. */
  bind: Map<string, THREE.Vector3>;
  /** Fire along +x from `STANDOFF` away, at the moment `tick` names. */
  shoot: (at: { y: number; z: number }, tick: number) => ShotResult | null;
}

/**
 * A match with a target running away from a standing shooter, played for `ticks`
 * with every snapshot delivered — without which every rewind below would be clamped
 * as a tick this server never sent.
 */
async function played(ticks: number): Promise<Played | null> {
  const real = await realBodies();
  if (!real) {
    return null;
  }
  const { target, body, bind } = real;
  const ground = new Ground();
  const match = new Match(ground, world(), TICK_RATE, 4, real.weapons, {
    map: "dome-mw3",
    gametype: defaultGametype,
    catalogue: real.catalogue,
    bodies: real.bodies,
  });
  match.join(target);
  match.join("shooter");

  const seen: { tick: number; feet: Vec3 }[] = [];
  for (let i = 1; i <= ticks; i++) {
    match.receive(target, input(i, 0));
    match.receive("shooter", { ...input(i, 0), input: idleInput(0, 0) });
    const snapshot = match.step();
    match.snapshotFor("shooter", snapshot.players);
    match.snapshotFor(target, snapshot.players);
    seen.push({ tick: match.tick, feet: { ...snapshot.players.find((p) => p.id === target)!.state.movement.feet } });
  }

  const shoot = (at: { y: number; z: number }, tick: number) =>
    match.traceShot("shooter", { x: -STANDOFF, y: at.y, z: at.z }, { x: 1, y: 0, z: 0 }, 20, input(99, tick & 0xffff));
  return { match, ground, target, body, seen, bind, shoot };
}

describe("a shot", () => {
  it("lands on the body that was there, and not on the one that is there now", async () => {
    const p = await played(40);
    if (!p) {
      return;
    }
    const past = p.seen[p.seen.length - 12]!;
    const now = p.seen[p.seen.length - 1]!;
    // The two moments have to be further apart than the body is wide, or "hits the
    // past and misses the present" would pass on a rewind that did nothing.
    expect(Math.abs(past.feet.z - now.feet.z)).toBeGreaterThan(0.5);

    const chest = { y: past.feet.y + 1.3, z: past.feet.z };
    const hit = p.shoot(chest, past.tick) as PlayerShot;
    expect(hit.kind).toBe("player");
    expect(hit.id).toBe(p.target);
    expect(hit.location).toMatch(/^torso/);
    // Fired from five metres away, so a hit anywhere on the body is about that far.
    expect(hit.distance).toBeCloseTo(STANDOFF, 0);

    // The same ray, judged at the newest tick this server sent: they have run out
    // of it. This is `rewind.test.ts`'s "not the present" pair, through a skeleton.
    expect(p.shoot(chest, now.tick)).toBeNull();
    // And the ray is not simply a miss: where they are *now*, judged now, is a hit.
    expect(p.shoot({ y: now.feet.y + 1.3, z: now.feet.z }, now.tick)?.kind).toBe("player");
  }, 120_000);

  it("reports the part of the body the ray went through", async () => {
    const p = await played(40);
    if (!p) {
      return;
    }
    const past = p.seen[p.seen.length - 12]!;
    // Posed by the shot itself: the crown is a fifth of a metre in front of the
    // capsule's axis on a running body, so aiming from the state rather than from
    // the rig would be aiming at where the head is not.
    expect(p.shoot({ y: past.feet.y + 1.3, z: past.feet.z }, past.tick)?.kind).toBe("player");
    const crown = worldPosition(p.body, "j_head_end");

    const head = p.shoot(crown, past.tick);
    expect(head).toMatchObject({ kind: "player", location: "head" });
    // Twenty centimetres lower is the chest, which is the assertion that a hit is
    // placed by where the ray met the boxes and not by which player it found.
    expect(p.shoot({ y: crown.y - 0.2, z: crown.z }, past.tick)).toMatchObject({ location: "torsoUpper" });
  }, 120_000);

  it("is traced against the pose the target was drawn in, not against their bind pose", async () => {
    const p = await played(40);
    if (!p) {
      return;
    }
    const past = p.seen[p.seen.length - 12]!;
    const hit = p.shoot({ y: past.feet.y + 1.3, z: past.feet.z }, past.tick);
    expect(hit?.kind).toBe("player");

    // A rig whose world matrices were never updated traces its bind pose, which is
    // a plausible wrong answer: the body is in roughly the right place and every
    // limb is in the wrong one. Measured in the rig's own frame, so the placement
    // is not what is being compared.
    for (const bone of WATCHED) {
      expect(inRig(p.body, bone).distanceTo(p.bind.get(bone)!)).toBeGreaterThan(0.05);
    }
    // And the hit was read off *those* matrices rather than from the state the pose
    // was decided from: where the bind pose would have held the crown, at the same
    // placement, there is nothing to hit — a running body's head is lower and
    // further forward than a body standing to attention.
    const crown = worldPosition(p.body, "j_head_end");
    const unposed = p.body.rig.root.localToWorld(p.bind.get("j_head_end")!.clone());
    expect(crown.distanceTo(unposed)).toBeGreaterThan(0.1);
    expect(p.shoot(crown, past.tick)).toMatchObject({ location: "head" });
    expect(p.shoot(unposed, past.tick)).toBeNull();

    // And turned to face where the player is looking, which nothing above would
    // notice: every aim point here is read off the rig, so a body stood at a right
    // angle to the one on screen is still hit exactly where it was aimed at. Yaw 0
    // faces -z, so the body's own right (`_ri` is the character's) is +x. The hips
    // rather than the shoulders: a body holding a rifle carries its chest turned.
    const left = worldPosition(p.body, "j_hip_le");
    const right = worldPosition(p.body, "j_hip_ri");
    expect(right.x - left.x).toBeGreaterThan(0.15);
    expect(Math.abs(right.z - left.z)).toBeLessThan(0.15);
  }, 120_000);

  it("stops at the map, so a body behind a wall is not hit", async () => {
    const p = await played(40);
    if (!p) {
      return;
    }
    const past = p.seen[p.seen.length - 12]!;
    const chest = { y: past.feet.y + 1.3, z: past.feet.z };
    expect(p.shoot(chest, past.tick)?.kind).toBe("player");

    // A wall two metres short of them. The bullet and the player collide with
    // different geometry, which is why this is its own trace and its own channel.
    p.ground.wallAt = STANDOFF - 2;
    expect(p.shoot(chest, past.tick)).toMatchObject({ kind: "world", distance: STANDOFF - 2 });

    // A wall *behind* them changes nothing: the nearest of everything wins.
    p.ground.wallAt = STANDOFF + 2;
    expect(p.shoot(chest, past.tick)?.kind).toBe("player");
  }, 120_000);

  it("does not find the shooter in it", async () => {
    const p = await played(40);
    if (!p) {
      return;
    }
    const newest = p.seen[p.seen.length - 1]!;
    // Straight down through their own chest, from their own eye. The shooter stands
    // at the spawn and has never moved, so every box they own is on this segment.
    const down = p.match.traceShot("shooter", { x: 0, y: 1.6, z: 0 }, { x: 0, y: -1, z: 0 }, 20, input(99, newest.tick & 0xffff));
    expect(down).toBeNull();
  }, 120_000);
});

/**
 * The shot nobody sent.
 *
 * Above, `traceShot` is called directly with an origin and a direction, which is
 * the geometry. This is the other half: that a shot exists at all only because
 * this server replayed a client's own input, fired the same weapon state machine
 * the client runs, and saw its counter move — and that when it does, the bullet
 * leaves the shooter's eye, along the way the shooter was looking, at the moment
 * that *input* named rather than at the present.
 */
describe("a shot out of the replay", () => {
  /** Where the shooter aims, as a height above the target's feet. */
  const CHEST = 1.3;

  /** A duel: the target running away down -z from a shooter standing at the spawn. */
  async function duel(ticks: number) {
    const p = await played(ticks);
    if (!p) {
      return null;
    }
    const match = p.match;
    let seq = 1000;
    /** Every tick's recorded position for the target, which is all a client is ever told. */
    const feetAt = new Map<number, Vec3>(p.seen.map((s) => [s.tick, s.feet]));

    /**
     * One tick with the shooter sending `command` and naming the tick `lag` back.
     * Returns the shots it fired and the absolute tick they were judged against.
     */
    /**
     * The kick the last snapshot carried — what this client had drawn when the
     * trigger went, and so the aim a round fired on the next tick leaves along.
     * Cloned each tick, because a snapshot hands back the live `WeaponData` and
     * its `viewKick` is moved in place.
     */
    let drawn: ViewKick = { pitch: 0, yaw: 0, pitchVel: 0, yawVel: 0 };

    const step = (command: PlayerInput, lag: number) => {
      const named = match.tick - lag;
      const before = drawn;
      match.receive(p.target, input(++seq, 0));
      match.receive("shooter", {
        seq: ++seq,
        dt: DT,
        input: command,
        claim: { x: 0, y: 0, z: 0 },
        drawn: { tick: named & 0xffff, frac: 0 },
      });
      const snapshot = match.step();
      match.snapshotFor("shooter", snapshot.players);
      match.snapshotFor(p.target, snapshot.players);
      feetAt.set(match.tick, { ...snapshot.players.find((x) => x.id === p.target)!.state.movement.feet });
      // The shooter's own state as this tick left it: where this tick's shot has
      // *moved* the view to, which is not what it was traced along. The **view**
      // kick, not the gun kick — the gun kick rocks the model, and a shot that
      // followed it would leave along a line nothing aimed down.
      const me = snapshot.players.find((x) => x.id === "shooter")!.state;
      drawn = { ...(me.weapon?.viewKick ?? { pitch: 0, yaw: 0, pitchVel: 0, yawVel: 0 }) };
      return { shots: [...match.shotsThisTick], named, kick: drawn, drawn: before };
    };

    /**
     * Hold the trigger until a round leaves, aiming `height` above the target's
     * feet *as the snapshot for the named tick has them* — which is exactly what
     * a client with a crosshair on somebody is doing, and means the aim is right
     * for whichever tick the weapon chooses to fire on.
     */
    const fire = (lag: number, height: number, limit = 200) => {
      for (let i = 0; i < limit; i++) {
        const feet = feetAt.get(match.tick - lag) ?? feetAt.get(match.tick)!;
        const pitch = Math.atan2(feet.y + height - EYE_HEIGHT, Math.abs(feet.z));
        const { shots, named, kick, drawn: had } = step({ ...idleInput(0, pitch), fire: true }, lag);
        if (shots.length > 0) {
          return { shot: shots[0]!, named, feet: feetAt.get(named)!, pitch, kick, drawn: had };
        }
      }
      throw new Error(`the shooter fired nothing in ${limit} ticks`);
    };

    /**
     * Queue several inputs into one tick, each naming its own moment. A client at
     * our tick rate sends one a tick; a burst after a stall is four frames of
     * aiming, and each of them was drawn at a different time.
     */
    const volley = (commands: { command: PlayerInput; lag: number }[]) => {
      match.receive(p.target, input(++seq, 0));
      for (const { command, lag } of commands) {
        match.receive("shooter", {
          seq: ++seq,
          dt: DT,
          input: command,
          claim: { x: 0, y: 0, z: 0 },
          drawn: { tick: (match.tick - lag) & 0xffff, frac: 0 },
        });
      }
      const snapshot = match.step();
      match.snapshotFor("shooter", snapshot.players);
      match.snapshotFor(p.target, snapshot.players);
      feetAt.set(match.tick, { ...snapshot.players.find((x) => x.id === p.target)!.state.movement.feet });
      return [...match.shotsThisTick];
    };

    return { match, target: p.target, fire, volley, step, feetAt };
  }

  /**
   * How far a round ended up from the line it was aimed along, degrees, and which
   * way round that line it went. The second is what ties a deviation to the seed
   * that produced it: the cone's width is the weapon's, but its bearing is drawn.
   */
  function angleBetween(a: Vec3, b: Vec3): number {
    const dot = Math.min(1, Math.max(-1, a.x * b.x + a.y * b.y + a.z * b.z));
    return (Math.acos(dot) * 180) / Math.PI;
  }

  function bearing(direction: Vec3, line: Vec3): number {
    // The same basis `spreadDirection` builds: right horizontal, up their cross.
    const flat = Math.hypot(line.x, line.z);
    const rx = flat > 1e-6 ? -line.z / flat : 1;
    const rz = flat > 1e-6 ? line.x / flat : 0;
    const ux = -rz * line.y;
    const uy = rz * line.x - rx * line.z;
    const uz = rx * line.y;
    const dx = direction.x - line.x;
    const dy = direction.y - line.y;
    const dz = direction.z - line.z;
    const angle = Math.atan2(dx * ux + dy * uy + dz * uz, dx * rx + dz * rz);
    return angle < 0 ? angle + 2 * Math.PI : angle;
  }

  /** Eye to aim point, which is what a hit's `distance` is within the body's own depth. */
  function reach(feet: Vec3, height: number): number {
    return Math.hypot(feet.z, feet.y + height - EYE_HEIGHT);
  }

  it("leaves the shooter's eye, down the line of sight they were drawn — before this round's own kick", async () => {
    const d = await duel(60);
    if (!d) {
      return;
    }
    const first = d.fire(12, CHEST);
    // The shooter has stood at the world's spawn since they joined, looking along
    // -z, which is what yaw 0 is. So the origin is that spawn's feet plus the eye,
    // and the direction is the camera's own line — plus whatever kick the gun had
    // *already* taken, which `aimAngles` is the one definition of on both ends.
    // This first round comes off a gun at rest, so its line is the bare line of
    // sight: a bullet is away before the weapon recoils. Nothing else is allowed
    // in it either — this is the assertion a server deriving its aim from a
    // client's finished aim would fail.
    expect(first.drawn).toEqual({ pitch: 0, yaw: 0, pitchVel: 0, yawVel: 0 });
    const line = aimDirection(aimAngles({ yaw: 0, pitch: first.pitch }, first.drawn), { x: 0, y: 0, z: 0 });
    expect(first.shot.from).toEqual({ x: 0, y: EYE_HEIGHT, z: 0 });

    // The round does *not* leave dead along that line: it leaves inside the cone
    // the weapon's own `hipSpread` allows, which is a few degrees wide from the
    // hip (sim/recoil.ts). What it must not do is leave further off than that, or
    // off in a direction nothing here chose.
    const off = angleBetween(first.shot.direction, line);
    expect(off).toBeGreaterThan(0);
    expect(off).toBeLessThan(HIP_CONE_CEILING);

    // **Where in the cone is this server's own arithmetic**, off a seed it derives
    // from the player's id and the round's ordinal. So the bearing the round was
    // pushed along, measured around the line of sight, is the one that seed draws
    // — which `Math.random` in place of the stream would fail, and which is the
    // half of a shot a client has no way to influence.
    const sample = coneSample(shotStream(hashString("shooter"), first.shot.ordinal), { angle: 0, radius: 0 });
    expect(bearing(first.shot.direction, line)).toBeCloseTo(sample.angle, 6);
    expect(first.shot.shooter).toBe("shooter");
    expect(first.shot.ordinal).toBeGreaterThan(0);
    expect((first.shot.result as PlayerShot).id).toBe(d.target);

    // And the view did move: the kick that round took is real rather than nought,
    // which is what the next round leaves along. Without this pair, a server that
    // dropped the kick from the aim entirely would pass everything above.
    expect(Math.abs(first.kick.pitch) + Math.abs(first.kick.yaw)).toBeGreaterThan(0.01);
    // Not the very next round, and that is the model rather than a flaky test:
    // hip fire is meant to leave the aim where it found it, so an M4's hip
    // `CenterSpeed` takes most rounds' kick back inside the cooldown
    // (docs/engine/player.md). What must not happen is the kick never surviving
    // at all — a magazine is enough rounds to establish that, and this shooter
    // is hip-firing because the cone above is a hip cone.
    // The yaw specifically, because the line below is off the x=0 plane only if
    // the kick that survived had one.
    let second = d.fire(12, CHEST);
    for (let i = 0; i < 25 && second.drawn.yaw === 0; i++) {
      second = d.fire(12, CHEST);
    }
    expect(Math.abs(second.drawn.pitch) + Math.abs(second.drawn.yaw)).toBeGreaterThan(0.01);
    const moved = aimDirection(aimAngles({ yaw: 0, pitch: second.pitch }, second.drawn), { x: 0, y: 0, z: 0 });
    // The line this one leaves along is the kicked one — off the x=0 plane, since
    // this weapon's kick has a yaw in it — and the round is again inside the cone
    // about *that* line rather than about the line of sight.
    expect(moved.x).not.toBeCloseTo(0, 6);
    expect(angleBetween(second.shot.direction, moved)).toBeLessThan(HIP_CONE_CEILING);
    // A different round, so a different draw: two shots of a burst share an aim
    // and must not share a deviation.
    const next = coneSample(shotStream(hashString("shooter"), second.shot.ordinal), { angle: 0, radius: 0 });
    expect(bearing(second.shot.direction, moved)).toBeCloseTo(next.angle, 6);
    expect(next.angle).not.toBe(sample.angle);
  }, 120_000);

  it("is judged at the moment its own input named, not at the present", async () => {
    const d = await duel(60);
    if (!d) {
      return;
    }
    const past = d.fire(12, CHEST);
    const now = d.fire(0, CHEST);

    const hitPast = past.shot.result as PlayerShot;
    const hitNow = now.shot.result as PlayerShot;
    expect(hitPast.kind).toBe("player");
    expect(hitNow.kind).toBe("player");
    expect(hitPast.id).toBe(d.target);

    // The two moments have to be further apart than the tolerance below, or
    // "judged then, not now" would pass on a rewind that did nothing.
    expect(Math.abs(reach(now.feet, CHEST) - reach(past.feet, CHEST))).toBeGreaterThan(1);

    // Each shot's distance is the separation at the tick *its own* input named —
    // not the other's, and not the one the tick it was fired on would give. The
    // half-metre is the body's own depth: the ray stops on their back.
    expect(hitPast.distance).toBeCloseTo(reach(past.feet, CHEST), 0);
    expect(hitNow.distance).toBeCloseTo(reach(now.feet, CHEST), 0);
    expect(Math.abs(hitNow.distance - hitPast.distance)).toBeGreaterThan(1);
  }, 120_000);

  it("aims where the player is looking, pitch and all", async () => {
    const d = await duel(60);
    if (!d) {
      return;
    }
    const chest = d.fire(12, CHEST);
    expect((chest.shot.result as PlayerShot).location).toMatch(/^(head|helmet|neck|torsoUpper|torsoLower)$/);

    // Knee height at the same range, which is a steeper look down. A pitch of the
    // wrong sign would put this as far *above* their head, so the leg is what
    // fixes the sign rather than merely showing that pitch is read at all.
    const low = d.fire(12, 0.5);
    expect(low.shot.direction.y).toBeLessThan(chest.shot.direction.y);
    expect((low.shot.result as PlayerShot).location).toMatch(/Leg|Foot/);

    // And over their head, which is the same argument upside down: a flipped sign
    // would aim this at their shins and hit them.
    const over = d.fire(12, 2.6);
    expect(over.shot.direction.y).toBeGreaterThan(0);
    expect(over.shot.result).toBeNull();
  }, 120_000);

  /**
   * The moment comes off the input that fired, and a tick can hold four of them.
   *
   * This is why the shot is taken inside `step`'s per-input loop and cannot be
   * hoisted out of it: a tick draining a client's backlog is draining four frames
   * of aiming, each drawn at its own time. Hoisting would judge every shot in the
   * tick against the last input's moment, which is the newest — and therefore
   * looks right on a standing target and is wrong by a metre on a running one.
   */
  it("takes the moment from the input that fired, not from the tick it was drained on", async () => {
    const d = await duel(60);
    if (!d) {
      return;
    }
    // One shot to get the weapon past its raise, then long enough off the trigger
    // that the next press fires at once — on the first input of the volley.
    d.fire(12, CHEST);
    for (let i = 0; i < 30; i++) {
      d.step(idleInput(0, 0), 0);
    }

    const past = d.feetAt.get(d.match.tick - 12)!;
    const present = d.feetAt.get(d.match.tick)!;
    expect(Math.abs(reach(present, CHEST) - reach(past, CHEST))).toBeGreaterThan(1);

    // Four inputs in one tick: the first aimed a fifth of a second ago, the rest
    // aimed at this instant. The trigger is down on all four, so the round leaves
    // on the first — and must be judged where that first input was looking.
    const pitch = Math.atan2(past.y + CHEST - EYE_HEIGHT, Math.abs(past.z));
    const firing: PlayerInput = { ...idleInput(0, pitch), fire: true };
    const shots = d.volley([
      { command: firing, lag: 12 },
      { command: firing, lag: 0 },
      { command: firing, lag: 0 },
      { command: firing, lag: 0 },
    ]);

    expect(shots).toHaveLength(1);
    const hit = shots[0]!.result as PlayerShot;
    expect(hit.kind).toBe("player");
    expect(hit.distance).toBeCloseTo(reach(past, CHEST), 0);
    expect(Math.abs(hit.distance - reach(present, CHEST))).toBeGreaterThan(1);
  }, 120_000);
});
