"""Third-person player characters: the map's own MP bodies, wearing a head and
holding the weapon the viewmodel stage chose, and the game's player clips.

A CoD multiplayer character is three xmodels. `mp_body_*` carries the skeleton
and everything from the neck down; `head_*` is a second skinned model whose
joints are a subtree of the body's (plus a few of its own — a jaw, eyeballs, a
helmet); the weapon's `worldModel` hangs off the body's `j_gun`. So the body GLB
is the one that carries the skeleton — the head's extra joints and the weapon's
whole joint tree are grafted into it here — and the head and weapon are packed on
their own and rebound to it by joint name at run time
(src/scene/character.ts). The same shape as the viewmodel's gun and hands
(viewmodel.py), for the same reason: several heads share one body.

The clips are not a map's. Every player clip lives in `common_mp.ff`, one set for
every character in the game, so they are written once into `animations.glb` — a
skeleton with no meshes — and played on any body whose joints have those names.
What each of them is called is the game's own business, which is why the role
table below is per game; cast_clips.py is what builds the set, into the catalogue.
The data: docs/cod/reference.md#characters.
"""

import dataclasses
import json
import os

from . import cac
from .animations import TRANSLATION_BY_ASSET_TYPE, clip_to_gltf
from .files import read_bytes, read_json, write_text
from .gltf import joint_subtree, read_glb, skin_roots, write_glb
from .pack import pack_one
from .textures import texture_index
from .xanim import BoneTrack, Track, decode

OUT_DIR = "characters"  # under the world's assets/
# Seen across a map rather than at arm's length, so a prop's 512 px rather than the viewmodel's 1024.
BODY_TEXTURE_SIZE = 512
FORMAT_VERSION = 1  # of the `characters` scene extras, read by src/scene/character.ts

# Where a weapon hangs on the body, and what the world model's own root joint is
# called. `j_gun` and `tag_weapon_right` sit at the same place under `j_wrist_ri`;
# the clips key `j_gun`, so that is the one that carries the gun.
GUN_JOINT = "j_gun"
# Black Ops' bodies have no `j_gun`, and its clips key `tag_weapon_right` instead.
# Advanced Warfare's bodies have both, and its idle, runs and fire key only the tag.
GUN_JOINT_BY_GAME = {"t5": "tag_weapon_right", "s1": "tag_weapon_right"}
WEAPON_ROOT = "tag_weapon"
# The joint the engine turns for aim pitch; CoD has no aim-up/down player clips
# it plays. Named here so an export reports a body that cannot be aimed rather
# than shipping one that silently never looks up or down.
AIM_JOINT = "torso_stabilizer"

# The clip each role plays, in the order they are tried. A name is a pattern:
# `{}` is where `_<weapon class>` goes, and a name with no `{}` takes it on the
# end, so `pb_sprint` is tried as `pb_sprint_smg` and then bare. The class comes
# from the weapon file's `playerAnimType` through ANIM_TYPE_SUFFIX_BY_GAME; a
# role whose every spelling is missing from the zone is dropped. `pb_` clips are
# the whole body; `pt_` clips key the spine up and are layered over them
# additively (src/engine/characterAnimator.ts).
#
# MW2 and MW3 share one set of names.
IW_CLIP_ROLES = {
    "idle": ("pb_stand_alert",),
    "idleAds": ("pb_stand_ads",),
    "runForward": ("pb_combatrun_forward_loop",),
    "runBack": ("pb_combatrun_back_loop",),
    "runLeft": ("pb_combatrun_left_loop",),
    "runRight": ("pb_combatrun_right_loop",),
    "sprint": ("pb_sprint",),
    "jump": ("pb_standjump_takeoff",),
    "land": ("pb_standjump_land",),
    "fire": ("pt_stand_shoot_auto",),
    "fireAds": ("pt_stand_shoot_auto_ads",),
    "reload": ("pt_reload_stand_rifle",),
    # Mantling. One clip per kind, not the games' height-indexed set
    # (`mp_mantle_up_21` .. `_57`, named in inches): the engine stretches a clip
    # to the state it is playing, as the viewmodel already does, and seven more
    # would add ~770 KB to every world's animations.glb for a 0.4 s animation on
    # someone else's body. Whole-body clips, so NOT torso roles.
    "mantle": ("mp_mantle_up_39",),
    "mantleOver": ("mp_mantle_over_mid",),
    # Ladders. Whole-body loops, NOT torso roles: the weapon is holstered on a
    # ladder, so nothing layers over them. Their root motion is a fixed rise per
    # cycle, which is what lets the engine scrub them by height.
    "climbUp": ("pb_climbup",),
    "climbDown": ("pb_climbdown",),
    # Crouched and prone. MW2 and MW3 ship no stand <-> crouch clip and no prone
    # ADS idle or fire, and those roles are dropped there; Black Ops ships them all.
    "crouchIdle": ("pb_crouch_alert",),
    "crouchIdleAds": ("pb_crouch_ads",),
    "crouchForward": ("pb_crouch_run_forward",),
    "crouchBack": ("pb_crouch_run_back",),
    "crouchLeft": ("pb_crouch_run_left",),
    "crouchRight": ("pb_crouch_run_right",),
    "proneIdle": ("pb_prone_aim",),
    "proneIdleAds": ("pb_prone_aim_ads",),
    "proneForward": ("pb_prone_crawl",),
    "proneBack": ("pb_prone_crawl_back",),
    "proneLeft": ("pb_prone_crawl_left",),
    "proneRight": ("pb_prone_crawl_right",),
    "standToCrouch": ("pb_rifle_stand2crouch",),
    "crouchToStand": ("pb_rifle_crouch2stand",),
    "crouchToProne": ("pb_crouch2prone",),
    "proneToCrouch": ("pb_prone2crouch",),
    "crouchFire": ("pt_crouch_shoot_auto",),
    "crouchFireAds": ("pt_crouch_shoot_auto_ads",),
    "crouchReload": ("pt_reload_crouch_rifle",),
    "proneFire": ("pt_prone_shoot_auto",),
    "proneFireAds": ("pt_prone_ads_shoot_auto",),
    "proneReload": ("pt_reload_prone_auto",),
}
# Ghosts renames most of the set and spells its torso clips `mp_` rather than
# `pt_`; the ones it keeps (`pb_stand_ads`, the jumps, the climbs,
# `pt_stand_shoot_auto`) are the same clips. Two readings are worth knowing:
#
#  - The four-way run is `pb_hold_run{,_back,_left,_right}` and not the
#    per-class `pb_combatrun_*_<class>` set, which has no `_assault` forward
#    clip at all. One stride clock drives all four (rendering.md#player-characters),
#    so they have to come from one family or a strafe's feet slide against a run's.
#  - Mantling is `mp_mantle_<inches>_{up,over}`, 16 to 64. 40 is the one whose
#    height matches MW3's `mp_mantle_up_39`, and the engine stretches it anyway.
IW6_CLIP_ROLES = {
    "idle": ("pb_hold_idle",),
    "idleAds": ("pb_stand_ads",),
    "runForward": ("pb_hold_run",),
    "runBack": ("pb_hold_run_back",),
    "runLeft": ("pb_hold_run_left",),
    "runRight": ("pb_hold_run_right",),
    "sprint": ("pb_sprint", "pb_sprint_hold"),
    "jump": ("pb_standjump_takeoff",),
    "land": ("pb_standjump_land",),
    "fire": ("pt{}_stand_shoot_auto",),
    "fireAds": ("mp_core_stand_fire_ads",),
    "reload": ("mp_stand{}_reload",),
    "mantle": ("mp_mantle_40_up",),
    "mantleOver": ("mp_mantle_40_over",),
    "climbUp": ("pb_climbup",),
    "climbDown": ("pb_climbdown",),
    # Ghosts keeps MW's crawl and its hip fire, and renames the rest. It has no
    # prone ADS idle or fire, and its prone reload keys the whole body.
    "crouchIdle": ("mp_crouch_idle",),
    "crouchIdleAds": ("mp_crouch_idle_ads",),
    "crouchForward": ("mp_crouch_f",),
    "crouchBack": ("mp_crouch_b",),
    "crouchLeft": ("mp_crouch_l",),
    "crouchRight": ("mp_crouch_r",),
    "proneIdle": ("mp_prone_idle_iw6",),
    "proneForward": ("pb_prone_crawl",),
    "proneBack": ("pb_prone_crawl_back",),
    "proneLeft": ("pb_prone_crawl_left",),
    "proneRight": ("pb_prone_crawl_right",),
    "standToCrouch": ("mp_stand_2_crouch",),
    "crouchToStand": ("mp_crouch_2_stand",),
    "crouchToProne": ("mp_crouch_2_prone",),
    "proneToCrouch": ("mp_prone_2_crouch",),
    "crouchFire": ("pt_crouch_shoot_auto",),
    "crouchFireAds": ("pt_crouch_shoot_ads",),
    "crouchReload": ("mp_crouch{}_reload",),
    "proneFire": ("pt_prone_shoot_auto",),
    "proneReload": ("mp_prone_reload_iw6",),
}
# Advanced Warfare keeps Ghosts' sprint, jump, mantle and climb clips. Its `pb_hold_*`
# idle and runs are empty-handed (they key no gun joint), so the armed set is its own:
# `mp_stand_idle`, the aim grid's centre run `mp_run_assault_aim_5` forward, and the
# per-class `pb_combatrun_*` the other three ways, which AW does ship for `_assault`.
S1_CLIP_ROLES = {
    **IW6_CLIP_ROLES,
    "idle": ("mp_stand_idle",),
    "idleAds": ("mp_stand_ads_aim_5",),
    "runForward": ("mp_run{}_aim_5", "pb_combatrun_forward_loop"),
    "runBack": ("pb_combatrun_back_loop",),
    "runLeft": ("pb_combatrun_left_loop",),
    "runRight": ("pb_combatrun_right_loop",),
    "fireAds": ("pt_stand_shoot_auto_ads",),
}
# Black Ops ships every one of MW's names in its own common_mp.ff.
CLIP_ROLES_BY_GAME = {"iw4": IW_CLIP_ROLES, "iw5": IW_CLIP_ROLES, "iw6": IW6_CLIP_ROLES, "t5": IW_CLIP_ROLES, "s1": S1_CLIP_ROLES}
# Roles whose clip is laid over a `pb_` one, replacing the bones it keys: the spine
# and above, or the whole body for Ghosts' and AW's prone reload.
TORSO_ROLES = (
    "fire",
    "fireAds",
    "reload",
    "crouchFire",
    "crouchFireAds",
    "crouchReload",
    "proneFire",
    "proneFireAds",
    "proneReload",
)
# Roles the engine holds at their first frame: a body at rest is posed from its
# state and no clock, so the 8 to 20 s of fidgets after that frame are never
# read, and are not written.
HELD_ROLES = ("idle", "idleAds", "crouchIdle", "crouchIdleAds", "proneIdle", "proneIdleAds")
# A weapon file's `playerAnimType` -> the class its clips are named for, where
# they exist. Per game because the two enums are not the same list: Ghosts types
# its machine guns `autorifle` and its shotguns `other`, adds a bullpup spelling
# of three classes and a minigun, and drops MW's `rifle`.
IW_ANIM_TYPE_SUFFIX = {
    "autorifle": "assault",
    "rifle": "assault",
    "smg": "smg",
    "mg": "lmg",
    "lmg": "lmg",
    "shotgun": "shotgun",
    "sniper": "sniper",
    "pistol": "pistol",
    "rpg": "rpg",
}
IW6_ANIM_TYPE_SUFFIX = {
    "autorifle": "assault",
    "autorifle_bullpup": "assault",
    "smg": "smg",
    "smg_bullpup": "smg",
    "sniper": "sniper",
    "sniper_bullpup": "sniper",
    # The four Ghosts shotguns are the only weapons typed `other`.
    "other": "shotgun",
    "minigun": "mini",
    "pistol": "pistol",
    "rocketlauncher": "rpg",
    "riotshield": "shield",
    "hold": "hold",
}
# Black Ops' `playerAnimType` describes the reload, not the class (every pistol and
# launcher is `default`), so its clips' `_pistol`/`_rpg` suffix is read off
# `weaponClass` instead.
T5_ANIM_TYPE_SUFFIX = {"pistol": "pistol", "rocketlauncher": "rpg"}
# The three classes AW names clips for (`pb_sprint_assault`, `_smg`, `_sniper`).
S1_ANIM_TYPE_SUFFIX = {"autorifle": "assault", "smg": "smg", "sniper": "sniper"}
ANIM_TYPE_SUFFIX_BY_GAME = {
    "iw4": IW_ANIM_TYPE_SUFFIX,
    "iw5": IW_ANIM_TYPE_SUFFIX,
    "iw6": IW6_ANIM_TYPE_SUFFIX,
    "t5": T5_ANIM_TYPE_SUFFIX,
    "s1": S1_ANIM_TYPE_SUFFIX,
}
ANIM_TYPE_FIELD_BY_GAME = {"t5": "weaponClass"}

# Which side a body belongs to, by the first marker found in its name. MW3's MP
# bodies are named for their faction, not their team, so this is the lookup the
# game's own script does; an unrecognised family is reported and ordered by name.
# A family missing here costs a world that side's character silently, so both
# lists are the ones the games' own head names confirm: MW2 spells its allied
# families out as `head_allies_tf141_*`, `head_allies_us_army_*`,
# `head_allies_seal_udt_*`, and puts `op_` on the other side's
# (`head_op_airborne_sniper` beside `mp_body_airborne_assault_a`).
SIDES = {
    "allies": ("ally", "delta", "sas", "gign", "seal", "us_army", "usarmy", "fso", "tf141"),
    "axis": ("opforce", "russian", "spetsnaz", "militia", "africa", "pmc", "inner", "airborne"),
}
# Preferred role for the body that stands in for a side: the M4 is an assault rifle.
ROLE_ORDER = ("assault", "smg", "lmg", "shotgun", "riot", "sniper")
BODY_PREFIX = "mp_body_"
HEAD_PREFIX = "head_"
# Whether a head's name says which body wears it. MW2 and MW3 spell it out
# (`head_delta_elite_a` for `mp_body_delta_elite_assault_aa`), so there a head
# that matches no body is one no body should wear. Ghosts does not: its rangers
# wear any of the zone's interchangeable `head_mp_head_*`, and only the
# juggernaut's and the infected's heads are a body's own.
HEADS_ARE_A_BODYS_BY_GAME = {"iw4": True, "iw5": True, "iw6": False}
# The one word a body and its head disagree on: MW2 writes the allied faction
# `ally` on a body and `allies` on that body's head
# (`mp_body_ally_sniper_ghillie_desert`, `head_allies_sniper_ghillie_desert`).
SPELLINGS = {"ally": "allies"}


def _words(name):
    """`name`'s underscore-separated words, the spellings above reconciled."""
    return [SPELLINGS.get(w, w) for w in name.split("_")]


def _shared_prefix(a, b):
    """How many leading words `a` and `b` share."""
    x, y = _words(a), _words(b)
    n = 0
    while n < len(x) and n < len(y) and x[n] == y[n]:
        n += 1
    return n


def models_of_type(xmodel_dir, prefix, kind="animated"):
    """Names of every dumped xmodel starting `prefix` whose JSON says `"type": kind`."""
    out = []
    if not os.path.isdir(xmodel_dir):
        return out
    for f in sorted(os.listdir(xmodel_dir)):
        if f.startswith(prefix) and f.endswith(".json"):
            try:
                if read_json(os.path.join(xmodel_dir, f)).get("type") == kind:
                    out.append(f[:-5])
            except ValueError:
                continue
    return out


def side_of(body):
    """ "allies", "axis", or None for a body whose faction is not in SIDES."""
    if cac.side_of(body):
        return cac.side_of(body)
    name = body.removeprefix(BODY_PREFIX)
    for side, markers in SIDES.items():
        if any(m in name for m in markers):
            return side
    return None


def _role_rank(body):
    name = body.removeprefix(BODY_PREFIX)
    return next((i for i, role in enumerate(ROLE_ORDER) if role in name), len(ROLE_ORDER))


def choose_bodies(bodies):
    """One body per side, the plainest role each. Returns [(side, body)], allies first."""
    out = []
    for side in SIDES:
        mine = [b for b in bodies if side_of(b) == side]
        if mine:
            out.append((side, min(mine, key=lambda b: (_role_rank(b), b))))
    if out:
        return out
    # No name says which faction it is: take the two plainest bodies and call them by name.
    return [(b.removeprefix(BODY_PREFIX), b) for b in sorted(bodies, key=lambda b: (_role_rank(b), b))[:2]]


def head_for(body, heads, spares=None):
    """The head named after `body`, else the plainest of `spares`, else None.

    `spares` are the heads no body claims by name. `pick` passes them only for a
    game whose heads are not named after bodies (HEADS_ARE_A_BODYS_BY_GAME) and
    None otherwise, because where a game does name them, a head matching no body
    is a head no body should wear.
    """
    mine = [h for h in heads if _is_a_bodys_head(body, h)]
    best = max(mine, key=lambda h: _tokens_shared(body, h), default=None)
    if best is not None:
        return best
    return sorted(spares)[0] if spares else None


def unclaimed_heads(bodies, heads):
    """The heads whose names say they belong to no body in `bodies`."""
    return [h for h in heads if not any(_is_a_bodys_head(b, h) for b in bodies)]


def _tokens_shared(body, head):
    """How much of its name a body and a head have in common: (words, leading words).

    Words, not just a leading run, because MW2 writes the family either way round
    — `mp_body_desert_tf141_assault_a` wears `head_tf141_desert_a` — and the
    variant the two agree on can come last: the militia's `_blk` and `_wht`
    bodies have `_blk` and `_wht` heads, and a body in one wearing the other's is
    a body whose face does not match its arms. The leading count only breaks a
    tie, which is what keeps MW3's `head_delta_elite_a` on
    `mp_body_delta_elite_assault_aa`.
    """
    b, h = body.removeprefix(BODY_PREFIX), head.removeprefix(HEAD_PREFIX)
    return len(set(_words(b)) & set(_words(h))), _shared_prefix(b, h)


def _is_a_bodys_head(body, head):
    """Whether `head`'s name says it is `body`'s: two words in common, or the same first word.

    One word in common is a coincidence rather than a family: Ghosts'
    `head_mp_head_a` shares only the variant letter with
    `mp_body_us_rangers_assault_a_woodland` and is no body's own head.
    """
    words, leading = _tokens_shared(body, head)
    return words >= 2 or leading >= 1


def _spellings(pattern, suffix):
    """Every name one CLIP_ROLES pattern can have, the weapon class's spelling first.

    `{}` is where the class goes; a pattern with none takes it on the end, which
    is how every MW name is written (`pb_sprint` -> `pb_sprint_smg`).
    """
    if "{}" not in pattern:
        pattern += "{}"
    return ([pattern.format(f"_{suffix}")] if suffix else []) + [pattern.format("")]


def clip_names(game_key, info, available):
    """{role: clip name} for this weapon's `playerAnimType` in `game_key`, dropping roles the zone has no clip for."""
    field = ANIM_TYPE_FIELD_BY_GAME.get(game_key, "playerAnimType")
    suffix = ANIM_TYPE_SUFFIX_BY_GAME.get(game_key, {}).get((info.get(field) or "").strip().lower())
    out = {}
    for role, patterns in CLIP_ROLES_BY_GAME.get(game_key, {}).items():
        for name in (n for p in patterns for n in _spellings(p, suffix)):
            if name in available:
                out[role] = name
                break
    return out


def held(clip):
    """`clip` as its first frame alone: one key a track, no loop, no notes and no root motion."""

    def first(track):
        return Track([0], [track.values[0]]) if track and track.values else None

    return dataclasses.replace(
        clip,
        frames=1,
        looped=False,
        bones=[BoneTrack(b.name, first(b.rotation), first(b.translation)) for b in clip.bones],
        has_root_motion=False,
        delta_rotation=None,
        delta_translation=None,
        notetracks=[],
    )


def load_clips(anim_dir, roles):
    """{clip name: XAnim} for every clip `roles` names, a HELD_ROLES clip as its first frame.

    A clip some other role plays through is kept whole, whichever role names it first.
    """
    played = {name for role, name in roles.items() if role not in HELD_ROLES}
    clips = {}
    for name in sorted(set(roles.values())):
        clip = decode(read_bytes(os.path.join(anim_dir, name)), name)
        clips[name] = clip if name in played else held(clip)
    return clips


# -- Grafting -------------------------------------------------------------------------


def _copy_joints(dst, src, indices, parent_of):
    """Copy `src` nodes `indices` (parents first) into `dst`; return {src index: dst index}.

    A copied node whose parent was not copied too hangs from
    `parent_of(<its parent's name in src>)`, a node index in `dst`. Local transforms are copied as they are: both files are
    OAT's inches, and the axis change the whole rig needs is on the body's own
    root joint. The new joints join `dst`'s skin, which is what makes them bones
    for a glTF loader and joints for `clip_to_gltf`.
    """
    wanted = list(indices)
    copied = {}
    for old in wanted:
        node = src["nodes"][old]
        new = {"name": node["name"], **{k: list(node[k]) for k in ("translation", "rotation", "scale") if k in node}}
        copied[old] = len(dst["nodes"])
        dst["nodes"].append(new)
    inside = set(wanted)
    up = {c: i for i, n in enumerate(src["nodes"]) for c in n.get("children", [])}
    for old, new in copied.items():
        kids = [copied[c] for c in src["nodes"][old].get("children", []) if c in copied]
        if kids:
            dst["nodes"][new]["children"] = kids
        if up.get(old) not in inside:
            above = src["nodes"][up[old]]["name"] if old in up else None
            dst["nodes"][parent_of(above)].setdefault("children", []).append(new)
    dst["skins"][0]["joints"].extend(sorted(copied.values()))
    return copied


def graft_head(body, head):
    """Add the joints the head has and the body does not, each under its own named parent.

    The head's skeleton is the body's from `j_spine4` up, plus its own jaw, eye,
    helmet and NVG joints. Only the ones the body lacks are copied; the rest the
    body has already, and the head's meshes find them there by name at run time.
    """
    by_name = {n.get("name"): i for i, n in enumerate(body["nodes"])}
    roots, joints = skin_roots(head)
    if len(roots) != 1:
        raise ValueError(f"the head has {len(roots)} root joints, expected 1")
    up = {c: i for i, n in enumerate(head["nodes"]) for c in n.get("children", [])}

    wanted = [i for i in joint_subtree(head, roots[0]) if i in joints and head["nodes"][i]["name"] not in by_name]
    for i in wanted:
        parent = head["nodes"][up[i]]["name"] if i in up else None
        if parent not in by_name and up.get(i) not in wanted:
            raise ValueError(f"the head's {head['nodes'][i]['name']} hangs from {parent}, which is in neither skeleton")
    _copy_joints(body, head, wanted, lambda parent: by_name[parent])
    return [head["nodes"][i]["name"] for i in wanted]


def graft_weapon(body, weapon, gun_joint=GUN_JOINT):
    """Hang the world weapon's joints off the body's `gun_joint`, at rest in its frame.

    The weapon's root joint carries OAT's Z-up -> Y-up rotation, which the body's
    own root already applies to the whole rig; dropping it is what puts the gun in
    the hand rather than a quarter-turn out of it.
    """
    by_name = {n.get("name"): i for i, n in enumerate(body["nodes"])}
    if gun_joint not in by_name:
        raise ValueError(f"the body has no {gun_joint} joint to hang a weapon from")
    roots, _ = skin_roots(weapon)
    if len(roots) != 1:
        raise ValueError(f"the weapon has {len(roots)} root joints, expected 1")
    name = weapon["nodes"][roots[0]].get("name")
    if name != WEAPON_ROOT:
        raise ValueError(f"the weapon's root joint is {name!r}, expected {WEAPON_ROOT!r}")

    order = joint_subtree(weapon, roots[0])
    copied = _copy_joints(body, weapon, order, lambda _parent: by_name[gun_joint])
    root = body["nodes"][copied[roots[0]]]
    root.pop("translation", None)
    root.pop("rotation", None)
    return [weapon["nodes"][i]["name"] for i in order]


# -- The animation rig ----------------------------------------------------------------


def skeleton_spec(gltf):
    """[(name, parent name or None, node)] for every joint of `gltf`, parents first."""
    roots, joints = skin_roots(gltf)
    parent = {c: i for i, n in enumerate(gltf["nodes"]) for c in n.get("children", [])}
    out = []
    for root in sorted(roots):
        for i in joint_subtree(gltf, root):
            if i not in joints:
                continue
            up = parent.get(i)
            out.append((gltf["nodes"][i]["name"], gltf["nodes"][up]["name"] if up in joints else None, gltf["nodes"][i]))
    return out


def build_anim_rig(specs):
    """A joints-only glTF holding the union of `specs` (skeleton_spec outputs), parents first.

    No meshes and no unit scale: the clips' translations are the game's inches,
    the same as the bind translations they are added to on a packed body, and a
    file with no geometry is a few hundred KB of keys rather than a second body.
    """
    nodes, index = [], {}
    for spec in specs:
        for name, parent, node in spec:
            if name in index:
                continue
            copy = {"name": name, **{k: list(node[k]) for k in ("translation", "rotation", "scale") if k in node}}
            index[name] = len(nodes)
            nodes.append(copy)
            if parent is not None:
                if parent not in index:
                    raise ValueError(f"joint {name} comes before its parent {parent}")
                nodes[index[parent]].setdefault("children", []).append(index[name])
    roots = [i for i, n in enumerate(nodes) if not any(i in m.get("children", []) for m in nodes)]
    return {
        "asset": {"version": "2.0", "generator": "scripts/cod/characters.py"},
        "scenes": [{"nodes": roots}],
        "scene": 0,
        "nodes": nodes,
        "skins": [{"name": "player", "joints": list(range(len(nodes))), "skeleton": roots[0]}],
    }


def definition(game_key, weapon, info, roles, clips):
    """The clip table as src/scene/character.ts reads it from animations.glb's scene extras."""
    return {
        "version": FORMAT_VERSION,
        "game": game_key,
        "weapon": weapon,
        "animType": (info.get("playerAnimType") or "").strip(),
        "roles": roles,
        "torsoRoles": [r for r in TORSO_ROLES if r in roles],
        "aimJoint": AIM_JOINT,
        "clips": {
            name: {
                "duration": clips[name].duration,
                "looped": clips[name].looped,
                "notes": [[n, frame / clips[name].fps] for n, frame in clips[name].notetracks],
            }
            for name in sorted(set(roles.values()))
        },
    }


def write_anim_glb(out_path, specs, clips, roles, spec, absolute_bones=None):
    """animations.glb: the union skeleton with every clip a role names. Returns [problems].

    `absolute_bones` is `clip_to_gltf`'s: given (AW's rule), it decides which keys are
    absolute instead of each clip's asset type, and a body's is empty.
    """
    gltf = build_anim_rig(specs)
    buf = bytearray()
    problems = []
    for name in sorted(set(roles.values())):
        clip = clips[name]
        if absolute_bones is None and clip.asset_type not in TRANSLATION_BY_ASSET_TYPE:
            problems.append(f"{name}: asset type {clip.asset_type}, translations read as offsets (unverified)")
        written, unmatched = clip_to_gltf(gltf, buf, clip, absolute_bones)
        if not written:
            problems.append(f"{name} drives no joint of the player skeleton")
        elif unmatched > len(clip.bones) // 2:
            problems.append(f"{name}: {unmatched} of {len(clip.bones)} bones not in the skeleton")
    gltf["scenes"][0]["extras"] = {"characters": spec}
    gltf["buffers"] = [{"byteLength": len(buf)}]
    write_glb(out_path, gltf, buf)
    return problems


# -- The stage ------------------------------------------------------------------------


def _model_glb(models_dir, name):
    for dirpath, _, files in os.walk(models_dir):
        for stem in (f"{name}_lod0.glb", f"{name}.glb"):
            if stem in files:
                return os.path.join(dirpath, stem)
    return None


def _pack(raw, out_path, iwi, states):
    return pack_one(raw, out_path, iwi, BODY_TEXTURE_SIZE, states, False)[1]


def pick(game_key, bodies, heads, choice):
    """[(side, body, head)] to export: `_overrides.json`'s "characters" if it names any, else one body a side.

    An override's `bodies` are taken as they are — a name the zone does not ship
    is fatal rather than quietly replaced — and `heads` pairs with it one for one
    when given.
    """
    chosen = [(side_of(b) or b.removeprefix(BODY_PREFIX), b) for b in choice.get("bodies", [])] or choose_bodies(bodies)
    named = choice.get("heads") or []
    if named and len(named) != len(chosen):
        raise ValueError(f"_overrides.json characters: {len(named)} heads for {len(chosen)} bodies")
    spares = None if HEADS_ARE_A_BODYS_BY_GAME.get(game_key, True) else unclaimed_heads(bodies, heads)
    out = []
    for i, (side, body) in enumerate(chosen):
        if body not in bodies:
            raise ValueError(f"{body} is not one of this zone's {len(bodies)} {BODY_PREFIX}* models")
        head = named[i] if named else head_for(body, heads, spares)
        # Fatal, not skipped: a chosen body we cannot dress is a gap in the
        # naming tables above, and dropping it ships a world one side short that
        # renders perfectly (docs/cod/pitfalls.md#characters).
        if head is None:
            raise ValueError(f"no head among this zone's {len(heads)} {HEAD_PREFIX}* models is {body}'s")
        out.append((side, body, head))
    return out


def pick_t5(raw_dir, xmodel_dir, choice):
    """[(side, body, head)] for a Black Ops map, as its create-a-class scripts dress them (cac.py).

    `_overrides.json`'s "characters" `bodies` pick others by name; each still wears
    the head its own class names, because the scripts say which that is.
    """
    cast = cac.read_cast(raw_dir)
    dumped = {f.removesuffix(".json") for f in os.listdir(xmodel_dir)} if os.path.isdir(xmodel_dir) else set()
    by_body = {body: head for classes in cast.values() for body, head, _ in classes.values()}
    named = choice.get("bodies") or []
    if named:
        missing = [b for b in named if b not in by_body or b not in dumped]
        if missing:
            raise ValueError(f"{', '.join(missing)}: not a body this zone's {cac.BODY_DIR}/ scripts dress")
        return [(side_of(b) or b, b, by_body[b]) for b in named]
    out = []
    for faction in cac.factions_in(cast, dumped):
        body, head, _ = cast[faction][cac.DEFAULT_CLASS]
        out.append((cac.FACTION_SIDES.get(faction, faction), body, head))
    return out


# What the characters stage decided, beside the GLBs it decided it for: which
# head each body wears, its side, the gun grafted into it and the anim type of
# the clip set it plays. `harvest` reads it, because the pairing is not
# recoverable from filenames (harvest._cast_of).
CAST_FILE = "cast.json"


def write_cast(out_dir, built, world_model, anim_type):
    """`cast.json`: [(side, body glb, head glb)], the held gun and its anim type, as `harvest` reads them."""
    body = {
        "characters": [{"side": side, "body": b, "head": h} for side, b, h in built],
        "weapon": f"assets/{OUT_DIR}/{world_model}.glb",
        "animType": anim_type,
    }
    write_text(os.path.join(out_dir, CAST_FILE), json.dumps(body, indent=1) + "\n")


def export_characters(work, assets_dir, game_key, states, info, choice=None):
    """The characters stage: the map's MP bodies, their heads and the held weapon.

    `info` is the chosen weapon's parsed infostring (viewmodel.parse_infostring),
    which names the world model and the animation type. No clips: those are the
    game's, and cast_clips.py builds them once the bodies are in the catalogue.
    Returns (out dir relative to the world, [(side, body glb, head glb)], weapon
    glb) or None when this map ships no player bodies.
    """
    models = os.path.join(work, "models")
    xmodel = os.path.join(models, "xmodel")
    if game_key == "t5":
        chosen = pick_t5(os.path.join(work, "raw"), xmodel, choice or {})
        if not chosen:
            print(f"      no characters: the zone's {cac.BODY_DIR}/ scripts dress no body it ships")
            return None
    else:
        bodies = models_of_type(xmodel, BODY_PREFIX)
        if not bodies:
            print(f"      no characters: the zone ships no {BODY_PREFIX}* models")
            return None
        chosen = pick(game_key, bodies, models_of_type(xmodel, HEAD_PREFIX), choice or {})
    if not any(side_of(b) for _, b, _ in chosen):
        # No body's name says which faction it is, so the characters are named for
        # themselves and the world ships no allies/axis split. On a Ghosts map
        # that is the truth about the zone, not a failed lookup: it carries the
        # Ghosts' bodies and the Federation's are in the loadout zones
        # (docs/cod/games.md#ghosts-iw6).
        print(f"      no faction in any body name; {len(chosen)} character(s) named for themselves")

    world_model = (info.get("worldModel") or "").strip()
    weapon_raw = _model_glb(models, world_model) if world_model else None
    if weapon_raw is None:
        print(f"      no characters: the weapon's world model {world_model or '?'} was not dumped")
        return None

    out_dir = os.path.join(assets_dir, OUT_DIR)
    os.makedirs(out_dir, exist_ok=True)
    iwi = texture_index(os.path.join(work, "img"))
    missing = _pack(weapon_raw, os.path.join(out_dir, f"{world_model}.glb"), iwi, states)
    weapon_graft, _ = read_glb(weapon_raw)

    built, problems = [], []
    for side, body, head in chosen:
        body_raw, head_raw = _model_glb(models, body), _model_glb(models, head)
        if body_raw is None or head_raw is None:
            raise ValueError(f"{side}: {body if body_raw is None else head} is in the zone but was not dumped")
        packed = os.path.join(out_dir, f"{body}.glb")
        missing += _pack(body_raw, packed, iwi, states)
        missing += _pack(head_raw, os.path.join(out_dir, f"{head}.glb"), iwi, states)

        gltf, buf = read_glb(packed)
        if AIM_JOINT not in {n.get("name") for n in gltf["nodes"]}:
            problems.append(f"{body} has no {AIM_JOINT} joint; it cannot be aimed")
        head_gltf, _ = read_glb(head_raw)
        added = graft_head(gltf, head_gltf)
        gun = graft_weapon(gltf, weapon_graft, GUN_JOINT_BY_GAME.get(game_key, GUN_JOINT))
        gltf["buffers"] = [{"byteLength": len(buf)}]
        write_glb(packed, gltf, buf)
        built.append((side, f"assets/{OUT_DIR}/{body}.glb", f"assets/{OUT_DIR}/{head}.glb"))
        print(f"      {side}: {body} + {head} (+{len(added)} head joints, +{len(gun)} weapon joints)")

    write_cast(out_dir, built, world_model, (info.get("playerAnimType") or "").strip())
    if missing:
        problems.append(f"{missing} texture(s) not in the dump, drawn white")
    for p in problems:
        print(f"      !! {p}")
    return f"assets/{OUT_DIR}", built, f"assets/{OUT_DIR}/{world_model}.glb"
