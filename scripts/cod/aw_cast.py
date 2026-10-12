"""Advanced Warfare's cast in the catalogue: bodies, heads, view hands, the gun they hold, their clips.

An AW body is not a model a zone ships. The game dresses a player in a costume
(costumes.py): a shirt, pants, gloves, shoes, kneepads, gear, an exo, a hat and
eyewear, each a skinned or rigid model, plus a head, over one skeleton they were
all authored on. So a catalogue body is composed here: those parts on the
skeleton of `mp_body_fso_vest_c_dirty` -- the one 84-joint body `common_mp.ff`
ships, with `j_gun` -- bound to one skin, then packed and grafted exactly as
every other game's (characters.graft_head, graft_weapon). The first-person arms
are composed the same way from the costume's view parts, on the skeleton of
`viewmodel_base_viewhands`, the hands every AW weapon file names.

Which costumes: the one every category's first item makes, whose ten models are
exactly the ones `common_mp.ff` keeps resident, and the game's own bot costumes.
The data: reverse/s1-zone/README.md#the-characters.
"""

import glob
import json
import os
import shutil

from . import cast_clips, catalog, costumes
from .characters import GUN_JOINT_BY_GAME, graft_head, graft_weapon
from .composite import _inverse, _world_matrices, compose, single_skin
from .files import read_text, write_text
from .gltf import _mul, read_glb, skin_roots, write_glb
from .pack import pack_one
from .textures import texture_index
from .viewmodel import VIEW_TEXTURE_SIZE, _model_glb, parse_infostring

GAME = "s1"
# Every MP string table, the costume tables among them, is in this one localized zone.
TABLE_ZONE = os.path.join("english", "eng_patch_code_post_gfx_mp.ff")
TABLE_DIR = "tables"
# The zone family each category's streamed models are in, one or a few models a zone.
PART_ZONES = {c: f"mp_{c}" for c in ("shirt", "head", "pants", "gloves", "shoes", "gear", "exo", "hat", "eyewear", "kneepads")}
VIEW_ZONES = "mp_viewarm"
# `_vl_` zones are the virtual lobby's copies of the same models.
LOBBY = "_vl_"
ZONE_INDEX = "costume_zones.json"

BASE_BODY = "mp_body_fso_vest_c_dirty"
BASE_HANDS = "viewmodel_base_viewhands"
BODY_PARTS = ("shirt", "pants", "gloves", "shoes", "kneepads", "gear", "exo", "hat", "eyewear")
VIEW_PARTS = ("shirt", "gloves", "exo")
# A skinned part whose own skeleton sits further than this from the base's has not been
# authored on it: its seams would open. The worst measured is 0.2 in, a female glove's fingers.
SEAM_TOLERANCE = 0.25
BODY_TEXTURE_SIZE = 512
BLACK = "$black"  # the engine's own image, which no dump writes
# What a player spawns holding: `CLASS_DEFAULT`'s primary in `mp/classtable.csv`.
CLASS_TABLE = os.path.join("mp", "classtable.csv")
DEFAULT_CLASS = "CLASS_DEFAULT"


def cast(work):
    """[(id, Costume, where it comes from)]: the resident default, then each bot costume."""
    root = os.path.join(work, TABLE_DIR)
    tables = costumes.read_tables(root)
    out = [("costume_default", costumes.resolve(costumes.first_items(), tables), "every category's first item")]
    bots = costumes.costume_columns(os.path.join(root, costumes.TABLE_DIR, costumes.BOT_TABLE))
    for n, ids in enumerate(bots, 1):
        out.append((f"costume_bot{n:02}", costumes.resolve(ids, tables), f"{costumes.BOT_TABLE} column {n}"))
    default = out[0][1]
    if not all(default.resident.values()):
        # The independent check on "first item": common_mp.ff keeps exactly these models.
        raise ValueError(f"the default costume names streamed models: {default.parts}")
    return out


def default_weapon(work):
    """`CLASS_DEFAULT`'s primary, as a weapon file name (`iw5_bal27_mp`)."""
    rows = {r[0]: r for r in costumes.read_csv(os.path.join(work, TABLE_DIR, CLASS_TABLE)) if r}
    column = rows["loadoutName"].index(DEFAULT_CLASS)
    return f"{rows['loadoutPrimary'][column]}_mp"


def wanted_models(members):
    """{zone family: {model}} of every streamed model a cast needs."""
    out = {}
    for _, costume, _ in members:
        for category, model in costume.parts.items():
            if not costume.resident[category]:
                out.setdefault(PART_ZONES[category], set()).add(model)
        for category, model in costume.views.items():
            if not costume.resident[category]:
                out.setdefault(VIEW_ZONES, set()).add(model)
    return out


def find_zones(zone_dir, wanted, work, walk):
    """{model: zone path}, walking each family's zones in order until it has them all.

    A zone is named by a number the tables do not give (`mp_shirt_027_tr` holds
    `mp_top_m_a_29{a,b,c,d}`), so each is walked for the models it holds; `walk`
    returns those names. What was learnt is kept in `ZONE_INDEX` for the next run.
    """
    index_path = os.path.join(work, ZONE_INDEX)
    seen = json.loads(read_text(index_path)) if os.path.exists(index_path) else {}
    found = {}
    for family, models in sorted(wanted.items()):
        for ff in sorted(glob.glob(os.path.join(zone_dir, f"{family}_*_tr.ff"))):
            if LOBBY in os.path.basename(ff):
                continue
            if models <= set(found):
                break
            name = os.path.basename(ff)
            if name not in seen:
                seen[name] = walk(ff)
            for model in models.intersection(seen[name]):
                found.setdefault(model, ff)
    write_text(index_path, json.dumps(seen, indent=1, sort_keys=True) + "\n")
    missing = sorted(m for models in wanted.values() for m in models if m not in found)
    if missing:
        raise ValueError(f"no zone holds {', '.join(missing)}")
    return found


def dump(backend, zone_dir, work):
    """Dump what the cast needs beside the companion zones: the tables, then each part's zone."""
    backend.dump(os.path.join(zone_dir, TABLE_ZONE), os.path.join(work, TABLE_DIR), "stringtable")
    members = cast(work)
    weapon = default_weapon(work)

    def walk(ff):
        return [n for n in backend.walk(ff).zone.found.get("XMODEL", {}) if not n.startswith(",")]

    zones = find_zones(zone_dir, wanted_models(members), work, walk)
    world = os.path.join(zone_dir, f"mp_wm_{weapon.removeprefix('iw5_').removesuffix('_mp')}_tr.ff")
    for ff in sorted(set(zones.values()) | ({world} if os.path.exists(world) else set())):
        backend.dump(ff, os.path.join(work, "models"), "xmodel")
    print(f"  cast: {len(members)} costume(s) over {len(zones)} streamed model(s) in {len(set(zones.values()))} zone(s)")


def skeleton_only(path, out_path):
    """`path`'s skeleton and nothing else: its joints, their one skin and its inverse binds."""
    gltf, buf = read_glb(path)
    skin = gltf["skins"][0]
    acc = dict(gltf["accessors"][skin["inverseBindMatrices"]])
    view = gltf["bufferViews"][acc.pop("bufferView")]
    start = view.get("byteOffset", 0) + acc.pop("byteOffset", 0)
    data = buf[start : start + 64 * acc["count"]]
    for node in gltf["nodes"]:
        node.pop("mesh", None)
        node.pop("skin", None)
    out = {
        "asset": gltf["asset"],
        "scene": 0,
        "scenes": gltf["scenes"],
        "nodes": gltf["nodes"],
        "skins": [{**skin, "inverseBindMatrices": 0}],
        "accessors": [{**acc, "bufferView": 0}],
        "bufferViews": [{"buffer": 0, "byteOffset": 0, "byteLength": len(data)}],
        "buffers": [{"byteLength": len(data)}],
    }
    write_glb(out_path, out, bytearray(data))


def dress(work, base, parts, out_path, xmodels, states, one_skin=True):
    """Compose `parts` on `base`'s skeleton; return {skinned part: its `seam`}.

    A body is bound to one skin (composite.single_skin). A pair of hands keeps a skin a
    part: the client rebinds each mesh to the weapon's joints with its own inverse binds,
    which is exact whatever skeleton the part was authored on, and the view arms' are not
    all one (`mp_view_top_05a` holds its left wrist 2.7 in from the base hands').
    """
    models = os.path.join(work, "models")
    placed = []
    for part in parts:
        path = _model_glb(models, part)
        if path is None:
            raise ValueError(f"{part} was not dumped")
        placed.append((part, path))
    skeleton = out_path + ".skeleton.glb"
    base_path = _model_glb(models, base)
    skeleton_only(base_path, skeleton)
    compose(skeleton, [(path, _root_bone(xmodels, part)) for part, path in placed], out_path)
    os.remove(skeleton)
    gltf, buf = read_glb(out_path)
    drop_unseen(gltf, states)
    if one_skin:
        single_skin(gltf, buf)
    gltf["buffers"] = [{"byteLength": len(buf)}]
    write_glb(out_path, gltf, buf)
    base_gltf = read_glb(base_path)[0]
    return {part: seam(base_gltf, read_glb(path)[0]) for part, path in placed if not _root_bone(xmodels, part)}


def drop_unseen(gltf, states):
    """Drop the surfaces that add `$black` to what is behind them, which is nothing.

    The gear's heat overlay (`mtl_mp_loadouts_04a_alpha`) is one: additive, coloured by a
    code image no dump writes, so packed it would be a white pixel added over the vest."""
    unseen = set()
    for i, mat in enumerate(gltf.get("materials", [])):
        colour = mat.get("pbrMetallicRoughness", {}).get("baseColorTexture")
        image = gltf["images"][gltf["textures"][colour["index"]]["source"]] if colour else {}
        blend = (states.get(mat.get("name", "")) or {}).get("blend")
        if blend == "add" and os.path.basename(image.get("uri", "")).startswith(BLACK):
            unseen.add(i)
            del mat["pbrMetallicRoughness"]["baseColorTexture"]  # nothing draws it now
    for mesh in gltf.get("meshes", []):
        mesh["primitives"] = [p for p in mesh["primitives"] if p.get("material") not in unseen]
    # A mesh with no primitives is not a mesh to a loader; its node stays, drawing nothing.
    for node in gltf["nodes"]:
        if "mesh" in node and not gltf["meshes"][node["mesh"]]["primitives"]:
            node.pop("mesh")
            node.pop("skin", None)


def seam(base, part):
    """How far, in inches, a skinned part's joints sit from the base skeleton's, measured from the
    part's root joint: a part authored on another skeleton opens at its seams by this much.
    Tags are left out; nothing is weighted to them (the shirts' `tag_stowed_back` is 3.7 in off)."""

    def placed(gltf):
        worlds = _world_matrices(gltf)
        return {n.get("name"): worlds[i] for i, n in enumerate(gltf["nodes"])}

    mine, theirs = placed(part), placed(base)
    roots, joints = skin_roots(part)
    root = part["nodes"][roots[0]]["name"]
    here, there = _inverse(mine[root]), _inverse(theirs[root])
    far = 0.0
    for name in {part["nodes"][j]["name"] for j in joints} & theirs.keys():
        if not name.startswith("tag_"):
            a, b = _mul(here, mine[name])[12:15], _mul(there, theirs[name])[12:15]
            far = max(far, sum((x - y) ** 2 for x, y in zip(a, b, strict=True)) ** 0.5)
    return far


def _root_bone(xmodels, name):
    path = os.path.join(xmodels, f"{name}.json")
    return json.loads(read_text(path)).get("rootBoneName") if os.path.exists(path) else None


def _entry(kind, ident, body, worlds_root):
    out = catalog.entry_dir(worlds_root, kind, GAME, ident)
    os.makedirs(out, exist_ok=True)
    write_text(os.path.join(out, f"{ident}.json"), json.dumps(body, indent=1) + "\n")
    return out


def build(work, worlds_root, states):
    """Every kind of the AW cast into the catalogue. Returns [problems]; prints what it built."""
    models = os.path.join(work, "models")
    xmodels = os.path.join(models, "xmodel")
    scratch = os.path.join(work, "cast")
    os.makedirs(scratch, exist_ok=True)
    iwi = texture_index(os.path.join(work, "img"))
    members = cast(work)
    problems = []

    weapon = default_weapon(work)
    info = parse_infostring(read_text(os.path.join(work, "weapons", "weapons", weapon)))
    world = info["worldModel"].strip()
    catalog.s1_compose(work, [world], "world weapon")
    weapon_raw = _model_glb(models, world)
    if weapon_raw is None:
        return [f"{weapon}'s world model {world} was not dumped"]
    out = catalog.entry_dir(worlds_root, "worldweapons", GAME, world)
    os.makedirs(out, exist_ok=True)
    missing = pack_one(weapon_raw, os.path.join(out, f"{world}.glb"), iwi, BODY_TEXTURE_SIZE, states, False)[1]
    weapon_graft, _ = read_glb(weapon_raw)
    print(f"  + worldweapons/{GAME}/{world} ({weapon}, the default class's primary)")

    hands = {}
    for ident, costume, source in members:
        parts = [costume.parts[c] for c in BODY_PARTS if c in costume.parts]
        raw = os.path.join(scratch, f"{ident}.glb")
        seams = dress(work, BASE_BODY, parts, raw, xmodels, states)
        opened = {p: d for p, d in seams.items() if d > SEAM_TOLERANCE}
        if opened:
            problems.append(f"{ident}: {', '.join(f'{p} {d:.2f} in' for p, d in opened.items())} off the skeleton")
        out = catalog.entry_dir(worlds_root, "characters", GAME, ident)
        os.makedirs(out, exist_ok=True)
        body_path = os.path.join(out, f"{ident}.glb")
        missing += pack_one(raw, body_path, iwi, BODY_TEXTURE_SIZE, states, False)[1]
        gltf, buf = read_glb(body_path)
        head = costume.parts.get("head")
        added = []
        if head:
            head_raw = _model_glb(models, head)
            missing += pack_one(head_raw, os.path.join(out, f"{head}.glb"), iwi, BODY_TEXTURE_SIZE, states, False)[1]
            added = graft_head(gltf, read_glb(head_raw)[0])
        gun = graft_weapon(gltf, weapon_graft, GUN_JOINT_BY_GAME[GAME])
        gltf["buffers"] = [{"byteLength": len(buf)}]
        write_glb(body_path, gltf, buf)

        view = tuple(costume.views.get(c) for c in VIEW_PARTS if costume.views.get(c))
        hands.setdefault(view, f"viewhands_{ident}")
        entry = {
            "id": ident,
            "game": GAME,
            # AW's teams are not factions: any costume plays on either side.
            "side": None,
            "body": f"{ident}.glb",
            **({"head": f"{head}.glb"} if head else {}),
            "bakedWeapon": world,
            "animType": (info.get("playerAnimType") or "").strip(),
            "costume": {"source": source, "parts": costume.parts, "hands": hands[view]},
            # Drawn in the part's own material: the variant's is not applied.
            **({"materialVariants": costume.variants} if costume.variants else {}),
        }
        _entry("characters", ident, entry, worlds_root)
        print(
            f"  + characters/{GAME}/{ident}: {len(parts)} part(s), {head or 'no head'} (+{len(added)}),"
            f" +{len(gun)} gun joints, seams {max(seams.values(), default=0.0):.3f} in"
        )

    for view, ident in hands.items():
        out = catalog.entry_dir(worlds_root, "viewhands", GAME, ident)
        os.makedirs(out, exist_ok=True)
        raw = os.path.join(scratch, f"{ident}.glb")
        dress(work, BASE_HANDS, list(view), raw, xmodels, states, one_skin=False)
        missing += pack_one(raw, os.path.join(out, f"{ident}.glb"), iwi, VIEW_TEXTURE_SIZE, states, False)[1]
        _entry("viewhands", ident, {"id": ident, "game": GAME, "hands": f"{ident}.glb", "parts": list(view)}, worlds_root)
        print(f"  + viewhands/{GAME}/{ident}: {', '.join(view)}")

    # The clip set those bodies play, keyed by the default class's weapon.
    problems += cast_clips.build(work, worlds_root, GAME, weapon)
    shutil.rmtree(scratch, ignore_errors=True)
    if missing:
        problems.append(f"{missing} texture(s) not in the dump, drawn white")
    return problems
