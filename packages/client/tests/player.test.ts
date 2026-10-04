// A player (engine/player/player.ts): movement and weapon stepped on one input,
// all of their changing state in one JSON-safe snapshot. And the local
// controls (engine/controls/firstPerson.ts) that turn devices into that input.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { CollisionWorld } from "@3d/shared/collision/world.js";
import { FirstPersonControls, type DeviceInput } from "../src/engine/controls/firstPerson.js";
import { idleInput, type PlayerInput } from "@3d/shared/sim/input.js";
import { EYE_HEIGHT, horizontalSpeed, RUN_SPEED, WALK_SPEED } from "@3d/shared/sim/movement.js";
import { Player, type PlayerState } from "@3d/shared/sim/player.js";
import { WeaponController } from "@3d/shared/sim/weapon.js";
import { weaponDef } from "@3d/shared/testing/weaponDef.js";
import { aimAngles } from "@3d/shared/sim/recoil.js";
import { hashString } from "@3d/shared/game/random.js";
import { DEFAULT_SENSITIVITY, radiansPerCount } from "../src/input/sensitivity.js";

const DT = 1 / 60;

function floor(): CollisionWorld {
  const root = new THREE.Group();
  const slab = new THREE.Mesh(new THREE.BoxGeometry(40, 1, 40));
  slab.position.set(0, -0.5, 0);
  slab.userData.collide = true;
  root.add(slab);
  const collision = new CollisionWorld();
  collision.rebuild(root);
  return collision;
}

/** A player standing on a floor, holding the test rifle (30 rounds), ready to fire. */
function armed(world = floor()) {
  const player = new Player(world);
  const weapon = new WeaponController(weaponDef({ clipSize: 30 }));
  player.equip(weapon);
  weapon.ready();
  player.setSpawn({ x: 0, y: 1.6, z: 0 }, { x: 0, y: 1.6, z: -1 });
  player.respawn();
  const input = idleInput(0, 0);
  for (let i = 0; i < 30; i++) {
    player.step(input, DT);
  } // settle onto the floor
  return { player, weapon, input };
}

describe("Player", () => {
  it("keeps all its state in its snapshot: a JSON copy plays in lockstep with the original", () => {
    const world = floor();
    const a = armed(world);
    const cues: string[] = [];
    a.weapon.on((e) => (e.type === "shot" || e.type === "reloaded") && cues.push(e.type));
    const script = (player: Player, from: number, to: number) => {
      const input: PlayerInput = idleInput(0.3, 0);
      for (let i = from; i < to; i++) {
        input.forward = i < 200 ? 1 : 0;
        input.run = i >= 20 && i < 90;
        input.fire = i >= 100 && i < 130;
        input.ads = i >= 110 && i < 160;
        input.jump = i === 60 || i === 170;
        input.reload = i === 140;
        input.yaw += 0.01;
        player.step(input, DT);
      }
    };
    script(a.player, 0, 75); // mid-sprint, mid-jump
    const b = armed(world);
    b.player.restore(JSON.parse(JSON.stringify(a.player.snapshot())) as PlayerState);
    script(a.player, 75, 300);
    script(b.player, 75, 300);
    expect(b.player.snapshot()).toEqual(a.player.snapshot());
    expect(cues).toContain("shot");
    expect(cues.at(-1)).toBe("reloaded");
  });

  it("sprints only while the weapon lets it: firing slows a sprint to a walk", () => {
    const { player, input } = armed();
    Object.assign(input, { forward: 1, run: true });
    for (let i = 0; i < 60; i++) {
      player.step(input, DT);
    }
    expect(horizontalSpeed(player.movement)).toBeCloseTo(RUN_SPEED, 3);
    input.fire = true;
    for (let i = 0; i < 30; i++) {
      player.step(input, DT);
    }
    expect(horizontalSpeed(player.movement)).toBeCloseTo(WALK_SPEED, 3);
  });

  it("respawns below the kill plane, facing the spawn's way", () => {
    const player = new Player(new CollisionWorld()); // nothing to stand on
    // A spawn's `at` is an eye, so the feet it implies are an eye height under it.
    const eye = 10 + EYE_HEIGHT;
    player.setSpawn({ x: 5, y: eye, z: 0 }, { x: 6, y: eye, z: 0 });
    player.setKillPlane(0);
    player.place({ x: 0, y: 1, z: 0 }, 0, 0);
    const input = idleInput(0, 0);
    for (let i = 0; i < 60 && player.movement.feet.x === 0; i++) {
      player.step(input, DT);
    }
    expect(player.movement.feet).toEqual({ x: 5, y: 10, z: 0 });
    expect(player.movement.yaw).toBeCloseTo(-Math.PI / 2);
  });

  /** In a match the fall is a death, and both ends stop the player at the same step for the server to deal it. */
  it("holds them where they fell instead, when passing the kill plane is a death", () => {
    const player = new Player(new CollisionWorld());
    player.setSpawn({ x: 5, y: 10 + EYE_HEIGHT, z: 0 }, { x: 6, y: 10 + EYE_HEIGHT, z: 0 });
    player.setKillPlane(0);
    player.setFallOut("die");
    player.place({ x: 0, y: 1, z: 0 }, 0, 0);
    const input = idleInput(0, 0);
    for (let i = 0; i < 60 && !player.outOfWorld; i++) {
      player.step(input, DT);
    }
    expect(player.outOfWorld).toBe(true);
    const fell = { ...player.movement.feet };
    for (let i = 0; i < 10; i++) {
      player.step({ ...input, forward: 1 }, DT);
    }
    expect(player.movement.feet).toEqual(fell);
    expect(fell.x).toBe(0);
    player.respawn();
    expect(player.outOfWorld).toBe(false);
  });
});

describe("FirstPersonControls", () => {
  function controls() {
    const held = new Set<string>();
    const pressed = new Set<string>();
    const look = { x: 0, y: 0 };
    const input: DeviceInput = {
      locked: true,
      isHeld: (a) => held.has(a),
      takePressed: (a) => pressed.delete(a),
      takeLook: () => ({ ...look }),
    };
    const view = new THREE.PerspectiveCamera();
    const fp = new FirstPersonControls(view, input, floor());
    cameras.set(fp, view);
    fp.player.place({ x: 0, y: 0, z: 0 }, 0, 0);
    for (let i = 0; i < 30; i++) {
      fp.update(DT);
    }
    return { fp, held, pressed, look };
  }

  /** The camera each controller was built with; it keeps its own private. */
  const cameras = new WeakMap<FirstPersonControls, THREE.PerspectiveCamera>();
  const camera = (fp: FirstPersonControls) => cameras.get(fp)!;

  it("draws the view kick between ticks, so a fast display does not see a staircase", () => {
    // The kick is simulation and moves once a tick; the camera is placed every
    // frame. Drawn live it holds still for two or three frames and then jumps,
    // and a round's whole upward throw lasts about a tick and a half — which is
    // exactly the range where that reads as a stutter rather than as a kick.
    const { fp, held } = controls();
    const kicking = weaponDef({
      clipSize: 30,
      motion: { hipViewKickPitchMin: 80, hipViewKickPitchMax: 100, hipViewKickCenterSpeed: 500 },
    });
    const weapon = new WeaponController(kicking);
    fp.player.setSeed(hashString("abc12345"));
    fp.player.equip(weapon);
    weapon.ready();
    fp.player.place({ x: 0, y: 0, z: 0 }, 0, 0);

    // Up to the tick that fires: that is the tick with a kick in it to draw.
    held.add("fire");
    for (let i = 0; i < 300 && fp.player.snapshot().weapon!.fired === 0; i++) {
      fp.update(DT);
    }
    expect(fp.player.snapshot().weapon!.fired).toBe(1);

    // Then frames far shorter than a tick. None of them steps the simulation, so
    // a camera drawn from the live kick would not move at all across them.
    const fired = fp.player.snapshot().weapon!.fired;
    const seen: number[] = [];
    for (let i = 0; i < 4; i++) {
      fp.update(DT / 8);
      seen.push(camera(fp).rotation.x);
    }
    expect(fp.player.snapshot().weapon!.fired).toBe(fired);
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]!).toBeGreaterThan(seen[i - 1]!);
    }
  });

  it("does not lose a jump pressed and released between two frames", () => {
    const { fp, pressed } = controls();
    pressed.add("jump");
    fp.update(DT);
    expect(fp.player.movement.velocity.y).toBeGreaterThan(0);
  });

  it("reports the mouse's turn, not a teleport's", () => {
    const { fp, look } = controls();
    fp.player.place({ x: 0, y: 0, z: 0 }, 2, 0); // an arrival facing elsewhere
    look.x = -100; // 100 counts to the left
    fp.update(DT);
    // The default sensitivity, in radians: 100 counts at 3 x m_yaw (input/sensitivity.ts).
    const turn = 100 * radiansPerCount(DEFAULT_SENSITIVITY);
    expect(fp.turn.yaw).toBeCloseTo(turn, 6);
    expect(fp.player.movement.yaw).toBeCloseTo(2 + turn, 4);
  });

  it("scales the aim by the view's zoom, so a scope does not cost its own magnification in precision", () => {
    const { fp, look } = controls();
    fp.setZoom(0.25); // a 4x scope
    look.x = -100;
    fp.update(DT);
    expect(fp.turn.yaw).toBeCloseTo(100 * radiansPerCount(DEFAULT_SENSITIVITY) * 0.25, 6);
  });

  it("takes the player's sensitivity, and never a nonsensical one", () => {
    const { fp, look } = controls();
    fp.setSensitivity(1);
    look.x = -100;
    fp.update(DT);
    expect(fp.turn.yaw).toBeCloseTo(100 * radiansPerCount(1), 6);

    // Out of range or not a number at all: clamped to the range rather than
    // handed to the view, where a NaN would take the camera out of the world.
    fp.setSensitivity(Number.NaN);
    look.x = -100;
    fp.update(DT);
    expect(fp.turn.yaw).toBeCloseTo(100 * radiansPerCount(DEFAULT_SENSITIVITY), 6);
  });

  /**
   * The compounding loop, on the end it actually lives on.
   *
   * `viewYaw()` reads `movement.yaw`, `readInput` sends it as `PlayerInput.yaw`,
   * and `stepMovement` assigns it straight back. So a kick applied anywhere but
   * at the camera is read back as the player's own intent on the next tick and
   * climbs every tick after that, with nothing to stop it.
   */
  it("kicks the camera and not the player: a magazine leaves the view angles where the mouse did", () => {
    const { fp, held } = controls();
    // The MW3 L96's own hip view kick (worlds/catalog/weapons/iw5/iw5_l96a1_mp).
    // Its pitch pair is 80 / 100 — both ends above zero, so every shot kicks the
    // same way and the camera can only end up above the player's own pitch if the
    // sign is right; its yaw pair is -50 / -55, which is not symmetric either. The
    // gun kick is here as well, and deliberately: it must reach the model and not
    // the camera, which is what the last two lines hold.
    const kicking = weaponDef({
      clipSize: 30,
      motion: {
        hipGunKickPitchMin: 5,
        hipGunKickPitchMax: -15,
        hipGunKickYawMin: 5,
        hipGunKickYawMax: -5,
        hipGunKickSpeedDecay: 16,
        hipGunKickStaticDecay: 20,
        hipViewKickPitchMin: 80,
        hipViewKickPitchMax: 100,
        hipViewKickYawMin: -50,
        hipViewKickYawMax: -55,
        hipViewKickCenterSpeed: 500,
      },
    });
    const weapon = new WeaponController(kicking);
    fp.player.setSeed(hashString("abc12345"));
    fp.player.equip(weapon);
    weapon.ready();
    fp.player.place({ x: 0, y: 0, z: 0 }, 0, 0);

    held.add("fire");
    for (let i = 0; i < 300 && fp.player.snapshot().weapon!.fired < 30; i++) {
      fp.update(DT);
    }

    expect(fp.player.snapshot().weapon!.fired).toBe(30);
    expect(fp.player.movement.yaw).toBe(0);
    expect(fp.player.movement.pitch).toBe(0);

    // The camera, meanwhile, has been pushed off the player's own angles — up,
    // which is the direction this weapon's view kick climbs, and to one side.
    const state = fp.player.snapshot().weapon!;
    const aim = aimAngles(fp.player.movement, state.viewKick);
    // Two places rather than nine: the camera draws the kick *between* ticks
    // (`previousKick`), so on a frame that has not reached the next tick it is a
    // fraction of a tick behind the simulation by design — and this weapon is
    // hard against `VIEW_KICK_LIMIT`, where a tick's step is at its largest. What
    // this test is about is that the kick reaches the camera and never the
    // player's own angles.
    // Within a tick's worth rather than exact: the camera draws the kick *between*
    // ticks (`previousKick`), so on a frame that has not reached the next tick it
    // is a fraction of a tick behind the simulation by design — and this weapon
    // sits hard against `VIEW_KICK_LIMIT`, where a tick's step is at its largest.
    // Six-tenths of a degree against a kick of ten: this still tells "the kick
    // reaches the camera" from "it does not".
    const LAG = 0.01; // radians
    expect(Math.abs(camera(fp).rotation.y - aim.yaw)).toBeLessThan(LAG);
    expect(Math.abs(camera(fp).rotation.x - aim.pitch)).toBeLessThan(LAG);
    expect(aim.pitch).toBeGreaterThan(0.001);
    expect(aim.yaw).toBeLessThan(-0.001);
    // And the gun kick is not in the camera. It is real here — the same weapon
    // carries both — so a build still feeding it to `aimAngles` would put the
    // camera somewhere neither of the two lines above allows.
    expect(Math.abs(state.kick.pitch)).toBeGreaterThan(0.05);
    expect(camera(fp).rotation.x).not.toBeCloseTo(aimAngles(fp.player.movement, state.kick).pitch, 6);
  });

  it("holds a pose still, looking allowed, until a movement key", () => {
    const { fp, held, look } = controls();
    fp.player.place({ x: 0, y: 5, z: 0 }, 0, 0); // in the air: gravity would pull it down
    fp.setFrozen(true);
    let released = false;
    fp.onUnfreeze = () => (released = true);
    look.x = 10;
    for (let i = 0; i < 30; i++) {
      fp.update(DT);
    }
    expect(fp.player.movement.feet.y).toBe(5);
    expect(fp.player.movement.yaw).not.toBe(0);
    held.add("forward");
    fp.update(DT);
    expect(released).toBe(true);
    expect(fp.player.movement.feet.y).toBeLessThan(5);
  });
});
