"""Black Ops II's weapons in the catalogue: the zones beyond `common_mp.ff`, the hands, the attachments.

Every multiplayer gun is in `common_mp.ff`, as on Black Ops, but three more zones
carry what a catalogue needs of them (docs/cod/games.md#black-ops-ii-t6):

- `common_patch_mp.ff` is the game's own rebalance: 81 of the weapon files again,
  with the same names and new numbers, their attachments and uniques again, and
  one gun the base zone lacks (the Peacekeeper). Dumped after `common_mp.ff`, so its
  copy of a file wins, as a map's does over its companions.
- `faction_<faction>_mp.ff` holds a faction's bodies and view hands. No map zone
  and no companion ships a pair of hands (every weapon file's `handModel` is
  empty), so the catalogue's hands come from these seven, all of them.
- Each gun's attachments are two assets rather than one: a `WeaponAttachment`
  (what fitting it does to any gun: mostly scales) and a `WeaponAttachmentUnique`
  (`au_<gun>_<attachment>`: what it does to this one: a model, clips, sounds).
  `attachments.t6_entry` reads the pair.
- `patch_mp.ff`'s `mp/statstable.csv` is the Create-a-Class menu: each gun's group,
  its slot, the attachments the menu offers and the default classes that carry it.
  It is a second source for what the weapon files say, and `check_menu` holds the
  build to it.
"""

import csv
import glob
import json
import os

from . import attachments, catalog
from .files import write_text
from .pack import pack_one
from .viewmodel import VIEW_TEXTURE_SIZE, _model_glb, view_hands

GAME = "t6"
PATCH_ZONE = "common_patch_mp.ff"
FACTION_ZONES = "faction_*_mp.ff"
# The dump kinds a patch zone replaces, in the order a companion's are dumped.
PATCH_KINDS = ("xmodel", "image", "material", "weapon", "xanim")
HANDS_KINDS = ("xmodel", "image", "material")
TABLE_ZONE = "patch_mp.ff"
TABLE_DIR = "tables"
STATS_TABLE = os.path.join("mp", "statstable.csv")
# statstable.csv's columns: the reference name (the weapon less `_mp`), the menu's
# group, the attachments it offers, the default classes that carry the gun, its slot.
STATS_NAME, STATS_GROUP, STATS_ATTACHMENTS, STATS_CLASSES, STATS_SLOT = 4, 2, 8, 11, 13
# The first default class (`mp/reset_classes.cfg`: `equipdefaultclass 0 class_custom_assault`),
# whose primary statstable names: the MTAR, `tar21_mp`.
DEFAULT_CLASS = "class_custom_assault"
# The hands the catalogue's guns are rigged on, and a world's default: TEAM_ALLIES is the
# SEALs (`mp/factiontable.csv`), and the long sleeve is the pair `faction_multiteam_mp.ff`
# keeps for them. Seven of the 18 pairs share its 72 joints; the Cordis and ISA pairs carry 60.
DEFAULT_HANDS = "c_usa_mp_seal6_longsleeve_viewhands"

# Weapons no field separates from a gun a player picks: the Wager Match copy of the
# KAP-40, which is the KAP-40 by every number. A list for the reason NOT_SELECTABLE is.
NOT_SELECTABLE = ("kard_wager_mp",)


def dump(backend, zone_dirs, work):
    """Dump the patch zone over the companion's dump, the attachments of both, and the factions' hands."""
    zone_dir = next((z for z in zone_dirs if os.path.exists(os.path.join(z, PATCH_ZONE))), None)
    if zone_dir is None:
        print(f"  ! no {PATCH_ZONE} beside any of {', '.join(zone_dirs)}; the weapons are the unpatched ones")
        return
    common = os.path.join(zone_dir, "common_mp.ff")
    patch = os.path.join(zone_dir, PATCH_ZONE)
    for ff in (common, patch):
        for kind in ("attachment", "attachmentunique"):
            backend.dump(ff, os.path.join(work, attachments.ATTACH_DIR), kind)
    print(f"  dumping {PATCH_ZONE} ({backend.name}) over it")
    for kind in PATCH_KINDS:
        backend.dump(patch, os.path.join(work, _folder(kind)), kind)
    tables = os.path.join(zone_dir, TABLE_ZONE)
    if os.path.exists(tables):
        backend.dump(tables, os.path.join(work, TABLE_DIR), "stringtable")
    for ff in sorted(glob.glob(os.path.join(zone_dir, FACTION_ZONES))):
        print(f"  dumping {os.path.basename(ff)} for its view hands")
        for kind in HANDS_KINDS:
            backend.dump(ff, os.path.join(work, _folder(kind)), kind)


def _folder(kind):
    """Where `catalog.dump_common` puts each kind, so the patch lands on top of the companion."""
    return {"xmodel": "models", "image": "img", "material": "mat", "weapon": "weapons", "xanim": "view_anim"}[kind]


def build_hands(work, worlds_root, iwi, states):
    """Pack every pair of view hands into `catalog/viewhands/t6/`; return their ids.

    A catalogue weapon carries the hands' skeleton and no hand meshes, and a world
    picks a pair to rebind onto it by joint name (viewmodel.py), so each pair is
    its own entry, as a harvested map's are."""
    models = os.path.join(work, "models")
    built = []
    for name in view_hands(os.path.join(models, "xmodel")):
        raw = _model_glb(models, name)
        if raw is None:
            print(f"  !! {name} is listed but has no model in the dump")
            continue
        out = catalog.entry_dir(worlds_root, "viewhands", GAME, name)
        os.makedirs(out, exist_ok=True)
        _, missing, _ = pack_one(raw, os.path.join(out, f"{name}.glb"), iwi, VIEW_TEXTURE_SIZE, states, False)
        write_text(
            os.path.join(out, f"{name}.json"), json.dumps({"id": name, "game": GAME, "hands": f"{name}.glb"}, indent=1) + "\n"
        )
        built.append(name)
        if missing:
            print(f"  !! {name}: {missing} texture(s) not in the dump, drawn white")
    print(f"  {len(built)} pair(s) of view hands")
    return built


def normalize(info):
    """A T6 weapon file with the keys the engine reads under the names every other game uses.

    `adsZoomFov` is `adsZoomFov1`: T6 keeps three, one per zoom level of a variable
    scope, and the first is the one a gun aims at unless an attachment adds levels."""
    out = dict(info)
    if "adsZoomFov" not in out and "adsZoomFov1" in out:
        out["adsZoomFov"] = out["adsZoomFov1"]
    return out


def read_menu(work):
    """{reference name: statstable row} out of the dumped `mp/statstable.csv`, or {} without one."""
    path = os.path.join(work, TABLE_DIR, STATS_TABLE)
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as fh:
        return {row[STATS_NAME]: row for row in csv.reader(fh) if len(row) > STATS_SLOT and row[STATS_NAME]}


def default_weapon(menu):
    """The weapon of the first default class: the primary whose row names `DEFAULT_CLASS`."""
    for name, row in menu.items():
        if DEFAULT_CLASS in row[STATS_CLASSES].split() and row[STATS_SLOT] == "primary":
            return f"{name}_mp"
    return None


def check_menu(menu, entries, worlds_root):
    """Hold the built weapons to the Create-a-Class menu; return what disagrees.

    Every built gun has to be a row, and its attachments the ones the menu offers
    (bar dual wield, which the engine cannot draw). The slot is the menu's: the
    crossbow is a `rifle` by `weaponClass` and a secondary by the menu, and the entry
    is rewritten where the two differ."""
    problems = []
    for entry in entries:
        row = menu.get(entry["id"].removesuffix("_mp"))
        if row is None:
            problems.append(f"{entry['id']} is not in {STATS_TABLE}")
            continue
        offered = set(row[STATS_ATTACHMENTS].split()) - set(attachments.T6_NOT_OFFERED)
        ours = {a["id"] for a in entry["attachments"]}
        if offered != ours:
            problems.append(f"{entry['id']}: the menu offers {sorted(offered - ours)} and not {sorted(ours - offered)}")
        if row[STATS_SLOT] in ("primary", "secondary") and row[STATS_SLOT] != entry["slot"]:
            print(f"  {entry['id']}: slot {entry['slot']} -> {row[STATS_SLOT]}, as the menu carries it")
            entry["slot"] = row[STATS_SLOT]
            path = os.path.join(catalog.entry_dir(worlds_root, "weapons", GAME, entry["id"]), f"{entry['id']}.json")
            write_text(path, json.dumps(entry, indent=1) + "\n")
    return problems
