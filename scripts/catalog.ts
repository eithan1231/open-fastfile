#!/usr/bin/env tsx
// Headless catalogue check: `pnpm catalog [<game>/<weapon>] [attachment...]`.
//
// Loads `worlds/catalog/index.json` off disk through the same `WeaponRegistry`
// both ends run, and reports what came back. The companion to `pnpm check`: that
// one says whether a world resolves, this one whether a catalogue loads and what
// fitting an attachment actually does to a gun's numbers.
//
// It is a real check and not a listing. `WeaponRegistry` refuses a weapon
// offering more attachments than the wire can carry, and `resolveWeapon` is
// where the exporter's collapse either produced usable numbers or plausible
// ones — so this is the fastest way to see an ACOG take an M4's ADS from 50° to
// 30° without starting a browser.
//
// Usage:
//   pnpm catalog                              # every weapon, and the hash both ends must agree on
//   pnpm catalog iw5/iw5_m4_mp                # one weapon and everything it accepts
//   pnpm catalog iw5/iw5_m4_mp acog xmags     # that weapon with those fitted

import fs from "node:fs/promises";
import path from "node:path";
import { fittedIds, fittedSlots, resolveWeapon, WeaponRegistry, type WeaponEntry } from "@3d/shared/sim/weaponRegistry.js";
import { HIT_LOCATIONS } from "@3d/shared/sim/hitLocations.js";
import type { WeaponDef } from "@3d/shared/sim/weaponDef.js";
import { VIEW_KICK_SCALE } from "@3d/shared/sim/recoil.js";
import { catalogueViewOf, type CatalogIndexBody } from "@3d/shared/game/catalogueView.js";
import { castFor } from "@3d/shared/game/cast.js";
import { GAMETYPES } from "@3d/shared/game/gametypes/registry.js";
import { SCRIPTS } from "@3d/shared/game/registry.js";
import { ACTOR_KINDS } from "@3d/shared/game/actors/kinds.js";
import type { GameKey } from "@3d/shared/dsl/resolved.js";

// Relative to the repo, not the caller: `pnpm catalog` may run from anywhere.
const CATALOG = path.resolve(import.meta.dirname, "..", "worlds", "catalog", "index.json");

type CatalogFile = Omit<CatalogIndexBody, "weapons"> & { weapons: WeaponEntry[] };

async function readCatalog(): Promise<CatalogFile> {
  const text = await fs.readFile(CATALOG, "utf8").catch(() => undefined);
  if (text === undefined) {
    console.error(`no catalogue at ${CATALOG}`);
    console.error("build one with `python3 -m scripts.cod catalog` (see docs/cod/pipeline.md).");
    process.exit(1);
  }
  const body = JSON.parse(text) as CatalogFile;
  console.log(`${CATALOG}: version ${body.version}, ${body.weapons.length} weapon(s)`);
  return body;
}

/** Every game the catalogue holds a cast for, in a stable order. */
const CAST_GAMES: readonly GameKey[] = ["iw4", "iw5", "iw6", "t5", "t6", "s1"];

/**
 * Every cast a gametype can produce, and whether the files it names are on disk.
 *
 * This is where the view-hands existence check lives now. `pnpm check` used to do
 * it, because a world named its own pair; no world names one any more, so the
 * check had nowhere to live — and without it a missing pair of hands would
 * degrade from a CI failure to a console warning in somebody's browser.
 */
async function reportCast(body: CatalogIndexBody, registry: WeaponRegistry): Promise<number> {
  const view = catalogueViewOf(body, registry);
  const root = path.dirname(CATALOG);
  const exists = async (rel: string): Promise<boolean> =>
    await fs
      .access(path.join(root, rel))
      .then(() => true)
      .catch(() => false);

  let missing = 0;
  for (const gametype of Object.values(GAMETYPES)) {
    for (const game of CAST_GAMES) {
      // Every side plus "no side at all", which is what an offline client asks for.
      for (const team of [undefined, ...gametype.teams]) {
        const cast = castFor({ game, gametype, team }, view);
        if (!cast) {
          continue;
        }
        const refs = [cast.animations, cast.hands, ...cast.characters.flatMap((c) => [c.body, c.head, c.weapon])];
        for (const ref of refs) {
          if (ref && !(await exists(path.join(ref.kind, ref.game, ref.id, ref.file)))) {
            console.error(`  ! ${gametype.id}/${game}${team ? `/${team}` : ""} names ${ref.kind}/${ref.game}/${ref.id}/${ref.file}, which is not on disk`);
            missing++;
          }
        }
      }
    }
  }
  const casts = CAST_GAMES.filter((game) => castFor({ game, gametype: Object.values(GAMETYPES)[0]! }, view));
  console.log(`cast: ${casts.length} game(s) can be dressed (${casts.join(", ") || "none"})`);
  for (const game of casts) {
    const cast = castFor({ game, gametype: Object.values(GAMETYPES)[0]! }, view)!;
    console.log(
      `  ${game.padEnd(6)} ${String(cast.characters.length).padStart(2)} body(s), hands ${cast.hands.id}, clips ${cast.animations.id}, default ${cast.defaultWeapon ?? "none"}`,
    );
  }
  return missing;
}

/**
 * Every alias a script can `say`, against the sound banks that were built.
 *
 * The other half of the check `Script.sounds` exists for, and the reason it is
 * declared rather than left implicit in an `event` hook: a script naming an alias
 * no exporter produced is *silence* at run time, and silence that looks like
 * success is the failure mode the whole audio layer has been avoiding. A browser
 * warns once and carries on; this refuses the build.
 *
 * Checked against **every** bank on disk rather than one, because a script is not
 * per game and its vocabulary has to exist somewhere. A game with no bank at all
 * (Ghosts, whose weapons are silent for the same reason) is simply not one of
 * them, so it neither satisfies nor fails anything.
 */
async function reportScriptSounds(): Promise<number> {
  const root = path.join(path.dirname(CATALOG), "sounds");
  const games = await fs.readdir(root).catch(() => [] as string[]);
  const held = new Set<string>();
  for (const game of games) {
    const text = await fs.readFile(path.join(root, game, "mp", "sounds.json"), "utf8").catch(() => undefined);
    if (text !== undefined) {
      for (const alias of Object.keys((JSON.parse(text) as { aliases: Record<string, unknown> }).aliases)) {
        held.add(alias.toLowerCase());
      }
    }
  }

  const named = SCRIPTS.flatMap((script) => (script.sounds ?? []).map((alias) => [script.id, alias] as const));
  if (held.size === 0) {
    console.log(`scripts: ${named.length} alias(es) named, no sound bank built to check them against`);
    return 0;
  }
  let missing = 0;
  for (const [script, alias] of named) {
    if (!held.has(alias.toLowerCase())) {
      console.error(`  ! script "${script}" says "${alias}", which no built sound bank holds`);
      missing++;
    }
  }
  console.log(`scripts: ${named.length} alias(es) named by ${SCRIPTS.length} script(s), against ${held.size} in ${games.length} bank(s)`);
  return missing;
}

/**
 * Every alias an actor kind's sound roles name, against **its own game's** bank.
 *
 * Stricter than a script's check, because a kind names its game: a zombie whose
 * voice is only in another game's bank is silent. A game with no bank built is
 * said and skipped, as a script's aliases are with no bank at all.
 */
async function reportActorSounds(): Promise<number> {
  const root = path.join(path.dirname(CATALOG), "sounds");
  let missing = 0;
  for (const kind of ACTOR_KINDS) {
    if (!kind.sounds) {
      continue;
    }
    const { game, aliases } = kind.sounds;
    const text = await fs.readFile(path.join(root, game, "mp", "sounds.json"), "utf8").catch(() => undefined);
    if (text === undefined) {
      console.log(`actor ${kind.id}: no ${game} sound bank built to check its ${Object.keys(aliases).length} role(s) against`);
      continue;
    }
    const held = new Set(Object.keys((JSON.parse(text) as { aliases: Record<string, unknown> }).aliases).map((a) => a.toLowerCase()));
    const absent = Object.entries(aliases).filter(([, alias]) => !held.has(alias.toLowerCase()));
    for (const [role, alias] of absent) {
      console.error(`  ! actor ${kind.id}'s ${role} is "${alias}", which the ${game} sound bank does not hold`);
    }
    missing += absent.length;
    console.log(`actor ${kind.id}: ${Object.keys(aliases).length - absent.length} of ${Object.keys(aliases).length} sound role(s) in the ${game} bank`);
  }
  return missing;
}

// 39.37 CoD units to the metre (scripts/cod/units.py). A damage range is the one
// number here a reader is likely to take for metres, so it is printed as both.
const UNITS_PER_M = 39.37;

/** What a shot does: the numbers a server judges one by, in the game's own units. */
function ballistics(def: WeaponDef): string[] {
  const out: string[] = [];
  const d = def.damage ?? {};
  const range =
    d.maxRange !== undefined && d.minRange !== undefined
      ? ` over ${d.maxRange}-${d.minRange} units (${(d.maxRange / UNITS_PER_M).toFixed(1)}-${(d.minRange / UNITS_PER_M).toFixed(1)} m)`
      : "";
  out.push(
    `  ${def.weaponType ?? "?"}, ${def.shotCount ?? 0} pellet(s), damage ${d.max ?? "?"} to ${d.min ?? "?"}${range}, melee ${d.melee ?? "?"}, penetrates ${def.penetrateType ?? "?"}`,
  );

  const s = def.spread ?? {};
  const stance = (lo?: number, hi?: number): string => `${lo ?? "?"}-${hi ?? "?"}`;
  out.push(
    `  spread: ADS ${s.ads ?? "?"}, hip ${stance(s.hipStandMin, s.hipStandMax)} standing, ${stance(s.hipDuckedMin, s.hipDuckedMax)} ducked, ${stance(s.hipProneMin, s.hipProneMax)} prone (degrees)`,
  );
  out.push(`          +${s.fireAdd ?? "?"} a shot, +${s.moveAdd ?? "?"} moving, +${s.turnAdd ?? "?"} turning, decaying ${s.decayRate ?? "?"}/s`);

  const loc = def.locationDamage ?? {};
  const named = HIT_LOCATIONS.filter((where) => loc[where] !== undefined);
  // Only what differs from the body multiplier, plus the head: the other fifteen
  // are 1 on every catalogued weapon and would bury the two that are not.
  const body = loc.torsoUpper ?? 1;
  const notable = named.filter((where) => where === "head" || loc[where] !== body);
  out.push(
    named.length === 0
      ? "  no location damage: Ghosts orders its `loc*` its own way and the dumper writes none yet (docs/cod/reference.md)"
      : `  location damage: body x${body}, ${notable.map((where) => `${where} x${loc[where]!}`).join(", ")} (${named.length} location(s))`,
  );
  return out;
}

/**
 * The recoil, both families, as degrees rather than as the weapon file's own
 * units — the scale is `sim/recoil.ts`'s estimate and is the point of printing
 * it. The view kick is the one that decides where a round goes; the gun kick
 * rocks the model, which is why a scoped sniper reads 0 there and is not broken.
 */
function recoil(def: WeaponDef): string[] {
  const m = def.motion;
  const at = (hip: string, ads: string, aimed: boolean): number | undefined => m[aimed ? ads : hip] ?? m[hip];
  const pair = (name: string, aimed: boolean, scale: number): string => {
    const lo = at(`hip${name}Min`, `ads${name}Min`, aimed);
    const hi = at(`hip${name}Max`, `ads${name}Max`, aimed);
    return lo === undefined || hi === undefined ? "-" : `${(lo * scale).toFixed(2)} to ${(hi * scale).toFixed(2)}`;
  };
  const out: string[] = [];
  for (const aimed of [false, true]) {
    const where = aimed ? "ADS" : "hip";
    const centre = at("hipViewKickCenterSpeed", "adsViewKickCenterSpeed", aimed) ?? 0;
    out.push(
      `  ${where} view kick: pitch ${pair("ViewKickPitch", aimed, VIEW_KICK_SCALE)}°/s, yaw ${pair("ViewKickYaw", aimed, VIEW_KICK_SCALE)}°/s thrown, ` +
        `pulled back at ${(centre * VIEW_KICK_SCALE).toFixed(0)}°/s² (positive pitch is up)`,
    );
    out.push(`  ${where} gun kick:  pitch ${pair("GunKickPitch", aimed, 1)}, yaw ${pair("GunKickYaw", aimed, 1)} (°/s into the model; not the aim)`);
  }
  return out;
}

/** The numbers a fitted set changes, and only those: a diff reads better than two full definitions. */
function changes(entry: WeaponEntry, fitted: readonly number[]): string[] {
  const bare = entry.def;
  const now = resolveWeapon(entry, fitted);
  const out: string[] = [];

  for (const key of [
    "clipSize",
    "fireType",
    "adsZoomFov",
    "adsOverlay",
    "boltAction",
    "roundsPerLoad",
    "shotCount",
    "weaponType",
    "weaponClass",
    "penetrateType",
  ] as const) {
    if (bare[key] !== now[key]) {
      out.push(`${key}: ${String(bare[key])} -> ${String(now[key])}`);
    }
  }
  for (const key of ["roles", "times", "motion", "damage", "spread", "locationDamage", "sounds"] as const) {
    const before = (bare[key] ?? {}) as Record<string, unknown>;
    const after = (now[key] ?? {}) as Record<string, unknown>;
    for (const field of Object.keys(after)) {
      if (before[field] !== after[field]) {
        out.push(`${key}.${field}: ${String(before[field] ?? "-")} -> ${String(after[field])}`);
      }
    }
  }
  const gone = bare.hideBones.filter((b) => !now.hideBones.includes(b));
  const added = now.hideBones.filter((b) => !bare.hideBones.includes(b));
  if (added.length) {
    out.push(`hides ${added.join(", ")}`);
  }
  if (gone.length) {
    out.push(`shows ${gone.join(", ")}`);
  }
  return out;
}

function describe(registry: WeaponRegistry, id: string, wanted: string[]): number {
  const entry = registry.entry(id);
  if (!entry) {
    console.error(`no weapon "${id}" in the catalogue; ids are <game>/<name>, as \`pnpm catalog\` lists them`);
    return 1;
  }

  const def = entry.def;
  // The bolt is most of the time between two shots, so it belongs beside the fire type rather than in the times.
  const cycle = def.boltAction ? `, bolt-action (${((def.times.fire ?? 0) + (def.times.rechamber ?? 0)).toFixed(3)}s a shot)` : "";
  console.log(`\n${id} (${entry.slot ?? "?"}, ${entry.class ?? "?"}): ${def.clipSize} rounds, ${def.fireType}${cycle}, ADS ${def.adsZoomFov ?? "none"}`);
  console.log(`  ${Object.keys(def.roles).length} role(s) over ${Object.keys(def.clips).length} clip(s), hides ${def.hideBones.join(", ") || "nothing"}`);
  for (const line of [...ballistics(def), ...recoil(def)]) {
    console.log(line);
  }
  if (def.adsOverlay) {
    console.log(`  aimed through ${def.adsOverlay}, which hides the weapon`);
  }
  // The aliases it is heard through, which are the weapon file's own names and
  // not spellings of its id — `iw5_m4_mp` is `weap_m4carbine_*`. An impact is a
  // prefix: the surface completes it (docs/engine/audio.md).
  if (def.sounds) {
    const { notes, impact, ...aliases } = def.sounds;
    const named = Object.entries(aliases).map(([role, alias]) => `${role} ${alias}`);
    console.log(`  sounds: ${named.join(", ") || "none"}`);
    console.log(`          impact ${impact ?? "none"}_<surface>, ${Object.keys(notes ?? {}).length} notetrack(s)`);
  }
  if (def.roundsPerLoad > 0) {
    console.log(
      `  reloads ${def.roundsPerLoad} at a time: ${def.times.reloadStart ?? 0}s in, ${def.times.reload ?? 0}s each, ${def.times.reloadEnd ?? 0}s out`,
    );
  }

  if (wanted.length === 0) {
    for (const [slot, attachment] of entry.attachments.entries()) {
      const where = attachment.model ? `${attachment.model} on ${attachment.tag ?? "?"}` : "no model";
      console.log(`  ${String(slot).padStart(2)} ${attachment.id.padEnd(16)} ${(attachment.type ?? "?").padEnd(12)} ${where}`);
      for (const line of changes(entry, [slot])) {
        console.log(`       ${line}`);
      }
    }
    return 0;
  }

  const fitted = fittedSlots(entry, wanted);
  const found = fittedIds(entry, fitted);
  const unknown = wanted.filter((name) => !found.includes(name));
  if (unknown.length) {
    console.error(`  ! ${id} does not offer ${unknown.join(", ")}`);
    return 1;
  }
  console.log(`  fitted ${found.join(" + ")} (slots ${fitted.join(", ")}):`);
  const lines = changes(entry, fitted);
  for (const line of lines.length ? lines : ["nothing this build reads"]) {
    console.log(`    ${line}`);
  }
  return 0;
}

const body = await readCatalog();
const weapons = body.weapons;
// The constructor is the check: it refuses a duplicate id, and a weapon offering
// more attachments than a four-bit slot index can name.
const registry = new WeaponRegistry(weapons);

const [target, ...wanted] = process.argv.slice(2);
if (target) {
  process.exit(describe(registry, target, wanted));
}

const fitted = weapons.filter((w) => w.attachments.length > 0);
const most = Math.max(0, ...weapons.map((w) => w.attachments.length));
console.log(`${registry.size} weapon(s), ${fitted.length} with attachments, at most ${most} on one weapon`);
console.log(`catalogHash ${registry.hash} — a game server refuses a join that does not carry this`);
for (const id of registry.order) {
  const entry = registry.entry(id)!;
  const list = entry.attachments.map((a) => a.id).join(", ");
  console.log(`  ${id.padEnd(28)} ${String(entry.attachments.length).padStart(2)}  ${list}`);
}

// Non-zero on a cast naming a file that is not there, or a script or an actor
// kind naming a sound that is not built, so this is a check and not only a report. Both are run
// before either is judged: one run should report everything wrong at once.
const wrong = (await reportCast(body, registry)) + (await reportScriptSounds()) + (await reportActorSounds());
process.exit(wrong === 0 ? 0 : 1);
