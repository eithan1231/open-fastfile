// Zombies: the survivors hold out against a horde that grows each round, and
// buy their way through the map with points.
//
// Plain data, like every declaration; the behaviour is `scripts/zombies.ts`, and
// the Black Ops numbers it plays by are in docs/cod/reference.md.

import type { GametypeDecl } from "./declaration.js";

export const ZOMBIES_GAMETYPE = "zombies";

export const zombiesGametype: GametypeDecl = {
  id: ZOMBIES_GAMETYPE,
  display: "Zombies",
  description: "Hold out together against a horde that grows every round. Earn points to open the map and arm yourself.",
  teams: ["survivors"],
  // The map's own zombies spawns: its `initial_spawn_points`, in the start room.
  spawnMode: "zombies",
  mode: "zombies",
  counters: ["round"],
  points: true,
  // Only where a world carries what the script reads — zones that target their
  // spawners, and door triggers that target door parts. Pentagon has the zones
  // and not yet its doors as parts, so it joins when it does.
  maps: ["theater-bo1"],
  games: ["t5"],
};

export const ZOMBIES_BO2_HORDE_GAMETYPE = "zombies_bo2";

/**
 * Zombies on Kino der Toten with Black Ops II's walkers instead of its own.
 *
 * A preview, and a way to see and hear the BO2 zombie before TranZit itself is
 * playable: TranZit's spawners, doors and zones are not what the script reads yet
 * (plan phase 1). Everything but the horde's kind is `zombies`, including its mode,
 * so the map is dressed exactly as that one is.
 */
export const zombiesBo2HordeGametype: GametypeDecl = {
  ...zombiesGametype,
  id: ZOMBIES_BO2_HORDE_GAMETYPE,
  display: "Zombies (BO2 horde)",
  description: "Kino der Toten's rounds against TranZit's walkers: a preview of Black Ops II's zombies.",
};
