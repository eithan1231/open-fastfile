// What a match dresses and arms its players with, now that the world does not say.
//
// The point of these is that moving the decision out of `characters.world` and
// `viewmodel.world` changed no behaviour: the default gametype asks the map for
// exactly the spawns `Match` already asked for, and names the weapon every world
// of that game already named.

import { describe, expect, it } from "vitest";
import type { ResolvedWorld, GameKey } from "@3d/shared/dsl/resolved.js";
import { catalogueViewOf } from "@3d/shared/game/catalogueView.js";
import { defaultGametype } from "@3d/shared/game/gametypes/default.js";
import { EYE_HEIGHT } from "@3d/shared/sim/movement.js";
import { WeaponRegistry, type WeaponEntry } from "@3d/shared/sim/weaponRegistry.js";
import type { WeaponDef } from "@3d/shared/sim/weaponDef.js";
import { NO_BODIES } from "../src/bodies.js";
import { Match } from "../src/match/match.js";
import type { Playing } from "../src/match/playing.js";

/** Every weapon a test instance can build. One registry, so an index means one thing. */
function registry(): WeaponRegistry {
  return new WeaponRegistry([weapon("m4_mp", "iw4"), weapon("iw5_m4_mp", "iw5"), weapon("iw6_ak12_mp", "iw6")]);
}

const TICK_RATE = 60;

/** A floor at y=0 and nothing else, as match.test.ts's is: a spawn needs something to stand on. */
class FlatGround {
  readonly ready = true;
  resolveCapsule(
    position: { x: number; y: number; z: number },
    _r: number,
    _h: number,
    out?: { position: { x: number; y: number; z: number }; grounded: boolean; normal: { x: number; y: number; z: number } },
  ) {
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

  /** Nothing here is shot at; the floor is for standing on. */
  traceRay(): null {
    return null;
  }

  groundBelow(from: { y: number }, distance: number, normal?: { x: number; y: number; z: number }): number | null {
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
}

function world(game: GameKey | undefined, spawns: { mode?: string; team?: string; start: boolean; x: number }[] = []): ResolvedWorld {
  return {
    game,
    spawn: { position: { x: 0, y: EYE_HEIGHT, z: 0 }, look: { x: 0, y: EYE_HEIGHT, z: -1 } },
    spawnPoints: spawns.map((s) => ({
      position: { x: s.x, y: EYE_HEIGHT, z: 0 },
      look: { x: s.x, y: EYE_HEIGHT, z: -1 },
      modes: s.mode === undefined ? undefined : [s.mode],
      team: s.team,
      start: s.start,
    })),
    triggers: [],
    mantles: [],
    ladders: [],
    points: [],
    solids: [],
    rooms: [],
    topLevelObjects: [],
  } as unknown as ResolvedWorld;
}

/** A weapon entry the registry accepts, with only the fields it reads. */
function weapon(id: string, game: string): WeaponEntry {
  return {
    id,
    game,
    class: "rifle",
    def: { game, weapon: id, gun: id, roles: { idle: "idle" }, clips: {}, times: {} } as unknown as WeaponDef,
    attachments: [],
  };
}

function playing(game: GameKey, over: Partial<Playing> = {}): Playing {
  const weapons = registry();
  const index = {
    version: 1,
    characters: [{ id: "mp_body_a", game, side: "allies", body: "mp_body_a.glb", animType: "autorifle" }],
    viewhands: [{ id: "viewhands_a", game, hands: "viewhands_a.glb" }],
    animations: [{ id: "autorifle", game, animType: "autorifle", clips: "animations.glb" }],
  };
  return { map: "dome-mw3", gametype: defaultGametype, catalogue: catalogueViewOf(index, weapons), bodies: NO_BODIES, ...over };
}

function match(w: ResolvedWorld, p: Playing): Match {
  return new Match(new FlatGround(), w, TICK_RATE, 8, registry(), p);
}

/**
 * The weapon one player is holding, by id.
 *
 * A snapshot names a weapon by its **index** in the catalogue rather than by name
 * (`PlayerState.weaponIndex`), because it goes out sixty times a second — so
 * reading one back means asking the registry that minted the index.
 */
function held(m: Match): string | null {
  const index = m.step().players[0]!.state.weaponIndex;
  return index === null ? null : registry().idAt(index);
}

describe("what a player spawns holding", () => {
  // Measured: all 25 Modern Warfare 3 worlds named this weapon, so the gametype
  // naming it per game reproduces every one of them.
  it("is the gametype's default, with no world declaring one", () => {
    const m = match(world("iw5"), playing("iw5"));
    m.join("a");
    expect(held(m)).toBe("iw5/iw5_m4_mp");
  });

  it("is that game's weapon, not another game's", () => {
    const m = match(world("iw4"), playing("iw4"));
    m.join("a");
    expect(held(m)).toBe("iw4/m4_mp");
  });

  // A hand-written world has no game, so no cast and no default — unarmed, which
  // is visible, rather than holding some other game's rifle.
  it("is nothing on a world that declares no game", () => {
    const m = match(world(undefined), playing("iw5"));
    m.join("a");
    expect(held(m)).toBeNull();
  });

  it("is nothing when this instance's catalogue holds no cast", () => {
    const empty = playing("iw5", { catalogue: catalogueViewOf({ version: 1 }, new WeaponRegistry([])) });
    const m = match(world("iw5"), empty);
    m.join("a");
    expect(held(m)).toBeNull();
  });

  it("still loses to a class that names a weapon", () => {
    const m = match(world("iw5"), playing("iw5"));
    m.join("a", { name: "C", game: "iw4", primary: { weapon: "iw4/m4_mp", attachments: [] }, secondary: { weapon: null, attachments: [] } });
    expect(held(m)).toBe("iw4/m4_mp");
  });
});

describe("which spawns the gametype asks for", () => {
  /**
   * The behavioural no-op this stage rests on. The default gametype names no
   * `spawnMode` and assigns no team, so the query widens to exactly the
   * `{ start: true }` `Spawns.place` asked for before a gametype existed.
   */
  it("is start spawns only, exactly as before", () => {
    const w = world("iw5", [
      { start: true, x: 10 },
      { start: true, x: 20 },
      { start: false, x: 99 },
    ]);
    const m = match(w, playing("iw5"));
    m.join("a");
    m.join("b");
    const xs = m.step().players.map((p) => p.state.movement.feet.x);
    // 99 is not a start spawn and must not be used while start spawns exist.
    expect([...xs].sort((l, r) => l - r)).toEqual([10, 20]);
  });

  it("ignores a mode the gametype does not name", () => {
    // Every spawn is qualified by a mode; the default gametype names none, so
    // `spawnPoints` widens rather than returning nothing.
    const w = world("iw5", [
      { mode: "tdm", start: true, x: 10 },
      { mode: "dom", start: true, x: 20 },
    ]);
    const m = match(w, playing("iw5"));
    m.join("a");
    m.join("b");
    expect(
      m
        .step()
        .players.map((p) => p.state.movement.feet.x)
        .sort((l, r) => l - r),
    ).toEqual([10, 20]);
  });

  /** A gametype that does name a mode collects the per-mode spawns every map carries. */
  it("narrows to one mode when the gametype names it", () => {
    const w = world("iw5", [
      { mode: "tdm", start: true, x: 10 },
      { mode: "dom", start: true, x: 20 },
    ]);
    const m = match(w, playing("iw5", { gametype: { ...defaultGametype, id: "dom", spawnMode: "dom" } }));
    m.join("a");
    m.join("b");
    // Both players take the one `dom` spawn: the map offers no second.
    expect(m.step().players.map((p) => p.state.movement.feet.x)).toEqual([20, 20]);
  });
});
