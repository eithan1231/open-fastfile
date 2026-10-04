"""The Advanced Warfare companion zone's walkers, and the alias checks that proved them.

No game files: each zone is a few bytes laid out for the test. What they pin is
what common_mp.ff established (reverse/s1-zone/README.md, "The companion zone"):
how many handles each table holds, which WAField types carry a string, and that
a walk whose cursor slips is named at the asset where it slipped.
"""

import json
import os
import struct

import pytest

from scripts.cod.iw6.zone import KIND_FLOAT, KIND_POINTER, KIND_UNSIGNED, POINTER_TAG, RUNTIME, TEMP, VIRTUAL
from scripts.cod.maps import load_maps
from scripts.cod.s1 import walkers
from scripts.cod.s1.aliases import CheckedZone

FOLLOWS = POINTER_TAG | 0xFFFFFFFF
U1 = (1, KIND_UNSIGNED, "")
U4 = (4, KIND_UNSIGNED, "")
F4 = (4, KIND_FLOAT, "")
PTR = (8, KIND_POINTER, "")


def ref(block, offset):
    """A pointer that does not follow: DB_GetPackedOffsetStreamPos's encoding."""
    return POINTER_TAG | block << 32 | offset + 1


def s1_layout(tmp_path, monkeypatch, types=None):
    """walkers.Layout over rows written for the test, with DECLARED merged in as it is for a zone."""
    monkeypatch.setattr(walkers, "fallback", lambda: str(tmp_path / "no-x360.json"))
    rows = []
    for typename, members in (types or {}).items():
        offset = 0
        for name, size, kind, base, *extra in members:
            n, pointee = (*extra, 0, 0)[:2]  # an array's count, a pointer's element size
            rows.append([typename, name, offset, size * max(n, 1), size, pointee, kind, n, 0, base])
            offset += size * max(n, 1)
        rows.append([typename, "", 0, offset, 0, 0, 0, 0, 0, ""])
    path = tmp_path / "s1.json"
    path.write_text(json.dumps(rows))
    return walkers.Layout(str(path))


def walk_one(layout, walker, blob, zone=CheckedZone):
    """Run `walker` over `blob` laid after a 72-byte XFile header, as an asset is entered."""
    data = bytes(72) + blob
    z = zone(data, layout)
    z.pos = 72
    z.push(TEMP)
    name = walker(z)
    z.check()
    return z, name


# --- the two tables ---------------------------------------------------------


def test_the_impact_table_is_nineteen_weapon_classes_across_every_surface(tmp_path, monkeypatch):
    """19 x (53 + 7), H1's shape. 30 x (31 + 7) walks the same 1,140 handles, which
    is why the walk alone could not tell them apart and the names had to."""
    layout = s1_layout(tmp_path, monkeypatch)
    assert (walkers.FX_IMPACT_ENTRIES, walkers.FX_NONFLESH, walkers.FX_FLESH) == (19, 53, 7)
    assert layout.size("FxImpactEntry") == 8 * 60
    assert walkers.FX_NONFLESH == walkers.SURFACE_FX_SURFACES == walkers.VEHICLE_SURFACE_SOUNDS


def test_a_surface_fx_table_is_six_rows_of_one_handle_per_surface(tmp_path, monkeypatch):
    layout = s1_layout(tmp_path, monkeypatch, {"SurfaceFxTable": [("name", *PTR), ("table", *PTR)]})
    blob = struct.pack("<QQ", FOLLOWS, FOLLOWS) + b"\0" + bytes(8 * 6 * 53) + b"next"
    z, name = walk_one(layout, walkers.surface_fx, blob)
    assert name == ""
    assert z.data[z.pos :] == b"next"
    assert z.blocks[VIRTUAL] == 1 + 3 + 8 * 318  # the name, the 4-byte alignment, the table


# --- attachments ------------------------------------------------------------

ATTACHMENT = [
    ("szInternalName", *PTR),
    ("szDisplayName", *PTR),
    ("type", *U4),
    ("weaponType", *U4),
    ("weapClass", *U4),
    ("greebleType", *U4),
    ("worldModels", *PTR),
    ("viewModels", *PTR),
    ("reticleViewModels", *PTR),
    ("chargeInfo", *PTR),
    ("hybridSettings", *PTR),
    ("fieldOffsets", *PTR, 0, 2),
    ("fields", *PTR),
    ("numFields", *U4),
]


def attachment_layout(tmp_path, monkeypatch):
    return s1_layout(
        tmp_path,
        monkeypatch,
        {
            "WeaponAttachment": ATTACHMENT,
            "AttChargeInfo": [("minChargeTime", *F4, 7)],
            "WAFieldParm": [("string", *PTR)],
            "WAField": [("index", *U1), ("type", *U1), ("code", *U1), ("pad", *U1, 5), ("parm", 8, 0, "WAFieldParm")],
        },
    )


def an_attachment(layout, fields):
    """A WeaponAttachment whose reticle list follows, then its WAFields as given."""
    head = bytearray(layout.size("WeaponAttachment"))
    for path in ("szInternalName", "reticleViewModels", "fieldOffsets", "fields"):
        struct.pack_into("<Q", head, layout.resolve("WeaponAttachment", path)[0], FOLLOWS)
    struct.pack_into("<I", head, layout.resolve("WeaponAttachment", "numFields")[0], len(fields))
    blob = head + b"acog\0" + bytes(8 * 32) + bytes(2 * len(fields))
    strings = b""
    for kind, parm, text in fields:
        blob += struct.pack("<BBB5xQ", 0, kind, 0, parm)
        strings += text
    return bytes(blob + strings)


def test_an_attachment_reads_a_string_only_for_the_types_that_carry_one(tmp_path, monkeypatch):
    """Type 7 is a float: a parm whose bits happen to look like a pointer is still a number."""
    layout = attachment_layout(tmp_path, monkeypatch)
    blob = an_attachment(layout, [(0, FOLLOWS, b"hide\0"), (7, FOLLOWS, b""), (11, FOLLOWS, b"npc_optic\0")])
    z, name = walk_one(layout, walkers.attachment, blob + b"next")
    assert name == "acog"
    assert z.data[z.pos :] == b"next"
    assert z.unhandled == []
    assert set(walkers.WAFIELD_STRINGS) == {0, 10, 11, 12, 13, 15, 16}


def test_a_reticle_list_is_thirty_two_models_not_h1s_sixty_four(tmp_path, monkeypatch):
    layout = attachment_layout(tmp_path, monkeypatch)
    blob = an_attachment(layout, [])
    z, _ = walk_one(layout, walkers.attachment, blob + b"next")
    assert z.data[z.pos :] == b"next"


# --- the H1-shaped structs ----------------------------------------------------


def test_the_declared_structs_are_h1s_sizes_with_four_byte_script_strings(tmp_path, monkeypatch):
    layout = s1_layout(tmp_path, monkeypatch)
    sizes = {name: layout.size(name) for name in walkers.DECLARED}
    assert sizes["AnimationClass"] == 88  # the X360 PDB's, re-derived for the PC, is 80
    assert sizes["EquipmentSoundTable"] == 88
    assert sizes["VectorField"] == 48 and sizes["VectorFieldSubField"] == 80
    assert layout.resolve("AnimationState", "animIndices")[0] == 32


def test_a_vector_field_is_its_sub_fields_then_each_ones_grid(tmp_path, monkeypatch):
    layout = s1_layout(tmp_path, monkeypatch)
    head = struct.pack("<QQ6fI4x", FOLLOWS, FOLLOWS, *([0.0] * 6), 1)
    sub = bytearray(80)
    struct.pack_into("<Q", sub, 0, FOLLOWS)
    struct.pack_into("<3I", sub, 44, 2, 3, 2)
    blob = head + b"vf\0" + bytes(sub) + bytes(16 * 12) + b"next"
    z, name = walk_one(layout, walkers.vector_field, blob)
    assert name == "vf"
    assert z.data[z.pos :] == b"next"


def test_an_anim_class_puts_its_anim_indices_in_the_runtime_block(tmp_path, monkeypatch):
    layout = s1_layout(tmp_path, monkeypatch)
    head = bytearray(88)
    struct.pack_into("<QQ", head, 0, FOLLOWS, FOLLOWS)
    machine = bytearray(24)
    struct.pack_into("<IHH", machine, 0, 5, 1, 0)
    struct.pack_into("<Q", machine, 8, FOLLOWS)
    state = bytearray(40)
    state[13] = 2  # entryCount
    struct.pack_into("<QQ", state, 24, FOLLOWS, FOLLOWS)
    blob = bytes(head) + b"dog\0" + bytes(machine) + bytes(state) + bytes(8 * 2) + b"next"
    z, name = walk_one(layout, walkers.anim_class, blob)
    assert name == "dog"
    assert z.data[z.pos :] == b"next"
    assert z.blocks[RUNTIME] == 8 * 2


def test_an_equipment_table_that_carries_a_table_is_refused(tmp_path, monkeypatch):
    layout = s1_layout(tmp_path, monkeypatch)
    empty = struct.pack("<Q", FOLLOWS) + bytes(80) + b"equipment_snd.def\0"
    z, name = walk_one(layout, walkers.equipment_sound_table, empty)
    assert (name, z.pos) == ("equipment_snd.def", len(z.data))
    filled = bytearray(empty)
    struct.pack_into("<Q", filled, 24, FOLLOWS)  # clothTypes
    with pytest.raises(NotImplementedError, match="clothTypes"):
        walk_one(layout, walkers.equipment_sound_table, bytes(filled))


# --- the alias checks -------------------------------------------------------


def strings_zone(tmp_path, monkeypatch):
    """A zone holding one string in VIRTUAL at offset 0, and a cursor to read references from."""
    layout = s1_layout(tmp_path, monkeypatch)
    z = CheckedZone(bytes(72) + b"name\0", layout)
    z.pos = 72
    z.push(VIRTUAL)
    z.string(FOLLOWS)
    return z


def test_a_string_reference_must_name_where_a_string_was_written(tmp_path, monkeypatch):
    z = strings_zone(tmp_path, monkeypatch)
    assert z.string(ref(VIRTUAL, 0)) == "name"
    z.string(ref(VIRTUAL, 1))
    assert z.alias_hits["string"] == 1
    assert [(kind, detail) for kind, _, detail in z.alias_misses] == [("string", (VIRTUAL, 1))]


def test_a_handle_reference_must_name_where_a_handle_was_stored(tmp_path, monkeypatch):
    z = strings_zone(tmp_path, monkeypatch)
    z.slots[8] = ("MATERIAL", "m")
    assert z.handle(ref(VIRTUAL, 8), None, "MATERIAL") == ("MATERIAL", "m")
    z.handle(ref(VIRTUAL, 12), None, "MATERIAL")
    assert [detail for _, _, detail in z.alias_misses] == [("MATERIAL", VIRTUAL, 12)]


def test_an_array_reference_must_land_on_an_element(tmp_path, monkeypatch):
    """The wider the stride the sharper the check: 12 bytes sees a 4-byte slip."""
    layout = s1_layout(tmp_path, monkeypatch, {"Owner": [("points", *PTR), ("other", *PTR)]})
    # The array lands at VIRTUAL 16, so its elements start at 16, 28, 40 and 52.
    owner = struct.pack("<QQ", FOLLOWS, 0)
    data = bytes(72) + owner + bytes(12 * 4) + struct.pack("<QQ", ref(VIRTUAL, 28), ref(VIRTUAL, 44))
    z = CheckedZone(data, layout)
    z.pos = 72
    z.push(VIRTUAL)
    z.elements(z.struct("Owner"), "points", 4, size=12)
    second = z.struct("Owner")
    z.elements(second, "points", 4, size=12)  # the same field: an element
    z.elements(second, "other", 4, size=12)  # another field into the same array: 4 bytes past one
    assert z.alias_hits["element"] == 1
    assert [detail for _, _, detail in z.alias_misses] == [(("Owner", "other"), VIRTUAL, 44, 4)]


def test_a_miss_is_reported_against_the_asset_it_was_read_in(tmp_path, monkeypatch):
    z = strings_zone(tmp_path, monkeypatch)
    z.pos = 76
    z.string(ref(VIRTUAL, 3))
    lines = z.alias_report([("RAWFILE", "a", 72), ("MATERIAL", "b", 75), ("FX", "c", 90)])
    assert lines[-1].startswith("      ALIAS MISS string x1: first in asset 1 (MATERIAL b)")


def test_an_aw_export_names_both_companion_zones_and_not_common_ff():
    # The default would add common.ff, which ff.py refuses; and the props are split
    # across the two (PLAN.md phase 7), so dropping either loses some.
    games, _ = load_maps()
    assert [os.path.basename(p) for p in games["aw"]["common"]] == ["common_core_mp.ff", "common_mp.ff"]
