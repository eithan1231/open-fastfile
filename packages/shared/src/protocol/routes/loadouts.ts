// A player's classes: what they spawn carrying.
//
// Every one of these answers with the whole set and the chosen index rather than
// with the part that changed. A class is five small objects, the menu shows all
// five at once, and an endpoint that returned only the edited one would leave
// the client stitching the answer back into its own copy — which is the sort of
// thing that works until two edits overlap.
//
// A class names its weapons and attachments; what those names *mean* is decided
// by the api against the catalogue as it stands (@3d/api src/loadouts.ts), which
// is why a save answers with the class as it will read back rather than with
// "ok". Saving an ACOG on a weapon that no longer takes one gives you back a
// class without it, and the menu shows that immediately.

import * as z from "zod/mini";
import { LOADOUT_COUNT, LOADOUT_NAME_MAX, MAX_LOADOUT_ATTACHMENTS, type Loadout } from "../../sim/loadout.js";
import { defineRoute, json } from "../route.js";

/**
 * A weapon's catalogue id, `<game>/<name>`. The same allowlist the catalogue's
 * own path segments use, because that is what this becomes: a request for
 * `catalog/weapons/<game>/<name>/`.
 */
const weaponId = z.string().check(z.maxLength(80), z.regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/, { error: "not a weapon id" }));

const attachmentId = z.string().check(z.maxLength(40), z.regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, { error: "not an attachment id" }));

const loadoutWeapon = z.object({
  weapon: z.nullable(weaponId),
  /** Capped here as well as stored capped: a body is untrusted, and the cap is a rule of the game. */
  attachments: z.array(attachmentId).check(z.maxLength(MAX_LOADOUT_ATTACHMENTS)),
});

/**
 * One class. `satisfies` against the simulation's own type, so a field added
 * there and forgotten here is a typecheck failure rather than a class that
 * silently stops carrying it.
 */
export const loadoutSchema: z.ZodMiniType<Loadout> = z.object({
  name: z.string().check(z.maxLength(LOADOUT_NAME_MAX)),
  /** A catalogue game, which is a path segment of every weapon id the class may name. */
  game: z.nullable(z.string().check(z.maxLength(16), z.regex(/^[a-z0-9]+$/, { error: "not a game" }))),
  primary: loadoutWeapon,
  secondary: loadoutWeapon,
});

/** Which class this player spawns with, and all five of them. */
export const loadoutsBody = z.object({
  loadouts: z.array(loadoutSchema),
  selected: z.number().check(z.int(), z.gte(0), z.lt(LOADOUT_COUNT)),
});
export type LoadoutsBody = z.infer<typeof loadoutsBody>;

/**
 * Which class, as a path segment. A string, because params are strings in both
 * directions and a params schema refuses a value rather than converting it
 * (../route.ts) — so the range is checked here and the digits are read in the
 * handler, rather than a handler having to remember to bound them.
 */
const classIndex = z.object({
  index: z.string().check(
    z.regex(/^\d{1,2}$/),
    z.refine((value) => Number(value) < LOADOUT_COUNT, { error: `not one of this player's ${LOADOUT_COUNT} classes` }),
  ),
});

export const loadoutsRoute = defineRoute({
  method: "GET",
  path: "/api/loadouts",
  auth: "user",
  result: json(loadoutsBody),
  revalidate: true,
});

export const loadoutSaveRoute = defineRoute({
  method: "POST",
  path: "/api/loadouts/:index",
  auth: "user",
  params: classIndex,
  input: loadoutSchema,
  result: json(loadoutsBody),
});

/** Which class to spawn with. Its own route because choosing one is not editing it. */
export const loadoutSelectRoute = defineRoute({
  method: "POST",
  path: "/api/loadouts/:index/select",
  auth: "user",
  params: classIndex,
  result: json(loadoutsBody),
});

export const LOADOUT_ROUTES = {
  loadouts: loadoutsRoute,
  saveLoadout: loadoutSaveRoute,
  selectLoadout: loadoutSelectRoute,
} as const;
