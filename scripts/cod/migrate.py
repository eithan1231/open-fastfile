"""Bring the worlds already on disk up to date with a DSL change.

Every world here was written by `export`, so a change to what `export` emits
leaves the 44 committed worlds a version behind. Re-running a full export would
cost the game files and minutes a map; this reads the world's own
committed `export_metadata.json` instead and rewrites only the line that moved.

So: no fastfiles, no dumps, no `.cache/`. The metadata is reference data the engine
may never read (docs/cod/pipeline.md) — a migration is a build step, not the
engine, which is why it is the one caller allowed to.
"""

import json
import os
import re

from . import gameobjects
from .entities import triple
from .files import read_json, write_text
from .props import ENTITY_CLASSES, rotate_clause
from .worldfile import drop_include, ensure_world_game
from .worlds import ENTRY_FILE, METADATA_FILE, game_of, world_dirs


def migrate_world_game(worlds_root, dry_run=False):
    """Ensure every imported world declares `game:`. Returns (changed, already, skipped)."""
    changed, already, skipped = [], [], []
    for world_dir in world_dirs(worlds_root):
        slug = os.path.basename(world_dir)
        game_key = game_of(world_dir)
        if not game_key:
            # A hand-written world: it has no game, and `game:` is optional for
            # exactly that reason.
            skipped.append(slug)
            continue
        if dry_run:
            text = open(os.path.join(world_dir, ENTRY_FILE), encoding="utf-8").read()
            (already if "\n  game:" in text else changed).append(slug)
            continue
        (changed if ensure_world_game(world_dir, game_key) else already).append(slug)
    return changed, already, skipped


# What a world no longer declares, and the file each was included from.
RETIRED_CAST = ("viewmodel", "characters")

# The `_overrides.json` keys that chose them. The file is an author's, so only the
# retired keys go — everything else in it is still theirs.
OVERRIDES_FILE = "_overrides.json"


def retire_cast(worlds_root, dry_run=False):
    """Delete `viewmodel.world` and `characters.world`, their includes, and their overrides.

    Who a player is comes out of the catalogue now (docs/engine/scripting.md), so a
    world declaring either gets a `node-retired` error from `pnpm check` until the
    file is gone. This is what makes the 42 worlds on disk agree with that.
    """
    touched = []
    for world_dir in world_dirs(worlds_root):
        slug = os.path.basename(world_dir)
        gone = []
        for node in RETIRED_CAST:
            path = os.path.join(world_dir, f"{node}.world")
            if not os.path.isfile(path):
                continue
            gone.append(f"{node}.world")
            if not dry_run:
                drop_include(world_dir, f"{node}.world")
                os.remove(path)

        overrides = os.path.join(world_dir, OVERRIDES_FILE)
        if os.path.isfile(overrides):
            data = json.loads(open(overrides, encoding="utf-8").read())
            stale = [key for key in RETIRED_CAST if key in data]
            if stale:
                gone.append(f"{OVERRIDES_FILE} ({', '.join(stale)})")
                if not dry_run:
                    for key in stale:
                        del data[key]
                    write_text(overrides, json.dumps(data, indent=1) + "\n")

        if gone:
            touched.append((slug, gone))
    return touched


# -- --object-modes ----------------------------------------------------------------

PROPS_FILE = "props.world"
# How near a props.world placement must be to its entity's `at`: both are the same
# origin printed to the millimetre.
AT_TOLERANCE = 1e-3 + 1e-6
_ASSET = re.compile(r"^asset (\S+) \{")
_ASSET_FILE = re.compile(r'(?:catalog|source): "([^"]+)"')
_MODEL = re.compile(r"^(\s*model \{ asset: (\S+), at: (\S+) (\S+) (\S+),.*?)(, mode:(?: \"[^\"]*\")+)? \}$")
_MODE_HEADER = "exist only in the game modes their `mode:` names."


def _model_key(name):
    """A model's name as both an entity and a packed asset file spell it: basename, no LOD suffix."""
    # A catalogue id spells a folder `.` (`props/iw6/mv.foo_lod0`), a file path `/`.
    return re.sub(r"_lod\d+$", "", re.split(r"[/.\\]", name.removesuffix(".glb"))[-1])


def _asset_models(lines):
    """{asset name: model key}, from each asset's first `catalog:` or `source:`."""
    out, current = {}, None
    for line in lines:
        m = _ASSET.match(line)
        if m:
            current = m.group(1)
        if current and current not in out:
            f = _ASSET_FILE.search(line)
            if f:
                out[current] = _model_key(f.group(1))
        if line.startswith("}") or (m and line.rstrip().endswith("}")):
            current = None
    return out


def _rotate_of(entity):
    """The `rotate:` clause props.world writes for an entity's angles."""
    pitch, yaw, roll = (round(a, 4) for a in (triple(entity.get("angles", "")) or [0.0, 0.0, 0.0]))
    return rotate_clause({"pitch": pitch, "yaw": yaw, "roll": roll})


def _restricted_props(data):
    """[(model key, at, rotate clause, modes)] for every script-placed model entity, `modes` None where every mode has it."""
    game, entities = data.get("game"), data.get("entities", [])
    if game not in gameobjects.ALLOWED_BY_GAME:
        return []
    facts = gameobjects.MapFacts.from_entities(data.get("map", ""), entities)
    out = []
    for e in entities:
        model = e.get("model", "").removeprefix(",")
        if e.get("classname") in ENTITY_CLASSES and model and not model.startswith("*") and "at" in e:
            out.append((_model_key(model), e["at"], _rotate_of(e), gameobjects.modes_of(game, e, facts)))
    return out


def _with_mode_header(lines, count):
    """props.world's header, with its count of mode-only placements where a fresh export puts it."""
    lines = [line for line in lines if not (line.startswith("// ") and line.endswith(_MODE_HEADER))]
    if not count:
        return lines
    end = lines.index("") if "" in lines else 0
    at = next((i for i in range(end) if lines[i] == "//" and lines[i + 1].startswith("// SKIPPED")), end)
    return lines[:at] + [f"// {count} {_MODE_HEADER}"] + lines[at:]


def object_modes_world(world_dir, dry_run=False):
    """Give `mode:` to one world's props.world placements of models only some game modes have.

    Returns (tagged, changed, unmatched) or None for a world with nothing to read:
    placements now carrying a mode, lines rewritten (the header's count among
    them), and restricted entities with no placement (their asset did not export).
    """
    meta, props_path = os.path.join(world_dir, METADATA_FILE), os.path.join(world_dir, PROPS_FILE)
    if not (os.path.isfile(meta) and os.path.isfile(props_path)):
        return None
    wanted = _restricted_props(read_json(meta))
    text = open(props_path, encoding="utf-8").read()
    lines = text.split("\n")
    assets = _asset_models(lines)
    by_key = {}
    for key, at, rotate, modes in wanted:
        by_key.setdefault(key, []).append((at, rotate, modes))

    tagged = changed = 0
    taken = set()  # (model key, index into by_key[key])
    for i, line in enumerate(lines):
        m = _MODEL.match(line)
        if not m or m.group(2) not in assets:
            continue
        key, at = assets[m.group(2)], [float(v) for v in m.group(3, 4, 5)]
        # Two entities can share a spot (MW3's bomb in both `bombzone` and `dd_bombzone`
        # copies, or one crate turned two ways): a line takes the first not yet taken
        # that is turned as it is, which is the export's own order, since props.world
        # sorts a model's placements stably by position.
        near = [
            (k, rotate, modes)
            for k, (where, rotate, modes) in enumerate(by_key.get(key, ()))
            if (key, k) not in taken and max(abs(a - b) for a, b in zip(at, where, strict=True)) <= AT_TOLERANCE
        ]
        k, _, modes = next((n for n in near if f", {n[1]}," in line), (None, None, None))
        if k is None:
            continue
        taken.add((key, k))
        new = m.group(1) + (f", {gameobjects.mode_clause(modes)}" if modes else "") + " }"
        tagged += bool(modes)
        if new != line:
            lines[i] = new
            changed += 1
    unmatched = sum(1 for key, v in by_key.items() for k, (_, _, modes) in enumerate(v) if modes and (key, k) not in taken)
    header = _with_mode_header(lines, tagged)
    changed += header != lines
    out = "\n".join(header)
    if out != text and not dry_run:
        write_text(props_path, out)
    return tagged, changed, unmatched


def object_modes(worlds_root, dry_run=False):
    """`--object-modes` over every world: [(slug, tagged, changed, unmatched)]."""
    out = []
    for world_dir in world_dirs(worlds_root):
        result = object_modes_world(world_dir, dry_run)
        if result:
            out.append((os.path.basename(world_dir), *result))
    return out


def main(args):
    if args.object_modes:
        rows = object_modes(args.worlds, args.dry_run)
        verb = "would rewrite" if args.dry_run else "rewrote"
        print(f"  {verb} {sum(1 for r in rows if r[2])} props.world file(s) of {len(rows)}")
        for slug, tagged, changed, unmatched in rows:
            if tagged or changed or unmatched:
                missing = f", {unmatched} restricted entit(ies) with no placement" if unmatched else ""
                print(f"    {slug}: {tagged} placement(s) with a mode, {changed} line(s) changed{missing}")
        print("  gameplay.world's trigger modes and `solid` lines come from `export --gameplay-only`.")
        return True
    if args.retire_cast:
        touched = retire_cast(args.worlds, args.dry_run)
        verb = "would remove" if args.dry_run else "removed"
        print(f"  {verb} the retired cast from {len(touched)} world(s)")
        for slug, gone in touched:
            print(f"    {slug}: {', '.join(gone)}")
        return True

    changed, already, skipped = migrate_world_game(args.worlds, args.dry_run)
    verb = "would add" if args.dry_run else "added"
    print(f"  {verb} `game:` to {len(changed)} world(s); {len(already)} already had one; {len(skipped)} not imported")
    for slug in changed:
        print(f"    {verb} {slug}")
    if skipped:
        print(f"    no export_metadata.json (left alone): {', '.join(skipped)}")
    return True
