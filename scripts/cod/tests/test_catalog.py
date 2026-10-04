"""The shared asset catalogue: which weapon files describe a gun a player carries.

The filters matter more than they look. A zone holds 164 weapon files and only a
third are guns; the rest are grenades, killstreaks, turrets and debug cameras
that answer most of the same fields the same way. Getting one wrong puts a UAV
marker in a loadout's launcher slot, which nothing downstream would question.
"""

import json
import os
import re

from scripts.cod.catalog import (
    CATALOG_VERSION,
    INDEXED_KINDS,
    entry_dir,
    is_player_weapon,
    scan_entries,
    weapon_slot,
    write_index,
)

REGISTRY = os.path.join(os.path.dirname(__file__), "..", "..", "..", "packages", "shared", "src", "sim", "weaponRegistry.ts")


def test_the_catalog_version_matches_the_one_both_readers_check():
    """The number `index.json` carries, and the number a client and a game server refuse it over.

    It is also the only thing that catches a stale damage table: `catalogHash`
    digests the weapon and attachment order and nothing else, so two ends holding
    the same guns with different numbers agree on it. Written down twice because
    neither language can read the other's constant.
    """
    text = open(os.path.abspath(REGISTRY), encoding="utf-8").read()
    found = re.search(r"^export const CATALOG_VERSION = (\d+);$", text, re.MULTILINE)
    assert found, "could not read CATALOG_VERSION out of weaponRegistry.ts"
    assert int(found[1]) == CATALOG_VERSION


def info(**kw):
    base = {
        "inventoryType": "primary",
        "weaponClass": "rifle",
        "gunModel": "viewmodel_m4_iw5",
        "displayName": "WEAPON_M4_CARBINE",
    }
    return {**base, **kw}


def test_a_rifle_is_a_primary_and_a_pistol_a_secondary():
    assert weapon_slot(info()) == "primary"
    assert weapon_slot(info(weaponClass="pistol")) == "secondary"
    assert weapon_slot(info(weaponClass="rocketlauncher")) == "secondary"


def test_equipment_is_not_carried_at_all():
    """`inventoryType` is what separates a weapon from a grenade or a killstreak."""
    for kind in ("offhand", "item", "exclusive", "altmode", "scavenger"):
        assert weapon_slot(info(inventoryType=kind)) is None


def test_a_turret_is_not_a_loadout_weapon_though_it_is_carried():
    assert weapon_slot(info(weaponClass="turret")) is None
    assert weapon_slot(info(weaponClass="non-player")) is None


def test_a_debug_camera_is_rejected_by_its_model():
    """MW3's five `camera_*fov` files answer every other test and point at `weapon_ac130`."""
    assert not is_player_weapon("camera_10fov", info(weaponClass="smg", gunModel="weapon_ac130"))


def test_the_placeholder_weapon_is_rejected():
    assert not is_player_weapon("defaultweapon_mp", info(displayName="WEAPON_DEFAULTWEAPON", gunModel="viewmodel_default"))


def test_a_weapon_with_no_name_is_not_player_facing():
    """`uav_strike_projectile_mp` is a launcher by every field and has no display name."""
    assert not is_player_weapon("uav_strike_projectile_mp", info(weaponClass="rocketlauncher", displayName=""))


def test_a_killstreaks_own_copy_is_rejected_by_its_kill_icon():
    """Identical to the ordinary weapon but for this, so it is the only thing that tells them apart.

    Ghosts ships six such copies against MW3's four, and names their icons after
    the streak rather than after one Juggernaut.
    """
    assert is_player_weapon("iw5_usp45_mp", info(weaponClass="pistol", killIcon="hud_icon_usp_45"))
    assert not is_player_weapon("iw5_usp45jugg_mp", info(weaponClass="pistol", killIcon="death_juggernaut"))
    assert is_player_weapon("iw6_p226_mp", info(weaponClass="pistol", killIcon="hud_icon_p226"))
    assert not is_player_weapon("iw6_p226jugg_mp", info(weaponClass="pistol", killIcon="icon_ks_jugg_hud"))
    assert not is_player_weapon("iw6_gm6helisnipe_mp", info(weaponClass="sniper", killIcon="icon_ks_heli_sniper_hud"))


def test_the_killstreak_and_mode_weapons_no_field_separates_are_named():
    """A judgement, not a reading of the data — which is why it is a list rather than a rule."""
    assert not is_player_weapon("uav_strike_marker_mp", info(weaponClass="rocketlauncher", displayName="WEAPON_UAV_STRIKE"))
    assert is_player_weapon("rpg_mp", info(weaponClass="rocketlauncher", displayName="WEAPON_RPG"))
    # Safeguard's pistol: the Magnum's kill icon, 1000 damage and a name of its own.
    horde = info(weaponClass="pistol", killIcon="hud_icon_magnum", displayName="HORDE_PISTOL")
    assert not is_player_weapon("iw6_magnumhorde_mp", horde)


def test_modern_warfare_2_ships_a_weapon_file_per_attachment_combination():
    """1121 of MW2's weapon files are guns; 43 are weapons and the rest are combinations."""
    from scripts.cod.catalog import base_weapons

    guns = {
        "aa12_mp": {},
        "aa12_eotech_mp": {},
        "aa12_eotech_grip_mp": {},
        "aa12_fmj_silencer_mp": {},
        "ak47_mp": {},
        "ak47_gl_mp": {},
    }
    assert sorted(base_weapons(guns)) == ["aa12_mp", "ak47_mp"]


def test_a_weapon_no_shorter_name_prefixes_is_a_base():
    from scripts.cod.catalog import base_weapons

    # `mp5k_mp` is not a variant of `mp5_mp`: the token is `mp5k`, not `mp5` + `k`.
    assert sorted(base_weapons({"mp5_mp": {}, "mp5k_mp": {}})) == ["mp5_mp", "mp5k_mp"]


def test_nothing_is_dropped_when_a_game_ships_no_combinations():
    """MW3 names its base weapons only, so this must leave all of them alone."""
    from scripts.cod.catalog import base_weapons

    guns = {"iw5_m4_mp": {}, "iw5_acr_mp": {}, "rpg_mp": {}}
    assert sorted(base_weapons(guns)) == sorted(guns)


# --- The index's shape -------------------------------------------------------
#
# One array per kind, so a kind this build has never heard of is a key an older
# reader simply does not have — which is why adding characters and view-hands
# cost no CATALOG_VERSION bump. Both TS readers refuse the *whole* catalogue on a
# version mismatch, leaving every player unarmed, so that must stay rare.


def read_index(root):
    with open(f"{root}/catalog/index.json") as f:
        return json.load(f)


def test_write_index_keeps_weapons_even_when_empty(tmp_path):
    # Every reader of this file requires `weapons`; an absent one means the file
    # is not a catalogue at all, as opposed to one with no bodies in it yet.
    write_index(str(tmp_path), {})
    assert read_index(tmp_path) == {"version": CATALOG_VERSION, "weapons": []}


def test_write_index_omits_a_kind_with_no_entries(tmp_path):
    write_index(str(tmp_path), {"weapons": [{"id": "a"}], "characters": []})
    body = read_index(tmp_path)
    # Absent rather than `[]`: a reader tells "none built" from "built and empty".
    assert "characters" not in body
    assert body["weapons"] == [{"id": "a"}]


def test_write_index_sorts_every_kind_by_id(tmp_path):
    write_index(
        str(tmp_path),
        {"weapons": [{"id": "b"}, {"id": "a"}], "characters": [{"id": "z"}, {"id": "m"}]},
    )
    body = read_index(tmp_path)
    # Catalogue order is the wire's order for weapons (catalogHash covers it), so
    # this is load-bearing rather than tidiness.
    assert [e["id"] for e in body["weapons"]] == ["a", "b"]
    assert [e["id"] for e in body["characters"]] == ["m", "z"]


def test_write_index_writes_kinds_in_a_fixed_order(tmp_path):
    write_index(str(tmp_path), {kind: [{"id": "x"}] for kind in INDEXED_KINDS})
    assert list(read_index(tmp_path)) == ["version", *INDEXED_KINDS]


def write_entry(root, kind, game, ident, body):
    d = entry_dir(str(root), kind, game, ident)
    os.makedirs(d, exist_ok=True)
    with open(f"{d}/{ident}.json", "w") as f:
        json.dump(body, f)


def test_scan_entries_reads_every_kind_off_disk(tmp_path):
    write_entry(tmp_path, "weapons", "iw5", "m4", {"id": "m4", "game": "iw5"})
    write_entry(tmp_path, "characters", "iw5", "delta", {"id": "delta", "game": "iw5"})
    write_entry(tmp_path, "viewhands", "iw5", "hands", {"id": "hands", "game": "iw5"})
    write_entry(tmp_path, "actors", "t5", "zombie_ger", {"id": "zombie_ger", "game": "t5"})
    by_kind = scan_entries(str(tmp_path))
    assert {k: len(v) for k, v in by_kind.items()} == {
        "weapons": 1,
        "characters": 1,
        "viewhands": 1,
        "animations": 0,
        "actors": 1,
    }


def test_scan_entries_keeps_two_games_apart(tmp_path):
    # The same id in two games is two entries: `at4_mp` is in both Modern
    # Warfares with different numbers, which is why `game` is a path segment.
    write_entry(tmp_path, "weapons", "iw4", "at4_mp", {"id": "at4_mp", "game": "iw4"})
    write_entry(tmp_path, "weapons", "iw5", "at4_mp", {"id": "at4_mp", "game": "iw5"})
    weapons = scan_entries(str(tmp_path))["weapons"]
    assert sorted(e["game"] for e in weapons) == ["iw4", "iw5"]


def test_scan_entries_ignores_an_entry_folder_with_no_json(tmp_path):
    os.makedirs(entry_dir(str(tmp_path), "weapons", "iw5", "half_written"), exist_ok=True)
    assert scan_entries(str(tmp_path))["weapons"] == []


def test_black_ops_puts_viewmodel_anywhere_in_the_name():
    assert is_player_weapon("ak47_mp", info(gunModel="t5_weapon_ak47_viewmodel"))
    assert is_player_weapon("m16_mp", info(gunModel="t5_weapon_viewmodel_m16a1"))
    # The campaign's copy, dumped out of `common.ff` beside the MP zone.
    assert not is_player_weapon("ak47_sp", info(gunModel="t5_weapon_ak47_viewmodel"))


def test_dual_wield_is_left_out():
    """Two guns, one per hand; the engine draws one. Black Ops names both halves `_DW`."""
    rh = info(weaponClass="pistol", gunModel="t5_weapon_asp_viewmodel_dw_rh", displayName="WEAPON_ASP_DW")
    assert not is_player_weapon("aspdw_mp", rh)
    assert not is_player_weapon("asplh_mp", {**rh, "gunModel": "t5_weapon_asp_viewmodel_dw_lh"})


def test_black_ops_killstreak_guns_are_rejected():
    assert not is_player_weapon("minigun_mp", info(weaponClass="mg", killIcon="hud_obit_minigun"))
    assert not is_player_weapon("m202_flash_mp", info(weaponClass="rocketlauncher", killIcon="hud_obit_grim"))
    assert not is_player_weapon("m220_tow_mp", info(weaponClass="rocketlauncher", gunModel="t5_weapon_strela_viewmodel"))
