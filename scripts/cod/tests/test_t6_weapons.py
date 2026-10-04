"""Black Ops II's weapons: the T6 weapon dumpers, the attachment reading and the catalogue's checks.

The unit tests build their inputs. Three read the installed game when it is there
(as test_t6.py finds it): the attachment arrays are indexed by attachment type, the
patch zone's weapon files are a rebalance of the base zone's, and every gun's attachment
list is what the Create-a-Class menu (`mp/statstable.csv`) offers.
"""

import os

import pytest

from scripts.cod import attachments, catalog, t6_catalog, viewmodel
from scripts.cod.iw5.dumpers.weapon import load_fields
from scripts.cod.t6.dumpers import weapon as t6_weapon

from .installed import game_path

BO2_ZONES = game_path("bo2", "zone", "all")
needs_game = pytest.mark.skipif(not os.path.exists(os.path.join(BO2_ZONES, "common_mp.ff")), reason="no Black Ops II install")


# -- The dumper's paths ---------------------------------------------------------------------------


def test_paths_name_enums_by_value_and_vec3_by_v():
    record = object.__new__(t6_weapon.Weapon)
    record.enums = {"WEAP_ANIM_IDLE": 1, "HITLOC_HEAD": 2}
    assert record._indexed("szXAnims[WEAP_ANIM_IDLE]") == "szXAnims[1]"
    assert record._indexed("locationDamageMultipliers[HITLOC_HEAD]") == "locationDamageMultipliers[2]"
    # T6's vec3_t is a union whose only named member is `v`.
    assert record._indexed("weapDef.vStandMove.x") == "weapDef.vStandMove.v[0]"
    assert record._indexed("attachment.viewModelOffsets.z") == "attachment.viewModelOffsets.v[2]"


def test_the_field_table_covers_every_kind_the_dumper_reads():
    table = load_fields("t6")
    kinds = {kind for key in ("fields", "attachment_fields", "attachment_unique_fields") for _, _, kind in table[key]}
    handled = set(t6_weapon.ENUMS) | {
        "WFT_NOTETRACKSOUNDMAP", "WFT_HIDETAGS", "AUFT_HIDETAGS", "WFT_ATTACHMENTS", "WFT_ATTACHMENT_UNIQUES",
        "WFT_WEAPON_CAMO", "AUFT_CAMO", "WFT_BOUNCE_SOUND", "AUFT_ANIM_NAME", "CSPFT_UINT",
    }  # fmt: skip
    from scripts.cod.iw5.dumpers import weapon as iw

    handled |= set(iw.ENUM_TABLES) | iw.ASSET_TYPES | {
        "CSPFT_STRING", "WFT_ANIM_NAME", "CSPFT_INT", "CSPFT_BOOL", "CSPFT_QBOOLEAN", "CSPFT_FLOAT",
        "CSPFT_MILLISECONDS", "CSPFT_SOUND", "CSPFT_SCRIPT_STRING", "WFT_EXPLOSION_TAG",
    }  # fmt: skip
    assert kinds <= handled, kinds - handled
    # The keys the engine reads, bar the two T6 spells differently (normalize) or lacks.
    keys = {key for key, _, _ in table["fields"]}
    assert set(viewmodel.WEAPON_KEYS) - keys == {"adsZoomFov"}


# -- What the catalogue reads ---------------------------------------------------------------------


def test_sound_notetracks_name_their_alias():
    wanted = {"sndnt#fly_an94_mag_out", "rmbnt#reload_large", "sndnt#none", "interruptible"}
    assert viewmodel.notetrack_sounds({}, wanted) == {"sndnt#fly_an94_mag_out": "fly_an94_mag_out"}
    # Without the clips' notetracks there is nothing to read them from.
    assert viewmodel.notetrack_sounds({}, None) == {}


def test_sound_notetracks_come_out_in_one_order():
    # The catalogue writes these as they come, so a set's order would make two
    # builds of the same weapon differ.
    notes = ["sndnt#fly_gear_reload_plr", "sndnt#fly_ak47_mag_in_plr", "sndnt#fly_ak47_mag_out_plr"]
    expected = sorted(notes)
    assert list(viewmodel.notetrack_sounds({}, set(notes))) == expected
    assert list(viewmodel.notetrack_sounds({}, set(reversed(notes)))) == expected


def test_view_hands_are_named_by_faction():
    assert viewmodel.is_view_hands("c_usa_mp_seal6_longsleeve_viewhands")
    assert not viewmodel.is_view_hands("c_usa_mp_seal6_body")
    assert not viewmodel.is_view_hands("viewmodel_base_viewhands")


def gun(**extra):
    return {
        "gunModel": "t6_wpn_ar_an94_view",
        "inventoryType": "primary",
        "weaponClass": "rifle",
        "displayName": "WEAPON_AN94",
        "killIcon": "menu_mp_weapons_an94",
        **extra,
    }


def test_player_weapons_are_the_menu_guns():
    assert catalog.is_player_weapon("an94_mp", gun())
    assert catalog.weapon_slot(gun(weaponClass="pistol spread")) == "secondary"
    assert not catalog.is_player_weapon("kard_wager_mp", gun())
    assert not catalog.is_player_weapon("kard_dw_mp", gun(displayName="WEAPON_KARD_DW"))
    assert not catalog.is_player_weapon("remote_mortar_missile_mp", gun(gunModel="t6_wpn_tablet_view", displayName=""))
    assert not catalog.is_player_weapon("an94_mp", gun(gunModel="t6_wpn_ar_an94_world"))


def test_normalize_names_the_first_zoom():
    assert t6_catalog.normalize({"adsZoomFov1": "50", "adsZoomFov2": "30"})["adsZoomFov"] == "50"
    assert t6_catalog.normalize({"adsZoomFov": "65", "adsZoomFov1": "50"})["adsZoomFov"] == "65"


ATTACH_DEFAULTS = {
    "attachmentType": "extclip", "displayName": "WEAPON_EXTCLIP", "clipSizeScale": "1", "clipSize": "10",
    "fireTimeScale": "1", "reloadTimeScale": "1", "reloadEmptyTimeScale": "1", "reloadAddTimeScale": "1",
    "adsTransInTimeScale": "1", "adsTransOutTimeScale": "1", "damageRangeScale": "1", "hipSpreadMinScale": "1",
    "hipSpreadMaxScale": "1", "adsViewKickCenterSpeedScale": "1", "adsIdleAmountScale": "1", "adsZoomFov1": "1",
    "swayOverride": "0", "adsSwayOverride": "0", "hipIdleAmount": "0", "standMoveF": "-300", "standRotP": "-300",
    "standRotR": "-300", "standRotY": "0", "swayMaxAngle": "0",
}  # fmt: skip
WEAPON = gun(
    clipSize="30", fireTime="0.096", reloadTime="2.475", reloadEmptyTime="3.105", adsTransInTime="0.25",
    maxDamageRange="1150", minDamageRange="2251", damage="40", minDamage="24", hipSpreadStandMin="3",
    hipSpreadMax="6.75", adsViewKickCenterSpeed="1500", adsZoomFov="50", fireSound="wpn_an94_fire_npc",
    fireSoundPlayer="wpn_an94_fire_plr", idleAnim="viewmodel_an94_idle", adsUpAnim="viewmodel_an94_ads_up",
    hideTags="tag_grip_on",
)  # fmt: skip


def attach(**changes):
    return {**ATTACH_DEFAULTS, **changes}


def test_scales_multiply_the_weapons_own_numbers_and_unset_values_change_nothing():
    assert attachments.t6_numbers(attach(), WEAPON) == {}
    extclip = attachments.t6_numbers(attach(clipSizeScale="1.345"), WEAPON)
    assert extclip == {"clipSize": 40}  # the AN-94's 30 rounds, 40 in the game's own menu
    rapid = attachments.t6_numbers(attach(fireTimeScale="0.75", damageRangeScale="0.6", hipSpreadMaxScale="1.2"), WEAPON)
    assert rapid["times"] == {"fire": 0.072}
    assert rapid["damage"] == {"maxRange": 690.0, "minRange": 1350.6}
    assert rapid["spread"] == {"hipStandMax": 8.1}
    sight = attachments.t6_numbers(attach(adsZoomFov1="35", adsSwayOverride="1", adsSwayMaxAngle="0.45"), WEAPON)
    assert sight["adsZoomFov"] == 35.0 and sight["motion"]["adsSwayMaxAngle"] == 0.45


def test_a_unique_brings_its_clips_sounds_and_hides():
    none = {
        "attachmentType": "none",
        "idleAnim": "viewmodel_an94_idle",
        "adsUpAnim": "viewmodel_an94_ads_up",
        "hideTags": "tag_grip_on",
    }
    silencer = {**none, "attachmentType": "silencer", "viewModel": "t6_attach_ar_silencer4_view",
                "fireSound": "wpn_an94_silencer_fire_npc", "fireSoundPlayer": "wpn_an94_silencer_fire_plr"}  # fmt: skip
    entry = attachments.t6_entry("silencer", attach(attachmentType="silencer"), silencer, none, WEAPON)
    assert entry["overrides"]["sounds"] == {"fire": "wpn_an94_silencer_fire_npc", "firePlayer": "wpn_an94_silencer_fire_plr"}
    assert "hideBones" not in entry
    # A dual magazine is the gun's own mesh, which the bare gun hides: no model, and it shows.
    grip = {**none, "attachmentType": "grip", "viewModel": "", "idleAnim": "viewmodel_an94_grip_idle", "hideTags": ""}
    entry = attachments.t6_entry("grip", attach(attachmentType="grip"), grip, none, WEAPON)
    assert entry["type"] == "underbarrel"
    assert entry["overrides"]["roles"] == {"idle": "viewmodel_an94_grip_idle"}
    assert entry["showBones"] == ["tag_grip_on"]  # the gun's own grip, which the bare gun hides
    # A scope with a model nothing mounts yet hides nothing: no sights at all would be worse.
    acog = {**none, "attachmentType": "acog", "viewModel": "t6_attach_optic_acog_view", "hideTags": "tag_grip_on\ntag_sights"}
    entry = attachments.t6_entry("acog", attach(attachmentType="acog"), acog, none, WEAPON)
    assert entry["type"] == "scope" and "hideBones" not in entry and "showBones" not in entry


def test_a_second_weapon_brings_no_numbers():
    gl = {"attachmentType": "gl", "altWeapon": "gl_an94_mp", "viewModel": "t6_attach_gl_gp25_view", "fireSound": "wpn_m320_fire"}
    entry = attachments.t6_entry("gl", attach(attachmentType="gl", clipSizeScale="2"), gl, None, WEAPON)
    assert "clipSize" not in (entry.get("overrides") or {})
    assert "sounds" not in (entry.get("overrides") or {})


def test_the_menu_holds_the_build_to_its_attachments_and_slot(tmp_path):
    row = [""] * 14
    row[t6_catalog.STATS_NAME], row[t6_catalog.STATS_ATTACHMENTS], row[t6_catalog.STATS_SLOT] = "crossbow", "acog dw", "secondary"
    row[t6_catalog.STATS_CLASSES] = "class_custom_assault"
    entry = {"id": "crossbow_mp", "game": "t6", "slot": "primary", "attachments": [{"id": "acog"}, {"id": "ir"}]}
    (tmp_path / "catalog" / "weapons" / "t6" / "crossbow_mp").mkdir(parents=True)
    problems = t6_catalog.check_menu({"crossbow": row}, [entry], str(tmp_path))
    assert problems == ["crossbow_mp: the menu offers [] and not ['ir']"]
    assert entry["slot"] == "secondary"
    assert '"slot": "secondary"' in (tmp_path / "catalog" / "weapons" / "t6" / "crossbow_mp" / "crossbow_mp.json").read_text()
    assert t6_catalog.default_weapon({"crossbow": row}) is None  # a secondary is not the class's weapon
    row[t6_catalog.STATS_SLOT] = "primary"
    assert t6_catalog.default_weapon({"crossbow": row}) == "crossbow_mp"


# -- The installed game ---------------------------------------------------------------------------


def walk(name):
    from scripts.cod.zonecode.walker import walk_fastfile

    return walk_fastfile(os.path.join(BO2_ZONES, name))


@needs_game
def test_attachment_arrays_are_indexed_by_attachment_type():
    """A weapon's `attachments[i]` and `attachmentUniques[i]` (i < 63) are of type i, on every gun:
    what reading the arrays as a list in load order, or the type from the wrong member, would break."""
    names = load_fields("t6")["names"]["szAttachmentTypeNames"]
    zone = walk("common_mp.ff")
    checked = 0
    for asset in zone.by_type("weapon"):
        if asset.name.startswith(","):
            continue
        for array in ("attachments", "attachmentUniques"):
            items = asset.record[array]
            for index, item in enumerate(list(items)[:63] if items is not None else []):
                if item is not None:
                    assert item.record["attachmentType"] == index, (asset.name, array, item.name, names[index])
                    checked += 1
    assert checked > 800


@needs_game
def test_the_patch_zone_rebalances_the_base_zones_weapons(tmp_path):
    """`common_patch_mp.ff` re-ships 81 weapon files with new numbers: the AN-94's first damage step
    moves from 1300 to 1150 units. A catalogue built from `common_mp.ff` alone is the launch game's."""
    from scripts.cod.t6.backend import Backend

    backend = Backend()
    for zone in ("common_mp.ff", t6_catalog.PATCH_ZONE):
        backend.dump(os.path.join(BO2_ZONES, zone), str(tmp_path / zone), "weapon")
    read = lambda zone: viewmodel.parse_infostring((tmp_path / zone / "weapons" / "an94_mp").read_text("latin-1"))  # noqa: E731
    base, patched = read("common_mp.ff"), read(t6_catalog.PATCH_ZONE)
    assert (base["maxDamageRange"], patched["maxDamageRange"]) == ("1300", "1150")
    # Six damage tiers, stepped by a one-unit ramp: 40 to 1150, 33 to 2250, 24 beyond.
    assert [patched[k] for k in ("damage", "damage2", "damage3", "minDamage")] == ["40", "33", "33", "24"]
    assert [patched[k] for k in ("maxDamageRange", "damageRange2", "damageRange3", "minDamageRange")] == [
        "1150",
        "1151",
        "2250",
        "2251",
    ]


@needs_game
def test_every_guns_attachments_are_what_the_menu_offers(tmp_path):
    """The weapon files and `mp/statstable.csv` are two sources for one list: they agree on every gun."""
    from scripts.cod.t6.backend import Backend

    backend = Backend()
    backend.dump(os.path.join(BO2_ZONES, "patch_mp.ff"), str(tmp_path / t6_catalog.TABLE_DIR), "stringtable")
    for zone in ("common_mp.ff", t6_catalog.PATCH_ZONE):
        backend.dump(os.path.join(BO2_ZONES, zone), str(tmp_path / "weapons"), "weapon")
    menu = t6_catalog.read_menu(str(tmp_path))
    guns = catalog.base_weapons(catalog.player_weapons(str(tmp_path)))
    assert len(guns) == 38  # 37 build; the ballistic knife's fire clip moves tag_origin
    for name, info in guns.items():
        row = menu[name.removesuffix("_mp")]
        listed = set(attachments.accepted(info)) - {"defaultattachment"}
        assert listed == set(row[t6_catalog.STATS_ATTACHMENTS].split()), name
    assert t6_catalog.default_weapon(menu) == "tar21_mp"
