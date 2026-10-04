// A small weapon definition for tests: an automatic rifle with every clip role
// the state machine uses, short clips, and the weapon-file times that stretch
// them. It carries a rechamber and the two halves of a segmented reload too,
// which only a `boltAction: true` or `roundsPerLoad` override reaches — so one
// test can be the bolt-action one and another the shotgun.

import type { WeaponDef } from "../src/sim/weaponDef.js";

export function weaponDef(overrides: Partial<WeaponDef> = {}): WeaponDef {
  const clip = (duration: number, notes: [string, number][] = [], looped = false) => ({ duration, looped, notes });
  return {
    game: "iw5",
    weapon: "test_mp",
    gun: "viewmodel_test",
    roles: {
      idle: "idle",
      fire: "fire",
      reload: "reload",
      reloadEmpty: "reload_empty",
      raise: "pullout",
      firstRaise: "first_pullout",
      drop: "putaway",
      sprintIn: "sprint_in",
      sprintLoop: "sprint_loop",
      sprintOut: "sprint_out",
      adsUp: "ads_up",
      rechamber: "rechamber",
      adsRechamber: "rechamber_ads",
      reloadStart: "reload_in",
      reloadEnd: "reload_out",
    },
    clips: {
      idle: clip(1 / 30, [], true),
      fire: clip(0.5, [["interruptible", 0.2]]),
      reload: clip(2, [
        ["clipout", 0.4],
        ["clipin", 1.2],
      ]),
      reload_empty: clip(2.3),
      pullout: clip(1.1, [["lift", 0]]),
      first_pullout: clip(1.2),
      putaway: clip(0.6),
      sprint_in: clip(0.2),
      sprint_loop: clip(0.5, [], true),
      sprint_out: clip(0.2),
      ads_up: clip(0.4),
      rechamber: clip(0.6, [["bolt", 0.3]]),
      rechamber_ads: clip(0.6),
      reload_in: clip(0.5),
      reload_out: clip(0.4),
    },
    times: {
      fire: 0.1,
      fireInterruptible: 0.2,
      rechamber: 0.5,
      reload: 2,
      reloadEmpty: 2.3,
      reloadAdd: 1.3,
      reloadStart: 0.5,
      reloadStartAdd: 0.3,
      reloadEnd: 0.4,
      raise: 0.75,
      firstRaise: 0.8,
      drop: 0.4,
      sprintIn: 0.25,
      sprintLoop: 0.5,
      sprintOut: 0.2,
      adsIn: 0.3,
      adsOut: 0.3,
      adsReloadOut: 0.15,
    },
    clipSize: 3,
    fireType: "Full Auto",
    boltAction: false,
    roundsPerLoad: 0,
    adsZoomFov: 50,
    adsOverlay: null,
    motion: {},
    hideBones: [],
    ...overrides,
  };
}
