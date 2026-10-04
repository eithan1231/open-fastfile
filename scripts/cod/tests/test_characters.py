import math

import pytest

from scripts.cod.characters import (
    build_anim_rig,
    choose_bodies,
    clip_names,
    definition,
    graft_head,
    graft_weapon,
    head_for,
    pick,
    side_of,
    skeleton_spec,
    unclaimed_heads,
    write_anim_glb,
)
from scripts.cod.gltf import read_glb
from scripts.cod.xanim import BoneTrack, Track, XAnim

AXIS_CHANGE = [-math.sqrt(0.5), 0.0, 0.0, math.sqrt(0.5)]

DOME_BODIES = [
    "mp_body_ally_delta_sniper",
    "mp_body_delta_elite_assault_aa",
    "mp_body_delta_elite_lmg_a",
    "mp_body_opforce_russian_urban_sniper",
    "mp_body_russian_military_assault_a",
    "mp_body_russian_military_smg_a",
]
DOME_HEADS = ["head_ally_delta_sniper", "head_delta_elite_a", "head_russian_military_aa", "head_russian_military_f"]

# mp_rust's own. MW2 writes the family the other way round on a head
# (`desert_tf141` against `tf141_desert`) and spells the allied one `ally` on a
# body and `allies` on its head, neither of which a leading-run match survives.
RUST_BODIES = [
    "mp_body_ally_sniper_ghillie_desert",
    "mp_body_desert_tf141_assault_a",
    "mp_body_desert_tf141_smg",
    "mp_body_op_sniper_ghillie_desert",
    "mp_body_opforce_arab_assault_a",
    "mp_body_opforce_arab_smg_a",
]
RUST_HEADS = [
    "head_allies_sniper_ghillie_desert",
    "head_allies_tf141_desert_sniper",
    "head_op_sniper_ghillie_desert",
    "head_opforce_arab_a",
    "head_opforce_arab_b",
    "head_tf141_desert_a",
    "head_tf141_desert_b",
]
# mp_rundown's militia, whose bodies and heads agree on a `_blk`/`_wht` variant
# that is the last word of both names rather than the first.
MILITIA_BODIES = ["mp_body_militia_assault_aa_blk", "mp_body_militia_assault_aa_wht", "mp_body_militia_smg_ab_blk"]
MILITIA_HEADS = ["head_militia_a_wht", "head_militia_ba_blk", "head_militia_bb_blk_hat"]

# mp_prisonbreak's own, which are one faction in five camos plus two specials.
PRISONBREAK_BODIES = [
    "mp_body_infected_a",
    "mp_body_juggernaut_light_black",
    *(f"mp_body_us_rangers_assault_a_{camo}" for camo in ("arctic", "desert", "elite", "urban", "woodland")),
]
PRISONBREAK_HEADS = ["head_juggernaut_light_black", "head_mp_head_a", "head_mp_head_ab", "head_mp_infected"]
# The Ghosts player clips the roles below reach for, out of the 222 in common_mp.ff.
PRISONBREAK_CLIPS = {
    "pb_hold_idle",
    "pb_hold_run",
    "pb_hold_run_back",
    "pb_hold_run_left",
    "pb_hold_run_right",
    "pb_stand_ads",
    "pb_sprint_assault",
    "pb_sprint_hold",
    "pb_standjump_takeoff",
    "pb_standjump_land",
    "pb_climbup",
    "pb_climbdown",
    "pt_stand_shoot_auto",
    "pt_mini_stand_shoot_auto",
    "mp_core_stand_fire_ads",
    "mp_stand_reload",
    "mp_stand_shotgun_reload",
    "mp_mantle_40_up",
    "mp_mantle_40_over",
}


def body_gltf():
    """A packed body as OAT lays it out: the joints under a `<model>_skel` node, under the unit-scale root."""
    return {
        "asset": {"version": "2.0"},
        "scenes": [{"nodes": [7]}],
        "nodes": [
            {"name": "tag_origin", "rotation": AXIS_CHANGE, "children": [1]},
            {"name": "torso_stabilizer", "translation": [0.0, 0.0, 37.0], "children": [2]},
            {"name": "j_spine4", "translation": [0.0, 0.0, 14.5], "children": [3, 5]},
            {"name": "j_neck", "translation": [0.0, 0.0, 5.0], "children": [4]},
            {"name": "j_head", "translation": [0.0, 0.0, 3.0]},
            {"name": "j_wrist_ri", "translation": [-7.6, 5.1, -6.9], "children": [6]},
            {"name": "j_gun", "translation": [0.4, 0.0, 0.0]},
            {"name": "unit-scale", "scale": [0.0254] * 3, "children": [8]},
            {"name": "body_lod0_skel", "children": [0]},
        ],
        "skins": [{"joints": [0, 1, 2, 3, 4, 5, 6]}],
        "buffers": [{"byteLength": 0}],
    }


def head_gltf():
    """A head: the body's spine-and-up joints by name, plus its own jaw and helmet."""
    return {
        "asset": {"version": "2.0"},
        "scenes": [{"nodes": [5]}],
        "nodes": [
            {"name": "j_spine4", "children": [1]},
            {"name": "j_neck", "translation": [0.0, 0.0, 5.0], "children": [2]},
            {"name": "j_head", "translation": [0.0, 0.0, 3.0], "children": [3, 4]},
            {"name": "j_jaw", "translation": [1.0, 0.0, -1.0]},
            {"name": "j_helmet", "translation": [0.0, 0.0, 2.5]},
            {"name": "head_lod0_skel", "children": [0]},
        ],
        "skins": [{"joints": [0, 1, 2, 3, 4]}],
        "buffers": [{"byteLength": 0}],
    }


def weapon_gltf():
    return {
        "asset": {"version": "2.0"},
        "scenes": [{"nodes": [3]}],
        "nodes": [
            {"name": "tag_weapon", "rotation": AXIS_CHANGE, "translation": [1.0, 2.0, 3.0], "children": [1, 2]},
            {"name": "tag_flash", "translation": [13.5, 0.0, 0.0]},
            {"name": "tag_clip", "translation": [4.0, 0.0, -1.0]},
            {"name": "weapon_lod0_skel", "children": [0]},
        ],
        "skins": [{"joints": [0, 1, 2]}],
        "buffers": [{"byteLength": 0}],
    }


def names(gltf):
    return {gltf["nodes"][j]["name"] for j in gltf["skins"][0]["joints"]}


def parent_of(gltf, name):
    i = next(k for k, n in enumerate(gltf["nodes"]) if n.get("name") == name)
    return next((n["name"] for n in gltf["nodes"] if i in n.get("children", [])), None)


# -- Choosing who to export -----------------------------------------------------------


def test_side_of_reads_the_faction_out_of_the_model_name():
    assert side_of("mp_body_delta_elite_assault_aa") == "allies"
    assert side_of("mp_body_russian_military_smg_a") == "axis"
    assert side_of("mp_body_opforce_ghillie_desert_sniper") == "axis"
    assert side_of("mp_body_something_else") is None
    # MW2's two: Task Force 141 is the allies (its sniper head is
    # `head_allies_tf141_desert_sniper`) and the Russian airborne the axis (its
    # is `head_op_airborne_sniper`). A family missing here costs a world a side.
    assert side_of("mp_body_desert_tf141_assault_a") == "allies"
    assert side_of("mp_body_airborne_assault_a") == "axis"


def test_choose_bodies_takes_one_assault_body_a_side():
    assert choose_bodies(DOME_BODIES) == [
        ("allies", "mp_body_delta_elite_assault_aa"),
        ("axis", "mp_body_russian_military_assault_a"),
    ]


def test_choose_bodies_falls_back_to_names_when_no_faction_is_recognised():
    bodies = ["mp_body_mercenary_smg_a", "mp_body_pirate_assault_a", "mp_body_pirate_lmg_a"]
    # The assault body first, then the next plainest; both named for themselves.
    assert choose_bodies(bodies) == [
        ("pirate_assault_a", "mp_body_pirate_assault_a"),
        ("mercenary_smg_a", "mp_body_mercenary_smg_a"),
    ]


def test_head_for_pairs_by_the_longest_shared_name():
    assert head_for("mp_body_delta_elite_assault_aa", DOME_HEADS) == "head_delta_elite_a"
    assert head_for("mp_body_russian_military_assault_a", DOME_HEADS) == "head_russian_military_aa"
    assert head_for("mp_body_nobody_at_all", []) is None


def test_head_for_reads_mw2s_spellings_of_the_same_family():
    # The family the other way round, and a head that shares no leading word with
    # its body at all. The `_b` head shares one word fewer.
    assert head_for("mp_body_desert_tf141_assault_a", RUST_HEADS) == "head_tf141_desert_a"
    # `ally` on the body, `allies` on its head. `head_op_sniper_ghillie_desert`
    # shares three words with it and is the other side's.
    assert head_for("mp_body_ally_sniper_ghillie_desert", RUST_HEADS) == "head_allies_sniper_ghillie_desert"
    assert head_for("mp_body_op_sniper_ghillie_desert", RUST_HEADS) == "head_op_sniper_ghillie_desert"
    # A variant both names carry last: a `_blk` body wears a `_blk` head, and the
    # one `_wht` head is the `_wht` body's.
    assert head_for("mp_body_militia_assault_aa_blk", MILITIA_HEADS) == "head_militia_ba_blk"
    assert head_for("mp_body_militia_assault_aa_wht", MILITIA_HEADS) == "head_militia_a_wht"
    assert unclaimed_heads(MILITIA_BODIES, MILITIA_HEADS) == []


def test_pick_dresses_both_sides_of_an_mw2_zone():
    assert pick("iw4", RUST_BODIES, RUST_HEADS, {}) == [
        ("allies", "mp_body_desert_tf141_assault_a", "head_tf141_desert_a"),
        ("axis", "mp_body_opforce_arab_assault_a", "head_opforce_arab_a"),
    ]


def test_pick_refuses_a_body_it_cannot_find_a_head_for():
    # Dropping it instead ships a world one side short, and it renders perfectly.
    with pytest.raises(ValueError, match="is .*'s"):
        pick("iw4", ["mp_body_delta_elite_assault_aa"], ["head_russian_military_aa"], {})


def test_a_ghosts_body_with_no_namesake_head_wears_a_spare():
    # Ghosts names no head after a ranger, so the rangers wear an interchangeable
    # `head_mp_head_*` while the juggernaut's own head is left to the juggernaut.
    spares = unclaimed_heads(PRISONBREAK_BODIES, PRISONBREAK_HEADS)
    assert spares == ["head_mp_head_a", "head_mp_head_ab", "head_mp_infected"]
    assert head_for("mp_body_us_rangers_assault_a_woodland", PRISONBREAK_HEADS, spares) == "head_mp_head_a"
    assert head_for("mp_body_juggernaut_light_black", PRISONBREAK_HEADS, spares) == "head_juggernaut_light_black"
    # MW2 and MW3 name a head after its body, so `pick` offers no spares there:
    # a head matching nothing is a head this body should not wear.
    assert head_for("mp_body_us_rangers_assault_a_woodland", PRISONBREAK_HEADS) is None


def test_pick_uses_the_override_and_refuses_a_body_the_zone_lacks():
    assert pick("iw5", DOME_BODIES, DOME_HEADS, {"bodies": ["mp_body_delta_elite_lmg_a"]}) == [
        ("allies", "mp_body_delta_elite_lmg_a", "head_delta_elite_a")
    ]
    named = {"bodies": ["mp_body_delta_elite_lmg_a"], "heads": ["head_russian_military_f"]}
    assert pick("iw5", DOME_BODIES, DOME_HEADS, named) == [("allies", "mp_body_delta_elite_lmg_a", "head_russian_military_f")]
    with pytest.raises(ValueError, match="is not one of this zone's"):
        pick("iw5", DOME_BODIES, DOME_HEADS, {"bodies": ["mp_body_not_in_this_zone"]})
    with pytest.raises(ValueError, match="heads for"):
        pick("iw5", DOME_BODIES, DOME_HEADS, {"bodies": DOME_BODIES[:2], "heads": ["head_delta_elite_a"]})


def test_clip_names_prefers_the_anim_types_own_variant_and_falls_back():
    available = {"pb_stand_alert", "pb_sprint", "pb_sprint_assault", "pb_combatrun_forward_loop"}
    roles = clip_names("iw5", {"playerAnimType": "autorifle"}, available)
    assert roles["sprint"] == "pb_sprint_assault"  # the variant exists
    assert roles["idle"] == "pb_stand_alert"  # it does not, so the base clip stands
    assert "reload" not in roles  # the zone has no clip for it at all
    # An animation type with no suffix of its own still gets the base set.
    assert clip_names("iw5", {"playerAnimType": "brand_new_thing"}, available)["sprint"] == "pb_sprint"


def test_clip_names_reads_each_games_own_names():
    # The same role, the same weapon class, two games that spell every clip differently.
    ghosts = clip_names("iw6", {"playerAnimType": "autorifle"}, PRISONBREAK_CLIPS)
    assert ghosts["idle"] == "pb_hold_idle"
    assert ghosts["runForward"] == "pb_hold_run"
    assert ghosts["sprint"] == "pb_sprint_assault"
    # Read with MW3's names the same zone has no idle, no run and no reload,
    # which is a body standing in its bind pose rather than a plausible one.
    assert "idle" not in clip_names("iw5", {"playerAnimType": "autorifle"}, PRISONBREAK_CLIPS)
    # A game with no table of its own ships no characters rather than MW3's clips.
    assert clip_names("t6", {"playerAnimType": "autorifle"}, PRISONBREAK_CLIPS) == {}


# The AW player clips the roles reach for, out of common_mp.ff's 4,489.
AW_CLIPS = PRISONBREAK_CLIPS - {"pb_stand_ads", "mp_core_stand_fire_ads"} | {
    "mp_stand_idle",
    "mp_stand_ads_aim_5",
    "pt_stand_shoot_auto_ads",
    "mp_run_assault_aim_5",
    "pb_combatrun_back_loop_assault",
    "pb_combatrun_left_loop_assault",
    "pb_combatrun_right_loop_assault",
    "pb_combatrun_forward_loop_smg",
    "pb_combatrun_back_loop_smg",
}


def test_advanced_warfare_keeps_ghosts_runs_with_its_own_idle_and_aim():
    aw = clip_names("s1", {"playerAnimType": "autorifle"}, AW_CLIPS)
    assert aw["idle"] == "mp_stand_idle"
    assert aw["idleAds"] == "mp_stand_ads_aim_5"
    assert aw["fireAds"] == "pt_stand_shoot_auto_ads"
    # Armed runs, not Ghosts' empty-handed `pb_hold_run`: AW's forward is its aim grid's centre.
    assert aw["runForward"] == "mp_run_assault_aim_5" and aw["runBack"] == "pb_combatrun_back_loop_assault"
    assert aw["sprint"] == "pb_sprint_assault"
    assert clip_names("s1", {"playerAnimType": "smg"}, AW_CLIPS)["runForward"] == "pb_combatrun_forward_loop_smg"
    # Ghosts reads the same names it always did.
    assert clip_names("iw6", {"playerAnimType": "autorifle"}, AW_CLIPS | PRISONBREAK_CLIPS)["idle"] == "pb_hold_idle"


def test_black_ops_reads_mws_names_with_the_class_off_weapon_class():
    # Black Ops' `playerAnimType` is `default` on every pistol, so the suffix comes
    # from `weaponClass` — and the rifle takes the bare clips.
    available = {"pb_stand_alert", "pb_stand_alert_pistol", "pb_sprint", "pb_sprint_rpg"}
    pistol = clip_names("t5", {"playerAnimType": "default", "weaponClass": "pistol"}, available)
    assert pistol["idle"] == "pb_stand_alert_pistol"
    assert clip_names("t5", {"playerAnimType": "default", "weaponClass": "rifle"}, available)["idle"] == "pb_stand_alert"
    launcher = clip_names("t5", {"playerAnimType": "default", "weaponClass": "rocketlauncher"}, available)
    assert launcher["sprint"] == "pb_sprint_rpg"


def test_a_clip_pattern_takes_the_weapon_class_where_the_game_puts_it():
    # Ghosts infixes the class in a reload and a minigun's fire, and suffixes it
    # everywhere else; a pattern with no `{}` is the suffix case.
    assert clip_names("iw6", {"playerAnimType": "other"}, PRISONBREAK_CLIPS)["reload"] == "mp_stand_shotgun_reload"
    assert clip_names("iw6", {"playerAnimType": "minigun"}, PRISONBREAK_CLIPS)["fire"] == "pt_mini_stand_shoot_auto"
    # The class's own spelling is missing, so the classless one stands.
    assert clip_names("iw6", {"playerAnimType": "autorifle"}, PRISONBREAK_CLIPS)["reload"] == "mp_stand_reload"


# -- Grafting -------------------------------------------------------------------------


def test_graft_head_adds_only_the_joints_the_body_lacks():
    body = body_gltf()
    added = graft_head(body, head_gltf())
    assert added == ["j_jaw", "j_helmet"]
    # The shared joints stay the body's own, so the head's meshes find them by name.
    assert sorted(names(body)) == [
        "j_gun",
        "j_head",
        "j_helmet",
        "j_jaw",
        "j_neck",
        "j_spine4",
        "j_wrist_ri",
        "tag_origin",
        "torso_stabilizer",
    ]
    assert parent_of(body, "j_jaw") == "j_head"
    assert parent_of(body, "j_helmet") == "j_head"


def test_graft_weapon_hangs_the_gun_off_j_gun_at_rest():
    body = body_gltf()
    assert graft_weapon(body, weapon_gltf()) == ["tag_weapon", "tag_flash", "tag_clip"]
    assert parent_of(body, "tag_weapon") == "j_gun"
    assert parent_of(body, "tag_flash") == "tag_weapon"
    # The root's own transform is OAT's axis change, which the body's root already applies.
    root = next(n for n in body["nodes"] if n["name"] == "tag_weapon")
    assert "rotation" not in root and "translation" not in root
    # The muzzle keeps its offset in the gun's own frame.
    assert next(n for n in body["nodes"] if n["name"] == "tag_flash")["translation"] == [13.5, 0.0, 0.0]


def test_graft_weapon_refuses_a_model_that_is_not_a_world_weapon():
    weapon = weapon_gltf()
    weapon["nodes"][0]["name"] = "j_gun"
    with pytest.raises(ValueError, match="expected 'tag_weapon'"):
        graft_weapon(body_gltf(), weapon)


def test_grafted_joints_join_the_skin_so_a_loader_makes_them_bones():
    body = body_gltf()
    before = len(body["skins"][0]["joints"])
    graft_head(body, head_gltf())
    graft_weapon(body, weapon_gltf())
    assert len(body["skins"][0]["joints"]) == before + 2 + 3
    assert len(set(body["skins"][0]["joints"])) == len(body["skins"][0]["joints"])


# -- The animation rig ----------------------------------------------------------------


def clip(name, bones, frames=4, asset_type=2):
    return XAnim(
        name=name,
        frames=frames,
        fps=30.0,
        looped=True,
        bones=[BoneTrack(b, Track(list(range(frames)), [[0.0, 0.0, 0.0, 1.0]] * frames), None) for b in bones],
        asset_type=asset_type,
    )


def test_build_anim_rig_is_the_union_of_every_bodys_skeleton():
    a, b = body_gltf(), body_gltf()
    graft_head(a, head_gltf())
    b["nodes"].append({"name": "j_coatfront_le", "translation": [1.0, 0.0, 0.0]})
    b["nodes"][2]["children"].append(len(b["nodes"]) - 1)
    b["skins"][0]["joints"].append(len(b["nodes"]) - 1)

    rig = build_anim_rig([skeleton_spec(a), skeleton_spec(b)])
    assert "j_helmet" in names(rig) and "j_coatfront_le" in names(rig)
    # No meshes and no unit scale: the clips' translations are the game's inches,
    # which is what the bind translations they are added to are in too.
    assert "meshes" not in rig
    assert not any(n["name"] == "unit-scale" for n in rig["nodes"])
    assert next(n for n in rig["nodes"] if n["name"] == "tag_origin")["rotation"] == AXIS_CHANGE
    # Every joint but the root has a parent inside the rig.
    parented = {c for n in rig["nodes"] for c in n.get("children", [])}
    assert len(parented) == len(rig["nodes"]) - 1


def test_write_anim_glb_writes_every_role_and_reports_a_clip_that_drives_nothing(tmp_path):
    body = body_gltf()
    graft_head(body, head_gltf())
    clips = {
        "pb_stand_alert": clip("pb_stand_alert", ["torso_stabilizer", "j_head"]),
        "pt_stand_shoot_auto": clip("pt_stand_shoot_auto", ["j_spine4"], asset_type=1),
        "pb_sprint": clip("pb_sprint", ["j_brow_le", "j_cheek_ri"]),  # face bones this rig has none of
    }
    roles = {"idle": "pb_stand_alert", "fire": "pt_stand_shoot_auto", "sprint": "pb_sprint"}
    spec = definition("iw5", "iw5_m4_mp", {"playerAnimType": "autorifle"}, roles, clips)
    out = tmp_path / "animations.glb"
    problems = write_anim_glb(str(out), [skeleton_spec(body)], clips, roles, spec)

    assert problems == ["pb_sprint drives no joint of the player skeleton"]
    gltf, _ = read_glb(str(out))
    assert sorted(a["name"] for a in gltf["animations"]) == ["pb_stand_alert", "pt_stand_shoot_auto"]
    # The clip table travels with the clips, so one file answers "what plays what".
    carried = gltf["scenes"][0]["extras"]["characters"]
    assert carried["roles"] == roles
    assert carried["torsoRoles"] == ["fire"]
    assert carried["aimJoint"] == "torso_stabilizer"
    assert carried["clips"]["pb_stand_alert"]["duration"] == pytest.approx(4 / 30)


def moving_clip(name, bone, offset, asset_type):
    """One bone keyed at `offset` inches on every frame."""
    frames = 2
    track = Track([0, 1], [list(offset)] * frames)
    return XAnim(name=name, frames=frames, fps=30.0, looped=False, bones=[BoneTrack(bone, None, track)], asset_type=asset_type)


def _translations(path):
    from scripts.cod.gltf import read_accessor

    gltf, buf = read_glb(path)
    out = {}
    for anim in gltf["animations"]:
        for channel in anim["channels"]:
            if channel["target"]["path"] == "translation":
                sampler = anim["samplers"][channel["sampler"]]
                out[anim["name"]] = [round(v, 4) for v in read_accessor(gltf, buf, sampler["output"])[0]]
    return out


def test_every_other_game_writes_its_clips_as_it_did(tmp_path):
    # Without `absolute_bones` the asset type decides, byte for byte as before: MW's torso
    # clips (type 1) key the translation itself, its body clips (type 2) an offset on the bind.
    body = body_gltf()
    clips = {
        "pt_stand_shoot_auto": moving_clip("pt_stand_shoot_auto", "j_neck", (1.0, 0.0, 0.0), 1),
        "pb_stand_alert": moving_clip("pb_stand_alert", "j_neck", (1.0, 0.0, 0.0), 2),
    }
    roles = {"idle": "pb_stand_alert", "fire": "pt_stand_shoot_auto"}
    spec = definition("iw5", "iw5_m4_mp", {"playerAnimType": "autorifle"}, roles, clips)
    before, after = tmp_path / "before.glb", tmp_path / "after.glb"
    write_anim_glb(str(before), [skeleton_spec(body)], clips, roles, spec)
    write_anim_glb(str(after), [skeleton_spec(body)], clips, roles, spec, absolute_bones=None)
    assert before.read_bytes() == after.read_bytes()
    # j_neck's bind is 5 in up its parent.
    assert _translations(str(before)) == {"pt_stand_shoot_auto": [1.0, 0.0, 0.0], "pb_stand_alert": [1.0, 0.0, 5.0]}


def test_an_aw_body_reads_every_translation_as_an_offset(tmp_path):
    # AW's type-1 body clips key j_neck at ~0 and mean "at the bind": read as absolute, the
    # head sinks into the chest (reverse/s1-zone/README.md#the-animations).
    body = body_gltf()
    clips = {"mp_stand_reload": moving_clip("mp_stand_reload", "j_neck", (0.0, 0.0, 0.0), 1)}
    roles = {"reload": "mp_stand_reload"}
    spec = definition("s1", "iw5_bal27_mp", {"playerAnimType": "autorifle"}, roles, clips)
    out = tmp_path / "aw.glb"
    assert write_anim_glb(str(out), [skeleton_spec(body)], clips, roles, spec, absolute_bones=set()) == []
    assert _translations(str(out)) == {"mp_stand_reload": [0.0, 0.0, 5.0]}
    # An additive clip cannot be baked, and is refused rather than written as a pose.
    clips["mp_hold_stand_aim_1"] = moving_clip("mp_hold_stand_aim_1", "j_neck", (0.0, 0.0, 0.0), 6)
    with pytest.raises(ValueError, match="additive"):
        write_anim_glb(str(out), [skeleton_spec(body)], clips, {"aim": "mp_hold_stand_aim_1"}, spec, absolute_bones=set())
