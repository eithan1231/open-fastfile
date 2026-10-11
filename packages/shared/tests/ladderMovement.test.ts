// Climbing a ladder as a movement step: grabbing one, climbing it where the view
// points, getting off at the top and the bottom, and jumping away — and the
// weapon going away for the length of it.
//
// The ones that would be quiet if they broke: getting off at the top has to
// land the player on the platform without the capsule ever sinking into it,
// and the whole of the state has to survive a JSON round-trip, or a server's
// replay of a climb would drift from the client's.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { CollisionWorld } from "../src/collision/world.js";
import { idleInput, type PlayerInput } from "../src/sim/input.js";
import {
  createMovement,
  EMPTY_HANDS,
  HEIGHT,
  movementEnv,
  PLAYER_MOVEMENT,
  RADIUS,
  stepMovement,
  type LadderMove,
  type MovementState,
} from "../src/sim/movement.js";
import { LadderVolumes, NO_LADDERS } from "../src/sim/moves/ladder.js";
import { UNIT } from "../src/sim/units.js";
import { MantleVolumes, NO_MANTLES } from "../src/sim/moves/mantle.js";
import { Player } from "../src/sim/player.js";
import { WeaponController } from "../src/sim/weapon.js";
import { WeaponRegistry, weaponKey, type WeaponEntry } from "../src/sim/weaponRegistry.js";
import { weaponDef } from "../testing/weaponDef.js";
import { movementSchema } from "../src/net/messages/player.js";
import { BitReader, BitWriter } from "../src/net/codec/bits.js";
import type { ResolvedLadder } from "../src/dsl/resolved.js";

const DT = 1 / 60;
const TOP = 3;
/** The game's `g_speed`, which a climb is a share of. */
const SPEED = 190 * UNIT;
/** Pitches where the view asks for full speed up, and full speed down. */
const LOOK_UP = 0.6;
const LOOK_DOWN = -0.9;

function collider(size: [number, number, number], at: [number, number, number]): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size));
  mesh.position.set(...at);
  mesh.userData.collide = true;
  return mesh;
}

/** The ladder, as the maps build one: a thin box of its own, against the face of what it climbs. */
const LADDER: ResolvedLadder = { id: 0, tags: [], position: { x: 0, y: TOP / 2, z: -2 }, yaw: 0, size: { x: 0.8, y: TOP, z: 0.2 } };

/**
 * A floor at y = 0, a 3 m platform from z = -2.1 back with the ladder against
 * its face, and a player standing in front of it facing -Z.
 */
function setup(ladders: ResolvedLadder[] = [LADDER]) {
  const root = new THREE.Group();
  root.add(
    collider([40, 1, 40], [0, -0.5, 0]),
    collider([40, TOP, 8], [0, TOP / 2, -6.1]),
    // The ladder is a wall, exactly as the clipmap's player-clip brush is.
    collider([0.8, TOP, 0.2], [0, TOP / 2, -2]),
  );
  const collision = new CollisionWorld();
  collision.rebuild(root);
  const volumes = new LadderVolumes(ladders);
  // Further from the ladder than the 30 units a falling player reaches for one.
  const state = createMovement({ x: 0, y: 0, z: 0 }, 0, 0);
  const input = idleInput(0, 0);
  const env = movementEnv(collision, { mantles: NO_MANTLES, ladders: volumes }, PLAYER_MOVEMENT);
  const run = (seconds: number, each?: () => void) => {
    for (let t = 0; t < seconds - 1e-9; t += DT) {
      stepMovement(state, input, DT, env, EMPTY_HANDS);
      each?.();
    }
  };
  run(0.3); // settle onto the floor
  return { state, input, run, collision, volumes, env };
}

/** Walk into the ladder until it is held. */
function grab(ctx: ReturnType<typeof setup>) {
  ctx.input.forward = 1;
  ctx.run(1);
  expect(ctx.state.move.kind).toBe("ladder");
}

/** Press jump for one step and let it go. */
function press(input: PlayerInput, run: (s: number) => void) {
  input.jump = true;
  run(DT);
  input.jump = false;
}

describe("ladders", () => {
  it("is grabbed by walking into it, and not by standing in front of it", () => {
    const idle = setup();
    idle.state.feet.z = -2 + 0.1 + RADIUS;
    idle.run(0.5);
    expect(idle.state.move.kind).toBe("walk");

    const walking = setup();
    grab(walking);
    // Its side faces the player: the facing points back along +Z.
    expect(Math.cos((walking.state.move as LadderMove).facing)).toBeCloseTo(-1, 6);
  });

  it("is not grabbed walking into it backwards, or where the world has no ladder", () => {
    const back = setup();
    back.input.yaw = Math.PI;
    back.input.forward = -1;
    back.run(1);
    expect(back.state.move.kind).toBe("walk");

    const none = setup([]);
    none.input.forward = 1;
    none.run(1);
    expect(none.state.move.kind).toBe("walk");
  });

  it("climbs where the view points: up looking up, down looking down, at half the game's speed", () => {
    const ctx = setup();
    grab(ctx);
    ctx.input.pitch = LOOK_UP;
    ctx.run(0.4);
    expect(ctx.state.velocity.y).toBeCloseTo(SPEED * 0.5, 3);
    expect(ctx.state.feet.y).toBeGreaterThan(0.5);

    ctx.input.pitch = LOOK_DOWN;
    ctx.run(0.4);
    // The push into the ladder shares the approach, so this one is only close.
    expect(ctx.state.velocity.y).toBeCloseTo(-SPEED * 0.5, 1);
    expect(ctx.state.move.kind).toBe("ladder");
  });

  it("climbs slower looking level, and faster the higher the view", () => {
    const speedAt = (pitch: number) => {
      const ctx = setup();
      grab(ctx);
      ctx.input.pitch = pitch;
      ctx.run(0.4);
      return ctx.state.velocity.y;
    };
    // (sin(pitch) + 0.25) × 2.5 of full speed, clamped: 0.625 looking level.
    expect(speedAt(0)).toBeCloseTo(SPEED * 0.5 * 0.625, 3);
    expect(speedAt(0.05)).toBeGreaterThan(speedAt(0));
    expect(speedAt(LOOK_UP)).toBeGreaterThan(speedAt(0.05));
  });

  it("moves sideways on the strafe keys, and stops when they are let go", () => {
    const ctx = setup();
    grab(ctx);
    ctx.input.pitch = LOOK_UP;
    ctx.run(0.3);
    ctx.input.right = 1;
    ctx.run(0.2);
    const before = ctx.state.feet.x;
    ctx.run(0.1);
    expect(ctx.state.feet.x).toBeGreaterThan(before);
    // Diagonal: the game's command scale shares one speed between the two keys.
    expect(ctx.state.velocity.x).toBeCloseTo(SPEED * 0.2 * Math.SQRT1_2, 1);
    ctx.input.right = 0;
    ctx.run(0.2);
    expect(ctx.state.velocity.x).toBeCloseTo(0, 9);
  });

  it("stops climbing the step forward is let go, and stops sliding the step strafe is", () => {
    const ctx = setup();
    grab(ctx);
    ctx.input.pitch = LOOK_UP;
    ctx.input.right = 1;
    ctx.run(0.4);
    expect(ctx.state.velocity.y).toBeGreaterThan(1);
    ctx.input.forward = 0;
    ctx.run(DT);
    expect(ctx.state.velocity.y).toBe(0);
    // Still sliding sideways, which is the other key's business.
    expect(Math.abs(ctx.state.velocity.x)).toBeGreaterThan(0.5);
    const height = ctx.state.feet.y;
    ctx.input.right = 0;
    ctx.run(DT);
    expect(ctx.state.velocity.x).toBeCloseTo(0, 9);
    const x = ctx.state.feet.x;
    ctx.run(0.5);
    expect(ctx.state.feet.y).toBeCloseTo(height, 9);
    expect(ctx.state.feet.x).toBeCloseTo(x, 6);
  });

  it("holds the player where they are when every key is let go: no gravity", () => {
    const ctx = setup();
    grab(ctx);
    ctx.input.pitch = LOOK_UP;
    ctx.run(0.6);
    ctx.input.forward = 0;
    ctx.run(DT);
    const height = ctx.state.feet.y;
    ctx.run(1);
    expect(ctx.state.move.kind).toBe("ladder");
    expect(ctx.state.feet.y).toBeCloseTo(height, 6);
  });

  it("gets off at the top onto the platform, never sinking into anything on the way", () => {
    const ctx = setup();
    grab(ctx);
    ctx.input.pitch = LOOK_UP;
    let sunk = 0;
    // Long enough to get over, short enough not to walk off the platform's far end.
    ctx.run(2, () => {
      if (ctx.collision.overlapsCapsule(ctx.state.feet, RADIUS, HEIGHT)) {
        sunk++;
      }
    });
    expect(sunk).toBe(0);
    expect(ctx.state.move.kind).toBe("walk");
    expect(ctx.state.grounded).toBe(true);
    expect(ctx.state.feet.y).toBeCloseTo(TOP, 2);
    expect(ctx.state.feet.z).toBeLessThan(-2.1);
  });

  it("lets go at the bottom when forward is let go on the ground", () => {
    const ctx = setup();
    // Looking down, forward climbs down: into the floor, so they stay on it.
    ctx.input.pitch = LOOK_DOWN;
    grab(ctx);
    expect(ctx.state.grounded).toBe(true);
    ctx.input.forward = 0;
    ctx.run(DT);
    expect(ctx.state.move.kind).toBe("walk");
    // The ground clears the lock at once: walking back in grabs it again.
    ctx.input.forward = 1;
    ctx.run(0.2);
    expect(ctx.state.move.kind).toBe("ladder");
  });

  it("jumps away from the ladder on a new press, looking at it or away from it", () => {
    for (const yaw of [0, Math.PI]) {
      const ctx = setup();
      grab(ctx);
      ctx.input.pitch = LOOK_UP;
      ctx.run(0.5);
      ctx.input.yaw = yaw;
      ctx.input.forward = 0;
      ctx.run(DT);
      press(ctx.input, ctx.run);
      expect(ctx.state.move.kind).toBe("walk");
      expect(ctx.state.ladderLock).toBe(false);
      // Away from the ladder, which is at -Z, at the game's push-off speed.
      expect(Math.hypot(ctx.state.velocity.x, ctx.state.velocity.z)).toBeCloseTo(128 * UNIT, 1);
      expect(ctx.state.velocity.z).toBeGreaterThan(0);
    }
  });

  it("does not throw a player off for holding jump", () => {
    const ctx = setup();
    // Bouncing at it with jump held: grabbed on one of the jumps, and kept. The
    // view is where forward neither climbs nor descends, so it stays put there.
    ctx.input.jump = true;
    ctx.input.forward = 1;
    ctx.input.pitch = Math.asin(-0.25);
    ctx.run(1.5);
    expect(ctx.state.move.kind).toBe("ladder");
    ctx.run(1);
    expect(ctx.state.move.kind).toBe("ladder");
    ctx.input.jump = false;
    ctx.run(0.5);
    press(ctx.input, ctx.run);
    expect(ctx.state.move.kind).toBe("walk");
  });

  it("is grabbed no sooner than 0.3 s after a jump, and jumped off no sooner than 0.5 s", () => {
    const ctx = setup();
    // Further from the ladder than the 8 units a standing player reaches, and within the 30 a jumping one does.
    ctx.state.feet.z = -1.35;
    ctx.input.forward = 1;
    press(ctx.input, ctx.run);
    ctx.run(0.2);
    expect(ctx.state.move.kind).toBe("walk");
    ctx.run(0.15);
    expect(ctx.state.move.kind).toBe("ladder");
    expect(ctx.state.sinceJump).toBeLessThan(0.5);
    press(ctx.input, ctx.run);
    expect(ctx.state.move.kind).toBe("ladder");
    ctx.run(0.2);
    press(ctx.input, ctx.run);
    expect(ctx.state.move.kind).toBe("walk");
  });

  it("is not grabbed again after falling off until the player has landed", () => {
    const ctx = setup();
    grab(ctx);
    ctx.input.pitch = LOOK_UP;
    ctx.run(0.6);
    // Backwards off it: in the air, looking away does not let go, but pulling back
    // with the view level climbs down — so walk out sideways instead.
    ctx.input.forward = 0;
    ctx.input.right = 1;
    ctx.run(0.75);
    expect(ctx.state.move.kind).toBe("walk");
    expect(ctx.state.grounded).toBe(false);
    expect(ctx.state.ladderLock).toBe(true);
    // Straight back in front of it while still falling: the lock holds.
    ctx.state.feet.x = 0;
    ctx.input.right = 0;
    ctx.run(DT);
    expect(ctx.state.move.kind).toBe("walk");
    ctx.run(1);
    expect(ctx.state.grounded).toBe(true);
    expect(ctx.state.ladderLock).toBe(false);
  });

  it("holds the view within 100 degrees of the ladder in the air", () => {
    const ctx = setup();
    grab(ctx);
    ctx.input.pitch = LOOK_UP;
    ctx.run(0.5);
    ctx.input.yaw = 2.5; // 143 degrees round from facing the ladder
    ctx.run(DT);
    expect(ctx.state.move.kind).toBe("ladder");
    expect(ctx.state.yaw).toBeCloseTo((100 * Math.PI) / 180, 6);
  });

  it("survives a JSON round-trip in lockstep", () => {
    const ctx = setup();
    let copy: MovementState = JSON.parse(JSON.stringify(ctx.state));
    const script = (i: number) => {
      ctx.input.forward = i < 150 ? 1 : 0;
      ctx.input.right = i >= 60 && i < 80 ? 1 : 0;
      ctx.input.pitch = i < 100 ? LOOK_UP : -0.1;
      ctx.input.jump = i === 130;
    };
    for (let i = 0; i < 200; i++) {
      script(i);
      stepMovement(ctx.state, ctx.input, DT, ctx.env, EMPTY_HANDS);
      stepMovement(copy, ctx.input, DT, ctx.env, EMPTY_HANDS);
      copy = JSON.parse(JSON.stringify(copy));
      // Against a JSON copy too: JSON has no -0, and friction stops a player on one.
      expect(copy).toEqual(JSON.parse(JSON.stringify(ctx.state)));
    }
  });

  it("round-trips through the wire codec, and costs only the move's tag when nobody is on one", () => {
    const ctx = setup();
    const size = (s: MovementState) => {
      const writer = new BitWriter();
      movementSchema.write(writer, s);
      return writer.finish();
    };
    const idle = size(ctx.state).byteLength;
    grab(ctx);
    const bytes = size(ctx.state);
    expect(bytes.byteLength).toBeGreaterThan(idle);
    const decoded = movementSchema.read(new BitReader(bytes));
    expect((decoded.move as LadderMove).facing).toBeCloseTo((ctx.state.move as LadderMove).facing, 4);
    expect(decoded.jumpHeld).toBe(ctx.state.jumpHeld);
    expect(decoded.sinceJump).toBeCloseTo(ctx.state.sinceJump, 2);
  });
});

describe("the weapon on a climb", () => {
  /** A player at the foot of the ladder, holding the test rifle, ready to fire. */
  function armed() {
    const ctx = setup();
    const player = new Player(ctx.collision);
    player.setClimbs({ mantles: NO_MANTLES, ladders: ctx.volumes });
    const weapon = new WeaponController(weaponDef({ clipSize: 30 }));
    player.equip(weapon);
    weapon.ready();
    player.place({ x: 0, y: 0, z: 0 }, 0, 0);
    const input = idleInput(0, 0);
    const run = (seconds: number) => {
      for (let t = 0; t < seconds - 1e-9; t += DT) {
        player.step(input, DT);
      }
    };
    return { player, weapon, input, run };
  }

  it("goes away on a ladder, cannot fire there, and comes back after", () => {
    const { player, weapon, input, run } = armed();
    input.forward = 1;
    run(1);
    expect(player.movement.move.kind).toBe("ladder");
    expect(["dropping", "lowered"]).toContain(weapon.data.state);
    input.fire = true;
    input.reload = true;
    input.pitch = LOOK_UP;
    run(0.5);
    expect(weapon.data.state).toBe("lowered");
    expect(weapon.data.ammo).toBe(30);
    expect(player.snapshot().stowed).toBe(true);

    input.fire = false;
    input.reload = false;
    run(4); // over the top
    expect(player.movement.move.kind).toBe("walk");
    expect(player.snapshot().stowed).toBe(false);
    expect(weapon.data.state).toBe("idle");
  });

  it("goes away for a mantle too, so nothing is fired mid-climb", () => {
    // A 1 m step with a mantle volume on its edge, in place of the platform.
    const root = new THREE.Group();
    root.add(collider([40, 1, 40], [0, -0.5, 0]), collider([40, 1, 8], [0, 0.5, -7]));
    const world = new CollisionWorld();
    world.rebuild(root);
    const player = new Player(world);
    const mantles = new MantleVolumes([{ id: 0, tags: [], position: { x: 0, y: 0.5, z: -3 }, yaw: 0, size: { x: 4, y: 1, z: 0.5 } }]);
    player.setClimbs({ mantles, ladders: NO_LADDERS });
    const weapon = new WeaponController(weaponDef({ clipSize: 30 }));
    player.equip(weapon);
    weapon.ready();
    player.place({ x: 0, y: 0, z: -3 + 0.2 + RADIUS }, 0, 0);
    const input = idleInput(0, 0);
    for (let i = 0; i < 20; i++) {
      player.step(input, DT);
    }
    input.jump = true;
    player.step(input, DT);
    expect(player.mantling).toBe(true);
    input.fire = true;
    while (player.mantling) {
      player.step(input, DT);
    }
    expect(weapon.data.ammo).toBe(30);
    expect(weapon.data.state).not.toBe("firing");
  });

  it("finishes a swap the climb held up, rather than raising the old weapon over it", () => {
    const ctx = setup();
    const key = (id: string) => weaponKey({ game: "iw5", id });
    const entry = (id: string): WeaponEntry => ({
      id,
      game: "iw5",
      def: weaponDef({ weapon: id }),
      attachments: [],
      slot: id === "m9" ? "secondary" : "primary",
      class: id === "m9" ? "pistol" : "rifle",
    });
    const player = new Player(ctx.collision, new WeaponRegistry([entry("m4"), entry("m9")]));
    player.equipLoadout({ name: "Assault", game: "iw5", primary: { weapon: key("m4"), attachments: [] }, secondary: { weapon: key("m9"), attachments: [] } });
    player.weapon!.ready();
    // Standing against the ladder, so the swap and the grab come in one step.
    player.place({ x: 0, y: 0, z: -2 + 0.1 + RADIUS + 0.01 }, 0, 0);
    const input = idleInput(0, LOOK_DOWN);
    for (let t = 0; t < 0.3; t += DT) {
      player.step(input, DT);
    }
    // Only now: settling from `place` starts in the air, where the ladder is in reach.
    player.setClimbs({ mantles: NO_MANTLES, ladders: ctx.volumes });
    input.swap = true;
    input.forward = 1;
    player.step(input, DT);
    input.swap = false;
    for (let t = 0; t < 1; t += DT) {
      player.step(input, DT);
    }
    expect(player.movement.move.kind).toBe("ladder");
    expect(player.weaponId).toBe(key("m4"));
    expect(player.snapshot().swapping).toBe(true);
    input.forward = 0;
    for (let t = 0; t < 3; t += DT) {
      player.step(input, DT);
    }
    expect(player.movement.move.kind).toBe("walk");
    expect(player.weaponId).toBe(key("m9"));
    expect(player.weapon!.data.state).toBe("idle");
    expect(player.snapshot().swapping).toBe(false);
  });
});
