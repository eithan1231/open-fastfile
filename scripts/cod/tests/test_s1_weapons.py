"""Advanced Warfare's weapons and attachments, without the game files.

What is pinned here is what the zones settled and a plausible reading gets
wrong (reverse/s1-zone/README.md#the-weapons): three enums S1 renumbered, the
damage tiers x64-zt names the wrong way round, attachments as edits rather
than blocks, and which weapon files are one gun's variants.
"""

import struct

import pytest

from scripts.cod import attachments, catalog
from scripts.cod.s1.dumpers import attachment as attachment_dump
from scripts.cod.s1.dumpers import weapon as weapon_dump
from scripts.cod.viewmodel import CLIP_ROLES, parse_infostring

# --- the enums --------------------------------------------------------------


def test_the_enums_s1_renumbered_are_read_through_s1s_own_tables():
    fire, impact, anim = (weapon_dump.ENUMS[e] for e in ("weapFireType_t", "ImpactType", "playerAnimType_t"))
    # H1's fire types: the AMR9's 35-round magazine is seven bursts of five.
    assert fire[5] == "5-Round Burst" and fire[6] == "Double Barrel"
    # H1's impacts: `shotgun_energy` at 7, so a frag grenade (9) explodes as a
    # grenade and the EM1 (12) is a beam, where x64-zt's s1 table says rocket and nothing.
    assert impact[7] == "shotgun_energy" and impact[9] == "grenade_explode" and impact[12] == "energy_beam"
    # x64-zt's s1 table: IW6's 5 is `mg`, S1's is a sniper's.
    assert anim[5] == "sniper" and anim[8] == "m203" and anim[14] == "minigun"
    assert weapon_dump.ENUMS["AttachmentType"] == ("scope", "underbarrel", "siderail", "other")


def test_a_value_past_an_enum_is_written_as_its_number():
    class Record(dict):
        pass

    assert weapon_dump.scalar(Record(stickiness=6), "WeapStickinessType", "stickiness") == "6"
    assert weapon_dump.scalar(Record(offhandClass=8), "OffhandClass", "offhandClass") == "8"
    assert weapon_dump.scalar(Record(fireTime=80), "ms", "fireTime") == "0.08"


def test_each_clip_role_reads_s1s_own_slot():
    """`vm_ak12_reload` is slot 24 and `vm_ak12_ads_up` 128 on every gun; IW6's numbers are 16 and 90."""
    assert weapon_dump.ANIMS["reloadAnim"] == 24 and weapon_dump.ANIMS["adsUpAnim"] == 128
    assert weapon_dump.ANIMS["raiseAnim"] == 36 and weapon_dump.ANIMS["sprintLoopAnim"] == 52
    assert set(CLIP_ROLES.values()) <= set(weapon_dump.ANIMS)
    assert all(0 < slot < weapon_dump.NUM_ANIMS for slot in weapon_dump.ANIMS.values())


def test_the_keys_are_oats_spellings_of_s1s_members():
    assert weapon_dump.key_of("szDisplayName") == "displayName"
    assert weapon_dump.key_of("hipSpreadStandMax") == "hipSpreadMax"
    assert weapon_dump.key_of("weapClass") == "weaponClass"
    assert weapon_dump.key_of("positionReloadTransTime") == "adsReloadTransTime"
    assert weapon_dump.key_of("minDamage") == "minDamage"


# --- the damage tiers -------------------------------------------------------


class _Weapon:
    def __init__(self, **fields):
        self.record = {"weapType": 1, **fields}


def test_a_zone_whose_guns_regain_damage_with_range_is_refused():
    """What x64-zt's own names give on every AW gun: 33, down to 24 by 1600, back up to 28."""
    misread = {f"gun{i}": _Weapon(damage=33, midDamage=24, minDamage=28) for i in range(3)}
    with pytest.raises(SystemExit):
        weapon_dump.check_damage_tiers(None, misread)
    right = {f"gun{i}": _Weapon(damage=33, midDamage=28, minDamage=24) for i in range(3)}
    right["defaultweapon_mp"] = _Weapon(damage=100, midDamage=30, minDamage=80)  # a debug gun may disagree
    weapon_dump.check_damage_tiers(None, right)


# --- override rows ------------------------------------------------------------


def test_an_override_row_names_its_attachments_by_their_place_in_the_weapons_list():
    accepted = ["opticsacog2", ",silencer01", "gl"]
    assert weapon_dump._pair({"a": 2, "b": 0}, "a", "b", accepted, "x") == ["silencer01", "none"]
    # Either column may hold the only one, and `0 0` is the bare weapon.
    assert weapon_dump._pair({"a": 0, "b": 3}, "a", "b", accepted, "x") == ["gl", "none"]
    assert weapon_dump._pair({"a": 0, "b": 0}, "a", "b", accepted, "x") == ["none", "none"]
    assert weapon_dump._pair({"a": 3, "b": 1}, "a", "b", accepted, "x") == ["gl", "opticsacog2"]
    with pytest.raises(SystemExit):
        weapon_dump._pair({"a": 4, "b": 0}, "a", "b", accepted, "x")


# --- attachment edits -----------------------------------------------------------


class _Field:
    def __init__(self, kind, base=""):
        self.kind, self.base = kind, base


def _parm(fmt, value):
    return struct.pack(fmt, value) + bytes(4)


def test_an_edit_reads_by_its_own_type_and_is_refused_on_a_member_of_another():
    f32, i32, ptr = _Field(3), _Field(2), _Field(4)
    assert attachment_dump.edit("adsZoomFov", f32, "float", "set", _parm("<f", 30.0), "x") == 30.0
    # A set whole number is an int; a scaled one is the factor, as a float.
    assert attachment_dump.edit("clipSize", i32, "int", "set", _parm("<i", 1), "x") == 1
    assert attachment_dump.edit("clipSize", i32, "int", "scale", _parm("<f", 1.5), "x") == 1.5
    assert attachment_dump.edit("stateTimers.fireTime", i32, "ms", "set", _parm("<i", 500), "x") == 0.5
    fire = _Field(2, "weapFireType_t")
    assert attachment_dump.edit("fireType", fire, "int", "set", _parm("<i", 1), "x") == "Single Shot"
    assert attachment_dump.edit("tracerType", _Field(4, "TracerDef"), "tracer", "set", ",ohm", "x") == "ohm"
    with pytest.raises(SystemExit):
        attachment_dump.edit("adsZoomFov", f32, "int", "set", _parm("<i", 1), "x")
    with pytest.raises(SystemExit):
        attachment_dump.edit("fireRumble", ptr, "material", "set", "m", "x")


def _edit(key, value, op="set", kind="float"):
    return {"key": key, "member": key, "type": kind, "op": op, "value": value}


INFO = {
    "clipSize": "30",
    "fireTime": "0.08",
    "adsZoomFov": "50",
    "fireType": "Full Auto",
    "hipSpreadMax": "6",
    "maxDamageRange": "400",
    "damage": "33",
    "idleAnim": "vm_ak12_idle",
    "adsUpAnim": "vm_ak12_ads_up",
    "fireSound": "wpn_ak12_npc",
    "fireSoundPlayer": "wpn_ak12_plr",
    "attachments": "opticsacog2\ngl\nxmags\nsilencer01\ngm6scope\nopticsacog2ar",
    "animOverrides": "opticsacog2 none adsUpAnim vm_ak12_acog_ads_up none 0 0\n"
    "gl none idleAnim vm_ak12_gl_idle vm_ak12_gl_alt_idle 0 0\n"
    "gl opticsacog2 adsUpAnim vm_ak12_gl_acog none 0 0\n"
    "opticsacog2ar none adsUpAnim vm_ak12_acog_ads_up none 0 0",
    "soundOverrides": "silencer01 none player_fire wpn_ak12_sup_plr none\nsilencer01 none fire wpn_ak12_sup_npc none",
}


def test_set_replaces_and_scale_multiplies_in_the_weapon_files_own_units():
    edited = attachments.s1_apply(
        INFO,
        [
            _edit("clipSize", 1.5, "scale", "int"),
            _edit("fireTime", 0.8, "scale", "ms"),
            _edit("adsZoomFov", 30.0),
            _edit("fireType", "Single Shot", kind="int"),
            _edit(None, 1.0),  # a member no weapon-file key names
        ],
    )
    assert edited["clipSize"] == "45" and edited["fireTime"] == "0.064"
    assert edited["adsZoomFov"] == "30" and edited["fireType"] == "Single Shot"
    assert INFO["clipSize"] == "30"


def test_an_attachment_is_its_edits_diffed_against_the_weapon():
    acog = {"type": "scope", "displayName": "ACOG", "fields": [_edit("adsZoomFov", 30.0)]}
    entry = attachments.s1_entry("opticsacog2", acog, INFO)
    assert entry["type"] == "scope"
    assert entry["overrides"] == {"adsZoomFov": 30.0, "roles": {"adsUp": "vm_ak12_acog_ads_up"}}

    xmags = {"type": "other", "fields": [_edit("clipSize", 1.5, "scale", "int")]}
    assert attachments.s1_entry("xmags", xmags, INFO)["overrides"] == {"clipSize": 45}

    silencer = {"type": "other", "fields": [_edit("maxDamageRange", 0.75, "scale")]}
    overrides = attachments.s1_entry("silencer01", silencer, INFO)["overrides"]
    assert overrides["damage"] == {"maxRange": 300.0}
    assert overrides["sounds"] == {"firePlayer": "wpn_ak12_sup_plr", "fire": "wpn_ak12_sup_npc"}


def test_a_second_weapon_brings_its_clips_and_not_its_numbers():
    """The launcher sets one round of 135 for the grenade, not for the rifle it hangs under."""
    gl = {"type": "underbarrel", "fields": [_edit("clipSize", 1, kind="int"), _edit("damage", 135, kind="int")]}
    assert attachments.s1_second_weapon(gl)
    entry = attachments.s1_entry("gl", gl, INFO)
    assert entry["overrides"] == {"roles": {"idle": "vm_ak12_gl_idle"}}
    assert attachments.s1_second_weapon({"shareAmmoWithAlt": True, "fields": []})
    assert not attachments.s1_second_weapon({"fields": [_edit("clipSize", 1.5, "scale", "int")]})


def test_a_siderail_is_other_and_an_attachment_that_changes_nothing_is_not_offered():
    rail = attachments.s1_entry("trackrounds", {"type": "siderail", "fields": []}, INFO, model="vm_tracker")
    assert rail["type"] == "other" and not attachments.s1_offered(rail)
    hides = attachments.s1_entry("irons", {"type": "scope", "hideIronSightsWithThisAttachment": True}, INFO)
    assert attachments.s1_offered(hides)


def test_an_automatic_attachment_is_part_of_the_weapon():
    defs = {"gm6scope": {"automaticAttachment": True, "fields": [_edit("adsZoomFov", 15.0)]}}
    assert attachments.s1_fold_automatic(INFO, defs)["adsZoomFov"] == "15"
    defs["gm6scope"]["fields"].append(_edit("damage", 20, kind="int"))  # now a second weapon: left alone
    assert attachments.s1_fold_automatic(INFO, defs)["adsZoomFov"] == "50"


def test_a_twin_that_differs_only_in_its_sway_is_offered_once():
    one = {"type": "scope", "fields": [_edit("adsZoomFov", 30.0)]}
    twin = {"type": "scope", "fields": [_edit("adsZoomFov", 30.0), _edit("adsIdleAmount", 25.0)]}
    info = {**INFO, "adsIdleAmount": "10"}
    entries = [attachments.s1_entry("opticsacog2", one, info), attachments.s1_entry("opticsacog2ar", twin, info)]
    assert [e["id"] for e in attachments.s1_distinct(entries)] == ["opticsacog2"]


# --- which weapon files are guns ----------------------------------------------


def test_a_supply_drop_variant_or_a_skin_is_not_a_gun_of_its_own():
    names = [
        "iw5_ak12_mp",
        "iw5_ak12loot3_mp",
        "iw5_ak12ghosts_mp",
        "iw5_bal27_mp",
        "iw5_bal27atlas_mp",
        "iw5_dlcgun1_mp",
        "iw5_dlcgun10_mp",
        "iw5_dlcgun1loot0_mp",
    ]
    kept = catalog.s1_base_weapons(dict.fromkeys(names, {}))
    assert sorted(kept) == ["iw5_ak12_mp", "iw5_bal27_mp", "iw5_dlcgun10_mp", "iw5_dlcgun1_mp"]


def test_an_aw_viewmodel_is_a_viewmodel():
    info = {
        "inventoryType": "primary",
        "weaponClass": "rifle",
        "gunModel": "vm_ak12_loot_base",
        "displayName": "WEAPON_AK12",
        "killIcon": "hud_icon_ak12",
    }
    assert catalog.is_player_weapon("iw5_ak12_mp", info)
    assert catalog.GAME_KEYS["aw"] == "s1" and "s1" in catalog.ATTACHMENT_GAMES


def test_an_s1_weapon_file_reads_back_as_an_infostring():
    text = "\\".join(["WEAPONFILE", "clipSize", "30", "fireType", "5-Round Burst"])
    assert parse_infostring(text) == {"clipSize": "30", "fireType": "5-Round Burst"}


def test_an_aw_rigid_attachment_mounts_on_the_tag_its_name_implies():
    """`vm_foregrip` carries no joint; without the prefix read off, the scope-tag fallback would take it."""
    assert attachments.derived_tag("vm_foregrip") == "tag_foregrip"
    assert attachments.derived_tag("viewmodel_as50_scope_iw5") == "tag_as50_scope"
    entry = {"id": "foregrip", "model": "vm_foregrip"}
    attachments.resolve_mounts([entry], {"j_gun", "tag_foregrip", "tag_scope"})
    assert entry["tag"] == "tag_foregrip"
