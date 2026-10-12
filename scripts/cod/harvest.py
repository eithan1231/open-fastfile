"""Move the cast every world packs into the shared catalogue, from what is on disk.

A world used to ship the people in it: its own bodies, its own heads, its own
third-person gun, its own clip file, and **every** pair of view hands its zone
shipped in order to name one. That is ~17 MB a world to use about 1 MB of it, and
it is why a body could not be worn in another map.

This needs no game files. The GLBs are already exported and, across the worlds of
one game, byte-identical — a body is a body, and the exporter wrote it the same
way every time. So a harvest reads `worlds/`, writes `worlds/catalog/`, and leaves
`worlds/*/assets/` alone: the two sit side by side until a later stage removes the
per-world copies, which is what makes the change reviewable.

**Keyed by the path relative to the family root, never the basename.**
`prisonbreak-ghosts` packs both `props/iw6_pbk_rock_large_01_lod0.glb` and
`props/mv/iw6_pbk_rock_large_01_lod0.glb`, with different bytes — `pack_models`
keeps the subpath. Keyed by basename those two silently become one asset.
"""

import hashlib
import json
import os
import re
import shutil

from . import cast_clips
from .catalog import entry_dir, scan_entries, write_index
from .characters import CAST_FILE, side_of
from .files import read_json, read_text, write_text
from .gltf import read_glb
from .viewmodel import is_view_hands
from .worlds import imported_worlds

# Where each family sits under a world's `assets/`, and the catalogue kind it
# becomes. `weapons` is not here: a weapon already lives in the catalogue, which
# is the whole reason a world names one rather than packing it.
CHARACTERS_DIR = "characters"
VIEWHANDS_DIR = "viewmodel"

# A world whose `cast.json` names no anim type has it in this file's extras
# instead, beside its bodies. Read for that alone: the clips in it are not harvested.
ANIM_FILE = "animations.glb"

# The third-person gun hung on a body's `j_gun`. Its own kind rather than a file
# inside each character entry, because one world weapon serves every body of a
# game — exactly one per game on this disk — and copying it into 26 entries would
# store it 26 times.
#
# Not indexed: a character entry *names* it (`bakedWeapon`) and the cast addresses
# it by id, as attachments and overlays already are. Nothing enumerates it.
WORLDWEAPONS_KIND = "worldweapons"

# One `character` block of a `characters.world`, back when a world declared one.
# A regex rather than a parser because the file was machine-written to a fixed
# shape, and the DSL's own parser is TypeScript. Kept for a tree that still has
# those files: the harvest is a migration, and it must keep working on a checkout
# that has not run it yet.
CHARACTER_BLOCK = re.compile(
    r"character\s+\S+\s*\{"
    r'\s*body:\s*"(?P<body>[^"]+)"'
    r'(?:\s*head:\s*"(?P<head>[^"]+)")?'
    r'(?:\s*weapon:\s*"(?P<weapon>[^"]+)")?'
    r"\s*\}"
)


def digest(path):
    with open(path, "rb") as fh:
        return hashlib.md5(fh.read()).hexdigest()


def scene_extras(path, key):
    """One glTF scene's `extras[key]`, or None. The definitions the exporter already wrote."""
    gltf, _ = read_glb(path)
    scenes = gltf.get("scenes") or [{}]
    return (scenes[gltf.get("scene", 0)].get("extras") or {}).get(key), gltf


class Collisions:
    """Same key, different bytes: the first world wins and the rest are reported.

    Never a substitution and never a merge. A world whose copy differs keeps its
    own — it stays valid on its own terms, and a later stage can look at the seven
    props and two clip files this actually finds rather than at a guess.
    """

    def __init__(self):
        self.seen = {}  # (kind, game, rel) -> (md5, world)
        self.clashes = []  # (kind, game, rel, first world, other world)

    def claim(self, kind, game, rel, path, world):
        """Whether `path` is the copy to harvest. False means one is already taken."""
        key = (kind, game, rel)
        md5 = digest(path)
        if key not in self.seen:
            self.seen[key] = (md5, world)
            return True
        if self.seen[key][0] != md5:
            self.clashes.append((kind, game, rel, self.seen[key][1], world))
        return False

    def report(self):
        for kind, game, rel, first, other in self.clashes:
            print(f"      !! {game}/{rel} differs between {first} and {other}; kept {first}'s ({kind})")


def _copy(src, kind, game, ident, worlds_root, name=None, dry_run=False):
    """One file into its catalogue entry folder. Returns its name inside the entry."""
    out = entry_dir(worlds_root, kind, game, ident)
    base = name or os.path.basename(src)
    if not dry_run:
        os.makedirs(out, exist_ok=True)
        shutil.copy2(src, os.path.join(out, base))
    return base


def _write_entry(kind, game, ident, body, worlds_root, dry_run=False):
    """An entry's own `<id>.json`, which `scan_entries` reads the index back from."""
    if dry_run:
        return
    out = entry_dir(worlds_root, kind, game, ident)
    os.makedirs(out, exist_ok=True)
    write_text(os.path.join(out, f"{ident}.json"), json.dumps(body, indent=1) + "\n")


def harvest_characters(worlds_root, collisions, dry_run=False):
    """Every body, its head and its baked gun into `catalog/characters/<game>/<body>/`.

    One entry per body rather than per side: a side is a body's *property*
    (`characters.side_of`, the exporter's own table), so a gametype asks for "this
    game's allies" and gets every body the games put there rather than the one
    whichever map happened to pick.
    """
    entries = []
    for world_dir, world, game in imported_worlds(worlds_root):
        cast = _cast_of(world_dir)
        for body, head, weapon, anim_type in cast:
            rel = os.path.basename(body)
            ident = rel.removesuffix(".glb")
            if not collisions.claim("characters", game, rel, body, world):
                continue
            files = {"body": _copy(body, "characters", game, ident, worlds_root, dry_run=dry_run)}
            if head:
                files["head"] = _copy(head, "characters", game, ident, worlds_root, dry_run=dry_run)
            # The gun this body was rigged holding, once per game rather than once
            # per body that names it.
            if weapon and collisions.claim(WORLDWEAPONS_KIND, game, os.path.basename(weapon), weapon, world):
                gun = os.path.basename(weapon).removesuffix(".glb")
                _copy(weapon, WORLDWEAPONS_KIND, game, gun, worlds_root, dry_run=dry_run)
            entry = {
                "id": ident,
                "game": game,
                # The faction the source game put this body on, which is what a
                # gametype asks by. None for a body whose family is not in SIDES.
                "side": side_of(ident),
                **files,
                # The gun whose joints are already grafted into this body
                # (characters.graft_weapon). Recorded, not used: a peer holds this
                # and not what their class names until run-time grafting exists.
                "bakedWeapon": os.path.basename(weapon).removesuffix(".glb") if weapon else None,
                "animType": anim_type,
            }
            _write_entry("characters", game, ident, entry, worlds_root, dry_run)
            entries.append(entry)
    return entries


def _cast_of(world_dir):
    """This world's (body, head, weapon, animType), as the characters stage paired them.

    `assets/characters/cast.json` is where an export writes the pairs down now;
    `characters.world` is where it used to, and a tree that has not been
    re-exported still has only that.

    The world file rather than a listing of `assets/characters/`, because the
    pairing is not recoverable from the filenames: sorted bodies and sorted heads
    do not correspond, and pairing by position puts `head_tf141_desert_a` on
    `mp_body_opforce_arab_assault_a` — the wrong face, on the wrong side, in 4 of
    the 26 bodies on this disk. `characters.py` decided each pair when it
    exported, and this is where it wrote the answer down.

    A harvest is a one-time migration and runs while those files are still here.
    """
    path = os.path.join(world_dir, "characters.world")
    assets = os.path.join(world_dir, "assets", CHARACTERS_DIR)
    cast_path = os.path.join(assets, CAST_FILE)
    if not os.path.isdir(assets) or not (os.path.isfile(cast_path) or os.path.isfile(path)):
        return []
    anim_type = None
    anim_path = os.path.join(assets, ANIM_FILE)
    if os.path.isfile(anim_path):
        spec, _ = scene_extras(anim_path, "characters")
        anim_type = (spec or {}).get("animType")

    def under(rel):
        """A world-relative `assets/characters/x.glb` as a real path, or None."""
        full = os.path.join(world_dir, rel)
        return full if rel and os.path.isfile(full) else None

    if os.path.isfile(cast_path):
        cast = read_json(cast_path)
        anim_type = cast.get("animType", anim_type)
        pairs = [(c["body"], c.get("head"), cast.get("weapon")) for c in cast.get("characters", [])]
    else:
        blocks = CHARACTER_BLOCK.finditer(read_text(path, "utf-8"))
        pairs = [tuple(m.group(k) for k in ("body", "head", "weapon")) for m in blocks]
    return [(under(body), under(head or ""), under(weapon or ""), anim_type) for body, head, weapon in pairs if under(body)]


def harvest_viewhands(worlds_root, collisions, dry_run=False):
    """Every pair of view hands into `catalog/viewhands/<game>/<id>/`.

    A world packs every pair its zone shipped in order to name one, so the
    catalogue gains all of them and no world needs any — measured at 203 MB of
    files holding 40 MB of distinct ones, with no pair differing within a game.
    """
    entries = []
    for world_dir, world, game in imported_worlds(worlds_root):
        d = os.path.join(world_dir, "assets", VIEWHANDS_DIR)
        for rel in sorted(os.listdir(d)) if os.path.isdir(d) else []:
            src = os.path.join(d, rel)
            if not is_view_hands(rel.removesuffix(".glb")) or not os.path.isfile(src):
                continue
            ident = rel.removesuffix(".glb")
            if not collisions.claim("viewhands", game, rel, src, world):
                continue
            entry = {
                "id": ident,
                "game": game,
                "hands": _copy(src, "viewhands", game, ident, worlds_root, dry_run=dry_run),
            }
            _write_entry("viewhands", game, ident, entry, worlds_root, dry_run)
            entries.append(entry)
    return entries


# Props are not in the default set. They are 717 MB and 44 tracked `props.world`
# files, so moving them is a deliberate act with a reviewable diff of its own, not
# something a cast harvest does on the way past. Nor are the clips a body plays:
# they are a game's and no world's, and cast_clips.py builds them.
HARVESTERS = ("characters", "viewhands")
ALL_HARVESTERS = (*HARVESTERS, "props")


def harvest(worlds_root, kinds=HARVESTERS, dry_run=False, prune=False):
    """The cast into the catalogue. Returns (entries by kind, problems)."""
    collisions = Collisions()
    by_kind, problems = {}, []
    if "characters" in kinds:
        by_kind["characters"] = harvest_characters(worlds_root, collisions, dry_run)
    if "viewhands" in kinds:
        by_kind["viewhands"] = harvest_viewhands(worlds_root, collisions, dry_run)
    if "props" in kinds:
        counts, kept = harvest_props(worlds_root, dry_run)
        print(f"      props: {counts['entries']} entries, {counts['rewritten']} declaration(s) rewritten")
        for note in kept:
            print(f"      .. {note}")
        if prune:
            freed, still, trouble = prune_props(worlds_root, dry_run)
            print(f"      pruned {freed / 1e9:.2f} GB of per-world copies; {still} file(s) still named by a world")
            for note in trouble:
                print(f"      .. {note}")
    collisions.report()
    return by_kind, problems


def harvest_after_export(worlds_root, work, game_key):
    """The cast harvest an export runs on its way out, the clip set rebuilt over it, and the index after both.

    The clips come out of the export's own dumps in `work`, over every body of
    `game_key` the harvest has just left in the catalogue. Without the index the
    entries land on disk and neither end is served them. Returns the problems.
    """
    _, problems = harvest(worlds_root)
    problems += cast_clips.build(work, worlds_root, game_key)
    write_index(worlds_root, scan_entries(worlds_root))
    return problems


def main(args):
    kinds = tuple(args.kinds) if args.kinds else HARVESTERS
    print(f"  harvesting {', '.join(kinds)} from {args.worlds}{' (dry run)' if args.dry_run else ''}")
    by_kind, problems = harvest(args.worlds, kinds, args.dry_run, getattr(args, "prune", False))
    for kind, entries in by_kind.items():
        print(f"    {kind}: {len(entries)} entr{'y' if len(entries) == 1 else 'ies'}")
    for p in problems:
        print(f"    !! {p}")
    if problems:
        return False
    if not args.dry_run:
        # Rebuilt from disk, so a harvest of one kind does not drop the weapons a
        # `catalog` run put there.
        path = write_index(args.worlds, scan_entries(args.worlds))
        print(f"    index -> {os.path.relpath(path, args.worlds)}")
    return True


# --- Props --------------------------------------------------------------------

PROPS_DIR = "props"
PROPS_KIND = "props"
# What `props.py` writes, and what this rewrites. One line per asset: every one of
# the 12,785 declarations on disk is in this form, and the multi-level `lod` form
# `props.py` can emit has never appeared in a world.
PROPS_ASSET_LINE = re.compile(
    # `rest` is everything after `source` — `until:`, `hull:`. Its `[^,}]+` takes the
    # space before the closing brace with it, so a caller rebuilding the line must
    # rstrip it or write two.
    r'^asset (?P<name>\S+) \{ source: "(?P<src>assets/props/[^"]+)"(?P<rest>(?:, [a-z-]+: [^,}]+)*)\s*\}$',
    re.M,
)


def prop_id(rel):
    """A prop's catalogue id: its path under `assets/props/`, without `.glb`.

    `/` becomes `.` because a catalogue id is one path segment (the route's own
    allowlist, `protocol/routes/catalog.ts`) and Ghosts ships five props under an
    `mv/` subdirectory whose basenames collide with top-level ones. Measured: all
    7,227 ids come out inside the allowlist and under its 64-character cap, and
    the substitution collides with nothing.
    """
    return rel.removesuffix(".glb").replace("/", ".")


def _prop_files(world_dir):
    """Every prop file in a world, as (path under assets/props, full path)."""
    root = os.path.join(world_dir, "assets", PROPS_DIR)
    out = []
    for dirpath, _, names in os.walk(root) if os.path.isdir(root) else []:
        for name in names:
            full = os.path.join(dirpath, name)
            out.append((os.path.relpath(full, root).replace(os.sep, "/"), full))
    return sorted(out)


def harvest_props(worlds_root, dry_run=False):
    """Every prop into `catalog/props/<game>/<id>/`, and each world rewritten to name it.

    Two passes, because a world may only point at the shared copy if its own bytes
    are the shared bytes. The first world by name wins a key; any other world whose
    copy is byte-identical points at it, and one whose copy differs **keeps its own
    local `source:`** — so a disagreement is handled by leaving that world alone
    rather than by choosing for it. Measured: 7 of 2,261 shared keys differ, all
    iw5, and all because one export carried an animation clip the other did not.

    `until:` and `hull:` stay in the world file. They are per-asset facts and every
    world agrees on them (verified: 0 of 7,227 keys disagree), but the resolver is
    synchronous and has never seen a catalogue, so it could not read them from an
    entry even though they belong to one.
    """
    winners = {}  # (game, rel) -> (md5, world)
    for world_dir, world, game in imported_worlds(worlds_root):
        for rel, full in _prop_files(world_dir):
            key = (game, rel)
            if key in winners:
                continue
            winners[key] = (digest(full), world)
            if not dry_run:
                _copy(full, PROPS_KIND, game, prop_id(rel), worlds_root, name=os.path.basename(rel), dry_run=dry_run)

    rewritten, kept = 0, []
    for world_dir, world, game in imported_worlds(worlds_root):
        path = os.path.join(world_dir, "props.world")
        if not os.path.isfile(path):
            continue
        local = {rel: full for rel, full in _prop_files(world_dir)}
        changed = [0]

        def replace(match, game=game, local=local, world=world, changed=changed):
            rel = match.group("src").removeprefix("assets/props/")
            full = local.get(rel)
            winner = winners.get((game, rel))
            # No file, or bytes the shared copy does not have: leave the line
            # exactly as it is. It still validates as a world-local asset.
            if full is None or winner is None or digest(full) != winner[0]:
                if full is not None and winner is not None:
                    kept.append(f"{world}/{rel} differs from {winner[1]}'s; left pointing at its own copy")
                return match.group(0)
            changed[0] += 1
            ident = prop_id(rel)
            return (
                f'asset {match.group("name")} {{ catalog: "{PROPS_KIND}/{game}/{ident}", '
                f'source: "{os.path.basename(rel)}"{match.group("rest").rstrip()} }}'
            )

        text = read_text(path, "utf-8")
        rewrote = PROPS_ASSET_LINE.sub(replace, text)
        rewritten += changed[0]
        if not dry_run and rewrote != text:
            write_text(path, rewrote)
    return {"entries": len(winners), "rewritten": rewritten}, kept


def prune_props(worlds_root, dry_run=False):
    """Delete the per-world prop files no world names any more.

    The harvest copies rather than moves, so that a rewritten world and its old
    files sit side by side while the change is checked. This is the other half:
    once every declaration points at the catalogue, 1.7 GB of per-world copies is
    read by nothing.

    Driven by what each world's `props.world` actually says, not by what the
    catalogue holds — so the eight declarations left pointing at their own copy keep
    their files, and a file is only ever deleted because nothing references it.

    `worlds/*/assets/` is gitignored and rebuilding it needs the game files, so this
    checks that the catalogue really holds each file's bytes before removing it.
    """
    freed, kept, missing = 0, 0, []
    for world_dir, world, game in imported_worlds(worlds_root):
        path = os.path.join(world_dir, "props.world")
        if not os.path.isfile(path):
            continue
        text = read_text(path, "utf-8")
        named = {m.removeprefix("assets/props/") for m in re.findall(r'source: "(assets/props/[^"]+)"', text)}
        for rel, full in _prop_files(world_dir):
            if rel in named:
                kept += 1
                continue
            shared = os.path.join(entry_dir(worlds_root, PROPS_KIND, game, prop_id(rel)), os.path.basename(rel))
            # Never delete something the catalogue cannot give back.
            if not os.path.isfile(shared) or digest(shared) != digest(full):
                missing.append(f"{world}/{rel} is not in the catalogue byte-for-byte; left alone")
                continue
            freed += os.path.getsize(full)
            if not dry_run:
                os.remove(full)
        if not dry_run:
            root = os.path.join(world_dir, "assets", PROPS_DIR)
            # Empty directories left behind, deepest first.
            for dirpath, _, _ in sorted(os.walk(root), reverse=True) if os.path.isdir(root) else []:
                if not os.listdir(dirpath):
                    os.rmdir(dirpath)
    return freed, kept, missing
