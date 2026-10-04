// A class, and the weapon swap it makes possible.
//
// The swap is the part worth guarding. It spans two ticks — a putaway, then the
// other weapon coming up — and a **server replays a client's inputs to check
// them**, so the two ends must arrive at the same hand from the same input. That
// is the whole reason `swapping` is in `PlayerState` rather than being a flag
// the client keeps to itself, and these tests are what say so.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { CollisionWorld } from "../src/collision/world.js";
import { Player } from "../src/sim/player.js";
import { idleInput, type PlayerInput } from "../src/sim/input.js";
import { RUN_SPEED, WALK_SPEED } from "../src/sim/movement.js";
import { defaultLoadout, defaultLoadouts, LOADOUT_COUNT, type Loadout } from "../src/sim/loadout.js";
import { WeaponRegistry, weaponKey, type WeaponEntry } from "../src/sim/weaponRegistry.js";
import { weaponDef } from "../testing/weaponDef.js";

const key = (id: string) => weaponKey({ game: "iw5", id });

/** A floor, so a stepped player has somewhere to stand. The swap does not care, but `stepMovement` does. */
function floor(): CollisionWorld {
  const root = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(40, 1, 40));
  mesh.position.set(0, -0.5, 0);
  mesh.userData.collide = true;
  root.add(mesh);
  const collision = new CollisionWorld();
  collision.rebuild(root);
  return collision;
}

const nowhere = floor();

/** Every clip role the swap uses, so a weapon can actually be put away and drawn. */
function entry(id: string, attachments: WeaponEntry["attachments"] = []): WeaponEntry {
  return { id, game: "iw5", def: weaponDef({ weapon: id }), attachments, slot: id === "m9" ? "secondary" : "primary", class: id === "m9" ? "pistol" : "rifle" };
}

const registry = new WeaponRegistry([entry("m4", [{ id: "acog", overrides: { adsZoomFov: 35 } }]), entry("m9")]);

function loadout(over: Partial<Loadout> = {}): Loadout {
  return {
    name: "Assault",
    game: "iw5",
    primary: { weapon: key("m4"), attachments: [] },
    secondary: { weapon: key("m9"), attachments: [] },
    ...over,
  };
}

/** Step `seconds` of play in sixtieths, holding `input`. Returns the player. */
function run(player: Player, seconds: number, input: PlayerInput = idleInput(0, 0)): Player {
  for (let t = 0; t < seconds; t += 1 / 60) {
    player.step(input, 1 / 60);
  }
  return player;
}

function armed(): Player {
  const player = new Player(nowhere, registry);
  player.equipLoadout(loadout());
  player.weapon!.ready();
  return player;
}

describe("a class", () => {
  it("gives a player five to start with, each named by its place and carrying nothing", () => {
    const classes = defaultLoadouts();
    expect(classes).toHaveLength(LOADOUT_COUNT);
    expect(classes[0]).toEqual({ name: "Class 1", game: null, primary: { weapon: null, attachments: [] }, secondary: { weapon: null, attachments: [] } });
    expect(defaultLoadout(4).name).toBe("Class 5");
  });

  it("puts the primary in hand and keeps the secondary on the player", () => {
    const player = armed();
    expect(player.weaponId).toBe(key("m4"));
    expect(player.canSwap).toBe(true);
  });

  /**
   * A class names its attachments and the simulation numbers them: the two
   * spellings exist because a stored class outlives the catalogue that gave the
   * numbers out (sim/loadout.ts).
   */
  it("turns the attachment names a class stores into the slots the wire carries", () => {
    const player = new Player(nowhere, registry);
    player.equipLoadout(loadout({ primary: { weapon: key("m4"), attachments: ["acog"] } }));
    expect(player.snapshot().attachments).toEqual([0]);
    expect(player.weapon!.def.adsZoomFov).toBe(35);
  });

  it("leaves a slot empty rather than substituting a weapon the catalogue does not hold", () => {
    const player = new Player(nowhere, registry);
    player.equipLoadout(loadout({ secondary: { weapon: key("nothing_mp"), attachments: [] } }));
    expect(player.weaponId).toBe(key("m4"));
    expect(player.canSwap).toBe(false);
  });

  it("carries only its own game's weapons, each in its category's slot", () => {
    const otherGame = new Player(nowhere, registry);
    otherGame.equipLoadout(loadout({ game: "iw4" }));
    expect(otherGame.weaponId).toBeNull();

    const noGame = new Player(nowhere, registry);
    noGame.equipLoadout(loadout({ game: null }));
    expect(noGame.weaponId).toBeNull();

    // A pistol named as the primary and a rifle as the secondary: neither is carried.
    const swapped = new Player(nowhere, registry);
    swapped.equipLoadout(loadout({ primary: { weapon: key("m9"), attachments: [] }, secondary: { weapon: key("m4"), attachments: [] } }));
    expect(swapped.weaponId).toBeNull();
    expect(swapped.canSwap).toBe(false);
  });

  it("holds the secondary when the class names no primary", () => {
    const player = new Player(nowhere, registry);
    player.equipLoadout(loadout({ primary: { weapon: null, attachments: [] } }));
    expect(player.weaponId).toBe(key("m9"));
  });
});

describe("swapping weapons", () => {
  const pressSwap = { ...idleInput(0, 0), swap: true };

  it("puts the held weapon away first, and the other comes up when it is gone", () => {
    const player = armed();
    player.step(pressSwap, 1 / 60);
    expect(player.weaponId).toBe(key("m4"));
    expect(player.weapon!.data.state).toBe("dropping");
    expect(player.snapshot().swapping).toBe(true);

    // The putaway is `drop` (0.4 s in this definition); the raise follows it.
    run(player, 0.5);
    expect(player.weaponId).toBe(key("m9"));
    expect(player.snapshot().swapping).toBe(false);
    expect(player.weapon!.data.state).toBe("raising");
  });

  /** `swap` is pressed, not held — so one press is one swap, and this presses twice. */
  it("swaps back, and the first weapon keeps the ammo it had", () => {
    const player = armed();
    player.weapon!.restore({ ...player.weapon!.data, ammo: 1 });

    player.step(pressSwap, 1 / 60);
    run(player, 1.5);
    expect(player.weaponId).toBe(key("m9"));

    player.step(pressSwap, 1 / 60);
    run(player, 1.5);
    expect(player.weaponId).toBe(key("m4"));
    expect(player.weapon!.data.ammo).toBe(1);
  });

  it("does nothing for a class with one weapon", () => {
    const player = new Player(nowhere, registry);
    player.equipLoadout(loadout({ secondary: { weapon: null, attachments: [] } }));
    player.weapon!.ready();
    run(player, 1, pressSwap);
    expect(player.weaponId).toBe(key("m4"));
  });

  it("ignores a second press while one is already running", () => {
    const player = armed();
    player.step(pressSwap, 1 / 60);
    const started = player.weapon!.data.timer;
    player.step(pressSwap, 1 / 60);
    expect(player.weapon!.data.timer).toBeLessThan(started);
    expect(player.weaponId).toBe(key("m4"));
  });

  /**
   * The reason `swapping` is on the wire. A server steps the same inputs from
   * the same state and must end up holding what the client predicted; without
   * the flag its putaway would simply end and leave the old weapon up.
   */
  it("is reproduced by a server replaying the same inputs", () => {
    const client = armed();
    const server = armed();

    for (let t = 0; t < 1; t += 1 / 60) {
      const input = t === 0 ? pressSwap : idleInput(0, 0);
      client.step(input, 1 / 60);
      server.step(input, 1 / 60);
    }
    expect(server.weaponId).toBe(client.weaponId);
    expect(server.snapshot()).toEqual(client.snapshot());
  });

  /** A peer is restored, never stepped: their new weapon arrives named, and the flag only stops them popping to it early. */
  it("reaches a peer as the weapon the snapshot names", () => {
    const them = armed();
    const us = new Player(nowhere, registry);
    us.equipLoadout(loadout());

    them.step(pressSwap, 1 / 60);
    us.restore(them.snapshot());
    expect(us.weaponId).toBe(key("m4"));
    expect(us.snapshot().swapping).toBe(true);

    run(them, 0.5);
    us.restore(them.snapshot());
    expect(us.weaponId).toBe(key("m9"));
    expect(us.snapshot().swapping).toBe(false);
  });
});

/**
 * A weapon is handed over `lowered`, a lowered weapon is never `sprinting`, and
 * `Player.step` hands that straight to `stepMovement` — so before equipping
 * raised one, an armed player walked for the whole match, until a climb's
 * putaway and raise happened to push the weapon out of `lowered`.
 */
describe("a weapon put in a player's hands", () => {
  const sprint: PlayerInput = { ...idleInput(0, 0), forward: 1, run: true };
  const speed = (player: Player) => Math.hypot(player.movement.velocity.x, player.movement.velocity.z);

  it("comes up, rather than staying lowered until something else raises it", () => {
    const byId = new Player(nowhere, registry);
    byId.equipById(key("m4"));
    expect(byId.weapon!.data.state).toBe("raising");
    expect(byId.weapon!.data.clip!.role).toBe("firstRaise");

    const byClass = new Player(nowhere, registry);
    byClass.equipLoadout(loadout());
    expect(byClass.weapon!.data.state).toBe("raising");
  });

  it("lets the player run, with no climb needed to get the weapon out of the way", () => {
    for (const arm of [(p: Player) => p.equipById(key("m4")), (p: Player) => p.equipLoadout(loadout())]) {
      const player = new Player(nowhere, registry);
      arm(player);

      // A player cannot sprint through the raise (0.8 s here) or the sprint's
      // own lead-in (0.25 s), which is faithful; they walk until both are done.
      run(player, 0.5, sprint);
      expect(player.weapon!.data.state).toBe("raising");
      expect(player.weapon!.sprinting).toBe(false);
      expect(speed(player)).toBeLessThan(WALK_SPEED + 0.01);

      run(player, 1.5, sprint);
      expect(player.weapon!.sprinting).toBe(true);
      expect(speed(player)).toBeCloseTo(RUN_SPEED, 1);
    }
  });

  /** The raise belongs to the weapon in hand. The secondary is still lowered when the swap hands it over. */
  it("leaves the other weapon on the player's back lowered", () => {
    const player = new Player(nowhere, registry);
    player.equipLoadout(loadout());
    run(player, 1); // the primary's raise plays out

    player.step({ ...idleInput(0, 0), swap: true }, 1 / 60);
    run(player, 0.5);
    expect(player.weaponId).toBe(key("m9"));
    // `raise({ quick: true })` from `finishSwap`, which only acts on a lowered
    // weapon: a secondary raised at equip would still be playing `firstRaise`.
    expect(player.weapon!.data.clip!.role).toBe("raise");
  });
});

/**
 * A server may hand a player weapons at any moment — a respawn, a class taking
 * effect at once, a script's `arm` — and the client must end up holding exactly
 * what it was handed. The snapshot carries both weapons and a count of armings
 * (`PlayerState.armed`), and these are what that buys.
 */
describe("weapons handed over by the server", () => {
  const pressSwap = { ...idleInput(0, 0), swap: true };
  const fire = { ...idleInput(0, 0), fire: true };

  it("reach the client whole: both weapons, what is on each, and which is in hand", () => {
    const server = armed();
    server.equipWeapons({ weapon: key("m9"), attachments: [] }, { weapon: key("m4"), attachments: ["acog"] });
    const client = armed();
    client.restore(server.snapshot());
    expect(client.carrying.map((held) => held.id)).toEqual([key("m9"), key("m4")]);
    expect(client.carrying[1]!.fitted).toEqual([0]);
    expect(client.weaponId).toBe(key("m9"));
  });

  it("take no notice of which game or slot a weapon is from, since a script chose them", () => {
    const player = new Player(nowhere, registry);
    player.equipWeapons({ weapon: key("m9"), attachments: [] }, null);
    expect(player.weaponId).toBe(key("m9"));
    expect(player.canSwap).toBe(false);
  });

  /** Same two weapons, fresh magazines: without the count, the spare the client emptied would stay empty until it was drawn. */
  it("refill a spare the client had emptied, when the server arms them again with the same two", () => {
    const swap = (player: Player) => {
      player.step(pressSwap, 1 / 60);
      run(player, 1);
    };
    const client = armed();
    const server = armed();
    swap(client);
    run(client, 0.3, fire);
    swap(client);
    expect(client.weaponId).toBe(key("m4"));

    server.equipLoadout(loadout());
    server.weapon!.ready(); // past `firstRaise`, which a swap waits for
    client.restore(server.snapshot());
    swap(client);
    swap(server);
    expect(client.weaponId).toBe(key("m9"));
    expect(client.weapon!.data.ammo).toBe(server.weapon!.data.ammo);
  });

  it("keep both weapons as they were when all the client got wrong was a swap", () => {
    const client = armed();
    const server = armed();
    const primary = client.weapon;
    client.step(pressSwap, 1 / 60);
    run(client, 1);
    expect(client.weaponId).toBe(key("m9"));
    client.restore(server.snapshot());
    expect(client.weaponId).toBe(key("m4"));
    expect(client.weapon).toBe(primary);
  });
});
