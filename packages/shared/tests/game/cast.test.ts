// `castFor`: who a player is, now that no world says.
//
// The property that matters most is purity. `pnpm dev` starts no game server and a
// client with none plays exactly as it does offline, so the browser reaches this
// answer on its own and a game server reaches it for a real match — and the two
// must agree without either being told.

import { describe, expect, it } from "vitest";
import { bodyFor, bodyIndex, castFor } from "../../src/game/cast.js";
import type { CatalogueView, CharacterEntry, ViewhandsEntry, AnimationsEntry } from "../../src/game/catalogueView.js";
import { defaultGametype } from "../../src/game/gametypes/default.js";
import type { GameKey } from "../../src/dsl/resolved.js";

function body(id: string, side: string | undefined, game: GameKey = "iw5"): CharacterEntry {
  return { id, game, side, body: `${id}.glb`, head: `head_${id}.glb`, animType: "autorifle" };
}

/**
 * A catalogue as an object literal — the point of narrowing it to an interface
 * (`loadouts.ts` does the same for a stored class). No disk, no fixtures.
 */
function catalogue(opts: { characters?: CharacterEntry[]; hands?: ViewhandsEntry[]; animations?: AnimationsEntry[]; weapons?: string[] }): CatalogueView {
  const { characters = [], hands = [], animations = [], weapons = ["iw5/iw5_m4_mp", "iw4/m4_mp", "iw6/iw6_ak12_mp"] } = opts;
  return {
    weapon: (id) => (weapons.includes(id) ? { game: id.split("/")[0]!, id } : undefined),
    charactersFor: (game) => characters.filter((c) => c.game === game),
    viewhandsFor: (game) => hands.filter((h) => h.game === game),
    animationsFor: (game, animType) => animations.find((a) => a.game === game && a.animType === animType),
    actorFor: () => undefined,
  };
}

const ANIMS: AnimationsEntry = { id: "autorifle", game: "iw5", animType: "autorifle", clips: "animations.glb" };
const HANDS: ViewhandsEntry = { id: "viewhands_delta", game: "iw5", hands: "viewhands_delta.glb" };

const full = () =>
  catalogue({
    characters: [body("mp_body_delta", "allies"), body("mp_body_russian", "axis")],
    hands: [HANDS],
    animations: [ANIMS],
  });

describe("castFor", () => {
  it("dresses a side in that side's bodies", () => {
    const cast = castFor({ game: "iw5", gametype: defaultGametype, team: "axis" }, full());
    expect(cast?.characters.map((c) => c.id)).toEqual(["mp_body_russian"]);
    expect(cast?.characters[0]?.side).toBe("axis");
  });

  it("offers every body when no side is asking", () => {
    const cast = castFor({ game: "iw5", gametype: defaultGametype }, full());
    expect(cast?.characters).toHaveLength(2);
  });

  // The reason `spawnPoints` widens a spawn query, for the same reason: Ghosts'
  // two rangers carry no faction at all, and a gametype must still dress them
  // rather than leave a whole game in capsules.
  it("falls back to every body when a side has none", () => {
    const sideless = catalogue({
      characters: [body("mp_body_ranger_a", undefined), body("mp_body_ranger_b", undefined)],
      hands: [HANDS],
      animations: [ANIMS],
    });
    const cast = castFor({ game: "iw5", gametype: defaultGametype, team: "allies" }, sideless);
    expect(cast?.characters).toHaveLength(2);
  });

  it("builds a ref the catalogue route can serve", () => {
    const cast = castFor({ game: "iw5", gametype: defaultGametype, team: "allies" }, full());
    expect(cast?.characters[0]?.body).toEqual({
      kind: "characters",
      game: "iw5",
      id: "mp_body_delta",
      file: "mp_body_delta.glb",
    });
    expect(cast?.animations).toEqual({ kind: "animations", game: "iw5", id: "autorifle", file: "animations.glb" });
    expect(cast?.hands).toEqual({ kind: "viewhands", game: "iw5", id: "viewhands_delta", file: "viewhands_delta.glb" });
  });

  // Measured, not chosen: all 25 Modern Warfare 3 worlds named this one weapon.
  it("arms a player with the weapon every world of that game named", () => {
    expect(castFor({ game: "iw5", gametype: defaultGametype }, full())?.defaultWeapon).toBe("iw5/iw5_m4_mp");
  });

  // A missing gun is visible; a substituted one is not.
  it("leaves a player unarmed when the catalogue does not hold the default", () => {
    const noWeapons = catalogue({ characters: [body("b", "allies")], hands: [HANDS], animations: [ANIMS], weapons: [] });
    expect(castFor({ game: "iw5", gametype: defaultGametype }, noWeapons)?.defaultWeapon).toBeNull();
  });

  it("prefers the game's usual hands but takes any it has", () => {
    const other: ViewhandsEntry = { id: "viewhands_op_force", game: "iw5", hands: "viewhands_op_force.glb" };
    const only = catalogue({ characters: [body("b", "allies")], hands: [other], animations: [ANIMS] });
    expect(castFor({ game: "iw5", gametype: defaultGametype }, only)?.hands.id).toBe("viewhands_op_force");
    const both = catalogue({ characters: [body("b", "allies")], hands: [other, HANDS], animations: [ANIMS] });
    expect(castFor({ game: "iw5", gametype: defaultGametype }, both)?.hands.id).toBe("viewhands_delta");
  });

  describe("no cast at all, so the caller draws capsules", () => {
    it("for a hand-written world, which declares no game", () => {
      expect(castFor({ game: undefined, gametype: defaultGametype }, full())).toBeUndefined();
    });

    it("for a game with no bodies built", () => {
      expect(castFor({ game: "t5", gametype: defaultGametype }, full())).toBeUndefined();
    });

    it("for a game whose clips are missing", () => {
      const noClips = catalogue({ characters: [body("b", "allies")], hands: [HANDS] });
      expect(castFor({ game: "iw5", gametype: defaultGametype }, noClips)).toBeUndefined();
    });

    it("for a game whose hands are missing", () => {
      const noHands = catalogue({ characters: [body("b", "allies")], animations: [ANIMS] });
      expect(castFor({ game: "iw5", gametype: defaultGametype }, noHands)).toBeUndefined();
    });
  });

  // The stopgap: Black Ops II has no bodies yet, so it borrows Black Ops' cast,
  // part by part, until each of its own is built.
  describe("a game that borrows another's cast (t6 from t5)", () => {
    const T5_ANIMS: AnimationsEntry = { id: "default", game: "t5", animType: "autorifle", clips: "animations.glb" };
    const T5_HANDS: ViewhandsEntry = { id: "viewmodel_usa_cia_standard_arms", game: "t5", hands: "arms.glb" };
    const t5 = (extra: { characters?: CharacterEntry[]; hands?: ViewhandsEntry[]; weapons?: string[] } = {}) =>
      catalogue({
        characters: [body("c_usa_cia", "allies", "t5"), ...(extra.characters ?? [])],
        hands: [T5_HANDS, ...(extra.hands ?? [])],
        animations: [T5_ANIMS],
        weapons: extra.weapons ?? ["t5/m16_mp"],
      });

    it("dresses a t6 world with t5's bodies, clips and hands until t6 has its own", () => {
      const cast = castFor({ game: "t6", gametype: defaultGametype }, t5());
      expect(cast?.characters.map((c) => c.body)).toEqual([{ kind: "characters", game: "t5", id: "c_usa_cia", file: "c_usa_cia.glb" }]);
      expect(cast?.animations).toEqual({ kind: "animations", game: "t5", id: "default", file: "animations.glb" });
      expect(cast?.hands.game).toBe("t5");
    });

    // t6 names a gun of its own, so the stand-in's is never borrowed for it: a t6
    // catalogue without that gun leaves the player unarmed, as for any other game.
    it("arms a t6 player with t6's own gun, never the stand-in's", () => {
      expect(castFor({ game: "t6", gametype: defaultGametype }, t5())?.defaultWeapon).toBeNull();
      expect(castFor({ game: "t6", gametype: defaultGametype }, t5({ weapons: ["t5/m16_mp", "t6/tar21_mp"] }))?.defaultWeapon).toBe("t6/tar21_mp");
    });

    it("takes t6's own part wherever one is built", () => {
      const own: ViewhandsEntry = { id: "viewarms_t6", game: "t6", hands: "t6.glb" };
      expect(castFor({ game: "t6", gametype: defaultGametype }, t5({ hands: [own] }))?.hands).toEqual({
        kind: "viewhands",
        game: "t6",
        id: "viewarms_t6",
        file: "t6.glb",
      });
    });

    it("leaves a game with no stand-in undressed", () => {
      expect(castFor({ game: "iw6", gametype: defaultGametype }, t5())).toBeUndefined();
    });
  });

  // The whole reason this is a function and not a lookup: offline and online must
  // not be able to disagree.
  it("is pure: the same inputs give a deep-equal cast twice", () => {
    const q = { game: "iw5", gametype: defaultGametype, team: "allies" } as const;
    expect(castFor(q, full())).toEqual(castFor(q, full()));
  });
});

// Which body a player wears. In shared, and derived from the id, because both ends
// have to reach the same answer: a client draws a peer in one of these and a server
// traces a bullet against that body's bones, and each body has its own box sizes —
// a head derived from a ghillie hood is 0.49 m across against 0.29 for an ordinary
// one. Two ends disagreeing is a hit box a fifth of a metre from where it is drawn.
describe("which body a player wears", () => {
  it("is the same answer every time it is asked", () => {
    for (const id of ["abc123", "x", "a-very-long-player-id-indeed"]) {
      expect(bodyIndex(id, 5)).toBe(bodyIndex(id, 5));
    }
  });

  it("is inside the cast it is choosing from", () => {
    for (const count of [1, 2, 3, 7]) {
      for (const id of ["abc123", "zzz", "q", "0"]) {
        const index = bodyIndex(id, count);
        expect(index).toBeGreaterThanOrEqual(0);
        expect(index).toBeLessThan(count);
      }
    }
  });

  it("spreads ids across the cast rather than giving everyone the first", () => {
    const seen = new Set(Array.from({ length: 200 }, (_, i) => bodyIndex(`player-${i}`, 4)));
    expect(seen.size).toBe(4);
  });

  it("answers for an empty cast rather than dividing by it", () => {
    expect(bodyIndex("abc", 0)).toBe(0);
    expect(bodyFor("abc", [])).toBeUndefined();
  });
});
