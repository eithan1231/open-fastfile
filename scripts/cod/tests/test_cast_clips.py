"""The clip set a game's bodies play, built into the catalogue from a companion dump.

What is worth pinning is what fails plausibly: a stance role the engine poses
with that no game's table names, a role the engine holds at one frame shipped as
twenty seconds of fidgets, and a set that lacks a joint one of the game's bodies
has, which leaves that body's bone where its bind pose put it.
"""

import json

from scripts.cod import cast_clips
from scripts.cod.characters import (
    CLIP_ROLES_BY_GAME,
    HELD_ROLES,
    IW6_CLIP_ROLES,
    IW_CLIP_ROLES,
    TORSO_ROLES,
    clip_names,
    held,
    load_clips,
)
from scripts.cod.gltf import read_glb, write_glb
from scripts.cod.tests.test_characters import body_gltf, clip
from scripts.cod.xanim import BoneTrack, Track, XAnim

# The roles the engine poses a crouched and a lying body from (sim/characterDef.ts), in its order.
STANCE_ROLES = [
    *(f"crouch{way}" for way in ("Idle", "IdleAds", "Forward", "Back", "Left", "Right")),
    *(f"prone{way}" for way in ("Idle", "IdleAds", "Forward", "Back", "Left", "Right")),
    "standToCrouch",
    "crouchToStand",
    "crouchToProne",
    "proneToCrouch",
    "crouchFire",
    "crouchFireAds",
    "crouchReload",
    "proneFire",
    "proneFireAds",
    "proneReload",
]


def test_every_stance_role_is_a_clip_of_some_game_and_no_table_names_another():
    assert set(STANCE_ROLES) <= set(IW_CLIP_ROLES)
    # Ghosts and AW have no prone ADS idle or fire, and the engine falls back to the hip clip.
    assert set(STANCE_ROLES) - set(IW6_CLIP_ROLES) == {"proneIdleAds", "proneFireAds"}
    standing = set(IW_CLIP_ROLES) - set(STANCE_ROLES)
    for game, table in CLIP_ROLES_BY_GAME.items():
        assert set(table) <= standing | set(STANCE_ROLES), game
    # An overlay is a torso role, or the engine plays it as a pair of legs.
    overlays = {r for r in STANCE_ROLES if r.endswith(("Fire", "FireAds", "Reload"))}
    assert overlays <= set(TORSO_ROLES) and not (set(TORSO_ROLES) & set(HELD_ROLES))


def test_clip_names_reads_each_familys_stance_names():
    mw = {
        "pb_crouch_alert",
        "pb_crouch_run_left",
        "pb_prone_crawl_back",
        "pb_crouch2prone",
        "pt_reload_prone_auto",
        "pb_prone_aim",
    }
    roles = clip_names("iw5", {"playerAnimType": "autorifle"}, mw)
    assert roles == {
        "crouchIdle": "pb_crouch_alert",
        "crouchLeft": "pb_crouch_run_left",
        "proneIdle": "pb_prone_aim",
        "proneBack": "pb_prone_crawl_back",
        "crouchToProne": "pb_crouch2prone",
        "proneReload": "pt_reload_prone_auto",
    }
    # Black Ops has the two MW lacks, under the same table.
    bo = clip_names("t5", {"weaponClass": "rifle"}, {"pb_rifle_stand2crouch", "pb_prone_aim_ads", "pt_prone_ads_shoot_auto"})
    assert bo == {
        "standToCrouch": "pb_rifle_stand2crouch",
        "proneIdleAds": "pb_prone_aim_ads",
        "proneFireAds": "pt_prone_ads_shoot_auto",
    }
    ghosts = {
        "mp_crouch_idle",
        "mp_crouch_f",
        "mp_stand_2_crouch",
        "mp_crouch_reload",
        "mp_prone_reload_iw6",
        "pb_prone_crawl",
        "pb_crouch_alert",
    }
    for game in ("iw6", "s1"):
        roles = clip_names(game, {"playerAnimType": "autorifle"}, ghosts)
        assert roles == {
            "crouchIdle": "mp_crouch_idle",
            "crouchForward": "mp_crouch_f",
            "proneForward": "pb_prone_crawl",
            "standToCrouch": "mp_stand_2_crouch",
            "crouchReload": "mp_crouch_reload",
            "proneReload": "mp_prone_reload_iw6",
        }


def fidget(name):
    """A long idle: two bones keyed over 600 frames, one from a frame after the first, with a note and root motion."""
    frames = 600
    turned = Track([0, 300, frames], [[0.0, 0.0, 0.0, 1.0], [0.0, 0.0, 1.0, 0.0], [0.0, 0.0, 0.0, 1.0]])
    late = Track([40, 90], [[1.0, 2.0, 3.0], [4.0, 5.0, 6.0]])
    return XAnim(
        name=name,
        frames=frames,
        fps=30.0,
        looped=True,
        bones=[BoneTrack("j_head", turned, None), BoneTrack("j_neck", None, late)],
        has_root_motion=True,
        delta_translation=Track([0, frames], [[0.0, 0.0, 0.0], [9.0, 0.0, 0.0]]),
        notetracks=[("breath", 120)],
    )


def test_held_keeps_the_first_frame_and_nothing_after_it():
    still = held(fidget("pb_crouch_alert"))
    assert (still.frames, still.looped, still.notetracks, still.has_root_motion) == (1, False, [], False)
    assert still.duration == 1 / 30
    head, neck = still.bones
    assert (head.rotation.indices, head.rotation.values) == ([0], [[0.0, 0.0, 0.0, 1.0]])
    # A track whose first key is late holds that key from the start, which is what frame 0 showed.
    assert (neck.translation.indices, neck.translation.values) == ([0], [[1.0, 2.0, 3.0]])
    assert head.translation is None and still.delta_translation is None


def test_load_clips_holds_an_idle_and_plays_everything_else_whole(tmp_path, monkeypatch):
    monkeypatch.setattr("scripts.cod.characters.read_bytes", lambda path: b"")
    monkeypatch.setattr("scripts.cod.characters.decode", lambda data, name: fidget(name))
    roles = {
        "idle": "pb_stand_alert",
        "crouchIdle": "pb_crouch_alert",
        "crouchForward": "pb_crouch_run_forward",
        "proneIdle": "pb_shared",
    }
    clips = load_clips(str(tmp_path), {**roles, "proneForward": "pb_shared"})
    assert {name: c.frames for name, c in clips.items()} == {
        "pb_stand_alert": 1,
        "pb_crouch_alert": 1,
        "pb_crouch_run_forward": 600,
        # Named by a role that plays through it too, so it is kept whole.
        "pb_shared": 600,
    }
    assert set(HELD_ROLES) == {"idle", "idleAds", "crouchIdle", "crouchIdleAds", "proneIdle", "proneIdleAds"}


def catalogue_body(root, game, ident, extra_joint=None, anim_type="autorifle"):
    """One body entry in a catalogue under `root`, optionally with a joint of its own under the head."""
    gltf = body_gltf()
    if extra_joint:
        gltf["nodes"].append({"name": extra_joint, "translation": [1.0, 0.0, 0.0]})
        gltf["nodes"][4]["children"] = [len(gltf["nodes"]) - 1]
        gltf["skins"][0]["joints"].append(len(gltf["nodes"]) - 1)
    out = root / "catalog" / "characters" / game / ident
    out.mkdir(parents=True)
    write_glb(str(out / f"{ident}.glb"), gltf, bytearray())
    (out / f"{ident}.json").write_text(json.dumps({"id": ident, "game": game, "body": f"{ident}.glb", "animType": anim_type}))


def dump(tmp_path, weapon, clips):
    """A companion dump holding `weapon`'s file and one (empty) file a clip name."""
    work = tmp_path / "work"
    (work / "weapons" / "weapons").mkdir(parents=True)
    (work / "weapons" / "weapons" / weapon).write_text("WEAPONFILE\\playerAnimType\\autorifle\\worldModel\\weapon_m4")
    (work / "view_anim" / "xanim").mkdir(parents=True)
    for name in clips:
        (work / "view_anim" / "xanim" / name).write_bytes(b"")
    return work


def test_build_writes_one_set_over_every_body_of_the_game(tmp_path, monkeypatch):
    monkeypatch.setattr(
        "scripts.cod.characters.decode", lambda data, name: clip(name, ["torso_stabilizer", "j_head", "j_gasmask"])
    )
    catalogue_body(tmp_path, "iw5", "mp_body_a")
    catalogue_body(tmp_path, "iw5", "mp_body_b", extra_joint="j_gasmask")
    catalogue_body(tmp_path, "iw4", "mp_body_other_game", extra_joint="j_not_this_games")
    names = ["pb_stand_alert", "pb_crouch_alert", "pb_crouch_run_forward_assault", "pb_crouch_run_forward", "pt_prone_shoot_auto"]
    work = dump(tmp_path, "iw5_m4_mp", names)

    assert cast_clips.build(str(work), str(tmp_path), "iw5") == []
    out = tmp_path / "catalog" / "animations" / "iw5" / "autorifle"
    entry = json.loads((out / "autorifle.json").read_text())
    # The class's own spelling first, as every other role is picked.
    assert entry["roles"] == {
        "idle": "pb_stand_alert",
        "crouchIdle": "pb_crouch_alert",
        "crouchForward": "pb_crouch_run_forward_assault",
        "proneFire": "pt_prone_shoot_auto",
    }
    assert entry["torsoRoles"] == ["proneFire"]
    assert (entry["id"], entry["game"], entry["clips"], entry["joints"]) == ("autorifle", "iw5", "animations.glb", 8)
    gltf, _ = read_glb(str(out / "animations.glb"))
    # The union of the game's bodies: the one joint only the second has, and none of another game's.
    joints = {n["name"] for n in gltf["nodes"]}
    assert "j_gasmask" in joints and "j_not_this_games" not in joints
    carried = gltf["scenes"][0]["extras"]["characters"]
    assert (carried["roles"], carried["weapon"], carried["game"]) == (entry["roles"], "iw5_m4_mp", "iw5")
    # The table both ends read says how long each clip is: an idle is the one frame it is held at.
    assert carried["clips"]["pb_crouch_alert"]["duration"] == 1 / 30
    assert carried["clips"]["pb_crouch_run_forward_assault"]["duration"] == 4 / 30


def test_build_leaves_a_game_with_no_bodies_alone_and_says_what_a_dump_lacks(tmp_path, monkeypatch):
    monkeypatch.setattr("scripts.cod.characters.decode", lambda data, name: clip(name, ["j_head"]))
    work = dump(tmp_path, "iw5_m4_mp", ["pb_stand_alert"])
    # No body of the game in the catalogue, and a game no body is rigged for: nothing to build.
    assert cast_clips.build(str(work), str(tmp_path), "iw5") == []
    assert cast_clips.build(str(work), str(tmp_path), "t6") == []
    assert not (tmp_path / "catalog" / "animations").exists()

    catalogue_body(tmp_path, "iw5", "mp_body_a", anim_type="smg")
    (problem,) = cast_clips.build(str(tmp_path / "nowhere"), str(tmp_path), "iw5")
    assert "iw5_m4_mp" in problem
    # A body that names another set than the one its game's weapon builds is said, not guessed at.
    (problem,) = cast_clips.build(str(work), str(tmp_path), "iw5")
    assert "smg" in problem and "autorifle" in problem
    # And a dump with no idle clip builds nothing rather than a set the engine refuses.
    (work / "view_anim" / "xanim" / "pb_stand_alert").unlink()
    (problem,) = cast_clips.build(str(work), str(tmp_path), "iw5")
    assert "idle" in problem
