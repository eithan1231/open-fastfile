// The weapons the zombies script arms a player with on joining
// (`DEFAULT_LOADOUT`), so a match of it can be stood up without a catalogue.

import { weaponDef } from "@3d/shared/testing/weaponDef.js";
import { WeaponRegistry } from "@3d/shared/sim/weaponRegistry.js";

export function zombiePistols(): WeaponRegistry {
  return new WeaponRegistry([
    { id: "m1911_mp", game: "t5", slot: "secondary", class: "pistol", def: weaponDef({ clipSize: 8 }), attachments: [] },
    { id: "fiveseven_mp", game: "t6", slot: "secondary", class: "pistol", def: weaponDef({ clipSize: 20 }), attachments: [] },
  ]);
}
