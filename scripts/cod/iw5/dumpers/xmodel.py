"""`xmodel`: `xmodel/<name>.json` and `model_export/<name>_lod<N>.glb`, as OpenAssetTools'
`--model-format GLB` writes them (scripts/cod/xmodel_glb.py has the GLB layout).

The JSON carries what pack.py, props.py, viewmodel.py and characters.py read: the
LOD files and their distances, `collLod`, `contents` (what a placement stops),
the physics preset and collmap, `rootBoneName`, and `type` (rigid, animated or
viewhands), which OAT infers from the skinning data.

A LOD's geometry is an `XModelSurfs` its `lodInfo` names: an asset on IW5, and on
IW4 the header the `SetModelSurfs` action keeps (zonecode/actions.py), so there
`modelSurfs` is the record itself. Either can be another zone's, named with a
leading comma and holding no surfaces: every MW3 and MW2 map zone's team flags
name `,flag2_lod000`, which only `common_mp.ff` holds. Such a LOD's surfaces are
found by name in the companion zones walked before it (`held_surfaces`,
zonecode/companions.py); the model's own materials and bones still apply. One no
companion holds is written with its materials and no vertices, and named. A model
named with a leading comma is another zone's, and is not written. Every other
member read here is the same in both games, so this writer is IW4's too.

IW4 and IW5 pack a model vertex as float xyz, a GfxColor, texture coordinates as two
half floats with **u in the high word**, and a normal as three bytes scaled by a
fourth (shell.unpack_unit_vec). A surface's triangles index from its own
`baseVertIndex` in the LOD's vertex list.

Black Ops II's models are T5's in shape and are written here too, with two
differences in the vertex (t6/vertices.py): u is the *low* half float, and the
normal is three signed 10-bit fields. A T6 texture holds its image directly
rather than through IW's union.
"""

import struct
from collections import Counter

from ... import xmodel_glb as glb
from ...iw6.dumpers.common import asset_path, write_json
from ...iw6.vertices import half
from ...shell import unpack_unit_vec
from ...t6 import vertices as t6_vertices
from ...zonecode.companions import holds
from ...zonecode.values import Asset
from . import dumper
from .common import plain

SCHEMA = "http://openassettools.dev/schema/xmodel.v1.json"
FOLDER = "model_export"
DEFAULT_ROOT_BONE = ""  # OAT xmodel::DEFAULT_XMODEL_ROOT_BONE_NAME
SKEL_MAT = 64  # sizeof(DObjSkelMat): a bone offset in a vertex list or blend is bone index * this
PACKED_VERTEX = struct.Struct("<3f4x4BIII")  # xyz, binormalSign, rgba, texCoord, normal, tangent
ANIM_MAT = struct.Struct("<4f3f4x")  # DObjAnimMat: quat, trans, transWeight
TS_COLOR_MAP, TS_NORMAL_MAP = 2, 5
# T5's colour maps include TS_COLOR0_MAP..TS_COLOR15_MAP (0xC-0x1B), which IW's enum has not.
COLOUR_MAPS = {"t5": {TS_COLOR_MAP, *range(0xC, 0x1C)}, "t6": {TS_COLOR_MAP, *range(0xC, 0x1C)}}
WEIGHT_SCALE = 65535.0


def lod_file(name, lod):
    return f"{FOLDER}/{name}_lod{lod}.glb"


def f32(x):
    return struct.unpack("<f", struct.pack("<f", x))[0]


def surfaces(model, lod):
    """The XSurface records of one LOD, or None when its XModelSurfs holds none (another zone's).
    T5 keeps every LOD's surfaces on the model, each LOD a run of them from its `surfIndex`."""
    if "surfs" in model:
        surfs = model["surfs"]
        if surfs is None:
            return None
        first = model[f"lodInfo[{lod}].surfIndex"]
        return list(surfs)[first : first + model[f"lodInfo[{lod}].numsurfs"]]
    return surface_list(model[f"lodInfo[{lod}].modelSurfs"])


def surface_list(model_surfs):
    """An XModelSurfs' XSurface records, or None when it holds none (another zone's)."""
    surfs = getattr(model_surfs, "record", model_surfs)  # IW5's is an asset, IW4's the record SetModelSurfs kept
    if surfs is None or surfs["surfs"] is None:
        return None
    return list(surfs["surfs"])[: surfs["numsurfs"]]


def surfaces_name(model, lod):
    """The name of the XModelSurfs a LOD's geometry is, or None where there is none (T5)."""
    key = f"lodInfo[{lod}].modelSurfs"
    surfs = model[key] if key in model else None
    if surfs is None:
        return None
    return surfs.name if isinstance(surfs, Asset) else surfs["name"]


@holds("surfaces")
def held_surfaces(walk):
    """{name: XModelSurfs} of every XModelSurfs `walk` holds the surfaces of: IW5's assets,
    and the headers IW4's models keep. What a map's comma-named LOD is looked up in."""
    held = {}
    candidates = [(a.name, a) for a in walk.by_type("xmodelsurfs")]
    for model in walk.by_type("xmodel"):
        for lod in range(model.record["numLods"]):
            name = surfaces_name(model.record, lod)
            if name is not None:
                candidates.append((name, model.record[f"lodInfo[{lod}].modelSurfs"]))
    for name, surfs in candidates:
        if not name.startswith(",") and name not in held and surface_list(surfs) is not None:
            held[name] = surfs
    return held


def resolve_foreign(walk, models, companions):
    """{(model name, lod): [XSurface]} for each LOD of `models` whose surfaces are another
    zone's, from the companion zones; and the (model, lod, surfaces name) none of them holds."""
    wanted = []
    for asset in models:
        model = asset.record
        for lod in range(model["numLods"]):
            name = surfaces_name(model, lod)
            if name is not None and name.startswith(",") and surfaces(model, lod) is None:
                wanted.append((asset.name, lod, name))
    found = companions.find("surfaces", {name[1:] for _, _, name in wanted}) if wanted and companions else {}
    resolved = {(model, lod): surface_list(found[name[1:]]) for model, lod, name in wanted if name[1:] in found}
    return resolved, [w for w in wanted if (w[0], w[1]) not in resolved]


def has_default_armature(model, lods):
    """One bone, and every surface of every LOD one rigid list over all of it (OAT
    HasDefaultArmatureForAllLods): OAT then writes no skeleton, only the bone's name."""
    if model["numBones"] != 1 or model["numRootBones"] != 1:
        return False
    for surfs in lods:
        for s in surfs or ():
            lists = s["vertList"]
            if s["vertListCount"] != 1 or s["vertInfo.vertsBlend"] is not None or lists is None:
                return False
            first = lists[0]
            if (first["boneOffset"], first["triOffset"]) != (0, 0):
                return False
            if (first["triCount"], first["vertCount"]) != (s["triCount"], s["vertCount"]):
                return False
    return True


def model_type(model, lods):
    """OAT GetType: rigid unless some surface blends; viewhands when, besides, every local
    translation is zero and some bone's bounds are not centred on it."""
    if not any(s["vertInfo.vertsBlend"] is not None for surfs in lods for s in surfs or ()):
        return "rigid"
    trans = model["trans"]
    count = 3 * (model["numBones"] - model["numRootBones"])
    nulled = trans is None or not any(struct.unpack_from(f"<{count}f", trans.bytes()))
    info = model["boneInfo"]
    offset = info is not None and any(any(bone_offset(bone)) for bone in info)
    return "viewhands" if nulled and offset else "animated"


def bone_offset(info):
    """An XBoneInfo's offset from its bone: IW4/IW5 store the bounds' midpoint, T5 an `offset`."""
    return info.unpack("<3f", "offset" if "offset" in info else "bounds")


def bone_names(walk, model):
    """Script string 0 is the empty name, which OAT reads as its default root bone."""
    names = model["boneNames"]
    count = len(walk.script_strings)
    return (
        [(walk.script_string(i) or "") if i < count else "INVALID_BONE_NAME" for (i,) in names.unpack("<H")]
        if names is not None
        else []
    )


def skeleton(walk, model):
    """[xmodel_glb.Bone] in model space, from each bone's base matrix (OAT AddXModelBones)."""
    count, roots = model["numBones"], model["numRootBones"]
    names = bone_names(walk, model)
    parents = bytes(model["parentList"].bytes()) if model["parentList"] is not None else b""
    mats = list(model["baseMat"].unpack(ANIM_MAT.format)) if model["baseMat"] is not None else []
    bones = []
    for i in range(count):
        parent = None if i < roots else i - parents[i - roots]
        quat, trans = mats[i][:4], mats[i][4:7]
        bones.append(glb.Bone(names[i], parent, tuple(trans), (quat[0], quat[1], quat[2], quat[3])))
    return bones


def iw_tex_coords(packed):
    return half(packed >> 16), half(packed & 0xFFFF)


# (normal, texture coordinates) decoders by game; IW's everywhere but Black Ops II.
PACKING_BY_GAME = {"t6": (t6_vertices.unit_vec, t6_vertices.tex_coords)}


def vertices(surface, game=None):
    """[(xyz, normal, uv, rgba 0..1)] of one XSurface."""
    out = []
    verts = surface["verts0"]
    if verts is None:
        return out
    unit_vec, tex_coords = PACKING_BY_GAME.get(game, (unpack_unit_vec, iw_tex_coords))
    for x, y, z, r, g, b, a, uv, normal, _tangent in PACKED_VERTEX.iter_unpack(verts.bytes()[: 32 * surface["vertCount"]]):
        out.append(
            (
                (x, y, z),
                tuple(unit_vec(normal)),
                tex_coords(uv),
                (r / 255.0, g / 255.0, b / 255.0, a / 255.0),
            )
        )
    return out


def surface_weights(surface):
    """[(bone, weight)] per vertex, as OAT orders them: rigid lists, then blends, then none."""
    out = []
    lists = surface["vertList"]
    for entry in list(lists or ())[: surface["vertListCount"]]:
        out.extend([[(entry["boneOffset"] // SKEL_MAT, 1.0)]] * entry["vertCount"])
    blend = surface["vertInfo.vertsBlend"]
    if blend is not None:
        counts = surface["vertInfo.vertCount"]
        values = [v for (v,) in blend.unpack("<H")]
        at = 0
        for n, count in enumerate(counts):
            for _ in range(count):
                bones = [values[at] // SKEL_MAT]
                weights = []
                for k in range(n):
                    bones.append(values[at + 1 + 2 * k] // SKEL_MAT)
                    weights.append(f32(values[at + 2 + 2 * k] / WEIGHT_SCALE))
                first = 1.0
                for w in weights:
                    first = f32(first - w)
                out.append(list(zip(bones, [first, *weights], strict=True)))
                at += 1 + 2 * n
    out.extend([[]] * (surface["vertCount"] - len(out)))
    return out


def texture_of(material, semantics, preferred, fold=True):
    """A material's image for one of `semantics`, chosen as OAT's GetMaterialColorMap / NormalMap choose:
    the colour map's first and last letters compared folded, the normal map's as they are (`fold`),
    so T5's `Normal_Map` loses to the `Detail_Map` before it, as it does in OAT."""
    table = material.record["textureTable"] if material is not None else None
    count = material.record["textureCount"] if material is not None else 0
    found = [t for t in list(table or ())[:count] if t["semantic"] in semantics]
    if not found:
        return None
    pick = found[0]
    if len(found) > 1:
        for start, end in preferred:
            ends = ((chr(t["nameStart"] & 0xFF), chr(t["nameEnd"] & 0xFF)) for t in found)
            match = [
                t for t, (a, b) in zip(found, ends, strict=True) if ((a.lower(), b.lower()) if fold else (a, b)) == (start, end)
            ]
            if match:
                pick = match[0]
                break
    info = pick["u"] if "u" in pick else pick  # T6 holds the image on the texture itself
    return plain(info["image"]) if info is not None else None


COLOUR_PREFERENCE = (("c", "p"), ("r", "k"), ("d", "p"))
NORMAL_PREFERENCE = (("n", "p"),)


def lod_data(walk, model, name, index, surfs, bones, stats):
    """xmodel_glb.ModelLodData for one LOD (OAT ToCommonConverterIW5.Convert)."""
    # A base matrix's quaternion is not unit length (its transWeight is 2 / |q|^2, which
    # the game scales by); OAT builds the bones from it as stored.
    lod = glb.ModelLodData(f"{name}_lod{index}", stored_rotations=True)
    handles = list(model["materialHandles"] or ())[: model["numsurfs"]]
    distinct = {}
    for material in handles:
        key = material.name if material is not None else ""
        if key not in distinct:
            distinct[key] = len(lod.materials)
            lod.materials.append(
                glb.ModelMaterial(
                    plain(material) or "",
                    texture_of(material, COLOUR_MAPS.get(walk.game, {TS_COLOR_MAP}), COLOUR_PREFERENCE),
                    texture_of(material, {TS_NORMAL_MAP}, NORMAL_PREFERENCE, fold=False),
                )
            )
    info = f"lodInfo[{index}]"
    base = model[f"{info}.surfIndex"]
    weighted = bool(bones) and any(s["vertListCount"] or s["vertInfo.vertsBlend"] is not None for s in surfs or ())
    lod.weights = [] if weighted else None
    for i in range(model[f"{info}.numsurfs"]):
        material = handles[base + i] if base + i < len(handles) else None
        surface = surfs[i] if surfs is not None and i < len(surfs) else None
        triangles = []
        if surface is not None:
            if surface["baseVertIndex"] != len(lod.positions):
                stats["surfaces not at their base vertex"] += 1
            for position, normal, uv, rgba in vertices(surface, walk.game):
                lod.positions.append(position)
                lod.normals.append(normal)
                lod.uvs.append(uv)
                lod.colours.append(rgba)
            tris = surface["triIndices"]
            if tris is not None:
                flat = struct.unpack_from(f"<{3 * surface['triCount']}H", tris.bytes())
                triangles = [flat[k : k + 3] for k in range(0, len(flat), 3)]
            if weighted:
                lod.weights.extend(surface_weights(surface))
        key = material.name if material is not None else ""
        lod.surfaces.append(glb.Surface(distinct.get(key, 0), surface["baseVertIndex"] if surface is not None else 0, triangles))
    lod.bones = bones
    return lod


def model_json(walk, asset, lods, kind, armature_omitted):
    model = asset.record
    data = {"$schema": SCHEMA, "_game": walk.game, "_type": "xmodel", "_version": 2}
    coll = struct.unpack("<b", bytes([model["collLod"] & 0xFF]))[0]
    if coll >= 0:
        data["collLod"] = coll
    if model["contents"]:
        data["contents"] = model["contents"]
    data["flags"] = model["flags"]
    data["lods"] = [{"distance": model[f"lodInfo[{i}].dist"], "file": lod_file(asset.name, i)} for i in range(model["numLods"])]
    for key in ("physCollmap", "physConstraints", "physPreset"):  # T5 has no collmap, IW no constraints
        if key in model and plain(model[key]):
            data[key] = plain(model[key])
    if armature_omitted and model["numRootBones"]:
        names = bone_names(walk, model)
        if names and names[0] != DEFAULT_ROOT_BONE:
            data["rootBoneName"] = names[0]
    data["type"] = kind
    return data


@dumper("xmodel")
def write(walk, out, ctx=None):
    found = walk.by_type("xmodel")
    stats = Counter()
    own = [asset for asset in found if not asset.name.startswith(",")]
    foreign, missing = resolve_foreign(walk, own, ctx.companions if ctx is not None else None)
    for asset in found:
        if asset.name.startswith(","):
            stats["stubs"] += 1
            continue
        model = asset.record
        lods = [surfaces(model, i) for i in range(model["numLods"])]
        for i in range(len(lods)):
            if (asset.name, i) in foreign:
                lods[i] = foreign[asset.name, i]
                stats["LODs from a companion zone"] += 1
                if len(lods[i]) != model[f"lodInfo[{i}].numsurfs"]:
                    stats["of them with another surface count"] += 1
        omitted = has_default_armature(model, lods)
        bones = [] if omitted else skeleton(walk, model)
        kind = model_type(model, lods)
        write_json(asset_path(out, f"xmodel/{asset.name}.json"), model_json(walk, asset, lods, kind, omitted))
        stats["models"] += 1
        for index, surfs in enumerate(lods):
            stats["other zones' LODs"] += surfs is None
            glb.write(asset_path(out, lod_file(asset.name, index)), lod_data(walk, model, asset.name, index, surfs, bones, stats))
            stats["glbs"] += 1
    line = f"      {stats['models']} of {len(found)} models written ({stats['glbs']} LOD files)"
    for key in (
        "stubs",
        "LODs from a companion zone",
        "of them with another surface count",
        "other zones' LODs",
        "surfaces not at their base vertex",
    ):
        if stats[key]:
            line += f"; {stats[key]} {key}"
    print(line)
    if missing:
        named = ", ".join(f"{model} LOD {lod} ({name})" for model, lod, name in missing[:6])
        more = f" and {len(missing) - 6} more" if len(missing) > 6 else ""
        print(f"      WARNING: no companion zone walked holds the surfaces of {named}{more}: written with no vertices")
