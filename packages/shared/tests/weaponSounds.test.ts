// A shot is the fire counter advancing, and a reload is the clip's own
// notetracks (sim/weaponSounds.ts).
//
// Everything here fails as a *plausible* wrong result: a magazine's worth of
// rounds heard in one frame because `fired` started again at zero, one round
// heard twice because a wrap was read as a rewind, a silenced rifle heard
// unsilenced, or a bullet hitting metal that sounds like concrete. None of them
// throw, and none can be seen in a screenshot.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { WeaponData } from "../src/sim/weapon.js";
import type { WeaponClipInfo, WeaponDef } from "../src/sim/weaponDef.js";
import { resolveWeapon, type WeaponEntry } from "../src/sim/weaponRegistry.js";
import { CLIP_TIME_GRAIN, fireAlias, impactAliases, MAX_SHOTS_PER_OBSERVATION, reloadAlias, WeaponWatcher } from "../src/sim/weaponSounds.js";
import { weaponSchema } from "../src/net/messages/player.js";

/** Half a step of the grid `clip.time` travels on: the most a correction can snap it back. */
const HALF_STEP = 32 / (2 ** 14 - 1) / 2;

/** The M4's own aliases, which are `weap_m4carbine_*` and not `weap_m4_*`. */
const M4_SOUNDS = {
  fire: "weap_m4carbine_fire_npc",
  firePlayer: "weap_m4carbine_fire_plr",
  reload: "weap_m4carbine_reload_npc",
  impact: "bullet_large",
  notes: {
    weap_m4carbine_clipout_plr: "weap_m4carbine_clipout_plr",
    weap_m4carbine_clipin_plr: "weap_m4carbine_clipin_plr",
    weap_m4carbine_chamber_close_plr: "weap_m4carbine_chamber_close_plr",
  },
};

/** The M4's real reload clip: its notetracks and their times, as the catalogue carries them. */
const RELOAD_EMPTY: WeaponClipInfo = {
  duration: 2.333,
  looped: false,
  notes: [
    ["weap_m4carbine_clipout_plr", 0.3667],
    ["viewmodel_small", 0.4],
    ["weap_m4carbine_clipin_plr", 1.2333],
    ["weap_m4carbine_chamber_close_plr", 1.7333],
    ["reload_vm", 1.8],
  ],
};

function def(over: Partial<WeaponDef> = {}): WeaponDef {
  return {
    game: "iw5",
    weapon: "iw5_m4_mp",
    gun: "viewmodel_m4",
    roles: { idle: "idle_clip", reloadEmpty: "reload_empty_clip" },
    clips: { idle_clip: { duration: 1, looped: true, notes: [] }, reload_empty_clip: RELOAD_EMPTY },
    times: {},
    clipSize: 30,
    fireType: "Full Auto",
    boltAction: false,
    roundsPerLoad: 0,
    adsZoomFov: 50,
    adsOverlay: null,
    motion: {},
    hideBones: [],
    sounds: M4_SOUNDS,
    ...over,
  };
}

function data(over: Partial<WeaponData> = {}): WeaponData {
  return {
    state: "idle",
    input: { trigger: false, ads: false, sprint: false },
    timer: 0,
    span: 0,
    ammo: 30,
    cooldown: 0,
    pressed: false,
    burstLeft: 0,
    ads: 0,
    reloadQueued: false,
    refillAt: null,
    fired: 0,
    spread: 0,
    kick: { pitch: 0, yaw: 0, pitchSpeed: 0, yawSpeed: 0 },
    viewKick: { pitch: 0, yaw: 0, pitchVel: 0, yawVel: 0 },
    clip: null,
    ...over,
  };
}

/** A key that is the same object across calls, which is what "the same weapon is still held" means. */
const HELD = {};

describe("a round leaving", () => {
  it("is one voice per round and never two", () => {
    const watcher = new WeaponWatcher();
    const weapon = def();
    expect(watcher.observe(HELD, weapon, data({ fired: 0 }), true)).toHaveLength(0);
    // Full auto across a slow frame: three rounds went while nobody was looking,
    // and three is what must be heard — not one, and not one per tick since.
    const heard = watcher.observe(HELD, weapon, data({ fired: 3 }), true);
    expect(heard.map((e) => e.alias)).toEqual(Array(3).fill("weap_m4carbine_fire_plr"));
    expect(heard.map((e) => e.ordinal)).toEqual([1, 2, 3]);
    // And the same state again is silence: a counter that has not moved fired nothing.
    expect(watcher.observe(HELD, weapon, data({ fired: 3 }), true)).toHaveLength(0);
  });

  it("crosses the 16-bit wrap without inventing 65,000 rounds", () => {
    const watcher = new WeaponWatcher();
    const weapon = def();
    watcher.observe(HELD, weapon, data({ fired: 65534 }), true);
    // 65534 -> 2 is four rounds, and their ordinals wrap with the counter, so the
    // seeded draw a client makes is the one the server would make.
    const heard = watcher.observe(HELD, weapon, data({ fired: 2 }), true);
    expect(heard).toHaveLength(4);
    expect(heard.map((e) => e.ordinal)).toEqual([65535, 0, 1, 2]);
  });

  it("says nothing when the counter starts again, rather than a magazine at once", () => {
    // A respawn: the same weapon index, a brand-new controller, `fired` back at 0.
    // Read as a difference that would be 65,506 rounds.
    const watcher = new WeaponWatcher();
    const weapon = def();
    watcher.observe(HELD, weapon, data({ fired: 30 }), true);
    expect(watcher.observe({}, weapon, data({ fired: 0 }), true)).toHaveLength(0);
    // And the cap catches the case a key cannot: a peer whose index did not change.
    const peer = new WeaponWatcher();
    peer.observe(HELD, weapon, data({ fired: 30 }), false);
    expect(peer.observe(HELD, weapon, data({ fired: 0 }), false)).toHaveLength(0);
    expect(peer.observe(HELD, weapon, data({ fired: MAX_SHOTS_PER_OBSERVATION }), false)).toHaveLength(MAX_SHOTS_PER_OBSERVATION);
  });

  it("is not sounded again when a correction rewinds the counter", () => {
    // The same failure as a snapped playhead, in the other quantity this watcher
    // reads: the server had not fired this round yet, so it puts the counter
    // back and the replay fires it a second time.
    const watcher = new WeaponWatcher();
    const weapon = def();
    watcher.observe(HELD, weapon, data({ fired: 4 }), true);
    expect(watcher.observe(HELD, weapon, data({ fired: 5 }), true).map((e) => e.ordinal)).toEqual([5]);
    expect(watcher.observe(HELD, weapon, data({ fired: 4 }), true)).toHaveLength(0);
    // The replay fires it again, and it is the same round 5.
    expect(watcher.observe(HELD, weapon, data({ fired: 5 }), true)).toHaveLength(0);
    // The next round still sounds, and with its own ordinal.
    expect(watcher.observe(HELD, weapon, data({ fired: 6 }), true).map((e) => e.ordinal)).toEqual([6]);
  });

  it("is a different alias in your own hands than in somebody else's", () => {
    expect(fireAlias(M4_SOUNDS, true)).toBe("weap_m4carbine_fire_plr");
    expect(fireAlias(M4_SOUNDS, false)).toBe("weap_m4carbine_fire_npc");
    // Ghosts: no weapon sound is recoverable at all, so a weapon with no block
    // is *silent* rather than borrowing another gun's.
    expect(fireAlias(undefined, true)).toBeUndefined();
    const watcher = new WeaponWatcher();
    const mute = def({ sounds: undefined });
    watcher.observe(HELD, mute, data({ fired: 0 }), true);
    expect(watcher.observe(HELD, mute, data({ fired: 4, state: "reloading" }), true)).toEqual([]);
  });
});

describe("a reload", () => {
  it("is the clip's own notetracks, in order, and only the ones that are sounds", () => {
    const watcher = new WeaponWatcher();
    const weapon = def();
    const at = (time: number): WeaponData => data({ state: "reloading", clip: { role: "reloadEmpty", time, rate: 1, loop: false } });
    watcher.observe(HELD, weapon, at(0), true);
    // The whole clip in three observations, as three slow frames would cover it.
    const heard = [0.5, 1.5, 2.3].flatMap((time) => watcher.observe(HELD, weapon, at(time), true).map((e) => e.alias));
    expect(heard).toEqual(["weap_m4carbine_clipout_plr", "weap_m4carbine_clipin_plr", "weap_m4carbine_chamber_close_plr"]);
  });

  it("sounds each note once, however many frames straddle it", () => {
    const watcher = new WeaponWatcher();
    const weapon = def();
    const at = (time: number): WeaponData => data({ state: "reloading", clip: { role: "reloadEmpty", time, rate: 1, loop: false } });
    watcher.observe(HELD, weapon, at(0), true);
    let heard = 0;
    for (let time = 0.02; time <= 2.33; time += 0.02) {
      heard += watcher.observe(HELD, weapon, at(time), true).length;
    }
    expect(heard).toBe(3);
  });

  it("is one `_npc` alias for somebody else, once, and not their magazine in your ear", () => {
    const watcher = new WeaponWatcher();
    const weapon = def();
    const reloading = data({ state: "reloading", clip: { role: "reloadEmpty", time: 0.5, rate: 1, loop: false } });
    // The first observation is a placement: a peer who comes into view mid-reload
    // must not start theirs from the beginning.
    expect(watcher.observe(HELD, weapon, reloading, false)).toHaveLength(0);
    watcher.observe(HELD, weapon, data({ state: "idle" }), false);
    expect(watcher.observe(HELD, weapon, reloading, false).map((e) => e.alias)).toEqual(["weap_m4carbine_reload_npc"]);
    // Every snapshot for the next two seconds says `reloading`, and none of them
    // is a second reload.
    expect(watcher.observe(HELD, weapon, reloading, false)).toHaveLength(0);
  });

  it("is not sounded again by a correction snapping the playhead back", () => {
    // The bug this exists for, at its real numbers and in the shape the log
    // showed. `clip.time` advances only on a **tick** but is read every
    // **frame**, so most frames see it standing still — and the snapshot that
    // follows a tick restores the server's playhead rounded to
    // `quant(0, 32, 14)`'s grid and replays from there, which moves it
    // *backwards*. Read as a rewind, every notetrack behind the playhead sounded
    // again, twenty times a second: one ACR reload became twenty-odd voices.
    const watcher = new WeaponWatcher();
    const weapon = def();
    const at = (time: number): WeaponData => data({ state: "reloading", clip: { role: "reloadEmpty", time, rate: 1, loop: false } });
    watcher.observe(HELD, weapon, at(0), true);
    const heard: string[] = [];
    let playhead = 0;
    let ticked = 0;
    let snappedFor = 0;
    let backwards = 0;
    let previous = 0;
    // 144 Hz frames over a 20 Hz tick, each snapshot landing on the frame after
    // the tick it corrects.
    for (let frame = 1; frame <= 400 && playhead < 2.333; frame++) {
      if (frame / 144 >= (ticked + 1) / 20) {
        ticked++;
        playhead = ticked / 20;
      } else if (snappedFor < ticked) {
        snappedFor = ticked;
        playhead -= HALF_STEP;
      }
      if (playhead < previous) {
        backwards++;
      }
      previous = playhead;
      heard.push(...watcher.observe(HELD, weapon, at(playhead), true).map((e) => e.alias));
    }
    // The premise: without a playhead that really does go backwards this proves
    // nothing, and the log had it going backwards on every snapshot.
    expect(backwards).toBeGreaterThan(20);
    expect(heard).toEqual(["weap_m4carbine_clipout_plr", "weap_m4carbine_clipin_plr", "weap_m4carbine_chamber_close_plr"]);
  });

  it("survives a snap that lands exactly on a notetrack", () => {
    const watcher = new WeaponWatcher();
    const weapon = def();
    const at = (time: number): WeaponData => data({ state: "reloading", clip: { role: "reloadEmpty", time, rate: 1, loop: false } });
    watcher.observe(HELD, weapon, at(0), true);
    // Straddle `clipout` at 0.3667, then snap back across it and forward again.
    expect(watcher.observe(HELD, weapon, at(0.367), true).map((e) => e.alias)).toEqual(["weap_m4carbine_clipout_plr"]);
    expect(watcher.observe(HELD, weapon, at(0.3665), true)).toHaveLength(0);
    expect(watcher.observe(HELD, weapon, at(0.368), true)).toHaveLength(0);
  });

  it("sounds a clip that has started again by what it crosses from there", () => {
    // Sprint-cancel a reload and ask for it again and the clip plays from the
    // top. It is reported by what it crosses going forward and never by
    // replaying what it has already sounded, because this is indistinguishable
    // from a correction that snapped further than the grain — and of the two
    // wrong answers, a note missed is the one that is not a machine gun.
    const watcher = new WeaponWatcher();
    const weapon = def();
    const at = (time: number): WeaponData => data({ state: "reloading", clip: { role: "reloadEmpty", time, rate: 1, loop: false } });
    watcher.observe(HELD, weapon, at(0), true);
    watcher.observe(HELD, weapon, at(1.5), true);
    expect(watcher.observe(HELD, weapon, at(0.02), true)).toHaveLength(0);
    const heard = [0.5, 1.5, 2.3].flatMap((time) => watcher.observe(HELD, weapon, at(time), true).map((e) => e.alias));
    expect(heard).toEqual(["weap_m4carbine_clipout_plr", "weap_m4carbine_clipin_plr", "weap_m4carbine_chamber_close_plr"]);
  });

  it("sounds a notetrack at the very start of a clip", () => {
    // An L96A1 lifts its magazine at exactly 0.0 and a KSG lifts a shell at 0.0.
    // The interval is half-open at its start, so a baseline of 0 swallowed both
    // — `WeaponController.play` opens a clip at -1 for the same reason.
    const watcher = new WeaponWatcher();
    const lift: WeaponClipInfo = { duration: 2, looped: false, notes: [["weap_m4carbine_clipout_plr", 0]] };
    const weapon = def({ roles: { idle: "idle_clip", reload: "lift_clip" }, clips: { idle_clip: { duration: 1, looped: true, notes: [] }, lift_clip: lift } });
    watcher.observe(HELD, weapon, data({ state: "idle", clip: { role: "idle", time: 0.5, rate: 1, loop: true } }), true);
    const reloading = (time: number): WeaponData => data({ state: "reloading", clip: { role: "reload", time, rate: 1, loop: false } });
    expect(watcher.observe(HELD, weapon, reloading(0.017), true).map((e) => e.alias)).toEqual(["weap_m4carbine_clipout_plr"]);
    expect(watcher.observe(HELD, weapon, reloading(0.033), true)).toHaveLength(0);
  });

  it("is one pass for two roles that name one clip", () => {
    // `adsFire` and `idle` are both `viewmodel_l96_idle`, and `play` refuses to
    // restart one for another — so a correction that re-spells the role it
    // restores must not read as a new clip and replay its notetracks.
    const watcher = new WeaponWatcher();
    const shared: WeaponClipInfo = { duration: 2, looped: false, notes: [["weap_m4carbine_clipin_plr", 0.5]] };
    const weapon = def({ roles: { reload: "one_clip", reloadEmpty: "one_clip" }, clips: { one_clip: shared } });
    const at = (role: "reload" | "reloadEmpty", time: number): WeaponData => data({ state: "reloading", clip: { role, time, rate: 1, loop: false } });
    watcher.observe(HELD, weapon, at("reload", 0.1), true);
    expect(watcher.observe(HELD, weapon, at("reload", 0.6), true).map((e) => e.alias)).toEqual(["weap_m4carbine_clipin_plr"]);
    // The same moment, spelled the other way: the same pass, and silent.
    expect(watcher.observe(HELD, weapon, at("reloadEmpty", 0.6), true)).toHaveLength(0);
    expect(watcher.observe(HELD, weapon, at("reloadEmpty", 0.7), true)).toHaveLength(0);
  });

  it("still reads a looping clip as the tail of one pass and the head of the next", () => {
    const watcher = new WeaponWatcher();
    const loop: WeaponClipInfo = {
      duration: 1,
      looped: true,
      notes: [
        ["weap_m4carbine_clipin_plr", 0.2],
        ["weap_m4carbine_chamber_close_plr", 0.9],
      ],
    };
    const weapon = def({ roles: { idle: "idle_clip", reload: "loop_clip" }, clips: { idle_clip: { duration: 1, looped: true, notes: [] }, loop_clip: loop } });
    const at = (time: number): WeaponData => data({ state: "reloading", clip: { role: "reload", time, rate: 1, loop: true } });
    watcher.observe(HELD, weapon, at(0.5), true);
    // Across the join: the note at 0.9 is still behind us and the one at 0.2 ahead.
    expect(watcher.observe(HELD, weapon, at(0.3), true).map((e) => e.alias)).toEqual([
      "weap_m4carbine_clipin_plr",
      "weap_m4carbine_chamber_close_plr",
    ]);
  });

  it("keeps its grain wider than the grid the wire rounds the playhead to", () => {
    // The one number here that is not this module's to choose. If
    // `net/messages/player.ts` ever widens `clip.time`'s quantisation past the
    // grain, a correction can snap further than it and the bug is back — so it
    // is measured off the codec rather than written down twice.
    let worst = 0;
    for (let time = 0; time < 5; time += 0.0011) {
      const before = data({ clip: { role: "reloadEmpty", time, rate: 1, loop: false } });
      const after = weaponSchema.round!(before);
      worst = Math.max(worst, Math.abs((after.clip?.time ?? 0) - time));
    }
    expect(worst).toBeGreaterThan(0); // it really is lossy, or this proves nothing
    expect(worst).toBeLessThan(CLIP_TIME_GRAIN);
  });

  it("falls back to the loaded reload where a weapon names no empty one", () => {
    expect(reloadAlias(M4_SOUNDS, true)).toBe("weap_m4carbine_reload_npc");
    expect(reloadAlias({ reload: "a", reloadEmpty: "b" }, true)).toBe("b");
    expect(reloadAlias(undefined, false)).toBeUndefined();
  });
});

describe("a round arriving", () => {
  it("is the weapon's impact family and the surface, with the family's default behind it", () => {
    expect(impactAliases(M4_SOUNDS, "metal")).toEqual(["bullet_large_metal", "bullet_large_default"]);
    // `default` is a surface the world can actually answer, so it is not asked
    // for twice.
    expect(impactAliases(M4_SOUNDS, "default")).toEqual(["bullet_large_default"]);
    expect(impactAliases({}, "metal")).toEqual([]);
  });
});

describe("the catalogue's own weapons", () => {
  const root = path.resolve(import.meta.dirname, "../../../worlds/catalog/weapons");
  // Gitignored and built, like every other catalogue entry, so a checkout that
  // has not run `python3 -m scripts.cod catalog` skips this rather than failing.
  const built = fs.existsSync(root);
  const read = (game: string, id: string): WeaponEntry => JSON.parse(fs.readFileSync(path.join(root, game, id, `${id}.json`), "utf8")) as WeaponEntry;

  it.runIf(built)("carry aliases the weapon file named, not aliases spelled from their id", () => {
    // **The case a prefix rule gets wrong.** Both games' M4s are `m4carbine` in
    // the sound bank, and `m4_mp` and `iw5_m4_mp` are what they are called — so a
    // rule built from the id gives `weap_m4_fire_plr`, which no bank holds, and
    // every M4 in both games is silent.
    for (const [game, id] of [
      ["iw4", "m4_mp"],
      ["iw5", "iw5_m4_mp"],
    ] as const) {
      const sounds = read(game, id).def.sounds;
      expect(sounds?.firePlayer).toBe("weap_m4carbine_fire_plr");
      expect(sounds?.fire).toBe("weap_m4carbine_fire_npc");
      expect(sounds?.impact).toBe("bullet_large");
      expect(Object.values(sounds?.notes ?? {})).toContain("weap_m4carbine_clipin_plr");
    }
  });

  it.runIf(built)("let a silencer replace the two fire aliases and nothing else", () => {
    const entry = read("iw5", "iw5_m4_mp");
    const slot = entry.attachments.findIndex((a) => a.id === "silencer");
    expect(slot).toBeGreaterThanOrEqual(0);
    const silenced = resolveWeapon(entry, [slot]).sounds;
    expect(silenced?.firePlayer).toBe("weap_m4silenced_fire_plr");
    // Merged key by key: the reload, the impact and the notetracks are the bare
    // weapon's, because a silencer does not change how a magazine goes in.
    expect(silenced?.reload).toBe(entry.def.sounds?.reload);
    expect(silenced?.notes).toEqual(entry.def.sounds?.notes);
  });

  it.runIf(built)("space their notetracks far wider apart than the playhead's grain", () => {
    // What makes `CLIP_TIME_GRAIN` safe to hold the playhead still across: no two
    // notetracks that sound are close enough for the grain to reach from one to
    // the other. Measured over every weapon rather than argued, because the
    // margin is a property of the catalogue and the catalogue is rebuilt.
    let closest = Infinity;
    let where = "";
    for (const game of fs.readdirSync(root)) {
      for (const id of fs.readdirSync(path.join(root, game))) {
        const weapon = read(game, id).def;
        const named = new Set(Object.keys(weapon.sounds?.notes ?? {}));
        for (const [clip, info] of Object.entries(weapon.clips)) {
          const times = info.notes
            .filter(([note]) => named.has(note))
            .map(([, at]) => at)
            .sort((a, b) => a - b);
          for (let i = 1; i < times.length; i++) {
            const gap = times[i]! - times[i - 1]!;
            if (gap > 0 && gap < closest) {
              closest = gap;
              where = `${id} ${clip}`;
            }
          }
        }
      }
    }
    expect(closest).toBeLessThan(Infinity); // or the sweep found nothing and proves nothing
    // 33 ms on an LSAT's first pull-out, against a 3.9 ms grain.
    expect(closest, where).toBeGreaterThan(4 * CLIP_TIME_GRAIN);
  });

  it.runIf(built)("say nothing for Ghosts, whose weapon sounds are not recoverable", () => {
    // Measured: every IW6 weapon file carries a `notetrackSoundMap` (87 of the
    // 130 do) and an `impactType`, and **not one carries a `fireSound`** — the
    // emulated loader resolves them away (docs/cod/games.md). So this is the
    // path where a weapon fires through nothing at all, and it must not throw.
    // The names it does carry name a bank Ghosts has not got, which is the
    // second layer of the same silence: `resolveAlias` finds nothing.
    const sounds = read("iw6", "iw6_ak12_mp").def.sounds;
    expect(sounds?.fire).toBeUndefined();
    expect(sounds?.firePlayer).toBeUndefined();
    expect(sounds?.reload).toBeUndefined();
    expect(fireAlias(sounds, true)).toBeUndefined();
    const watcher = new WeaponWatcher();
    const iw6 = def({ sounds });
    watcher.observe(HELD, iw6, data({ fired: 0 }), true);
    expect(watcher.observe(HELD, iw6, data({ fired: 5 }), true)).toEqual([]);
  });
});
