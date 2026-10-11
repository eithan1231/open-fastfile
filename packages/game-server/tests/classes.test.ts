// What a gametype's scripts may say about classes, and what they may hand a
// player themselves — and the one death nobody gets to argue with.
//
// Everything a client is told arrives through a snapshot, so these read the
// wire's own `PlayerState` rather than reaching into the match: `weaponIndex` for
// what is in hand, and `armed` for whether the server handed anything over.

import { describe, expect, it } from "vitest";
import type { ResolvedWorld } from "@3d/shared/dsl/resolved.js";
import { catalogueViewOf } from "@3d/shared/game/catalogueView.js";
import type { CastChoice } from "@3d/shared/game/cast.js";
import type { ClassRequest, ClassRules } from "@3d/shared/game/classes.js";
import type { DamageCause } from "@3d/shared/game/damage.js";
import { defaultGametype } from "@3d/shared/game/gametypes/default.js";
import type { Script, ServerHooks } from "@3d/shared/game/hooks.js";
import type { GameEvent } from "@3d/shared/net/messages/events.js";
import type { PlayerId } from "@3d/shared/net/messages/fields.js";
import type { PlayerSnapshot } from "@3d/shared/net/messages/snapshot.js";
import { idleInput } from "@3d/shared/sim/input.js";
import type { Loadout } from "@3d/shared/sim/loadout.js";
import { CATALOG_VERSION, WeaponRegistry, type WeaponEntry } from "@3d/shared/sim/weaponRegistry.js";
import { weaponDef } from "@3d/shared/testing/weaponDef.js";
import * as THREE from "three";
import { SEGMENT_BONES } from "@3d/shared/sim/ragdollBones.js";
import type { BodyView, LoadedBody } from "../src/bodies.js";
import { Match } from "../src/match/match.js";

const TICK_RATE = 60;
const DT = 1 / TICK_RATE;
const RIFLE = "iw5/rifle_mp";
const SMG = "iw5/smg_mp";
const PISTOL = "iw5/pistol_mp";
const LAUNCHER = "iw5/launcher_mp";

/** A floor at y=0 that holds up anything above it, and nothing below it. */
const ground = {
  ready: true,
  resolveCapsule(
    position: { x: number; y: number; z: number },
    _r: number,
    _h: number,
    out?: { position: { x: number; y: number; z: number }; grounded: boolean },
  ) {
    const result = out ?? { position: { x: 0, y: 0, z: 0 }, grounded: false };
    result.position.x = position.x;
    result.position.y = position.y >= -0.5 ? Math.max(position.y, 0) : position.y;
    result.position.z = position.z;
    result.grounded = position.y <= 0 && position.y >= -0.5;
    return result;
  },
  overlapsCapsule: () => false,
  groundBelow: (from: { y: number }, distance: number) => (from.y >= 0 && from.y - distance <= 0 ? 0 : null),
  surfaceAt: () => null,
  traceRay: () => null,
};

function world(): ResolvedWorld {
  return {
    game: "iw5",
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

const entry = (id: string, weaponClass: string, attachments: WeaponEntry["attachments"] = []): WeaponEntry => ({
  id,
  game: "iw5",
  slot: weaponClass === "pistol" ? "secondary" : "primary",
  class: weaponClass,
  def: weaponDef({ weapon: id, clipSize: 30 }),
  attachments,
});
const registry = new WeaponRegistry([
  entry("rifle_mp", "rifle", [{ id: "acog", overrides: {} }]),
  entry("smg_mp", "smg"),
  entry("pistol_mp", "pistol"),
  entry("launcher_mp", "rocketlauncher"),
]);

const classOf = (primary: string): Loadout => ({
  name: primary,
  game: "iw5",
  primary: { weapon: primary, attachments: [] },
  secondary: { weapon: PISTOL, attachments: [] },
});
const RIFLE_CLASS = classOf(RIFLE);
const SMG_CLASS = classOf(SMG);

/** The default weapon: what a player with no class — or a refused one — spawns holding. */
const CAST: CastChoice = {
  characters: [{ id: "dummy", body: { kind: "characters", game: "iw5", id: "dummy", file: "dummy.glb" } }],
  animations: { kind: "animations", game: "iw5", id: "clips", file: "clips.glb" },
  hands: { kind: "hands", game: "iw5", id: "hands", file: "hands.glb" },
  defaultWeapon: LAUNCHER,
};

/**
 * One body for everybody, with a bone for every ragdoll segment and nothing else:
 * enough for a death to describe the corpse it leaves, which is what says whether
 * it left one.
 */
function stubBodies(): BodyView {
  const root = new THREE.Object3D();
  for (const bone of Object.values(SEGMENT_BONES)) {
    root.add(Object.assign(new THREE.Object3D(), { name: bone }));
  }
  const body = { id: "dummy", game: "iw5", rig: { root }, poser: { update: () => undefined }, boxes: { trace: () => null } } as unknown as LoadedBody;
  return { get: () => body };
}

function game(options: { rules?: Partial<ClassRules>; hooks?: ServerHooks; players?: PlayerId[] } = {}) {
  const script: Script = {
    id: "test",
    server: { classRules: () => options.rules, combatRules: () => ({ respawnDelay: 1 }), ...options.hooks },
    client: { cast: () => CAST },
  };
  const match = new Match(ground, world(), TICK_RATE, 8, registry, {
    map: "test",
    gametype: defaultGametype,
    catalogue: catalogueViewOf({ version: CATALOG_VERSION }, registry),
    bodies: stubBodies(),
    scripts: [script],
  });
  let seq = 0;
  let latest: PlayerSnapshot[] = [];
  const told: GameEvent[] = [];
  for (const id of options.players ?? []) {
    match.join(id, RIFLE_CLASS, "", 0);
  }
  const tick = (ticks = 1) => {
    for (let i = 0; i < ticks; i++) {
      for (const { id } of match.report()) {
        match.receive(id, { seq: ++seq, dt: DT, input: idleInput(0, 0), claim: { x: 0, y: 0, z: 0 }, drawn: { tick: 0, frac: 0 } });
      }
      latest = match.step().players;
      const first = latest[0];
      if (first) {
        for (const event of match.snapshotFor(first.id, latest).events) {
          if (!told.some((seen) => seen.id === event.id)) {
            told.push(event);
          }
        }
      }
    }
  };
  const state = (id: PlayerId) => latest.find((p) => p.id === id)!.state;
  const held = (id: PlayerId) => registry.idAt(state(id).weaponIndex);
  const spare = (id: PlayerId) => registry.idAt(state(id).spareIndex);
  return { match, tick, state, held, spare, told };
}

describe("a class chosen mid-game, by default", () => {
  it("waits for the next spawn, and changes nothing about what is in hand until then", () => {
    const g = game({ players: ["a"] });
    g.tick();
    const armed = g.state("a").armed;
    expect(g.match.chooseLoadout("a", SMG_CLASS, 1)).toBe("nextSpawn");
    g.tick();
    expect(g.held("a")).toBe(RIFLE);
    expect(g.state("a").armed).toBe(armed);
  });

  /** The client re-sends until it is answered, and a repeat must not refill a magazine. */
  it("treats the class in hand chosen again as nothing, and it cancels a change still waiting", () => {
    const g = game({ players: ["a"], rules: { grace: 10 } });
    g.tick();
    const armed = g.state("a").armed;
    expect(g.match.chooseLoadout("a", RIFLE_CLASS, 0)).toBe("now");
    g.tick();
    expect(g.state("a").armed).toBe(armed);
  });
});

describe("the gametype's class rules", () => {
  it("apply a change at once inside the grace after a spawn, and not after it", () => {
    const g = game({ players: ["a"], rules: { grace: 2 } });
    g.tick(TICK_RATE);
    const armed = g.state("a").armed;
    expect(g.match.chooseLoadout("a", SMG_CLASS, 1)).toBe("now");
    g.tick();
    expect(g.held("a")).toBe(SMG);
    expect(g.state("a").armed).not.toBe(armed);

    g.tick(2 * TICK_RATE);
    expect(g.match.chooseLoadout("a", RIFLE_CLASS, 0)).toBe("nextSpawn");
  });

  it("let every change happen ad hoc, or refuse every one, as `change` says", () => {
    const now = game({ players: ["a"], rules: { change: "now" } });
    now.tick(10 * TICK_RATE);
    expect(now.match.chooseLoadout("a", SMG_CLASS, 1)).toBe("now");
    now.tick();
    expect(now.held("a")).toBe(SMG);

    const never = game({ players: ["a"], rules: { change: "refuse" } });
    never.tick();
    expect(never.match.chooseLoadout("a", SMG_CLASS, 1)).toBe("refuse");
  });

  it("forbid custom classes altogether: nothing is taken, and a player spawns as one with no class", () => {
    const g = game({ rules: { customClasses: false } });
    expect(g.match.classRules.customClasses).toBe(false);
    expect(g.match.join("a", RIFLE_CLASS, "", 0)).toBe("refuse");
    g.tick();
    expect(g.held("a")).toBe(LAUNCHER);
    expect(g.match.chooseLoadout("a", SMG_CLASS, 1)).toBe("refuse");
  });
});

describe("a script's word on one player's classes", () => {
  it("lets one player change ad hoc and stops another changing at all", () => {
    const g = game({
      players: ["a", "b"],
      hooks: {
        tick: (ctx) => {
          ctx.setClassChange("a", "now");
          ctx.setClassChange("b", "refuse");
        },
      },
    });
    g.tick(10 * TICK_RATE);
    expect(g.match.chooseLoadout("a", SMG_CLASS, 1)).toBe("now");
    expect(g.match.chooseLoadout("b", SMG_CLASS, 1)).toBe("refuse");
  });

  it("has the last word on every request, first choices included, and is told what the engine would have done", () => {
    const asked: ClassRequest[] = [];
    const g = game({
      rules: { grace: 1 },
      hooks: {
        classChoice: (_ctx, request) => {
          asked.push(request);
          return request.id === "b" ? "refuse" : undefined;
        },
      },
    });
    expect(g.match.join("a", RIFLE_CLASS, "", 0)).toBe("now");
    expect(g.match.join("b", RIFLE_CLASS, "", 0)).toBe("refuse");
    g.tick();
    expect(g.held("a")).toBe(RIFLE);
    // Refused on the way in, and spawned anyway: as somebody with no class.
    expect(g.held("b")).toBe(LAUNCHER);
    expect(g.match.chooseLoadout("a", SMG_CLASS, 1)).toBe("now");
    expect(asked.map((r) => [r.id, r.first, r.alive, r.timing])).toEqual([
      ["a", true, false, "now"],
      ["b", true, false, "now"],
      ["a", false, true, "now"],
    ]);
  });
});

describe("weapons a script hands over", () => {
  it("are in hand at once with `arm`, whatever their game or slot, and the class comes back at the next spawn", () => {
    let armNow = false;
    let dropFrom = false;
    const g = game({
      players: ["a"],
      hooks: {
        tick: (ctx) => {
          if (armNow) {
            armNow = false;
            ctx.arm("a", { primary: { weapon: LAUNCHER }, secondary: { weapon: SMG } });
          }
          if (dropFrom) {
            dropFrom = false;
            ctx.spawn("a", { position: { x: 0, y: -200, z: 0 }, look: { x: 0, y: -200, z: -1 } } as never);
          }
        },
      },
    });
    g.tick();
    const armed = g.state("a").armed;
    armNow = true;
    g.tick();
    expect(g.held("a")).toBe(LAUNCHER);
    expect(g.spare("a")).toBe(SMG);
    expect(g.state("a").armed).not.toBe(armed);

    dropFrom = true;
    g.tick(2);
    expect(g.state("a").dead).toBe(true);
    g.tick(TICK_RATE + 1);
    expect(g.state("a").dead).toBe(false);
    expect(g.held("a")).toBe(RIFLE);
  });

  it("last every spawn with `setLoadout`, until it is given back — and a class chosen meanwhile is what they get back", () => {
    let forced: "on" | "off" | null = null;
    let drop = false;
    const g = game({
      players: ["a"],
      rules: { change: "now" },
      hooks: {
        tick: (ctx) => {
          if (forced) {
            ctx.setLoadout("a", forced === "on" ? { primary: { weapon: PISTOL } } : null);
            forced = null;
          }
          if (drop) {
            drop = false;
            ctx.spawn("a", { position: { x: 0, y: -200, z: 0 }, look: { x: 0, y: -200, z: -1 } } as never);
          }
        },
      },
    });
    const respawn = () => {
      drop = true;
      g.tick(TICK_RATE + 3);
      expect(g.state("a").dead).toBe(false);
    };
    forced = "on";
    g.tick();
    expect(g.held("a")).toBe(RIFLE); // not until they spawn
    respawn();
    expect(g.held("a")).toBe(PISTOL);
    expect(g.spare("a")).toBeNull();

    // Their choice counts and changes nothing in their hands while the script
    // holds them — not even a refill: nothing is handed over at all.
    const armed = g.state("a").armed;
    expect(g.match.chooseLoadout("a", SMG_CLASS, 1)).toBe("now");
    g.tick();
    expect(g.held("a")).toBe(PISTOL);
    expect(g.state("a").armed).toBe(armed);

    forced = "off";
    respawn();
    expect(g.held("a")).toBe(SMG);
  });

  it("waits for the next spawn, once, when the player is dead", () => {
    let arm = false;
    let drop = false;
    const g = game({
      players: ["a"],
      hooks: {
        tick: (ctx) => {
          if (drop) {
            drop = false;
            ctx.spawn("a", { position: { x: 0, y: -200, z: 0 }, look: { x: 0, y: -200, z: -1 } } as never);
          }
          if (arm) {
            arm = false;
            ctx.arm("a", { primary: { weapon: SMG } });
          }
        },
      },
    });
    drop = true;
    g.tick(2);
    expect(g.state("a").dead).toBe(true);
    arm = true;
    g.tick();
    expect(g.held("a")).toBe(RIFLE); // a corpse holds what it held
    g.tick(TICK_RATE);
    expect(g.held("a")).toBe(SMG);
    drop = true;
    g.tick(TICK_RATE + 3);
    expect(g.held("a")).toBe(RIFLE);
  });

  it("throws on a weapon this catalogue does not hold, or an attachment it does not offer", () => {
    const tries: (() => void)[] = [];
    const g = game({
      players: ["a"],
      hooks: {
        tick: (ctx) =>
          void tries.push(
            () => ctx.arm("a", { primary: { weapon: "iw5/nothing_mp" } }),
            () => ctx.setLoadout("a", { primary: { weapon: SMG, attachments: ["acog"] } }),
            () => ctx.arm("a", { primary: { weapon: RIFLE, attachments: ["acog"] } }),
          ),
      },
    });
    g.tick();
    expect(tries[0]).toThrow(/does not hold/);
    expect(tries[1]).toThrow(/does not offer/);
    expect(tries[2]).not.toThrow();
  });
});

describe("falling out of the world", () => {
  function fallen(hooks: ServerHooks = {}) {
    let drop = false;
    const deaths: { id: PlayerId; by: PlayerId | null; cause: DamageCause }[] = [];
    const g = game({
      players: ["a"],
      hooks: {
        ...hooks,
        playerDeath: (_ctx, id, by, cause) => void deaths.push({ id, by, cause }),
        tick: (ctx) => {
          if (drop) {
            drop = false;
            ctx.spawn("a", { position: { x: 0, y: -200, z: 0 }, look: { x: 0, y: -200, z: -1 } } as never);
          }
        },
      },
    });
    g.tick();
    drop = true;
    g.tick(2);
    return { ...g, deaths };
  }

  it("is a death nobody is responsible for, which is a suicide, and says so in the feed", () => {
    const g = fallen();
    expect(g.state("a").dead).toBe(true);
    expect(g.deaths).toEqual([{ id: "a", by: null, cause: "outOfWorld" }]);
    expect(g.told.filter((event) => event.kind === "death")).toMatchObject([{ victim: "a", killer: null, cause: "outOfWorld" }]);
  });

  it("leaves no body behind: there is nobody down there to see one fall", () => {
    expect(fallen().told.some((event) => event.kind === "spawn")).toBe(false);
    // The control: any other death on this same body does leave one.
    let kill = false;
    const shot = game({
      players: ["a"],
      hooks: {
        tick: (ctx) => {
          if (kill) {
            kill = false;
            ctx.damage("a", 1000, null);
          }
        },
      },
    });
    shot.tick();
    kill = true;
    shot.tick(2);
    expect(shot.told.some((event) => event.kind === "spawn")).toBe(true);
  });

  it("cannot be refused by a script, or the player would hang under the map for good", () => {
    const g = fallen({ playerDamage: () => ({ ignore: true }) });
    expect(g.state("a").dead).toBe(true);
  });

  it("holds the body where it fell, and the respawn puts it back on the map", () => {
    const g = fallen();
    const where = { ...g.state("a").movement.feet };
    g.tick(10);
    expect(g.state("a").movement.feet).toEqual(where);
    g.tick(TICK_RATE);
    expect(g.state("a").dead).toBe(false);
    expect(g.state("a").movement.feet.y).toBeGreaterThanOrEqual(0);
  });
});
