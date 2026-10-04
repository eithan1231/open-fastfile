"""Sound aliases: the table a world's ambience draws from, and the clips behind it.

The `sound` dump is one JSON per `snd_alias_list_t` (docs/cod/pipeline.md#the-dump-tree),
lossless and in game units. A map places an alias by
name through its createfx script, an alias names clips, and an alias may name
one more alias as a layer -- so what a world ships is a closure, exactly as an
effect's children are (`fx.py`).

Four conventions here were read out of the 7,387-alias MW3 bank rather than
assumed, and every one of them fails as *silence* rather than as an error:

- **`spatial` is derived from distance, not from a flag.** IW5 spells "never
  attenuate" as an absurd `distMax`, and `SPATIAL_MAX_UNITS` below is where the
  data splits (docs/cod/audio.md#how-far-a-sound-carries).
- **`probability` is an unnormalised weight**, not a probability: 1.3 and 0.05
  both occur. It is emitted as `weight` and normalised by whoever picks.
- **A leading comma means "defined in another zone"** -- on an alias name, on a
  clip's path, and on a `volumeFalloffCurve` alike. Left on, every map-zone
  clip shared with the common bank resolves to nothing.
- **Names are case-inconsistent in the game's own data**: dome places
  `emt_wind_grass_Ext` against a zone that defines `emt_wind_grass_ext`. Keys
  are lower-cased, and `load_dump` asserts that lower-casing collides nothing.
"""

import os
import re
import subprocess

from . import iwd
from .collision import ENGINE_SURFACES
from .files import read_bytes, read_json, write_json
from .t6 import sab
from .units import UNITS_PER_M

# At or above this `distMax`, an alias is the game saying "this is not somewhere
# in the world" -- the player's own weapon, a map-wide bed, a UI blip. Below it
# the bank is a dense continuum of real distances topping out at 22,000 in;
# at and above it there are six round constants and nothing else. Such an alias
# becomes a non-positional voice, because scaled naively a `_plr` rifle is a
# 63 km sphere, which sounds right until two players stand apart.
SPATIAL_MAX_UNITS = 25000.0

# Bit 0 of `flags` is looping, by correlation across the whole bank; OAT names
# no bit for any IW game, so nothing else in the word is interpreted and the raw
# value is carried through for whoever finds evidence for the rest.
LOOP_FLAG = 0x1

# Black Ops (T5) says what IW5 leaves to `distMax`: bit 1 is "3D". Set on every
# `_npc` alias and on 5% of `_plr` ones; on 98% of entries with a range and on 5
# of the 2,974 whose `distMax` is 0, which is how T5 spells "not in the world".
T5_SPATIAL_FLAG = 0x2

# T5 stores what IW5 stores as floats as fixed-point integers. Each scale is the
# one under which the bank's common values land on the grid it was authored on:
# volume `v / 65535` is whole decibels (46,395 is -3 dB, 41,349 is -4, 655 is -40),
# pitch `v / 32767` is semitones and round rates (27,553 is 2^(-3/12), 34,396 is
# 1.05), probability `p / 255` is 1, 0.5, 0.4, 0.2. Distances are inches and
# delays milliseconds, as IW5's are. docs/cod/audio.md#black-ops-t5.
T5_VOLUME_ONE, T5_PITCH_ONE, T5_PROBABILITY_ONE = 65535.0, 32767.0, 255.0

# Black Ops II's `volumeGroup` (bits 17-21 of `flags0`) where it names a mixer group
# the engine has: every `amb_*` entry but 35 of 264 is `grp_ambience` (21), and
# `grp_weapon` (15) is the commonest group of `wpn_*`. The rest -- foley, impacts,
# voice, music -- say nothing the engine's three channels do.
T6_VOLUME_GROUP_SHIFT, T6_VOLUME_GROUP_MASK = 17, 0x1F
T6_MIXER_GROUPS = {15: "weapons", 21: "ambience"}
# Where a T6 recording is: not in the zone and not in a .iwd, but an entry of a
# `.sabl`/`.sabs` bank file (t6/sab.py), which the dump names by path.
BANKED = "SAT_BANKED"


def _under_sound(path):
    """A T5 clip path as IW5 spells one: forward slashes, relative to `sound/`.

    T5 writes the whole Windows path (`sound\\fly\\footsteps\\...`); IW5 names a
    clip from inside `sound/`, which is where both the loaded dump and the .iwd
    lookup put it back.
    """
    path = path.replace("\\", "/")
    return path[len("sound/") :] if path.lower().startswith("sound/") else path


def _t5_sound_file(sf):
    """A T5 `soundFile` in IW5's shape: its Windows paths with forward slashes, and a streamed one as dir/name."""
    if not sf:
        return sf
    out = {"typeName": sf.get("typeName"), "exists": sf.get("exists")}
    if sf.get("loaded"):
        out["loaded"] = {"name": _under_sound(sf["loaded"]["name"])}
    if sf.get("streamed") and sf["streamed"].get("filename"):
        directory, _, name = _under_sound(sf["streamed"]["filename"]).rpartition("/")
        out["typeName"] = STREAMED
        out["streamed"] = {"dir": directory, "name": name}
    return out


def t5_entry(entry):
    """One T5 alias entry in the units and names IW5's dump uses, so one converter reads both."""
    return {
        **entry,
        "secondaryAliasName": entry.get("secondaryname"),
        "soundFile": _t5_sound_file(entry.get("soundFile")),
        "volMin": entry["volMin"] / T5_VOLUME_ONE,
        "volMax": entry["volMax"] / T5_VOLUME_ONE,
        "pitchMin": entry["pitchMin"] / T5_PITCH_ONE,
        "pitchMax": entry["pitchMax"] / T5_PITCH_ONE,
        "probability": entry["probability"] / T5_PROBABILITY_ONE,
    }


def _t6_sound_file(sf):
    """A T6 `soundFile` as a bank entry: its recording's path under `sound/`, and the bank file and id it is kept at."""
    if not sf or not sf.get("path"):
        return {"typeName": None, "exists": False}
    bank = sf.get("bank")
    return {
        "typeName": BANKED,
        "exists": bool(sf.get("exists") and bank),
        "banked": {"name": sf["path"], "bank": bank["path"], "offset": bank["offset"]} if bank else None,
    }


def t6_entry(entry):
    """One T6 alias entry in the units and names IW5's dump uses: T5's scales, and the flags word that matters.

    T6's `SndAliasFlags` is OAT's layout, confirmed against the bank files rather
    than by correlation alone: bit 0 of `flags0` agrees with every bank entry's own
    looping byte, and bits 15-16 (the load type) with which kind of bank file holds
    the recording (docs/cod/audio.md#black-ops-ii-t6). Bit 1 is `panType` 3D, the
    same bit T5 uses for it.
    """
    group = (entry["flags0"] >> T6_VOLUME_GROUP_SHIFT) & T6_VOLUME_GROUP_MASK
    return {
        **t5_entry({**entry, "secondaryname": entry.get("secondaryName"), "soundFile": None}),
        "flags": entry["flags0"],
        "mixerGroup": T6_MIXER_GROUPS.get(group),
        "soundFile": _t6_sound_file(entry.get("soundFile")),
    }


# The mixer groups the game actually names. `max` is the enum's end marker and
# means the same as null: nothing said, so the engine assigns by what raised it.
MIXER_GROUPS = ("weapons", "ambience", "mission")

# Mono Opus at 48 kbit/s, which is transparent for this material and a fifteenth
# of the 705 kbit/s PCM it comes from. An ambience loop is the one sound heard
# for minutes at a time, so it gets VBR rather than a hard ceiling.
BITRATE = "48k"

# What the dump calls the two places a clip can be.
LOADED, STREAMED = "SAT_LOADED", "SAT_STREAMED"


# The games whose dump is not in IW5's units, and what reads one of their entries into them.
ENTRY_READERS = {"t5": t5_entry, "t6": t6_entry}


def ref(name):
    """An alias or clip name as identity: no companion-zone marker, and lower case.

    A map zone spells a clip it shares with the common bank
    `,footsteps/foot_dirt01.wav`; the comma is linkage, not part of the name.
    """
    return (name[1:] if name.startswith(",") else name).lower()


def load_dump(root):
    """{alias name: dumped JSON} for every `sound_aliases/<name>.json` under `root`.

    Keys are lower-cased because the game's own data is not consistent about
    case and matches without it. Asserted rather than assumed: two aliases
    differing only in case would silently shadow each other here.
    """
    defs = {}
    for dirpath, _dirs, files in os.walk(root):
        for f in files:
            if not f.endswith(".json"):
                continue
            data = read_json(os.path.join(dirpath, f))
            if data.get("_type") != "sound_alias":
                continue
            if data.get("_game") in ENTRY_READERS:
                data = {**data, "entries": [ENTRY_READERS[data["_game"]](e) for e in data["entries"]]}
            key = ref(data["name"])
            if key in defs and defs[key]["name"] != data["name"]:
                raise ValueError(f"two aliases differ only in case: {defs[key]['name']} and {data['name']}")
            defs[key] = data
    if any(d.get("_game") in ENTRY_READERS for d in defs.values()):
        defs = t5_engine_names(defs)
    return defs


def closure(defs, wanted):
    """`wanted` plus every alias reachable through `secondaryAliasName`. Returns (names, missing).

    A layer that really plays: 1,414 entries in the MW3 bank name one, and an
    alias named only as a layer and never exported plays as nothing, so the
    names that could not be resolved come back to be reported rather than
    dropped -- the same contract `fx.closure` has for an effect's children.
    """
    seen, missing, queue = set(), set(), [ref(n) for n in wanted]
    while queue:
        name = queue.pop()
        if name in seen or name in missing:
            continue
        alias = defs.get(name)
        if alias is None:
            missing.add(name)
            continue
        seen.add(name)
        queue.extend(ref(e["secondaryAliasName"]) for e in alias["entries"] if e.get("secondaryAliasName"))
    return seen, missing


def clip_file(entry):
    """The clip an entry plays, as (where it is, its path in the world, its path in the game), or None.

    `SAT_LOADED` is PCM inside the fastfile, which the loadedsound dump writes
    out under this same path; `SAT_STREAMED` is not in the zone at all and
    resolves into the game's .iwd archives at `sound/<dir>/<name>`. A T6 entry
    is `SAT_BANKED` whatever its load type, because both halves are entries of
    the `.sabl`/`.sabs` bank files, read by bank path and offset. The world keeps
    the game's own path, minus the extension it no longer has.
    """
    sf = entry.get("soundFile") or {}
    if not sf.get("exists"):
        return None
    if sf.get("typeName") == LOADED and sf.get("loaded"):
        name = ref(sf["loaded"]["name"])
        return LOADED, os.path.splitext(name)[0], name
    if sf.get("typeName") == STREAMED and sf.get("streamed"):
        stream = sf["streamed"]
        name = ref(stream["dir"]) + "/" + ref(stream["name"])
        return STREAMED, os.path.splitext(name)[0], "sound/" + name
    if sf.get("typeName") == BANKED and sf.get("banked"):
        banked = sf["banked"]
        return BANKED, ref(banked["name"]), (banked["bank"], banked["offset"])
    return None


def _channel(entry):
    group = entry.get("mixerGroup")
    return group if group in MIXER_GROUPS else None


def convert(alias):
    """One dumped alias list in engine units: metres, seconds, and a flat clip list.

    An alias list is several entries -- the recordings it picks between -- and
    the schema carries one playback for all of them. Every numeric pair is
    therefore the **envelope** over the entries, so a variant that was quieter or
    lower is still inside the range sampled from; the single-valued fields come
    from the first entry, bar `loop`, which is true if any entry loops. A loop
    exported as a one-shot is a second of wind and then nothing.
    """
    entries = alias["entries"]
    first = entries[0]
    channel = _channel(first)
    clips = []
    for entry in entries:
        found = clip_file(entry)
        if found:
            clips.append({"file": found[1], "weight": entry["probability"]})
    dist_max = max(e["distMax"] for e in entries)
    return {
        "clips": clips,
        "volume": [min(e["volMin"] for e in entries), max(e["volMax"] for e in entries)],
        "pitch": [min(e["pitchMin"] for e in entries), max(e["pitchMax"] for e in entries)],
        "range": [min(e["distMin"] for e in entries) / UNITS_PER_M, dist_max / UNITS_PER_M],
        "loop": any(e["flags"] & LOOP_FLAG for e in entries),
        "spatial": (
            any(e["flags"] & T5_SPATIAL_FLAG for e in entries)
            if alias.get("_game") in ENTRY_READERS
            else dist_max < SPATIAL_MAX_UNITS
        ),
        "delay": first["startDelay"] / 1000.0,
        # The raw word, undecoded past bit 0, so that evidence for another bit
        # costs a reader and not a re-export.
        "flags": first["flags"] & 0xFFFFFFFF,
        **({"channel": channel} if channel else {}),
        **({"with": ref(first["secondaryAliasName"])} if first.get("secondaryAliasName") else {}),
    }


def _transcode(blob, out_path, bitrate=BITRATE):
    """One clip as mono Opus in WebM. Returns the bytes written.

    Fed over a pipe rather than by path: a streamed clip is read straight out of
    a .iwd and never exists as a file, and a loaded one is small enough that one
    read costs nothing. `-ac 1` is not a formality -- the bank is mostly mono,
    but not all of it, and a stereo emitter cannot be panned.
    """
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    args = ["-c:a", "libopus", "-b:a", bitrate, "-vbr", "on", "-ac", "1", "-application", "audio", "-f", "webm"]
    subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-y", "-i", "pipe:0", *args, out_path],
        input=blob,
        check=True,
        capture_output=True,
    )
    return os.path.getsize(out_path)


def _loaded_index(sound_roots):
    """{lower-case path without extension: file} over one or more loadedsound dumps.

    The dumper writes `sound/<the alias' own path>.wav`, so the index is over
    exactly the names an alias entry spells -- matched without case, like
    everything else the game names. Several roots because the catalogue reads a
    game's bank *and* one map zone, and the earlier root wins: a map zone spells
    a clip it shares with the bank `,footsteps/foot_dirt01.wav`, which is the
    bank's copy under another name.
    """
    have = {}
    roots = [sound_roots] if isinstance(sound_roots, str) else list(sound_roots or ())
    for root in roots:
        if not root or not os.path.isdir(root):
            continue
        for dirpath, _dirs, files in os.walk(root):
            for f in files:
                rel = os.path.relpath(os.path.join(dirpath, f), root)
                have.setdefault(os.path.splitext(rel)[0].lower().replace(os.sep, "/"), os.path.join(dirpath, f))
    return have


def clip_sources(aliases):
    """{path in the world: (where it is, its path in the game)} over every alias' clips."""
    wanted = {}
    for alias in aliases.values():
        for entry in alias["entries"]:
            found = clip_file(entry)
            if found:
                wanted[found[1]] = (found[0], found[2])
    return wanted


def export_clips(wanted, out_dir, sound_roots=(), search=None, bitrate=BITRATE):
    """Convert every clip in `wanted` into `<out_dir>/<path>.webm`.

    Returns (converted, missing paths, bytes in, bytes out). A clip that cannot
    be found is named rather than counted: an alias whose recordings are all
    missing plays as nothing, which nothing downstream would report.
    """
    loaded = _loaded_index(sound_roots)
    ok, missing, size_in, size_out = 0, [], 0, 0
    for path, (kind, source) in sorted(wanted.items()):
        if kind == LOADED:
            found = loaded.get(path)
            blob = read_bytes(found) if found else None
        elif kind == BANKED:
            blob = sab.read_clip(*source)
        else:
            blob = iwd.read(search, source) if search else None
        if not blob:
            missing.append(path)
            continue
        size_in += len(blob)
        size_out += _transcode(blob, os.path.join(out_dir, path + ".webm"), bitrate)
        ok += 1
    return ok, missing, size_in, size_out


def export_sounds(alias_root, wanted, out_dir, sound_root=None, search=None, bitrate=BITRATE):
    """`export_from_defs` over one dumped `sound_aliases/` directory."""
    return export_from_defs(load_dump(alias_root), wanted, out_dir, sound_root, search, bitrate)


def export_from_defs(defs, wanted, out_dir, sound_roots=(), search=None, bitrate=BITRATE):
    """Write `<out_dir>/sounds.json` for `wanted` and every alias it layers in, and its clips.

    Returns (the table, missing alias names, clips converted, missing clip
    paths, bytes in, bytes out).
    """
    names, missing = closure(defs, wanted)
    aliases = {name: convert(defs[name]) for name in sorted(names)}

    clips = clip_sources({name: defs[name] for name in names})
    ok, lost, size_in, size_out = export_clips(clips, os.path.join(out_dir, "clips"), sound_roots, search, bitrate)

    game_key = next((defs[n]["_game"] for n in sorted(names)), "iw5")
    os.makedirs(out_dir, exist_ok=True)
    write_json(os.path.join(out_dir, "sounds.json"), {"_version": 1, "game": game_key, "aliases": aliases})
    return aliases, missing, ok, lost, size_in, size_out


# --- The shared catalogue's half ----------------------------------------------

# What belongs to no one map, as prefixes over the bank's own names. `land*`
# rather than `land_*` because the game spells a landing `Land_plr_carpet`
# beside `land_plr_ceramic` and `ref` has already lower-cased both; nothing else
# in the 7,387-alias bank begins with those five letters.
#
# `foley*` matches nothing in IW5 -- its body foley is `gear_rattle_*` -- and is
# named anyway, because a game that does spell it that way then costs no rule.
CATALOG_FAMILIES = {
    "steps": ("step_", "land"),
    "foley": ("bodyfall_", "bodyslam_", "gear_", "foley", "breathing_"),
    # What a zombie does and what a zombies round says, in Black Ops II's spelling:
    # the vocals, the swing, the gibs, spawning and going inert, the round's start
    # and end, and a purchase taken or refused. No map's own enemy (TranZit's
    # screecher and avogadro) and no perk, box or power: nothing plays those yet.
    "zombies": (
        "zmb_vocals_zombie_",
        "zmb_attack_whoosh",
        "zmb_death_gibs",
        "zmb_zombie_",
        "mus_zombie_round_",
        "zmb_cha_ching",
        "zmb_no_cha_ching",
    ),
}

# The announcements something actually asks for, by name and one at a time.
#
# Not a prefix family, deliberately: `mp_*` is 333 aliases of battle chatter and
# killstreak lines in six languages, and a root nothing asks for is how 161 MB of
# voiceover gets shipped (docs/engine/audio.md#where-sound-lives). A gametype's
# own vocabulary arrives through the scripting layer and adds to this list entry
# by entry -- the other end of the ledger is `Script.sounds`, which `pnpm catalog`
# checks against what was actually built.
#
# Three today: the hit marker the engine raises itself, and the two the countdown
# script says (`@3d/shared/game/scripts/countdown.ts`). Those two cost 29 KB of
# Opus, out of 907 KB of source PCM -- and one of them is streamed, so it comes
# from the .iwd archives rather than from the zone like the hit marker does.
FEEDBACK_ALIASES = ("mp_hit_alert", "ui_mp_timer_countdown", "mp_bonus_start")

# A legal alias name, which is also what the DSL's bare `alias:` identifier
# allows. Used to pick aliases out of the prose a weapon file keeps them in.
ALIAS_TOKEN = re.compile(r"[A-Za-z_][A-Za-z0-9_-]*")


def family_of(name):
    """Which catalogue family an alias name belongs to, or None."""
    for family, prefixes in CATALOG_FAMILIES.items():
        if name.startswith(prefixes):
            return family
    return None


def family_closure(defs, family):
    """The aliases of one catalogue family in `defs`, and every alias they layer in."""
    names, _missing = closure(defs, {name for name in defs if family_of(name) == family})
    return {name: defs[name] for name in names}


def weapon_roots(infos, defs):
    """Every alias the weapon files in `{name: info}` name, of those `defs` holds.

    A weapon file spells its sounds across some thirty keys and two embedded
    tables -- `notetrackSoundMap` pairs an animation's notetrack with an alias,
    `soundOverrides` pairs an attachment combination with the fire sound it
    swaps in -- so every word of every key whose name says *sound* is read, and
    kept only where the bank has an alias by that name. That is what drops
    `none`, `fire` and the twelve `missileConeSound*` numbers without a list of
    keys to keep up to date per game.
    """
    found = set()
    for info in infos.values():
        for key, value in info.items():
            if "sound" not in key.lower() or not value:
                continue
            found |= {ref(t) for t in ALIAS_TOKEN.findall(value) if ref(t) in defs}
    return found


def impact_roots(defs, infos):
    """Every `<impactType>_<surface>` the catalogued weapons can make, of those the bank holds.

    Spelled by concatenation rather than taken as a family, because `bullet_*`
    is 375 aliases and most of them are for surfaces no collision triangle can
    answer: the bank has `bottle`, `crate`, `piano`, `teddybear` and `vase`, and
    `ENGINE_SURFACES` is the 33 a `.glb` can store. The exit wounds
    (`bullet_*_exit_*`) are left out for the same reason — nothing traces a
    round out the far side of anything yet.

    Measured, and the gaps are the point: `bullet_ap` has all 31 IW surfaces,
    `bullet_small` 30 (no `snow`) and `bullet_large` 29 (no `snow`, no `water`),
    so the engine falls back to each family's own `_default`. Six of MW3's guns
    carry `impactType shotgun`, for which the bank has **nothing at all**, and
    they are silent on impact.
    """
    families = {impact for info in infos.values() if (impact := (info.get("impactType") or "").strip())}
    wanted = {f"{family}_{surface}" for family in families for surface in ENGINE_SURFACES}
    return {name for name in wanted if name in defs}


def notetrack_roots(entries, defs):
    """Every alias the built weapon entries' clips play by notetrack (`def.sounds.notes`), of those `defs` holds.

    Black Ops II's weapon files name no reload sound: each clip's `sndnt#<alias>`
    notetracks do (viewmodel.notetrack_sounds), so the only place to read them from
    is the clips, which the catalogue's weapon entries have already decoded. For the
    other games this adds nothing `weapon_roots` has not already found."""
    found = set()
    for entry in entries:
        sounds = (entry.get("def") or {}).get("sounds") or {}
        found |= {alias for alias in (sounds.get("notes") or {}).values() if alias in defs}
        for attachment in entry.get("attachments") or []:
            found |= {a for a in ((attachment.get("overrides") or {}).get("sounds") or {}).values() if a in defs}
    return found


def catalog_roots(defs, weapons):
    """{family: root names} the shared catalogue is the closure of.

    Roots rather than the whole bank: MW3's is 7,387 aliases and 161 MB of JSON,
    overwhelmingly campaign voiceover and battlechatter no multiplayer game
    plays. A family is named here only when something is going to ask for it by
    name -- which is also why a group appearing empty is a finding and not a
    quiet success.
    """
    roots = {family: set() for family in CATALOG_FAMILIES}
    for name in defs:
        family = family_of(name)
        if family:
            roots[family].add(name)
    roots["weapons"] = weapon_roots(weapons, defs) - set().union(*roots.values())
    # After `weapons`, so an impact alias a weapon file happens to name is counted
    # once. A round arriving is not the weapon's own sound in the game's data
    # either: `impactType` is a *prefix* and the surface completes it, which is
    # why `weapon_roots` cannot find these on its own.
    roots["impacts"] = impact_roots(defs, weapons) - set().union(*roots.values())
    roots["feedback"] = {name for name in FEEDBACK_ALIASES if name in defs}
    return roots


def own_steps(defs):
    """The player's own footsteps and landings in a dump.

    The sixteen the IW5 bank has not got, and the test for whether a map zone is
    worth taking the union with: `step_*_plr_*` is the listener's own boot and
    `land*` is what it comes down on.
    """
    return {name for name in defs if (name.startswith("step_") and "_plr_" in name) or name.startswith("land")}


# The names the engine asks for, in Black Ops' own spelling. The engine spells a
# footstep, a landing, an impact and the hit marker as IW5 does
# (`@3d/shared/sim/footsteps.ts`); T5 prefixes each with its category (`fly_`,
# `prj_`, `mpl_`) and writes someone else's boots `_npc` where IW5 writes nothing.
# The `qstep`/`qland` sets are the quieter ones a perk swaps in.
T5_ENGINE_NAMES = (
    (re.compile(r"^fly_step_([a-z_]+?)_plr_([a-z]+)$"), r"step_\1_plr_\2"),
    (re.compile(r"^fly_step_([a-z_]+?)_npc_([a-z]+)$"), r"step_\1_\2"),
    (re.compile(r"^fly_land_plr_([a-z]+)$"), r"land_plr_\1"),
    (re.compile(r"^fly_land_npc_([a-z]+)$"), r"land_\1"),
    (re.compile(r"^prj_bullet_impact_([a-z]+)_([a-z]+)$"), r"bullet_\1_\2"),
    (re.compile(r"^mpl_hit_alert$"), "mp_hit_alert"),
)


def t5_engine_names(defs):
    """`defs` plus each alias the engine asks for by an IW5 name, under that name too.

    Added beside the game's own names rather than instead of them, because a
    weapon file and a layer still name the T5 spelling.
    """
    out = dict(defs)
    for name, alias in defs.items():
        for pattern, spelling in T5_ENGINE_NAMES:
            if pattern.match(name):
                engine = pattern.sub(spelling, name)
                out.setdefault(engine, {**alias, "name": engine})
                break
    return out


def merge_dumps(bank, extra):
    """`bank` widened by `extra`. Returns (defs, the names both hold, the names they disagree on).

    The catalogue is built from a game's own companion zone and from nothing
    else, and sound is the one documented exception: sixteen `step_run_plr_*`,
    `step_sprint_plr_*` and `land*` aliases -- the player's own footsteps and
    landings -- are absent from IW5's bank and defined by every map zone instead
    (docs/engine/audio.md#where-sound-lives).

    So the overlap is *proved* identical rather than trusted, and a disagreement
    comes back to be reported rather than resolved by a merge rule: two zones
    that mean different things by one name is a finding about the game's data,
    and picking one of them silently is how the catalogue would start shipping a
    map's own sound to every other map.
    """
    shared = sorted(set(bank) & set(extra))
    conflicts = [name for name in shared if convert(bank[name]) != convert(extra[name])]
    return {**extra, **bank}, shared, conflicts
