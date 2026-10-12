"""The clip set a game's players are posed from, built into the catalogue.

A player clip is a game's and not a map's: every one is in the companion zone,
and a clip binds to a body by joint name. So a set is built from a companion-zone
dump -- a `catalog` dump or an export's own scratch directory hold the same
clips -- over the union of the joints of every body the catalogue already holds
for that game, which is the skeleton a clip has to be able to turn. Which clips:
characters.CLIP_ROLES_BY_GAME. The data: docs/cod/reference.md#characters.
"""

import json
import os

from . import catalog
from .characters import AIM_JOINT, TORSO_ROLES, clip_names, definition, load_clips, skeleton_spec, write_anim_glb
from .files import read_text, write_text
from .gltf import read_glb
from .viewmodel import DEFAULT_WEAPON, parse_infostring

KIND = "animations"
BODIES_KIND = "characters"
ANIM_FILE = "animations.glb"
# A body's tagPositions are real in AW, so every translation key is an offset from
# them (reverse/s1-zone/README.md#the-animations): no joint's is absolute.
ABSOLUTE_BONES_BY_GAME = {"s1": set()}


def bodies(worlds_root, game_key):
    """[(entry, skeleton_spec)] for every body the catalogue holds for `game_key`, in id order."""
    out = []
    for entry in catalog.scan_kind(worlds_root, BODIES_KIND):
        if entry.get("game") == game_key and entry.get("body"):
            path = os.path.join(catalog.entry_dir(worlds_root, BODIES_KIND, game_key, entry["id"]), entry["body"])
            out.append((entry, skeleton_spec(read_glb(path)[0])))
    return out


def build(work, worlds_root, game_key, weapon=None):
    """Write `catalog/animations/<game>/<animType>/` from `work`'s clips. Returns [problems].

    `weapon` is the weapon file whose `playerAnimType` picks the class a clip is
    spelt for; the one every body of the game is rigged holding unless given. A
    game with no bodies in the catalogue, or none it is rigged holding, has no
    set to build and is left alone.
    """
    weapon = weapon or DEFAULT_WEAPON.get(game_key)
    cast = bodies(worlds_root, game_key) if weapon else []
    if not cast:
        return []
    weapon_file = os.path.join(work, "weapons", "weapons", weapon)
    anim_dir = os.path.join(work, "view_anim", "xanim")
    if not os.path.isfile(weapon_file) or not os.path.isdir(anim_dir):
        return [f"{game_key}'s player clips were not built: {work} holds no {weapon} weapon file or no view_anim/xanim dump"]

    info = parse_infostring(read_text(weapon_file))
    roles = clip_names(game_key, info, set(os.listdir(anim_dir)))
    if "idle" not in roles:
        return [f"{game_key}'s player clips were not built: no idle clip in {anim_dir} (is the clip companion dumped?)"]
    clips = load_clips(anim_dir, roles)
    spec = definition(game_key, weapon, info, roles, clips)
    anim_type = spec["animType"] or "default"
    problems = []
    strangers = sorted({e.get("animType") or "default" for e, _ in cast} - {anim_type})
    if strangers:
        problems.append(f"{game_key} bodies name clip set(s) {', '.join(strangers)}, and {weapon} builds {anim_type}")

    out = catalog.entry_dir(worlds_root, KIND, game_key, anim_type)
    os.makedirs(out, exist_ok=True)
    specs = [s for _, s in cast]
    problems += write_anim_glb(os.path.join(out, ANIM_FILE), specs, clips, roles, spec, ABSOLUTE_BONES_BY_GAME.get(game_key))
    joints = {name for s in specs for name, _, _ in s}
    entry = {
        "id": anim_type,
        "game": game_key,
        "animType": anim_type,
        "clips": ANIM_FILE,
        "joints": len(joints),
        "aimJoint": AIM_JOINT,
        "roles": roles,
        "torsoRoles": [r for r in TORSO_ROLES if r in roles],
        "clipTable": spec["clips"],
    }
    write_text(os.path.join(out, f"{anim_type}.json"), json.dumps(entry, indent=1) + "\n")
    counts = f"{len(roles)} role(s) over {len(clips)} clip(s), {len(joints)} joints of {len(cast)} bodies"
    print(f"  + {KIND}/{game_key}/{anim_type}: {counts}")
    return problems
