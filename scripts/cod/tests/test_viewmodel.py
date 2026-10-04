import json
import math
import os
import re

import pytest

from scripts.cod.gltf import read_glb, write_glb
from scripts.cod.viewmodel import (
    BALLISTIC_STRINGS,
    DAMAGE,
    FORMAT_VERSION,
    LOCATIONS,
    MOTION,
    SPREAD,
    ballistics,
    build_weapon_glb,
    check_fixed_bones,
    default_hands,
    definition,
    graft_hands_skeleton,
    gun_root_joint,
    hidden_bones,
    parse_infostring,
    role_clips,
    sound_overrides,
    view_hands,
    weapon_sounds,
)
from scripts.cod.worldfile import drop_include, ensure_include
from scripts.cod.xanim import BoneTrack, Track, XAnim

SHARED = os.path.join(os.path.dirname(__file__), "..", "..", "..", "packages", "shared", "src", "sim")
# Where a companion-zone dump lands: `catalog --dump <game>` keeps one here, and
# the ballistics test below reads real weapon files out of it rather than a
# fixture, because a fixture written from these same tables would only agree with itself.
WEAPON_DUMPS = {"iw4": ".cache/cod/catalog-mw2", "iw5": ".cache/cod/catalog-mw3", "iw6": ".cache/cod/catalog-ghosts"}

AXIS_CHANGE = [-math.sqrt(0.5), 0.0, 0.0, math.sqrt(0.5)]


def gun_gltf():
    """A packed gun as OAT lays it out: `j_gun` under a `<model>_skel` node beside the meshes, under the unit-scale root."""
    return {
        "asset": {"version": "2.0"},
        "scenes": [{"nodes": [4]}],
        "nodes": [
            {"name": "j_gun", "rotation": AXIS_CHANGE, "children": [1, 2]},
            {"name": "tag_clip", "translation": [4.3, 0.0, 1.3]},
            {"name": "tag_sight_off", "translation": [-0.6, 0.0, 4.0]},
            {"name": "gun_lod0_skel", "children": [0]},
            {"name": "unit-scale", "scale": [0.0254] * 3, "children": [3]},
        ],
        "skins": [{"joints": [0, 1, 2]}],
        "buffers": [{"byteLength": 0}],
    }


def hands_gltf():
    return {
        "asset": {"version": "2.0"},
        "scenes": [{"nodes": [4]}],
        "nodes": [
            {"name": "tag_origin", "rotation": AXIS_CHANGE, "children": [1]},
            {"name": "tag_view", "translation": [0.0, 0.0, 60.0], "children": [2]},
            {"name": "tag_torso", "translation": [-4.6, 0.0, -1.4], "children": [3]},
            {"name": "tag_weapon", "translation": [15.2, 0.0, -6.8]},
            {"name": "hands_lod0_skel", "children": [0]},
        ],
        "skins": [{"joints": [0, 1, 2, 3]}],
        "buffers": [{"byteLength": 0}],
    }


def parents_of(gltf, name):
    index = next(i for i, n in enumerate(gltf["nodes"]) if n.get("name") == name)
    return [n["name"] for n in gltf["nodes"] if index in n.get("children", [])]


def test_the_gun_hangs_from_tag_weapon_and_nowhere_else():
    # OAT puts j_gun under a skeleton node, not the scene root. Left listed there as
    # well, the loader attaches it to whichever parent it reaches first: the gun then
    # floats at the rig's origin while the hands hold nothing.
    gun = gun_gltf()
    graft_hands_skeleton(gun, hands_gltf())
    assert parents_of(gun, "j_gun") == ["tag_weapon"]
    j_gun = next(n for n in gun["nodes"] if n["name"] == "j_gun")
    assert "rotation" not in j_gun  # the axis change now lives on the hands' tag_origin
    assert parents_of(gun, "tag_origin") == ["gun_lod0_skel"]
    names = {gun["nodes"][j]["name"] for j in gun["skins"][1]["joints"]}
    assert names == {"tag_origin", "tag_view", "tag_torso", "tag_weapon"}


def view_clip(name, bones, asset_type=1, frames=1, notes=()):
    return XAnim(name, frames, 30.0, frames == 1, bones, asset_type=asset_type, notetracks=list(notes))


def weapon_info():
    # Weapon files spell clip names in mixed case; the assets are lowercase.
    fields = ["gunModel", "viewmodel_gun", "idleAnim", "Viewmodel_Gun_Idle", "clipSize", "30", "hideTags", "tag_clip\ntag_laser"]
    return parse_infostring("\\".join(["WEAPONFILE", *fields]))


def test_build_weapon_glb_writes_the_graft_the_clips_and_the_definition(tmp_path):
    write_glb(tmp_path / "gun.glb", gun_gltf(), bytearray())
    write_glb(tmp_path / "hands.glb", hands_gltf(), bytearray())
    idle = view_clip("viewmodel_gun_idle", [BoneTrack("tag_torso", None, Track([0], [[-7.5, -3.0, 1.5]]))])
    spec, _joints, problems = build_weapon_glb(
        tmp_path / "gun.glb", tmp_path / "hands.glb", tmp_path / "w.glb", "iw5", "gun_mp", weapon_info(), {idle.name: idle}
    )
    assert problems == []
    back, _ = read_glb(tmp_path / "w.glb")
    assert back["scenes"][0]["extras"]["viewmodel"] == spec
    assert spec["roles"] == {"idle": "viewmodel_gun_idle"}
    assert spec["hideBones"] == ["tag_clip", "tag_sight_off"]  # tag_laser is not on this gun
    assert [a["name"] for a in back["animations"]] == ["viewmodel_gun_idle"]


def test_view_clips_must_be_asset_type_1(tmp_path):
    write_glb(tmp_path / "gun.glb", gun_gltf(), bytearray())
    write_glb(tmp_path / "hands.glb", hands_gltf(), bytearray())
    idle = view_clip("viewmodel_gun_idle", [BoneTrack("tag_torso", None, Track([0], [[0.0, 0.0, 0.0]]))], asset_type=2)
    with pytest.raises(ValueError, match="asset type 2"):
        build_weapon_glb(
            tmp_path / "gun.glb", tmp_path / "hands.glb", tmp_path / "w.glb", "iw5", "gun_mp", weapon_info(), {idle.name: idle}
        )


def test_a_clip_that_moves_the_eye_or_the_rigs_root_is_refused():
    # The gun's own root is not among them: Ghosts animates `j_gun` on four weapons,
    # which swings the gun under the hands and is what the animator meant.
    check_fixed_bones(view_clip("ok", [BoneTrack("j_gun", Track([0], [[0, 0, 0, 1]]), None)]))
    check_fixed_bones(view_clip("ok", [BoneTrack("tag_view", None, None), BoneTrack("tag_torso", None, Track([0], [[0, 0, 0]]))]))
    with pytest.raises(ValueError, match="tag_view"):
        check_fixed_bones(view_clip("bad", [BoneTrack("tag_view", Track([0], [[0, 0, 0, 1]]), None)]))


def test_role_clips_match_names_case_blind_and_report_the_missing():
    info = parse_infostring("WEAPONFILE\\idleAnim\\Viewmodel_M4_Idle\\fireAnim\\viewmodel_m4_fire\\reloadAnim\\gone")
    roles, missing = role_clips(info, {"viewmodel_m4_idle", "viewmodel_m4_fire"})
    assert roles == {"idle": "viewmodel_m4_idle", "fire": "viewmodel_m4_fire"}
    assert missing == ["gone"]
    with pytest.raises(ValueError):
        parse_infostring("ATTACHMENTFILE\\a\\b")


def test_hidden_bones_always_fold_the_backup_sight_when_the_gun_has_one():
    assert hidden_bones({}, {"j_gun", "tag_sight_on", "tag_sight_off"}) == ["tag_sight_off"]
    assert hidden_bones({}, {"j_gun"}) == []


def test_definition_times_notetracks_in_seconds():
    reload = view_clip("viewmodel_m4_reload", [], frames=61, notes=[("weap_clipout", 11)])
    spec = definition("iw5", "m4", {"reloadTime": "2.029", "clipSize": "30"}, {"reload": reload.name}, {reload.name: reload}, [])
    assert spec["clips"][reload.name] == {"duration": 61 / 30, "looped": False, "notes": [["weap_clipout", 11 / 30]]}
    assert spec["times"] == {"reload": 2.029}
    assert spec["clipSize"] == 30


def test_view_hands_need_the_name_as_well_as_the_type(tmp_path):
    # OAT infers `"type": "viewhands"` from bone data, and a foliage rig passes it.
    models = [("viewhands_delta", "viewhands"), ("foliage_desertbrush_3_animated", "viewhands"), ("viewhands_prop", "animated")]
    for name, kind in models:
        (tmp_path / f"{name}.json").write_text(json.dumps({"type": kind}))
    assert view_hands(str(tmp_path)) == ["viewhands_delta"]


def test_default_hands_are_a_teams_everyday_pair():
    names = ["viewhands_delta", "viewhands_iw5_ghillie_desert", "viewhands_juggernaut_ally", "viewhands_op_force"]
    assert default_hands(names) == "viewhands_delta"
    assert default_hands(["viewhands_juggernaut_ally"]) == "viewhands_juggernaut_ally"
    assert default_hands([]) is None
    # A hostage's hands sort before every pair a Ghosts player wears.
    assert default_hands(["viewhands_gs_hostage", "viewhands_us_rangers_woodland"]) == "viewhands_us_rangers_woodland"


def test_the_guns_root_is_read_off_the_rig_when_it_is_not_j_gun():
    """Ghosts' riot shield roots at `tag_riotshiled`; no clip names either, so the root is
    only where the graft hangs the gun from the hands' `tag_weapon`."""
    gun = gun_gltf()
    assert gun_root_joint(gun) == 0
    gun["nodes"][0]["name"] = "tag_riotshiled"
    assert gun_root_joint(gun) == 0
    gun["nodes"].append({"name": "another_root"})  # two roots and no j_gun: nothing to choose between
    gun["skins"][0]["joints"] = [0, 1, 2, len(gun["nodes"]) - 1]
    with pytest.raises(ValueError, match="root joints"):
        gun_root_joint(gun)


def test_ensure_include_adds_the_line_once(tmp_path):
    (tmp_path / "world.world").write_text('world { name: "x" }\ninclude "props.world"\n\nlight sun { }\n')
    assert ensure_include(str(tmp_path), "minimap.world")
    assert not ensure_include(str(tmp_path), "minimap.world")
    assert (tmp_path / "world.world").read_text().count('include "minimap.world"\n') == 1


def test_drop_include_removes_the_line_once(tmp_path):
    # The inverse, and what retires a fragment from the 42 worlds that include it.
    (tmp_path / "world.world").write_text('world { name: "x" }\ninclude "props.world"\ninclude "minimap.world"\n')
    assert drop_include(str(tmp_path), "minimap.world")
    assert not drop_include(str(tmp_path), "minimap.world")
    text = (tmp_path / "world.world").read_text()
    assert 'include "minimap.world"' not in text
    # And leaves everything else alone.
    assert 'include "props.world"' in text


# -- The ballistics: the half of a weapon nothing draws ------------------------


def test_the_format_version_matches_the_one_the_engine_reads():
    """Two constants pointing at each other, in two languages that cannot import from each other.

    A weapon GLB carries this number and `readWeaponDef` refuses one it does not
    recognise, so the two moving apart is every exported weapon refused at load —
    and the two moving *together by accident* is worse: format 3's definitions
    read as format 4's, and every gun does no damage.
    """
    text = open(os.path.abspath(os.path.join(SHARED, "weaponDef.ts")), encoding="utf-8").read()
    found = re.search(r"^export const WEAPON_FORMAT_VERSION = (\d+);$", text, re.MULTILINE)
    assert found, "could not read WEAPON_FORMAT_VERSION out of weaponDef.ts"
    assert int(found[1]) == FORMAT_VERSION


def test_the_hit_locations_are_the_ones_the_engine_names():
    """`LOCATIONS` keys are `HIT_LOCATIONS`, in order.

    The engine classifies a bone to one of those names and looks the multiplier up
    by it. A name spelled only here is a multiplier nothing ever reads; a name
    spelled only there is a location with no multiplier at all.
    """
    text = open(os.path.abspath(os.path.join(SHARED, "hitLocations.ts")), encoding="utf-8").read()
    body = text[text.index("export const HIT_LOCATIONS") : text.index("] as const", text.index("export const HIT_LOCATIONS"))]
    found = re.findall(r'^\s{2}"(\w+)",$', body, re.MULTILINE)
    assert found, "could not read HIT_LOCATIONS out of hitLocations.ts"
    assert list(LOCATIONS) == found


def test_definition_carries_the_damage_the_spread_and_the_hit_locations():
    fields = ["damage", "42", "minDamage", "20", "maxDamageRange", "800", "hipSpreadMax", "7", "locHead", "1.4", "shotCount", "1"]
    spec = definition("iw5", "m4", parse_infostring("\\".join(["WEAPONFILE", *fields])), {}, {}, [])
    assert spec["damage"] == {"max": 42.0, "min": 20.0, "maxRange": 800.0}
    assert spec["spread"] == {"hipStandMax": 7.0}
    assert spec["locationDamage"] == {"head": 1.4}
    assert spec["shotCount"] == 1
    # A key the file does not carry is left out rather than written as zero: a
    # game whose struct has no member for one has not said it is nothing.
    assert "melee" not in spec["damage"] and "ads" not in spec["spread"]


def real_weapon_files(game):
    """Every weapon file a kept companion-zone dump holds, or None when there is no dump."""
    root = os.path.join(WEAPON_DUMPS[game], "weapons", "weapons")
    if not os.path.isdir(root):
        return None
    out = {}
    for name in sorted(os.listdir(root)):
        with open(os.path.join(root, name), encoding="utf-8", errors="replace") as fh:
            out[name] = parse_infostring(fh.read())
    return out


@pytest.mark.parametrize("game", sorted(WEAPON_DUMPS))
def test_every_ballistics_key_names_something_in_every_real_weapon_file(game):
    """The one failure this whole export has: a misspelt key resolves to nothing and the gun does no damage.

    Nothing downstream can tell that apart from a weapon the game really does
    give 0 damage, so the check has to be against the games' own files — all 1194
    of MW2's, all 156 of MW3's and all 130 of Ghosts' carry every key in
    `DAMAGE`, `SPREAD` and `LOCATIONS`, and the scalars beside them. Not one of
    them is optional here, which is why this asserts over every file rather than
    over a chosen gun. Ghosts' `loc*` keys are the dumper's own spellings
    (`iw6/dumpers/weapon.location_key`), so for that game this is also what
    catches one drifting from `LOCATIONS`.
    """
    files = real_weapon_files(game)
    if files is None:
        pytest.skip(f"needs a kept companion-zone dump in {WEAPON_DUMPS[game]}")
    assert len(files) > 100, f"{WEAPON_DUMPS[game]} holds {len(files)} weapon file(s); that is not a companion zone"

    unresolved = set()
    for info in files.values():
        got = ballistics(info)
        unresolved.update(f"damage.{role}" for role in DAMAGE if role not in got["damage"])
        unresolved.update(f"spread.{role}" for role in SPREAD if role not in got["spread"])
        unresolved.update(f"locationDamage.{where}" for where in LOCATIONS if where not in got["locationDamage"])
        unresolved.update(key for key in BALLISTIC_STRINGS if not got[key])
    assert not unresolved, f"{game}'s weapon files say nothing about: {', '.join(sorted(unresolved))}"


# The ten keys that are the aim's own recoil, and the four that reduce a burst's
# first rounds. Unlike the rest of `MOTION` they are not optional key by key:
# every file of all three games carries all fourteen.
RECOIL_KEYS = tuple(k for k in MOTION if "ViewKick" in k or "ReducedKick" in k)


@pytest.mark.parametrize("game", sorted(WEAPON_DUMPS))
def test_every_view_kick_key_names_something_in_every_real_weapon_file(game):
    """A misspelt `*ViewKick*` key is a weapon with no recoil, and nothing downstream can tell.

    The same failure the ballistics have and the same guard, because the same
    thing is at stake: `motion` is optional key by key, so a key spelled wrong is
    read as "this game did not say" and the gun's aim simply never moves. That is
    exactly what a scoped sniper looks like when only the gun kick is exported —
    `adsGunKickPitchMin`/`Max` are 0 on every one of them — which is the bug this
    test exists to stop coming back.
    """
    files = real_weapon_files(game)
    if files is None:
        pytest.skip(f"needs a kept companion-zone dump in {WEAPON_DUMPS[game]}")
    assert len(RECOIL_KEYS) == 14
    unresolved = set()
    for info in files.values():
        got = definition(game, "w", info, {}, {}, [])["motion"]
        unresolved.update(key for key in RECOIL_KEYS if key not in got)
    assert not unresolved, f"{game}'s weapon files say nothing about: {', '.join(sorted(unresolved))}"


def test_the_pitch_of_a_view_kick_is_upward_where_the_gun_kick_has_no_one_sign():
    """What fixes the sign `sim/recoil.ts` reads these at, asserted against the games themselves.

    `*ViewKickPitchMax* >= 0` in every weapon file of all three games, while the
    matching `*GunKickPitchMax*` is negative in hundreds. A gun kicks up, so the
    family with no negatives at its max end is the one whose positive is upward —
    and the other one has no single convention to read at all, which is why it is
    a drawing effect and not the aim.
    """
    seen, gun_negative = 0, 0
    for game in sorted(WEAPON_DUMPS):
        files = real_weapon_files(game)
        if files is None:
            continue
        for info in files.values():
            motion = definition(game, "w", info, {}, {}, [])["motion"]
            for where in ("hip", "ads"):
                assert motion[f"{where}ViewKickPitchMax"] >= 0, f"{game} spells a negative {where}ViewKickPitchMax"
                gun_negative += motion[f"{where}GunKickPitchMax"] < 0
            seen += 1
    if seen == 0:
        pytest.skip(f"needs a kept companion-zone dump in one of {', '.join(WEAPON_DUMPS.values())}")
    # And the comparison is not vacuous: the gun kick really does go both ways.
    assert gun_negative > 0


def test_a_weapons_sounds_come_from_its_file_and_its_notetracks_are_filtered_to_its_clips():
    """The alias is carried, and only the notetracks the exported clips can raise are kept."""
    info = {
        "fireSound": "weap_m4carbine_fire_npc",
        "fireSoundPlayer": "weap_m4carbine_fire_plr",
        "reloadSound": "weap_m4carbine_reload_npc",
        "meleeSwipeSound": "none",
        "impactType": "bullet_large",
        "notetrackSoundMap": (
            "weap_m4carbine_clipout_plr weap_m4carbine_clipout_plr\n"
            "weap_hybrid_flip_scope_on_plr weap_hybrid_flip_scope_on_plr\n"
            "melee_knife_stab none"
        ),
    }
    reload = view_clip("viewmodel_m4_reload", [], frames=61, notes=[("weap_m4carbine_clipout_plr", 11), ("viewmodel_small", 12)])
    spec = definition("iw5", "m4", info, {"reload": reload.name}, {reload.name: reload}, [])
    assert spec["sounds"] == {
        "fire": "weap_m4carbine_fire_npc",
        "firePlayer": "weap_m4carbine_fire_plr",
        "reload": "weap_m4carbine_reload_npc",
        "impact": "bullet_large",
        # `none` is not a sound, `viewmodel_small` is not in the map, and the
        # hybrid sight's note belongs to a clip this gun does not carry.
        "notes": {"weap_m4carbine_clipout_plr": "weap_m4carbine_clipout_plr"},
    }


def test_sound_overrides_are_read_one_attachment_at_a_time():
    """A silencer replaces the two fire aliases; an underbarrel's own fire is not the rifle's."""
    info = {
        "soundOverrides": (
            "silencer none fire weap_m4silenced_fire_npc none\n"
            "silencer none player_fire weap_m4silenced_fire_plr none\n"
            "gl none fire weap_m4carbine_fire_npc weap_m203_fire_npc\n"
            "gl silencer fire weap_m4silenced_fire_npc weap_m203_fire_npc"
        )
    }
    assert sound_overrides(info) == {
        "silencer": {"fire": "weap_m4silenced_fire_npc", "firePlayer": "weap_m4silenced_fire_plr"},
        # The GL's own row names the rifle's unchanged fire; the fifth column,
        # which is the launcher's, is deliberately not read. The two-attachment
        # row is the composition of two single ones and is skipped.
        "gl": {"fire": "weap_m4carbine_fire_npc"},
    }


@pytest.mark.parametrize("game", sorted(WEAPON_DUMPS))
def test_what_the_real_weapon_files_say_about_sound(game):
    """The M4 is the case a prefix rule gets wrong, and Ghosts is the case with no answer at all.

    Both games' M4s are `m4carbine` in the sound bank and neither is called that,
    so a rule spelling the alias from the weapon's id gives a name no bank holds
    and every M4 is silent. Ghosts is the other end: `docs/cod/games.md` records
    that its weapon sounds are not recoverable, and this is what keeps that a
    measured fact rather than a remembered one.
    """
    files = real_weapon_files(game)
    if files is None:
        pytest.skip(f"needs a kept companion-zone dump in {WEAPON_DUMPS[game]}")

    fired = [name for name, info in files.items() if weapon_sounds(info).get("firePlayer")]
    if game == "iw6":
        assert fired == [], f"Ghosts is supposed to have no fire sounds; {len(fired)} file(s) carry one"
        # It does carry the other half, which is why the block is per field.
        assert sum(1 for info in files.values() if weapon_sounds(info).get("notes")) > 50
        return

    assert len(fired) > 100, f"{game} carries fire sounds in only {len(fired)} of {len(files)} weapon files"
    m4 = "m4_mp" if game == "iw4" else "iw5_m4_mp"
    sounds = weapon_sounds(files[m4])
    assert sounds["firePlayer"] == "weap_m4carbine_fire_plr"
    assert sounds["fire"] == "weap_m4carbine_fire_npc"
    assert sounds["impact"] == "bullet_large"
