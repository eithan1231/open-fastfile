"""Walk an Advanced Warfare zone asset by asset, and keep what a dump needs.

    python3 -m scripts.cod.s1.walkers <map.ff> [--show N]

A zone is a dense stream: each asset's loader consumes exactly the bytes it
wrote, so reaching any asset means consuming every asset before it. There is no
seeking and no skipping. The CLI above is the evidence for that: it reports
where a walk stopped, and -- when it does not -- that the zone ended on its last
byte and every block cursor landed on the size the zone's own header declares.

The block model, the pointer rules and the Zone itself are IW6's
(`scripts/cod/iw6/zone.py`); a zone of either game is laid out the same way, and
`records.py` is shared with it for the same reason. Only the layout and the
walkers below are S1's. How the format was established: reverse/s1-zone/README.md.
"""

import collections
import json
import os
import struct
import sys
from collections import namedtuple
from dataclasses import dataclass

from .. import config
from ..iw6 import records as iw6_records
from ..iw6.records import Image, ImageStream, Material, Model, ModelLod, ModelSurfs, Placement, Raw, Surface, TextureDef
from ..iw6.zone import (
    CALLBACK,
    INSERT,
    KIND_POINTER,
    RUNTIME,
    SCRIPT,
    TEMP,
    VIRTUAL,
    Field,
    Zone,
    follows,
    is_pointer,
    reference,
)
from ..iw6.zone import Layout as Iw6Layout
from . import assets, ff

# Generated from x64-zt's s1 headers (GPL-3) by reverse/s1-zone (its README, "Struct
# layouts"), and shipped in scripts/cod/data/. $S1_LAYOUT names another copy.
DATA = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "s1")
LAYOUT = os.environ.get("S1_LAYOUT", os.path.join(DATA, "layout_pc.json"))
# x64-zt declares the PC build's structs but leaves a few assets unimplemented
# (impact fx, surface fx, sound submixes, reverb presets). The X360-derived layout
# carries those, and nothing else: a struct is taken from it only when x64-zt has
# never heard of it. It is derived from a development build's PDB, so it is never
# shipped; the user names it, and a map whose zone holds none of those assets needs none.
FALLBACK_KEY = "s1_layout_x360"


def fallback():
    """The X360-derived layout's path ($S1_LAYOUT_X360, else cod.config.json's `s1_layout_x360`), or None."""
    return config.data_path(FALLBACK_KEY)[0]


class MissingStruct(KeyError):
    """A struct only the X360-derived layout declares, asked for without it. Still a KeyError, so a walk
    records it as the asset it stopped at, as before; only the message is new."""

    def __str__(self):
        return self.args[0]


class Layout(Iw6Layout):
    """IW6's Layout over S1's rows. Its own __init__ would merge IW6's types in."""

    def __init__(self, path=LAYOUT):
        if not os.path.exists(path):
            raise FileNotFoundError(f"no S1 struct layout at {path}: it ships in scripts/cod/data/ (scripts/cod/data/README.md)")
        with open(path, encoding="utf-8") as fh:
            rows = json.load(fh)
        x360 = fallback()
        self.x360 = x360 if x360 and os.path.exists(x360) else None
        if self.x360:
            declared = {row[0] for row in rows}
            with open(self.x360, encoding="utf-8") as fh:
                rows += [row for row in json.load(fh) if row[0] not in declared]
        self.sizes, self.fields = {}, {}
        for typename, member, offset, size, elem, pointee, kind, e0, e1, base in rows:
            if not typename:
                continue
            members = self.fields.setdefault(typename, {})
            if member:
                members[member] = Field(offset, size, elem, pointee, kind, e0, e1, base)
            else:
                self.sizes[typename] = size
        self._declare_impact_entry()
        for typename, (size, members) in DECLARED.items():
            self.sizes[typename] = size
            self.fields[typename] = {name: Field(*row) for name, row in members.items()}
        self._name_damage_tiers()
        self._cache = {}

    def size(self, typename):
        if typename not in self.sizes and self.x360 is None:
            raise MissingStruct(
                f"{typename} is declared only by the X360-derived layout (layout.json), which this map's zone needs: "
                f"set cod.config.json's `{FALLBACK_KEY}` or $S1_LAYOUT_X360 to it "
                "(docs/cod/README.md#ghosts-and-advanced-warfare)"
            )
        return self.sizes[typename]

    def _name_damage_tiers(self):
        """Swap x64-zt's `min*Damage` and `mid*Damage`, which it declares the wrong way round.

        Read its way, every one of AW's guns falls to "mid" and climbs back to
        "min" with range; swapped, all of them fall monotonically, and the one
        block whose order its names fix (`signature*`: Damage, Mid, Min) runs the
        same way. The weapon dumper re-checks this on every zone (README.md#the-weapons)."""
        members = self.fields.get("WeaponDef", {})
        for low, mid in (("minDamage", "midDamage"), ("minPlayerDamage", "midPlayerDamage")):
            if low in members and mid in members:
                members[low], members[mid] = members[mid], members[low]

    def _declare_impact_entry(self):
        """FxImpactEntry, which neither source gets right for the PC build."""
        self.sizes["FxImpactEntry"] = 8 * (FX_NONFLESH + FX_FLESH)
        self.fields["FxImpactEntry"] = {
            "nonflesh": Field(0, 8 * FX_NONFLESH, 8, 64, KIND_POINTER, FX_NONFLESH, 0, "FxEffectDef"),
            "flesh": Field(8 * FX_NONFLESH, 8 * FX_FLESH, 8, 64, KIND_POINTER, FX_FLESH, 0, "FxEffectDef"),
        }


U8, U16, U32, F32, PTR = (1, 1), (2, 1), (4, 1), (4, 3), (8, 4)  # (element size, Field kind) of a member


def _declared(size, *members):
    """A struct neither generated layout has right, member by member:
    (name, offset, (element size, kind), count, pointee size, pointee type)."""
    fields = {}
    for name, offset, (elem, kind), count, pointee, base in members:
        fields[name] = (offset, elem * max(count, 1), elem, pointee, kind, count, 0, base)
    return size, fields


# Structs S1 writes that x64-zt's s1/ header omits and the X360 PDB gets wrong for the
# PC (its scr_string_t is 2 bytes, the PC's 4). Each is x64-zt's **H1** struct, and
# each walker's comment says what in the zone settled it.
DECLARED = {
    "VectorField": _declared(
        48,
        ("name", 0, PTR, 0, 1, ""),
        ("fields", 8, PTR, 0, 80, "VectorFieldSubField"),
        ("bounds", 16, F32, 6, 0, ""),
        ("fieldsCount", 40, U32, 0, 0, ""),
    ),
    "VectorFieldSubField": _declared(
        80,
        ("linearData", 0, PTR, 0, 16, ""),
        ("worldBounds", 8, F32, 6, 0, ""),
        ("ds", 32, F32, 3, 0, ""),
        ("numEntries", 44, U32, 3, 0, ""),
        ("flags", 56, U32, 0, 0, ""),
        ("type", 60, U32, 0, 0, ""),
    ),
    "AnimationClass": _declared(
        88,
        ("className", 0, PTR, 0, 1, ""),
        ("stateMachine", 8, PTR, 0, 24, "AnimationStateMachine"),
        ("animCtrl", 16, U32, 0, 0, ""),
        ("animTree", 20, U32, 0, 0, ""),
        ("scriptable", 24, PTR, 0, 64, "ScriptableDef"),
        ("soundCount", 32, U16, 0, 0, ""),
        ("effectCount", 34, U16, 0, 0, ""),
        ("soundNotes", 40, PTR, 0, 4, ""),
        ("soundNames", 48, PTR, 0, 4, ""),
        ("soundOptions", 56, PTR, 0, 4, ""),
        ("effectNotes", 64, PTR, 0, 4, ""),
        ("effectDefs", 72, PTR, 0, 8, ""),
        ("effectTags", 80, PTR, 0, 4, ""),
    ),
    "AnimationStateMachine": _declared(
        24,
        ("name", 0, U32, 0, 0, ""),
        ("stateCount", 4, U16, 0, 0, ""),
        ("aimSetCount", 6, U16, 0, 0, ""),
        ("states", 8, PTR, 0, 40, "AnimationState"),
        ("aimSets", 16, PTR, 0, 112, "AnimationAimSet"),
    ),
    "EquipmentSoundTable": _declared(
        88,
        ("szName", 0, PTR, 0, 1, ""),
        ("numClothTypes", 8, U32, 0, 0, ""),
        ("numWeaponRattleTypes", 12, U32, 0, 0, ""),
        ("numMoveTypes", 16, U32, 0, 0, ""),
        ("clothTypes", 24, PTR, 0, 8, ""),
        ("weaponRattleTypes", 32, PTR, 0, 16, ""),
        ("chancesPLR", 40, PTR, 0, 8, ""),
        ("chancesNPC", 48, PTR, 0, 8, ""),
        ("mvmtClothSoundSets", 56, PTR, 0, 8, ""),
        ("mvmtRattleSoundSets", 64, PTR, 0, 8, ""),
        ("mvmtAccentSoundSets", 72, PTR, 0, 16, ""),
        ("mvmtMantleSoundSets", 80, PTR, 0, 224, ""),
    ),
    "AnimationState": _declared(
        40,
        ("name", 0, U32, 0, 0, ""),
        ("notify", 4, U32, 0, 0, ""),
        ("blendTime", 8, F32, 0, 0, ""),
        ("flags", 12, U8, 0, 0, ""),
        ("entryCount", 13, U8, 0, 0, ""),
        ("aimSet", 16, PTR, 0, 112, "AnimationAimSet"),
        ("animEntries", 24, PTR, 0, 8, ""),
        ("animIndices", 32, PTR, 0, 8, ""),
    ),
}


@dataclass
class S1Surface(Surface):
    """IW6's Surface, plus where S1's `unknown0` landed: per vertex a float position and a
    packed normal, which is the independent check on how verts0 decodes (README.md#the-models)."""

    positions: int | None = None


WALKERS = {}


def asset(z, typename, value, storage=None):
    """A handle to an asset of `typename` (an XAssetType name without ASSET_TYPE_)."""
    return z.handle(value, WALKERS[typename], typename, storage)


def field_asset(z, record, path, typename):
    """A handle to an asset of `typename` stored in one of a record's fields.

    A reference resolves without a walker; only an asset that follows inline needs
    one, so a missing walker is an error just where it would actually be read.
    """
    value = record[path]
    if follows(value) and typename not in WALKERS:
        raise NotImplementedError(f"{record.type}.{path} carries an inline {typename}, which has no walker")
    return z.handle(value, WALKERS.get(typename), typename, record.address(path))


def walker(*types):
    def register(fn):
        for t in types:
            WALKERS[t] = fn
        return fn

    return register


# --- walkers ----------------------------------------------------------------
# Each is entered with the zone at the asset's header and returns its name. The
# shape of every struct below is IW6's, member for member, so these are ports.


@walker("NET_CONST_STRINGS")
def net_const_strings(z):
    ncs = z.struct("NetConstStrings")
    z.push(VIRTUAL)
    name = z.field_string(ncs, "name")
    start = z.elements(ncs, "stringList", ncs["entryCount"], align=7)
    z.strings_at(start, ncs["entryCount"])
    z.pop()
    return name


WATER = 11  # MaterialTextureDef.semantic for a water_t rather than an image
IMAGE_STREAMS = 4  # GfxImage.streams, and the XStreamFile entries a streamed image takes
STREAM_DATA = struct.Struct("<HHI")  # GfxImageStreamData: width, height, pixelSize:26 | levelCount:6


@walker("IMAGE")
def image(z):
    img = z.struct("GfxImage")
    z.push(VIRTUAL)
    name = z.field_string(img, "name")
    pixels = z.aliased(img, "pixelData", 1 if img["semantic"] == WATER else img["dataLen1"], align=3)
    z.pop()
    # GfxImage is byte-for-byte IW6's, so images.py reads IW6's record.
    record = Image(
        name,
        img["imageFormat"],
        img["mapType"],
        img["semantic"],
        img["width"],
        img["height"],
        img["depth"],
        img["numElements"],
        img["levelCount"],
        pixels,
        img["dataLen1"],
    )
    if img["streamed"]:
        at = img.at + z.layout.resolve("GfxImage", "streams")[0]
        for k in range(IMAGE_STREAMS):
            width, height, packed = STREAM_DATA.unpack_from(z.data, at + STREAM_DATA.size * k)
            record.streams.append(ImageStream(width, height, packed >> 26, packed & 0x3FFFFFF))
        record.stream_files = z.take_stream_files(IMAGE_STREAMS)
    z.record("IMAGE", name, record)
    return name


@walker("MATERIAL")
def material(z):
    mat = z.struct("Material")
    z.push(VIRTUAL)
    name = z.field_string(mat, "name")
    techset = field_asset(z, mat, "techniqueSet", "TECHNIQUE_SET")
    # The callback block takes four bytes per texture whether or not this material
    # carries the table itself: a material that aliases another's still gets them.
    z.blocks[CALLBACK] += 4 * mat["textureCount"]
    textures = []
    if follows(mat["textureTable"]):
        z.align(3)
        for tex in z.array("MaterialTextureDef", mat["textureCount"]):
            image = None
            if tex["semantic"] == WATER:
                if follows(tex["u.image"]):
                    raise NotImplementedError(f"material {name}: water texture")
            else:
                image = field_asset(z, tex, "u.image", "IMAGE")
            ends = (chr(tex["nameStart"] & 0xFF), chr(tex["nameEnd"] & 0xFF))
            textures.append(TextureDef(tex["nameHash"], *ends, tex["samplerState"], tex["semantic"], image and image[1]))
    constants = z.elements(mat, "constantTable", mat["constantCount"], align=15)
    state_bits = z.elements(mat, "stateBitsTable", mat["stateBitsCount"], align=3)
    if follows(mat["constantBufferTable"]):
        z.align(3)
        for cb in z.array("MaterialConstantBufferDef", mat["constantBufferCount"]):
            for stage in ("vs", "hs", "ds", "ps"):
                z.elements(cb, f"{stage}Data", cb[f"{stage}DataSize"], align=15)
            for stage in ("vs", "hs", "ds", "ps"):
                z.elements(cb, f"{stage}OffsetData", cb[f"{stage}OffsetDataSize"], align=1)
            cb.touch("vsConstantBuffer", "hsConstantBuffer", "dsConstantBuffer", "psConstantBuffer")
    if follows(mat["subMaterials"]):
        start = z.elements(mat, "subMaterials", mat["layerCount"], align=7)
        z.strings_at(start, mat["layerCount"])
    z.pop()
    z.record("MATERIAL", name, Material(name, mat.at, techset and techset[1], textures, state_bits, constants))
    return name


@walker("LIGHT_DEF")
def light_def(z):
    light = z.struct("GfxLightDef")
    z.push(VIRTUAL)
    name = z.field_string(light, "name")
    field_asset(z, light, "attenuation.image", "IMAGE")
    field_asset(z, light, "cucoloris.image", "IMAGE")
    z.pop()
    return name


@walker("TECHNIQUE_SET")
def technique_set(z):
    ts = z.struct("MaterialTechniqueSet")
    z.push(VIRTUAL)
    name = z.field_string(ts, "name")
    # S1 has 180 technique slots where IW6 has 412; the layout knows which.
    for t in range(z.layout.fields["MaterialTechniqueSet"]["techniques"].extents[0]):
        if not follows(ts[f"techniques[{t}]"]):
            continue
        z.align(3)
        hdr = z.struct("MaterialTechniqueHeader")
        for p in z.array("MaterialPass", hdr["passCount"]):
            field_asset(z, p, "vertexShader", "VERTEXSHADER")
            field_asset(z, p, "vertexDecl", "VERTEXDECL")
            field_asset(z, p, "hullShader", "HULLSHADER")
            field_asset(z, p, "domainShader", "DOMAINSHADER")
            field_asset(z, p, "pixelShader", "PIXELSHADER")
            count = p["perPrimArgCount"] + p["perObjArgCount"] + p["stableArgCount"]
            if follows(p["args"]):
                z.align(3)
                for arg in z.array("MaterialShaderArgument", count):
                    if arg["type"] == 4:
                        z.elements(arg, "u.literalConst", 4, align=3, size=4)
                    else:
                        arg.touch("u.literalConst")
        z.field_string(hdr, "name")
    z.pop()
    return name


@walker("VERTEXDECL")
def vertex_decl(z):
    decl = z.struct("MaterialVertexDeclaration")
    z.push(VIRTUAL)
    name = z.field_string(decl, "name")
    z.pop()
    return name


def _shader(typename, block):
    """Every shader kind; they differ only in their struct and in where the bytecode goes.

    **Only a vertex program stays in VIRTUAL**; every other kind loads into TEMP,
    the block the loader reuses. IW6 splits them the other way round. D3D11 is the
    reason: `CreateInputLayout` needs a vertex shader's input signature, so that
    bytecode has to outlive shader creation, and nothing else's does.

    The split was measured rather than guessed. `techsets_common_core_mp` walks to
    its last byte whatever we assume, so the evidence is its block sizes: its
    bytecode is 5,724,608 bytes in total but its VIRTUAL block is only 328,552
    larger than a walk that puts none of it there -- and its 140 vertex programs are
    328,468 of those bytes, the rest being their alignment. Its TEMP block is 34,444,
    which is one shader: a high-water mark, not a total.
    """

    def walk(z):
        shader = z.struct(typename)
        z.push(VIRTUAL)
        name = z.field_string(shader, "name")
        # S1 shares shader bytecode between shaders, so the pointer can be -2 (a
        # slot the loader inserts) as well as -1. elements() refuses -2; aliased()
        # is the path that reserves the slot.
        z.aliased(shader, "prog.loadDef.program", shader["prog.loadDef.programSize"], align=3, block=block)
        z.pop()
        return name

    return walk


walker("VERTEXSHADER")(_shader("MaterialVertexShader", VIRTUAL))
walker("PIXELSHADER")(_shader("MaterialPixelShader", TEMP))
walker("HULLSHADER")(_shader("MaterialHullShader", TEMP))
walker("DOMAINSHADER")(_shader("MaterialDomainShader", TEMP))
walker("COMPUTESHADER")(_shader("MaterialComputeShader", TEMP))


# FxElemType, from x64-zt's S1 enum. S1 adds two sprite types ahead of IW6's, so
# TRAIL, FLARE and PARTICLE_SIM sit two higher; everything from SPARK_FOUNTAIN on
# is numbered as IW6's PC build has it.
FX_TRAIL, FX_FLARE, FX_PARTICLE_SIM = 5, 6, 7
FX_SPARK_FOUNTAIN, FX_MODEL, FX_OMNI_LIGHT, FX_SPOT_LIGHT = 10, 11, 12, 13
FX_SOUND, FX_DECAL, FX_RUNNER, FX_VECTORFIELD = 14, 15, 16, 17
EXTENDED_DEFS = {
    FX_SPARK_FOUNTAIN: "FxSparkFountainDef",
    FX_SPOT_LIGHT: "FxSpotLightDef",
    FX_OMNI_LIGHT: "FxOmniLightDef",
}


def fx_visual(z, elem_type, value, storage):
    """One FxElemVisuals, loaded by element type (Load_FxElemVisuals)."""
    if elem_type == FX_MODEL:
        asset(z, "XMODEL", value, storage)
    elif elem_type in (FX_RUNNER, FX_SOUND, FX_VECTORFIELD):
        z.string(value)
    elif elem_type == FX_PARTICLE_SIM:
        asset(z, "PARTICLE_SIM_ANIMATION", value, storage)
    elif elem_type == FX_SPOT_LIGHT:
        asset(z, "LIGHT_DEF", value, storage)
    elif elem_type != FX_OMNI_LIGHT:
        asset(z, "MATERIAL", value, storage)


def fx_elem_def(z, e):
    kind, count = e["elemType"], e["visualCount"]
    z.elements(e, "velSamples", e["velIntervalCount"] + 1, align=3)
    z.elements(e, "visSamples", e["visStateIntervalCount"] + 1, align=3)
    e.touch("visuals.instance.anonymous")
    if kind == FX_DECAL:
        if follows(e["visuals.markArray"]):
            z.align(3)
            for mark in z.array("FxElemMarkVisuals", count):
                for k in range(2):  # S1 has two decal materials; IW6 has three
                    field_asset(z, mark, f"materials[{k}]", "MATERIAL")
    elif count > 1:
        if follows(e["visuals.array"]):
            z.align(3)
            block, cursor = z.block, z.blocks[z.block]
            start = z.take(8 * count)
            for i in range(count):
                fx_visual(z, kind, z.u64(start + 8 * i), (block, cursor + 8 * i))
    else:
        fx_visual(z, kind, e["visuals.instance.anonymous"], e.address("visuals"))
    for path in ("effectOnImpact", "effectOnDeath", "effectEmitted"):
        z.field_string(e, path + ".name")
        e.touch(path + ".handle")
    extended = e["extended.trailDef"]
    e.touch(
        "extended.sparkFountainDef", "extended.spotLightDef", "extended.flareDef", "extended.omniLightDef", "extended.unknownDef"
    )
    if kind == FX_TRAIL:
        if follows(extended):
            z.align(3)
            trail = z.struct("FxTrailDef")
            z.elements(trail, "verts", trail["vertCount"], align=3)
            z.elements(trail, "inds", trail["indCount"], align=1)
    elif kind in EXTENDED_DEFS:
        # S1 gives an omni light an extended def of its own; IW6 has no such struct
        # and its walker falls through to the one-byte read, which desyncs here.
        if follows(extended):
            z.align(3)
            z.take(z.layout.size(EXTENDED_DEFS[kind]))
    elif kind == FX_FLARE:
        if follows(extended):
            z.align(3)
            flare = z.struct("FxFlareDef")
            for path in ("intensityX", "intensityY", "srcCosIntensity", "srcCosScale"):
                z.elements(flare, path, flare[path + "IntervalCount"] + 1, align=3)
    elif extended:
        z.take(1)  # Load_FxElemExtendedDefPtr loads one byte for any other non-null pointer


@walker("FX")
def fx(z):
    d = z.struct("FxEffectDef")
    z.push(VIRTUAL)
    name = z.field_string(d, "name")
    count = d["elemDefCountLooping"] + d["elemDefCountOneShot"] + d["elemDefCountEmission"]
    if follows(d["elemDefs"]):
        z.align(3)
        for e in z.array("FxElemDef", count):
            fx_elem_def(z, e)
    z.pop()
    return name


# XSurface pointers the loader nulls: D3D11 handles that occupy header bytes but
# are never followed, so nothing of theirs is in the stream.
XSURFACE_RUNTIME = (
    "vb0",
    "vb0View",
    "indexBuffer",
    "blendVertsBuffer",
    "blendVertsView",
    "vblmapBuffer",
    "vblmapView",
    "tensionAccumTableBuffer",
    "tensionAccumTableView",
    "tensionDataBuffer",
    "tensionDataView",
    "indexBufferView",
)
SUBDIV_RUNTIME = (
    "regularPatchIndexBuffer",
    "faceIndexBuffer",
    "regularPatchIndexBufferView",
    "regularPatchFlagsView",
    "facePointsView",
    "edgePointsView",
    "vertexPointsView",
    "normalsView",
    "transitionPointsView",
    "regularPatchConesView",
)
SURF_FLAG_MOTION = 0x8  # verts0 holds packed motion vertices; both kinds are 32 bytes
BLEND_WEIGHTS = (1, 3, 5, 7, 9, 11, 13, 15)  # u16s per blended vertex, by bone count
# GfxVertexUnion0 is one pointer read three ways; the PC build writes the two
# 32-byte packed kinds only (the X360 PDB's quantised ones are not in these zones).
VERTS0 = ("verts0.packedVerts0", "verts0.packedMotionVerts0")


def xsurface(z, surf):
    """One XSurface's trailing data, and its geometry as an S1Surface. Four things differ
    from IW6 and each moves bytes: triIndices2, unknown0, a half-float lmapUnwrap, and
    the blend shapes at the end. Arrays aliasing an earlier surface's are read there."""
    verts, tris = surf["vertCount"], surf["triCount"]
    surf.touch(*XSURFACE_RUNTIME, *VERTS0)
    vertices = z.elements(surf, "verts0.verts0", verts, align=15, size=32)
    triangles = z.elements(surf, "triIndices", tris, align=15, size=6)
    z.elements(surf, "triIndices2", tris, align=15, size=6)  # S1 only
    rigid_lists = None
    if follows(surf["rigidVertLists"]):
        z.align(3)
        lists = z.array("XRigidVertList", surf["rigidVertListCount"])
        rigid_lists = lists[0].at if lists else None
        for rigid in lists:
            if follows(rigid["collisionTree"]):
                z.align(3)
                tree = z.struct("XSurfaceCollisionTree")
                z.elements(tree, "nodes", tree["nodeCount"], align=15)  # nodes before leafs
                z.elements(tree, "leafs", tree["leafCount"], align=1)
    positions = z.elements(surf, "unknown0", verts, align=15, size=16)  # S1 only
    counts = struct.unpack("<8h", surf.bytes("blendVertCounts"))
    blended = sum(w * n for w, n in zip(BLEND_WEIGHTS, counts, strict=True))
    blend_verts = z.elements(surf, "blendVerts", blended, align=1, size=2)
    blend_table = z.elements(surf, "blendVertsTable", verts, align=0, size=32)
    z.elements(surf, "lmapUnwrap", verts, align=3, size=4)  # half-float pair; IW6 writes 8
    if follows(surf["subdiv"]):
        z.align(3)
        subdiv = z.struct("XSurfaceSubdivInfo")
        if follows(subdiv["levels"]):
            z.align(15)
            levels = z.array("XSurfaceSubdivLevel", surf["subdivLevelCount"])
            for level in levels:
                level.touch(*SUBDIV_RUNTIME)
                z.elements(level, "rigidVertLists", surf["rigidVertListCount"], align=3, size=16)
                z.elements(level, "faceIndices", level["faceCount"], align=3, size=12)
                z.elements(level, "regularPatchIndices", level["regularPatchCount"], align=3, size=32)
                z.elements(level, "regularPatchFlags", level["regularPatchCount"], align=3, size=4)
                z.elements(level, "facePoints", level["facePointBufferSize"] & ~3, align=3, size=1)
                z.elements(level, "edgePoints", level["edgePointCount"], align=3, size=8)
                z.elements(level, "vertexPoints", level["vertexPointBufferSize"] & ~3, align=3, size=1)
                z.elements(level, "normals", level["normalBufferSize"] & ~3, align=3, size=1)
                z.elements(level, "transitionPoints", level["transitionPointCount"], align=3, size=4)
                z.elements(level, "regularPatchCones", level["regularPatchCount"], align=3, size=32)
    z.elements(surf, "tensionData", sum(counts), align=3, size=4)
    z.elements(surf, "tensionAccumTable", verts, align=1, size=32)
    if follows(surf["blendShapes"]):  # S1 only
        z.align(15)
        for shape in z.array("BlendShape", surf["blendShapesCount"]):
            shape.touch("blendShapeVertsBuffer", "blendShapeVertsView")
            z.elements(shape, "verts", shape["vertCount"], align=15, size=32)

    def where(taken, path):
        return taken if taken is not None else z.located(surf[path])

    return S1Surface(
        where(vertices, "verts0.verts0"),
        verts,
        bool(surf["flags"] & SURF_FLAG_MOTION),
        where(triangles, "triIndices"),
        tris,
        surf["flags"],
        where(rigid_lists, "rigidVertLists"),
        surf["rigidVertListCount"],
        counts,
        where(blend_verts, "blendVerts"),
        where(blend_table, "blendVertsTable"),
        bool(surf["subdiv"]),
        where(positions, "unknown0"),
    )


@walker("XMODEL_SURFS")
def xmodel_surfs(z):
    surfs = z.struct("XModelSurfs")
    z.push(VIRTUAL)
    name = z.field_string(surfs, "name")
    surfaces = []
    if follows(surfs["surfs"]):
        z.align(3)
        surfaces = [xsurface(z, surf) for surf in z.array("XSurface", surfs["numsurfs"])]
    z.pop()
    z.record("XMODEL_SURFS", name, ModelSurfs(name, surfaces))
    return name


@walker("XMODEL")
def xmodel(z):
    model = z.struct("XModel")
    z.push(VIRTUAL)
    name = z.field_string(model, "name")
    bones, roots = model["numBones"], model["numRootBones"]
    children, surfs = bones - roots, model["numsurfs"]
    record = Model(name, [], at=model.at, bone_count=bones, root_bone_count=roots)

    def shared(taken, path):
        """A bone array's offset, whether it streamed here or an earlier model carried it."""
        return taken if taken is not None else z.located(model[path])

    record.bone_names = shared(z.elements(model, "boneNames", bones, align=3), "boneNames")
    record.parents = shared(z.elements(model, "parentList", children), "parentList")
    record.tag_angles = shared(z.elements(model, "tagAngles", children, align=1), "tagAngles")
    record.tag_positions = shared(z.elements(model, "tagPositions", children, align=3), "tagPositions")
    z.elements(model, "partClassification", bones)
    record.base_mat = shared(z.elements(model, "baseMat", bones, align=3), "baseMat")
    z.elements(model, "reactiveMotionParts", model["numReactiveMotionParts"], align=15)
    z.elements(model, "reactiveMotionTweaks", 1, align=15, size=16)  # S1 only
    z.blocks[CALLBACK] += 4 * surfs
    materials = z.handles(model, "materialHandles", surfs, material, "MATERIAL")
    record.materials = [m[1] if m else None for m in materials]
    for i in range(6):
        lod = f"lodInfo[{i}]."
        lod_surfs = field_asset(z, model, lod + "modelSurfs", "XMODEL_SURFS")
        model.touch(lod + "surfs")
        if lod_surfs or i < model["numLods"]:
            record.lods.append(
                ModelLod(lod_surfs and lod_surfs[1], model[lod + "surfIndex"], model[lod + "numsurfs"], model[lod + "dist"])
            )
    z.elements(model, "collSurfs", model["numCollSurfs"], align=3)
    record.bone_info = shared(z.elements(model, "boneInfo", bones, align=3), "boneInfo")
    z.elements(model, "invHighMipRadius", surfs, align=1)
    z.elements(model, "blendShapeWeightNames", model["numberOfBlendShapeWeights"], align=3)
    z.elements(model, "blendShapeWeightMaps", model["numberOfBlendShapeWeightMaps"], align=3)
    preset = field_asset(z, model, "physPreset", "PHYSPRESET")
    collmap = field_asset(z, model, "physCollmap", "PHYSCOLLMAP")
    record.phys_preset, record.phys_collmap = preset and preset[1], collmap and collmap[1]
    if follows(model["mdaoVolumes"]):
        z.align(3)
        for volume in z.array("MdaoVolume", model["mdaoVolumeCount"]):
            field_asset(z, volume, "volumeData", "IMAGE")
    parts = _handle_names(z, model, "compositeModels", model["numCompositeModels"], xmodel, "XMODEL")
    if parts:
        # A composite model has no LODs of its own; AW builds a gun's viewmodel this way.
        z.record("XMODEL_COMPOSITE", name, parts)
    field_asset(z, model, "skeletonScript", "SKELETON_SCRIPT")
    if follows(model["bonePhysics"]):
        z.align(3)
        for bone in z.array("XPhysBoneInfo", model["numBonePhysics"]):
            field_asset(z, bone, "physPreset", "PHYSPRESET")
            field_asset(z, bone, "physContraint", "PHYSCONSTRAINT")  # the source spells it so
            field_asset(z, bone, "physCollmap", "PHYSCOLLMAP")
    z.pop()
    z.record("XMODEL", name, record)
    return name


WEAPON_ANIMS = 180  # NUM_WEAP_ANIMS; IW6's is 124
WEAPON_SOUNDS = (
    "pickupSound",
    "pickupSoundPlayer",
    "ammoPickupSound",
    "ammoPickupSoundPlayer",
    "projectileSound",
    "pullbackSound",
    "pullbackSoundPlayer",
    "throwbackSound",
    "throwbackSoundPlayer",
    "fireSound",
    "fireSoundPlayer",
    "fireSoundPlayerAkimbo",
    "fireMedSound",
    "fireMedSoundPlayer",
    "fireHighSound",
    "fireHighSoundPlayer",
    "fireLoopSound",
    "fireLoopSoundPlayer",
    "fireMedLoopSound",
    "fireMedLoopSoundPlayer",
    "fireHighLoopSound",
    "fireHighLoopSoundPlayer",
    "fireLoopEndPointSound",
    "fireLoopEndPointSoundPlayer",
    "fireStopSound",
    "fireStopSoundPlayer",
    "fireMedStopSound",
    "fireMedStopSoundPlayer",
    "fireHighStopSound",
    "fireHighStopSoundPlayer",
    "fireLastSound",
    "fireLastSoundPlayer",
    "fireFirstSound",
    "fireFirstSoundPlayer",
    "fireCustomSound",
    "fireCustomSoundPlayer",
    "emptyFireSound",
    "emptyFireSoundPlayer",
    "adsRequiredFireSoundPlayer",
    "meleeSwipeSound",
    "meleeSwipeSoundPlayer",
    "meleeHitSound",
    "meleeMissSound",
    "meleeHitSoundPlayer",
    "meleeMissSoundPlayer",
    "rechamberSound",
    "rechamberSoundPlayer",
    "reloadSound",
    "reloadSoundPlayer",
    "reloadEmptySound",
    "reloadEmptySoundPlayer",
    "reloadStartSound",
    "reloadStartSoundPlayer",
    "reloadEndSound",
    "reloadEndSoundPlayer",
    "detonateSound",
    "detonateSoundPlayer",
    "nightVisionWearSound",
    "nightVisionWearSoundPlayer",
    "nightVisionRemoveSound",
    "nightVisionRemoveSoundPlayer",
    "altSwitchSound",
    "altSwitchSoundPlayer",
    "raiseSound",
    "raiseSoundPlayer",
    "firstRaiseSound",
    "firstRaiseSoundPlayer",
    "putawaySound",
    "putawaySoundPlayer",
    "scanSound",
    "changeVariableZoomSound",
    "adsUpSound",
    "adsDownSound",
    "adsCrosshairEnemySound",
)
WEAPON_EFFECTS = (
    "viewFlashEffect",
    "viewBodyFlashEffect",
    "worldFlashEffect",
    "viewFlashADSEffect",
    "viewBodyFlashADSEffect",
    "signatureViewFlashEffect",
    "signatureViewBodyFlashEffect",
    "signatureWorldFlashEffect",
    "signatureViewFlashADSEffect",
    "signatureViewBodyFlashADSEffect",
    "meleeHitEffect",
    "meleeMissEffect",
)


def snd_alias_custom(z, value):
    """Load_SndAliasCustom: an 8-byte slot holding a string pointer, then the string."""
    if not follows(value):
        return None
    z.align(7)
    return z.string(z.u64(z.take(8)))


def field_snd(z, record, path):
    """The alias name a sound field holds, following it inline or through the slot it aliases."""
    record.touch(path)
    value = record[path]
    if follows(value) or not value:
        return snd_alias_custom(z, value)
    block, offset = reference(value)
    at = z.located(value)
    if at is None:
        return None
    inner = z.u64(at)
    if not is_pointer(inner):
        return None
    # The aliased slot's own string followed it, 8 bytes on, unless it was a reference too.
    return z.strings.get((block, offset + 8)) if follows(inner) else z.resolve_string(inner)


def snd_array(z, record, path, count):
    """A pointer array of sound aliases, then each non-null one's slot and string."""
    start = z.elements(record, path, count, align=7)
    if start is None:
        return
    for i in range(count):
        snd_alias_custom(z, z.u64(start + 8 * i))


# x64-zt's s1 header has the struct and says reticleViewModels holds 32 (H1's holds
# 64; 64 stops common_mp at its first weapon with a reticle). The string types are
# H1's writer's, and in common_mp exactly those types carry a pointer-valued parm.
ATTACHMENT_RETICLES = 32
ATTACHMENT_MODELS = (("worldModels", 2), ("viewModels", 2), ("reticleViewModels", ATTACHMENT_RETICLES))
WAFIELD_STRINGS = (0, 10, 11, 12, 13, 15, 16)


@dataclass
class S1Attachment:
    """What the ATTACHMENT walker keeps: the record, its models, and its field edits.

    `fields[i]` is the i-th WAField as (index, type, code, parm): the parm is its
    text for a pointer-valued type, else its eight raw bytes. `offsets` is the file offset of `fieldOffsets`,
    which may be an earlier attachment's copy; each names a WeaponDef member."""

    record: object
    display: str | None
    models: dict
    offsets: int | None
    fields: list


@dataclass
class S1Weapon:
    """What the WEAPON walker keeps: the WeaponDef record, and what its pointers led to.

    Scalars are read off `record` by member name. `names` holds each string or
    asset pointer's name, `lists` each handle array's names, and `arrays` the
    file offset of each plain array -- which may be another weapon's copy."""

    record: object
    names: dict
    lists: dict
    arrays: dict
    overrides: dict


def _handle_names(z, record, path, count, walker_fn, typename):
    """The asset names in an array of handles, None for an empty slot.

    An array that does not follow aliases an earlier one, whose elements were
    each recorded as a slot when it was read; a weapon sharing its clip list
    with another is the common case."""
    value = record[path]
    if follows(value):
        results = z.handles(record, path, count, walker_fn, typename)
    elif value and reference(value)[0] == VIRTUAL:
        offset = reference(value)[1]
        results = [z.slots.get(offset + 8 * i) for i in range(count)]
    else:
        results = []
    return [r[1] if r else None for r in results]


def _array(z, record, path, count, **kwargs):
    """File offset of a plain array behind a pointer: inline, or an earlier copy it aliases."""
    at = z.elements(record, path, count, **kwargs)
    return at if at is not None else z.located(record[path])


@walker("ATTACHMENT")
def attachment(z):
    """WeaponAttachment, in x64-zt's H1 writer's order less the members S1 lacks.
    The models are handles that follow inline, where the writer assumes references."""
    a = z.struct("WeaponAttachment")
    z.push(VIRTUAL)
    name = z.field_string(a, "szInternalName")
    display = z.field_string(a, "szDisplayName")
    models = {path: _handle_names(z, a, path, count, xmodel, "XMODEL") for path, count in ATTACHMENT_MODELS}
    z.elements(a, "chargeInfo", 1, align=3)
    z.elements(a, "hybridSettings", 1, align=3)
    offsets = _array(z, a, "fieldOffsets", a["numFields"], align=1)
    fields = []
    if follows(a["fields"]):
        z.align(3)
        for f in z.array("WAField", a["numFields"]):
            if f["type"] in WAFIELD_STRINGS:
                fields.append((f["index"], f["type"], f["code"], z.field_string(f, "parm.string")))
            else:
                f.touch("parm.string")
                fields.append((f["index"], f["type"], f["code"], f.bytes("parm")))
    elif (at := z.located(a["fields"])) is not None:
        size = z.layout.size("WAField")
        for i in range(a["numFields"]):
            index, kind, code = z.data[at + size * i : at + size * i + 3]
            parm = z.data[at + size * i + 8 : at + size * i + 16]
            text = z.resolve_string(struct.unpack("<Q", parm)[0]) if kind in WAFIELD_STRINGS else None
            fields.append((index, kind, code, text if kind in WAFIELD_STRINGS else parm))
    z.pop()
    z.record("ATTACHMENT", name, S1Attachment(a, display, models, offsets, fields))
    return name


@dataclass
class S1Anim(iw6_records.Anim):
    """IW6's Anim, plus the arrays S1 appends after the index data."""

    random_int: int | None = None
    secondary_name: str | None = None
    shape_names: int | None = None  # scr_string_t per blend shape
    shape_weights: int | None = None  # float per shape per frame (numframes + 1 each)
    sv_anim: int | None = None  # XAnimScriptedViewmodelAnimData: blendIn, blendOut


@walker("XANIMPARTS")
def xanim_parts(z):
    """S1 appends eight blend-shape members IW6 has none of, after the index data."""
    anim = z.struct("XAnimParts")
    z.push(VIRTUAL)
    name = z.field_string(anim, "name")
    record = S1Anim(name, anim.at)
    wide = anim["numframes"] >= 256  # index width, used throughout
    record.names = z.elements(anim, "names", anim["boneCount[9]"], align=3)
    record.notify = z.elements(anim, "notify", anim["notifyCount"], align=3)
    if follows(anim["deltaPart"]):
        z.align(3)
        delta = z.struct("XAnimDeltaPart")
        record.delta_trans = _delta_trans(z, delta, wide)
        record.delta_quat2 = _delta_quat(z, delta, "quat2", wide, 8, 4, 4)
        record.delta_quat = _delta_quat(z, delta, "quat", wide, 8, 8, 8)
    record.data_byte = z.elements(anim, "dataByte", anim["dataByteCount"])
    record.data_short = z.elements(anim, "dataShort", anim["dataShortCount"], align=1)
    record.data_int = z.elements(anim, "dataInt", anim["dataIntCount"], align=3)
    record.random_short = z.elements(anim, "randomDataShort", anim["randomDataShortCount"], align=1)
    record.random_byte = z.elements(anim, "randomDataByte", anim["randomDataByteCount"])
    record.random_int = z.elements(anim, "randomDataInt", anim["randomDataIntCount"], align=3)
    record.indices = z.elements(anim, "indices.data", anim["indexCount"], align=1 if wide else 0, size=2 if wide else 1)
    # Everything below is S1's; IW6 ends at the indices.
    shapes = anim["blendShapeCount"]
    record.secondary_name = z.field_string(anim, "secondaryName")
    record.shape_names = z.elements(anim, "blendShapeWeightNames", shapes, align=3)
    z.elements(anim, "blendShapeCoefficientMagnitudes", shapes, size=3)
    keys_at = z.elements(anim, "numberOfBlendShapeKeys", shapes, align=1, size=2)
    total_keys = sum(struct.unpack_from("<H", z.data, keys_at + 2 * i)[0] for i in range(shapes)) if keys_at else 0
    z.elements(anim, "blendShapeKeys", total_keys, align=1, size=2)
    z.elements(anim, "compressedBlendShapeCoefficients", total_keys + 2 * shapes, align=1, size=2)
    record.shape_weights = z.elements(anim, "blendShapeWeights", shapes * (anim["numframes"] + 1), align=3, size=4)
    record.sv_anim = z.elements(anim, "svAmimData", 1, align=3, size=8)
    z.pop()
    z.record("XANIMPARTS", name, record)
    return name


def _delta_trans(z, delta, wide):
    """XAnimPartTrans: a header, then either a compressed track or one frame. Returns its DeltaTrack."""
    if not follows(delta["trans"]):
        return None
    z.align(3)
    at = z.take(8)
    size = struct.unpack_from("<H", z.data, at)[0]
    small = z.data[at + 2]
    track = iw6_records.DeltaTrack(size, small=bool(small))
    if size == 0:
        track.values = z.take(12)  # float frame0[3]
        return track
    track.frames = z.take(32)  # mins, size, then the frames pointer
    frames = z.u64(track.frames + 24)
    track.indices = z.take((size + 1) * (2 if wide else 1))
    if follows(frames):
        z.align(0 if small else 3)
        track.values = z.take((size + 1) * (3 if small else 6))
    else:
        track.values = z.located(frames)
    return track


def _delta_quat(z, delta, path, wide, header, frame_size, one_frame):
    if not follows(delta[path]):
        return None
    z.align(3)
    at = z.take(header)
    size = struct.unpack_from("<H", z.data, at)[0]
    track = iw6_records.DeltaTrack(size)
    if size == 0:
        track.values = z.take(one_frame)
        return track
    frames = z.u64(z.take(8))
    track.indices = z.take((size + 1) * (2 if wide else 1))
    if follows(frames):
        z.align(3)
        track.values = z.take((size + 1) * frame_size)
    else:
        track.values = z.located(frames)
    return track


@walker("WEAPON")
def weapon(z):
    """S1's WEAPON is one flat WeaponDef, not IW6's WeaponCompleteDef wrapping one.

    It keeps what the weapon dumper reads (S1Weapon); the order of every read is
    the loader's, since that is what keeps the stream aligned for what follows.
    """
    w = z.struct("WeaponDef")
    names, lists, arrays, overrides = {}, {}, {}, {}
    z.push(VIRTUAL)

    def string(path):
        names[path] = z.field_string(w, path)

    def handle(path, typename):
        result = field_asset(z, w, path, typename)
        names[path] = result[1] if result else None

    def handles(path, count, walker_fn, typename):
        lists[path] = _handle_names(z, w, path, count, walker_fn, typename)

    def array(path, count, **kwargs):
        arrays[path] = _array(z, w, path, count, **kwargs)

    string("szInternalName")
    name = names["szInternalName"]
    string("szDisplayName")
    string("szAltWeaponName")
    handles("gunModel", 2, xmodel, "XMODEL")
    handle("handModel", "XMODEL")
    handle("persistentArmXModel", "XMODEL")
    string("lobWorldModelName")
    handle("camoWorldModelMaterialOverride", "MATERIAL")
    w.touch("camoViewModelMaterialOverride")  # the writer never touches it either
    handles("szXAnimsRightHanded", WEAPON_ANIMS, xanim_parts, "XANIMPARTS")
    handles("szXAnimsLeftHanded", WEAPON_ANIMS, xanim_parts, "XANIMPARTS")
    array("hideTags", 32, align=3)
    handles("attachments", w["numAttachments"], attachment, "ATTACHMENT")
    handles("szXAnims", WEAPON_ANIMS, xanim_parts, "XANIMPARTS")
    if follows(w["animOverrides"]):
        z.align(3)
        rows = overrides["animOverrides"] = []
        for entry in z.array("AnimOverrideEntry", w["numAnimOverrides"]):
            anim = field_asset(z, entry, "overrideAnim", "XANIMPARTS")
            alt = field_asset(z, entry, "altmodeAnim", "XANIMPARTS")
            rows.append((entry, anim[1] if anim else None, alt[1] if alt else None))
    if follows(w["soundOverrides"]):
        z.align(3)
        rows = overrides["soundOverrides"] = []
        for entry in z.array("SoundOverrideEntry", w["numSoundOverrides"]):
            rows.append((entry, field_snd(z, entry, "overrideSound"), field_snd(z, entry, "altmodeSound")))
    if follows(w["fxOverrides"]):
        z.align(3)
        rows = overrides["fxOverrides"] = []
        for entry in z.array("FXOverrideEntry", w["numFXOverrides"]):
            fx_ = field_asset(z, entry, "overrideFX", "FX")
            alt = field_asset(z, entry, "altmodeFX", "FX")
            rows.append((entry, fx_[1] if fx_ else None, alt[1] if alt else None))
    array("reloadOverrides", w["numReloadStateTimerOverrides"], align=3)
    if follows(w["notetrackOverrides"]):
        z.align(3)
        rows = overrides["notetrackOverrides"] = []
        for entry in z.array("NoteTrackToSoundEntry", w["numNotetrackOverrides"]):
            keys = _array(z, entry, "notetrackSoundMapKeys", 36, align=3)
            values = _array(z, entry, "notetrackSoundMapValues", 36, align=3)
            rows.append((entry, keys, values))
    array("notetrackSoundMapKeys", 36, align=3)
    array("notetrackSoundMapValues", 36, align=3)
    array("notetrackRumbleMapKeys", 16, align=3)
    array("notetrackRumbleMapValues", 16, align=3)
    array("notetrackFXMapKeys", 16, align=3)
    handles("notetrackFXMapValues", 16, fx, "FX")
    array("notetrackFXMapTagValues", 16, align=3)
    string("szAdsrBaseSetting")
    for path in WEAPON_EFFECTS:
        handle(path, "FX")
    for path in WEAPON_SOUNDS:
        names[path] = field_snd(z, w, path)
    snd_array(z, w, "bounceSound", 53)
    snd_array(z, w, "rollingSound", 53)
    for path in (
        "viewShellEjectEffect",
        "worldShellEjectEffect",
        "viewLastShotEjectEffect",
        "worldLastShotEjectEffect",
        "viewMagEjectEffect",
    ):
        handle(path, "FX")
    for path in ("reticleCenter", "reticleSide"):
        handle(path, "MATERIAL")
    handles("worldModel", 2, xmodel, "XMODEL")
    for path in ("worldClipModel", "rocketModel", "knifeModel", "worldKnifeModel"):
        handle(path, "XMODEL")
    for path in ("hudIcon", "pickupIcon", "minimapIconFriendly", "minimapIconEnemy", "minimapIconNeutral", "ammoCounterIcon"):
        handle(path, "MATERIAL")
    for path in ("szAmmoName", "szClipName", "szSharedAmmoCapName"):
        string(path)
    handle("physCollmap", "PHYSCOLLMAP")
    handle("physPreset", "PHYSPRESET")
    string("szUseHintString")
    string("dropHintString")
    array("locationDamageMultipliers", 22, align=3)
    for path in ("fireRumble", "fireMedRumble", "fireHighRumble", "meleeImpactRumble"):
        string(path)
    handle("tracerType", "TRACER")
    handle("signatureTracerType", "TRACER")
    handle("laserType", "LASER")
    names["turretOverheatSound"] = field_snd(z, w, "turretOverheatSound")
    handle("turretOverheatEffect", "FX")
    string("turretBarrelSpinRumble")
    field_snd(z, w, "turretBarrelSpinMaxSnd")
    # The writer interleaves up/down; the struct declares two arrays. Same slots
    # either way, so the byte count is the same and only the naming is at risk.
    for i in range(4):
        field_snd(z, w, f"turretBarrelSpinUpSnd[{i}]")
        field_snd(z, w, f"turretBarrelSpinDownSnd[{i}]")
    field_snd(z, w, "missileConeSoundAlias")
    field_snd(z, w, "missileConeSoundAliasAtBase")
    handle("stowOffsetModel", "XMODEL")
    if follows(w["turretHydraulicSettings"]):
        z.align(3)
        turret = z.struct("TurretHydraulicSettings")
        for path in ("verticalSound", "verticalStopSound", "horizontalSound", "horizontalStopSound"):
            field_snd(z, turret, path)
    for path in (
        "overlay.shader",
        "overlay.shaderLowRes",
        "overlay.shaderEMP",
        "overlay.shaderEMPLowRes",
        "killIcon",
        "dpadIcon",
        "hudProximityWarningIcon",
    ):
        handle(path, "MATERIAL")
    string("projectileName")
    handle("projectileModel", "XMODEL")
    handle("projExplosionEffect", "FX")
    handle("projDudEffect", "FX")
    names["projExplosionSound"] = field_snd(z, w, "projExplosionSound")
    names["projDudSound"] = field_snd(z, w, "projDudSound")
    array("parallelBounce", 53, align=3)
    array("perpendicularBounce", 53, align=3)
    for path in ("projTrailEffect", "projBeaconEffect", "projIgnitionEffect"):
        handle(path, "FX")
    names["projIgnitionSound"] = field_snd(z, w, "projIgnitionSound")
    for i in range(2):  # interleaved, not two passes
        string(f"accuracyGraphName[{i}]")
        knots = w[f"accuracyGraphKnotCount[{i}]"]
        z.elements(w, f"accuracyGraphKnots[{i}]", knots, align=3)
        z.elements(w, f"originalAccuracyGraphKnots[{i}]", knots, align=3)
    string("szScript")
    z.pop()
    z.record("WEAPON", name, S1Weapon(w, names, lists, arrays, overrides))
    return name


@walker("LOADED_SOUND")
def loaded_sound(z):
    """S1 keeps the PCM in LoadedSoundInfo and has no seek table, unlike IW6.

    **The PCM is VIRTUAL**, where IW6 loads it into TEMP. It is most of a map zone:
    putting it in the wrong block leaves `mp_prison` 208 MB short in VIRTUAL, which
    is what every alias later in that zone is measured against.
    """
    snd = z.struct("LoadedSound")
    z.push(VIRTUAL)
    name = z.field_string(snd, "name")
    if snd["filename.fileIndex"] == 0:  # otherwise the name is packed into the struct
        z.field_string(snd, "filename.info.raw.dir")
        z.field_string(snd, "filename.info.raw.name")
    z.aliased(snd, "info.data", snd["info.loadedSize"], block=VIRTUAL)
    z.pop()
    return name


@walker("CLUT")
def clut(z):
    lut = z.struct("Clut")
    z.push(VIRTUAL)
    z.elements(lut, "pixels", lut["width"] * lut["height"] * lut["depth"] * 4, size=1)
    name = z.field_string(lut, "name")
    z.pop()
    return name


@walker("SOUND_CURVE", "LPF_CURVE", "REVERB_CURVE")
def sound_curve(z):
    curve = z.struct("SndCurve")
    z.push(VIRTUAL)
    name = z.field_string(curve, "filename")
    curve.touch("name")  # a union with filename
    z.pop()
    return name


@walker("DOPPLER_PRESET")
def doppler_preset(z):
    preset = z.struct("DopplerPreset")
    z.push(VIRTUAL)
    name = z.field_string(preset, "name")
    z.pop()
    return name


@walker("SOUND_CONTEXT")
def sound_context(z):
    ctx = z.struct("SndContext")
    z.push(VIRTUAL)
    name = z.field_string(ctx, "name")
    z.pop()
    return name


SAT_LOADED, SAT_STREAMED, SAT_PRIMED = 1, 2, 3


@walker("SOUND")
def sound(z):
    """snd_alias_list_t. S1's differs from IW6's in ways that all move bytes:
    the header is 0x20 with byte counts, an alias is 0xF0, and a trailing
    context list follows every alias."""
    aliases = z.struct("snd_alias_list_t")
    z.push(VIRTUAL)
    name = z.field_string(aliases, "name")
    aliases.touch("aliasName")  # a union with name
    heads = []
    if follows(aliases["head"]):
        z.align(3)
        heads = z.array("snd_alias_t", aliases["count"])
    for head in heads:
        # Every alias points at the list's own name; none is written inline.
        head.touch("aliasName")
        # squelchName is emitted before soundFile even though it sits after it
        # in the struct, which is what the write order says and the struct does not.
        for path in ("subtitle", "secondaryAliasName", "chainAliasName", "squelchName"):
            z.field_string(head, path)
        if follows(head["soundFile"]):
            z.align(3)
            sf = z.struct("SoundFile")
            kind = sf["type"]
            if kind == SAT_LOADED:
                field_asset(z, sf, "u.loadSnd", "LOADED_SOUND")
            elif kind in (SAT_STREAMED, SAT_PRIMED):
                stream = "u.streamSnd.filename" if kind == SAT_STREAMED else "u.primedSnd.streamedPart"
                if kind == SAT_PRIMED:
                    field_asset(z, sf, "u.primedSnd.loadedPart", "LOADED_SOUND")
                if sf[stream + ".fileIndex"] == 0:  # otherwise the name is packed inline
                    z.field_string(sf, stream + ".info.raw.dir")
                    z.field_string(sf, stream + ".info.raw.name")
        field_asset(z, head, "sndContext", "SOUND_CONTEXT")
        field_asset(z, head, "volumeFalloffCurve", "SOUND_CURVE")
        field_asset(z, head, "lpfCurve", "LPF_CURVE")
        field_asset(z, head, "reverbSendCurve", "REVERB_CURVE")
        if follows(head["speakerMap"]):
            z.align(3)
            z.field_string(z.struct("SpeakerMap"), "name")
        field_asset(z, head, "dopplerPreset", "DOPPLER_PRESET")
    z.elements(aliases, "contextList", aliases["contextListCount"], align=1)
    z.pop()
    return name


@walker("TRACER")
def tracer(z):
    d = z.struct("TracerDef")
    z.push(VIRTUAL)
    name = z.field_string(d, "name")
    field_asset(z, d, "material", "MATERIAL")
    field_asset(z, d, "effectDef", "FX")
    z.pop()
    return name


@walker("LASER")
def laser(z):
    """x64-zt registers LaserDef but never implements it; the struct is all it needs.

    The PC build carries two references the X360 one does not -- an end effect and
    a friendly-team laser, which is itself a LaserDef.
    """
    d = z.struct("LaserDef")
    z.push(VIRTUAL)
    name = z.field_string(d, "name")
    field_asset(z, d, "laserMaterial", "MATERIAL")
    field_asset(z, d, "laserLightMaterial", "MATERIAL")
    field_asset(z, d, "laserEndEffect", "FX")
    field_asset(z, d, "friendlyTeamLaser", "LASER")
    z.pop()
    return name


# `vertices`, `indices`, `models` and `instances` are file offsets of the arrays behind
# draw.vd.vertices, draw.indices, models (GfxBrushModel) and dpvs.smodelInsts.
World = namedtuple("World", "name base_name header vertices indices surfaces sky_surfaces materials placements instances models")
WORLDS = []  # the GfxWorld of the zone being walked, for the caller


def placement(inst, model):
    """GfxStaticModelDrawInst.placement: origin, a 3x3 axis and a uniform scale, as IW6 writes it."""
    at = inst.zone.layout.resolve(inst.type, "placement")[0] + inst.at
    values = struct.unpack_from("<13f", inst.zone.data, at)
    return Placement(model[1] if model else None, values[0:3], (values[3:6], values[6:9], values[9:12]), values[12])


@walker("GFXWORLD")
def gfx_world(z):
    """The map's rendered world. S1 adds portal groups, a separate smodel lighting
    array, subdiv lighting, mdao volumes and build info; its light grid has three
    trees, and its light-grid colours are 16-bit where IW6's are 8-bit."""
    w = z.struct("GfxWorld")
    z.push(VIRTUAL)
    name = z.field_string(w, "name")
    base_name = z.field_string(w, "baseName")
    sky_surfaces = set()  # what skyStartSurfs lists; not the sky shell, whose material names it
    if follows(w["skies"]):
        z.align(3)
        for sky in z.array("GfxSky", w["skyCount"]):
            start = z.elements(sky, "skyStartSurfs", sky["skySurfCount"], align=3)
            if start is not None:
                sky_surfaces.update(struct.unpack_from(f"<{sky['skySurfCount']}i", z.data, start))
            field_asset(z, sky, "skyImage", "IMAGE")
    cells = w["dpvsPlanes.cellCount"]
    z.elements(w, "dpvsPlanes.planes", w["planeCount"], align=3)
    z.elements(w, "dpvsPlanes.nodes", w["nodeCount"], align=1)
    z.push(RUNTIME)
    z.elements(w, "dpvsPlanes.sceneEntCellBits", cells << 9, align=3, size=4)
    z.pop()
    counts_at = z.elements(w, "aabbTreeCounts", cells, align=3)
    if follows(w["aabbTrees"]):
        z.align(127)
        for i, cell in enumerate(z.array("GfxCellTree", cells)):
            count = struct.unpack_from("<I", z.data, counts_at + 4 * i)[0] if counts_at else 0
            if follows(cell["aabbTree"]):
                z.align(3)
                for node in z.array("GfxAabbTree", count):
                    z.elements(node, "smodelIndexes", node["smodelIndexCount"], align=1)
    if follows(w["cells"]):
        z.align(3)
        for cell in z.array("GfxCell", cells):
            if follows(cell["portals"]):
                z.align(3)
                for portal in z.array("GfxPortal", cell["portalCount"]):
                    portal.touch("writable.hullPoints", "writable.queuedParent")
                    z.elements(portal, "vertices", portal["vertexCount"], align=3)
            z.elements(cell, "reflectionProbes", cell["reflectionProbeCount"])
            z.elements(cell, "reflectionProbeReferences", cell["reflectionProbeReferenceCount"])
    if follows(w["portalGroup"]):
        z.align(3)
        for group in z.array("GfxPortalGroup", w["portalGroupCount"]):
            z.field_string(group, "targetName")
            z.elements(group, "gfxPortalArray", group["numPortals"], align=3)
    z.elements(w, "portalDistanceAnchorsAndCloseDistSquared", w["portalDistanceAnchorCount"], align=3, size=16)

    d = "draw."
    probes, refs = w[d + "reflectionProbeCount"], w[d + "reflectionProbeReferenceCount"]
    z.handles(w, d + "reflectionProbes", probes, image, "IMAGE")
    if follows(w[d + "reflectionProbeOrigins"]):
        z.align(3)
        for origin in z.array("GfxReflectionProbe", probes):
            if follows(origin["probeVolumes"]):
                z.align(3)
                for volume in z.array("GfxReflectionProbeVolume", origin["probeVolumeCount"]):
                    z.elements(volume, "probeVolumePlanes", volume["probeVolumePlaneCount"], align=1)
    # A runtime texture is 24 bytes, not the 32 x64-zt's s1 header says: its
    # GfxRawTexture is H1's -- a GfxTexture plus eight bytes of padding -- and IW6
    # declares these three fields as GfxTexture*. Eight bytes per probe and per
    # lightmap is most of what the RUNTIME block was over by.
    raw_texture = z.layout.size("GfxTexture")
    z.push(RUNTIME)
    z.elements(w, d + "reflectionProbeTextures", probes, align=3, size=raw_texture)
    z.pop()
    z.elements(w, d + "reflectionProbeReferenceOrigins", refs, align=3)
    z.elements(w, d + "reflectionProbeReferences", refs)
    lightmaps = w[d + "lightmapCount"]
    if follows(w[d + "lightmaps"]):
        z.align(3)
        for lightmap in z.array("GfxLightmapArray", lightmaps):
            field_asset(z, lightmap, "primary", "IMAGE")
            field_asset(z, lightmap, "secondary", "IMAGE")
    z.push(RUNTIME)
    z.elements(w, d + "lightmapPrimaryTextures", lightmaps, align=3, size=raw_texture)
    z.elements(w, d + "lightmapSecondaryTextures", lightmaps, align=3, size=raw_texture)
    z.pop()
    field_asset(z, w, d + "lightmapOverridePrimary", "IMAGE")
    field_asset(z, w, d + "lightmapOverrideSecondary", "IMAGE")
    w.touch(d + "vd.worldVb", d + "vld.layerVb", d + "indexBuffer")
    vertices_at = z.elements(w, d + "vd.vertices", w[d + "vertexCount"], align=3)
    z.elements(w, d + "vld.data", w[d + "vertexLayerDataSize"], align=3, size=1)
    indices_at = z.elements(w, d + "indices", w[d + "indexCount"], align=3, size=2)

    g = "lightGrid."
    rows = w[f"{g}maxs[{w[g + 'rowAxis']}]"] - w[f"{g}mins[{w[g + 'rowAxis']}]"] + 1
    z.elements(w, g + "rowDataStart", rows, align=1, size=2)
    z.elements(w, g + "rawRowData", w[g + "rawRowDataSize"], size=1)
    z.elements(w, g + "entries", w[g + "entryCount"], align=3)
    z.elements(w, g + "colors", w[g + "colorCount"], align=3)
    z.elements(w, g + "stageLightingContrastGain", w[g + "stageCount"], align=3, size=4)
    z.elements(w, g + "paletteEntryAddress", w[g + "paletteEntryCount"], align=3, size=4)
    z.elements(w, g + "paletteBitstream", w[g + "paletteBitstreamSize"], size=1)
    for i in range(3):  # IW6 has one tree; S1 has three
        z.elements(w, f"{g}tree[{i}].p_nodeTable", w[f"{g}tree[{i}].nodeCount"], align=3, size=4)
        z.elements(w, f"{g}tree[{i}].p_leafTable", w[f"{g}tree[{i}].leafTableSize"], size=1)

    models_at = z.elements(w, "models", w["modelCount"], align=3)
    if follows(w["materialMemory"]):
        z.align(3)
        for memory in z.array("MaterialMemory", w["materialMemoryCount"]):
            field_asset(z, memory, "material", "MATERIAL")
    field_asset(z, w, "sun.spriteMaterial", "MATERIAL")
    field_asset(z, w, "sun.flareMaterial", "MATERIAL")
    field_asset(z, w, "outdoorImage", "IMAGE")

    lights = w["primaryLightCount"] - w["lastSunPrimaryLightIndex"]
    dyn0, dyn1 = w["dpvsDyn.dynEntClientCount[0]"], w["dpvsDyn.dynEntClientCount[1]"]
    z.push(RUNTIME)
    z.elements(w, "cellCasterBits", cells * ((cells + 31) >> 5), align=3, size=4)
    z.elements(w, "cellHasSunLitSurfsBits", (cells + 31) >> 5, align=3, size=4)
    z.elements(w, "sceneDynModel", dyn0, align=3)
    z.elements(w, "sceneDynBrush", dyn1, align=3)
    z.elements(w, "primaryLightEntityShadowVis", (lights << 13) - 0x2000, align=3, size=4)
    z.elements(w, "primaryLightDynEntShadowVis[0]", dyn0 * (lights - 1), align=3, size=4)
    z.elements(w, "primaryLightDynEntShadowVis[1]", dyn1 * (lights - 1), align=3, size=4)
    z.elements(w, "nonSunPrimaryLightForModelDynEnt", dyn0, align=1, size=2)
    z.pop()

    for path in ("shadowGeom", "shadowGeomOptimized"):
        if follows(w[path]):
            z.align(3)
            for geom in z.array("GfxShadowGeometry", w["primaryLightCount"]):
                z.elements(geom, "sortedSurfIndex", geom["surfaceCount"], align=3, size=4)
                z.elements(geom, "smodelIndex", geom["smodelCount"], align=1, size=2)
    if follows(w["lightRegion"]):
        z.align(3)
        for region in z.array("GfxLightRegion", w["primaryLightCount"]):
            if follows(region["hulls"]):
                z.align(3)
                for hull in z.array("GfxLightRegionHull", region["hullCount"]):
                    z.elements(hull, "axis", hull["axisCount"], align=3)

    v = "dpvs."
    smodels, surfaces = w[v + "smodelCount"], w["surfaceCount"]
    smodel_vis, surface_vis = w[v + "smodelVisDataCount"], w[v + "surfaceVisDataCount"]
    z.push(RUNTIME)
    for i in range(3):
        z.elements(w, f"{v}smodelVisData[{i}]", smodel_vis, align=127, size=4)
    for i in range(3):
        z.elements(w, f"{v}surfaceVisData[{i}]", surface_vis, align=127, size=4)
    z.pop()
    z.elements(w, v + "unknownSModelVisData1", smodel_vis, align=127, size=4)
    z.elements(w, v + "unknownSModelVisData2", 2 * smodel_vis, align=127, size=4)
    z.push(RUNTIME)
    z.elements(w, v + "smodelVisData[3]", smodel_vis, align=127, size=4)
    z.elements(w, v + "surfaceVisData[3]", surface_vis, align=127, size=4)
    for base in (0, 9, 18):
        for i in range(base, base + 9):
            z.elements(w, f"{v}smodelUnknownVisData[{i}]", smodel_vis, align=127, size=4)
        for i in range(base, base + 9):
            z.elements(w, f"{v}surfaceUnknownVisData[{i}]", surface_vis, align=127, size=4)
    for i in range(3):
        z.elements(w, f"{v}smodelUmbraVisData[{i}]", smodel_vis + 1, align=127, size=4)
    for i in range(3):
        z.elements(w, f"{v}surfaceUmbraVisData[{i}]", surface_vis, align=127, size=4)
    z.elements(w, f"{v}smodelUmbraVisData[3]", smodel_vis + 1, align=127, size=4)
    z.elements(w, f"{v}surfaceUmbraVisData[3]", surface_vis, align=127, size=4)
    z.pop()

    z.elements(w, v + "lodData", smodels + 1, align=3, size=4)
    z.elements(w, v + "sortedSurfIndex", w[v + "staticSurfaceCount"], align=3, size=4)
    instances_at = z.elements(w, v + "smodelInsts", smodels, align=3)
    surfaces_at, surface_records, materials = None, [], []
    if follows(w[v + "surfaces"]):
        z.align(3)
        surface_records = z.array("GfxSurface", surfaces)
        surfaces_at = surface_records[0].at if surface_records else None
        for surface in surface_records:
            materials.append(field_asset(z, surface, "material", "MATERIAL"))
    z.elements(w, v + "surfacesBounds", surfaces, align=3)
    draw_insts, placements = [], []
    if follows(w[v + "smodelDrawInsts"]):
        z.align(3)
        draw_insts = z.array("GfxStaticModelDrawInst", smodels)
        for inst in draw_insts:
            placements.append(placement(inst, field_asset(z, inst, "model", "XMODEL")))
    if follows(w[v + "smodelLightingInsts"]):
        z.align(3)
        for inst, draw in zip(z.array("GfxStaticModelLighting", smodels), draw_insts, strict=True):
            # Only a vertex-lit model carries lighting values; the flag is on its
            # sibling in smodelDrawInsts, which is why that array is read first.
            if draw["flags"] & 0x80:
                inst.touch("vertexLightingInfo.lightingValuesVb")
                z.elements(
                    inst, "vertexLightingInfo.lightingValues", inst["vertexLightingInfo.numLightingValues"], align=3, size=20
                )
    z.elements(w, v + "subdivVertexLighting", w[v + "subdivVertexLightingInfoCount"], align=3)
    z.push(RUNTIME)
    z.elements(w, v + "surfaceMaterials", surfaces, align=7)
    z.elements(w, v + "surfaceCastsSunShadow", surface_vis, align=127, size=4)
    z.elements(w, v + "surfaceCastsSunShadowOpt", w[v + "sunShadowOptCount"] * w[v + "sunSurfVisDataCount"], align=127, size=4)
    z.elements(w, v + "surfaceDeptAndSurf", w[v + "staticSurfaceCount"], align=3)
    z.elements(w, v + "constantBuffersLit", smodels, align=7, size=8)
    z.elements(w, v + "constantBuffersAmbient", smodels, align=7, size=8)
    words0, words1 = w["dpvsDyn.dynEntClientWordCount[0]"], w["dpvsDyn.dynEntClientWordCount[1]"]
    z.elements(w, "dpvsDyn.dynEntCellBits[0]", words0 * cells, align=3, size=4)
    z.elements(w, "dpvsDyn.dynEntCellBits[1]", words1 * cells, align=3, size=4)
    # 16-byte aligned, unlike every other vis array here, which is 128 (x64-zt's
    # s1 gfxworld writer). At 128 the padding of these eight is the rest of it.
    for j in range(3):
        z.elements(w, f"dpvsDyn.dynEntVisData[0][{j}]", 32 * words0, align=15, size=1)
    for j in range(3):
        z.elements(w, f"dpvsDyn.dynEntVisData[1][{j}]", 32 * words1, align=15, size=1)
    z.elements(w, "dpvsDyn.dynEntVisData[0][3]", 32 * words0, align=15, size=1)
    z.elements(w, "dpvsDyn.dynEntVisData[1][3]", 32 * words1, align=15, size=1)
    z.pop()

    z.elements(w, "heroOnlyLights", w["heroOnlyLightCount"], align=3)
    w.touch("umbraTomePtr")
    z.elements(w, "umbraTomeData", w["umbraTomeSize"], align=15, size=1)
    if follows(w["mdaoVolumes"]):
        z.align(3)
        for volume in z.array("MdaoVolume", w["mdaoVolumesCount"]):
            field_asset(z, volume, "volumeData", "IMAGE")
    for path in ("bspCommandline", "lightCommandline", "bspTimestamp", "lightTimestamp"):
        z.field_string(w, "buildInfo." + path)
    z.pop()
    # Where the geometry landed, so an exporter need not walk it a second time.
    z.record(
        "GFXWORLD",
        name,
        {
            "vertices_at": vertices_at,
            "vertexCount": w[d + "vertexCount"],
            "indices_at": indices_at,
            "indexCount": w[d + "indexCount"],
            "surfaces_at": surfaces_at,
            "surfaceCount": surfaces,
            "bspVersion": w["bspVersion"],
            "smodelCount": smodels,
        },
    )
    WORLDS.append(
        World(
            name,
            base_name,
            w,
            vertices_at,
            indices_at,
            surface_records,
            sky_surfaces,
            materials,
            placements,
            instances_at,
            models_at,
        )
    )
    return name


@walker("FXWORLD")
def fx_world(z):
    """The glass system. S1 writes initGeoData before initPieceStates; IW6 swaps them."""
    world = z.struct("FxWorld")
    g = "glassSys."
    z.push(VIRTUAL)
    name = z.field_string(world, "name")
    if follows(world[g + "defs"]):
        z.align(3)
        for glass in z.array("FxGlassDef", world[g + "defCount"]):
            field_asset(z, glass, "physPreset", "PHYSPRESET")
            field_asset(z, glass, "material", "MATERIAL")
            field_asset(z, glass, "materialShattered", "MATERIAL")
            for path in ("pieceBreakEffect", "shatterEffect", "shatterSmallEffect", "crackDecalEffect"):
                field_asset(z, glass, path, "FX")
            for path in ("damagedSound", "destroyedSound", "destroyedQuietSound"):
                field_snd(z, glass, path)
    # Everything the glass system keeps per piece is rebuilt at load: it moves the
    # runtime block's cursor and takes nothing out of the file.
    limit, words = world[g + "pieceLimit"], world[g + "pieceWordCount"]
    z.push(RUNTIME)
    for path, count, mask, size in (
        ("piecePlaces", limit, 3, None),
        ("pieceStates", limit, 3, 32),
        ("pieceDynamics", limit, 3, 48),
        ("geoData", world[g + "geoDataLimit"], 3, 4),
        ("isInUse", words, 3, 4),
        ("cellBits", words * world[g + "cellCount"], 3, 4),
        ("visData", (limit + 15) & ~15, 15, 1),
        ("linkOrg", limit, 3, 12),
        ("halfThickness", (limit + 3) & ~3, 15, 4),
    ):
        z.elements(world, g + path, count, align=mask, size=size)
    z.pop()
    z.elements(world, g + "lightingHandles", world[g + "initPieceCount"], align=1, size=2)
    z.elements(world, g + "initGeoData", world[g + "initGeoDataCount"], align=3, size=4)
    z.elements(world, g + "initPieceStates", world[g + "initPieceCount"], align=3, size=56)
    z.pop()
    return name


@walker("GLASSWORLD")
def glass_world(z):
    """The breakable glass: one piece per pane, and the script names that address them."""
    world = z.struct("GlassWorld")
    z.push(VIRTUAL)
    name = z.field_string(world, "name")
    if follows(world["g_glassData"]):
        z.align(3)
        data = z.struct("G_GlassData")
        z.elements(data, "glassPieces", data["pieceCount"], align=3)
        if follows(data["glassNames"]):
            z.align(3)
            for entry in z.array("G_GlassName", data["glassNameCount"]):
                z.field_string(entry, "nameStr")
                z.elements(entry, "pieceIndices", entry["pieceCount"], align=1)
    z.pop()
    return name


def map_triggers(z, ents, prefix):
    """MapTriggers: the brush hulls behind a map's triggers. A MapEnts carries two --
    the server's and the client's -- so the shape is written once here."""
    z.elements(ents, prefix + "models", ents[prefix + "count"], align=3)
    z.elements(ents, prefix + "hulls", ents[prefix + "hullCount"], align=3)
    z.elements(ents, prefix + "slabs", ents[prefix + "slabCount"], align=3)


# ClientTriggers' parallel arrays: one entry per trigger, each a different property
# of it. They are written in this order, and the two vector ones are 4-byte aligned
# where the rest are 2-byte, which is the only thing separating them.
CLIENT_TRIGGER_ARRAYS = (
    ("visionSetTriggers", 1),
    ("lightSetTriggers", 1),
    ("clutTriggers", 1),
    ("triggerType", 1),
    ("origins", 3),
    ("scriptDelay", 3),
    ("audioTriggers", 1),
    ("blendLookup", 1),
    ("npcTriggers", 1),
    ("contextTriggers", 1),
    ("waterTriggers", 1),
)


@walker("MAP_ENTS")
def map_ents(z):
    """The map's entities: the entity string every spawn, trigger and script origin is
    parsed out of, the trigger brushes, and the spawn table the server uses."""
    ents = z.struct("MapEnts")
    z.push(VIRTUAL)
    name = z.field_string(ents, "name")
    entity_string = z.elements(ents, "entityString", ents["numEntityChars"])
    map_triggers(z, ents, "trigger.")
    map_triggers(z, ents, "clientTrigger.trigger.")
    count = ents["clientTrigger.trigger.count"]
    z.elements(ents, "clientTrigger.clientTriggerAabbTree", ents["clientTrigger.numClientTriggerNodes"], align=3)
    z.elements(ents, "clientTrigger.triggerString", ents["clientTrigger.triggerStringLength"])
    for path, align in CLIENT_TRIGGER_ARRAYS:
        z.elements(ents, "clientTrigger." + path, count, align=align)
    z.elements(ents, "clientTriggerBlend.blendNodes", ents["clientTriggerBlend.numClientTriggerBlendNodes"], align=3)
    spawns = z.elements(ents, "spawnList.spawns", ents["spawnList.spawnsCount"], align=3)
    if follows(ents["splineList.splines"]):
        z.align(3)
        for spline in z.array("SplinePointRecordList", ents["splineList.splineCount"]):
            if not follows(spline["splinePoints"]):
                continue
            z.align(3)
            for point in z.array("SplinePointEntityRecord", spline["splinePointCount"]):
                z.elements(point, "splineNodeLabel", 64)
                z.elements(point, "positionCubic", 4, align=3)
                z.elements(point, "tangentQuadratic", 3, align=3)
    z.pop()
    z.record(
        "MAPENTS",
        name,
        {
            "entity_string_at": entity_string,
            "numEntityChars": ents["numEntityChars"],
            "spawns_at": spawns,
            "spawnsCount": ents["spawnList.spawnsCount"],
            "triggerCount": ents["trigger.count"],
            "clientTriggerCount": count,
        },
    )
    return name


# FxImpactTable: 19 entries of nonflesh[53] + flesh[7], as x64-zt's H1 header has it
# (the X360 PDB's nonflesh[31] + flesh[4] is not the PC's). The walk only fixes the
# product, 1,140 handles; the shape is read off the names: each entry is one weapon
# class across the 53 surface types, with its flesh effects in the last seven slots.
FX_IMPACT_ENTRIES = 19
FX_NONFLESH, FX_FLESH = 53, 7


@walker("IMPACT_FX")
def impact_fx(z):
    table = z.struct("FxImpactTable")
    z.push(VIRTUAL)
    name = z.field_string(table, "name")
    if follows(table["table"]):
        z.align(3)
        for entry in z.array("FxImpactEntry", FX_IMPACT_ENTRIES):
            for k in range(FX_NONFLESH):
                field_asset(z, entry, f"nonflesh[{k}]", "FX")
            for k in range(FX_FLESH):
                field_asset(z, entry, f"flesh[{k}]", "FX")
    z.pop()
    return name


# SurfaceFxTable.table: 6 entries of one handle per surface type, x64-zt's H1 shape
# (its s1 header omits the asset). common_mp's one table reads as six shell-eject
# families, each across all 53 surfaces, which is what fixes the stride.
SURFACE_FX_ENTRIES, SURFACE_FX_SURFACES = 6, 53


@walker("SURFACE_FX")
def surface_fx(z):
    table = z.struct("SurfaceFxTable")
    z.push(VIRTUAL)
    name = z.field_string(table, "name")
    if follows(table["table"]):
        z.align(3)
        block, cursor = z.block, z.blocks[z.block]
        start = z.take(8 * SURFACE_FX_ENTRIES * SURFACE_FX_SURFACES)
        for i in range(SURFACE_FX_ENTRIES * SURFACE_FX_SURFACES):
            asset(z, "FX", z.u64(start + 8 * i), (block, cursor + 8 * i))
    z.pop()
    return name


@walker("VECTORFIELD")
def vector_field(z):
    """x64-zt's H1 writer: the sub-fields 16-aligned, then each one's grid of vec4s."""
    field = z.struct("VectorField")
    z.push(VIRTUAL)
    name = z.field_string(field, "name")
    if follows(field["fields"]):
        z.align(15)
        for sub in z.array("VectorFieldSubField", field["fieldsCount"]):
            x, y, w = struct.unpack("<3I", sub.bytes("numEntries"))
            z.elements(sub, "linearData", x * y * w, align=3)
    z.pop()
    return name


AIM_SET = 112  # H1's AnimationAimSet: 4-byte scr_string_ts and 8-byte anim indices


@walker("ANIMCLASS")
def anim_class(z):
    """AnimationClass, in x64-zt's H1 writer's order. The anim indices are RUNTIME."""
    anim = z.struct("AnimationClass")
    z.push(VIRTUAL)
    name = z.field_string(anim, "className")
    if follows(anim["stateMachine"]):
        z.align(3)
        machine = z.struct("AnimationStateMachine")
        if follows(machine["states"]):
            z.align(3)
            for state in z.array("AnimationState", machine["stateCount"]):
                z.elements(state, "aimSet", 1, align=3, size=AIM_SET)
                z.elements(state, "animEntries", state["entryCount"], align=3)
                z.push(RUNTIME)
                z.elements(state, "animIndices", state["entryCount"], align=3)
                z.pop()
        z.elements(machine, "aimSets", machine["aimSetCount"], align=3, size=AIM_SET)
    if follows(anim["scriptable"]):
        raise NotImplementedError(f"animclass {name} carries its ScriptableDef inline")
    sounds, effects = anim["soundCount"], anim["effectCount"]
    for path in ("soundNotes", "soundNames", "soundOptions"):
        z.elements(anim, path, sounds, align=3)
    z.elements(anim, "effectNotes", effects, align=3)
    z.handles(anim, "effectDefs", effects, fx, "FX")
    z.elements(anim, "effectTags", effects, align=3)
    z.pop()
    return name


EQUIPMENT_TABLES = (
    "clothTypes",
    "weaponRattleTypes",
    "chancesPLR",
    "chancesNPC",
    "mvmtClothSoundSets",
    "mvmtRattleSoundSets",
    "mvmtAccentSoundSets",
    "mvmtMantleSoundSets",
)


@walker("EQUIPMENT_SND_TABLE")
def equipment_sound_table(z):
    """H1's 88-byte struct, which the one table in common_mp fills to the byte: a name
    and nothing else, as x64-zt says H1's is. Nothing writes the tables, so one that
    follows is refused rather than guessed at."""
    table = z.struct("EquipmentSoundTable")
    z.push(VIRTUAL)
    name = z.field_string(table, "szName")
    for path in EQUIPMENT_TABLES:
        if table[path]:
            raise NotImplementedError(f"equipment sound table {name}: {path} is not walked")
    z.pop()
    return name


@walker("PHYSPRESET")
def phys_preset(z):
    preset = z.struct("PhysPreset")
    z.push(VIRTUAL)
    name = z.field_string(preset, "name")
    z.field_string(preset, "sndAliasPrefix")
    z.pop()
    return name


# VehicleDef's sound aliases, in the order the loader reads them. Each is a
# Load_SndAliasCustom: an 8-byte slot and then the alias name.
VEHICLE_SOUNDS = (
    "turretSpinSnd",
    "turretStopSnd",
)
VEHICLE_SOUNDS_LATE = (
    "idleLowSnd",
    "idleHighSnd",
    "engineLowSnd",
    "engineHighSnd",
    "boostSnd",
    "idleLowSndAlt",
    "idleHighSndAlt",
    "engineLowSndAlt",
    "engineHighSndAlt",
    "turretSpinSndAlt",
    "turretStopSndAlt",
    "engineStartUpSnd",
    "engineShutdownSnd",
    "engineIdleSnd",
    "engineSustainSnd",
    "engineRampUpSnd",
    "engineRampDownSnd",
    "suspensionSoftSnd",
    "suspensionHardSnd",
    "collisionSnd",
    "speedSnd",
)
VEHICLE_SURFACE_SOUNDS = 53


@walker("VEHICLE")
def vehicle(z):
    """VehicleDef. x64-zt leaves S1's vehicles unimplemented, but its **H1** writer
    is a full one and H1's VehicleDef has the same members in the same order -- down
    to `surfaceSnds[53]` -- so this is a port of that rather than a derivation."""
    veh = z.struct("VehicleDef")
    z.push(VIRTUAL)
    name = z.field_string(veh, "name")
    veh.touch("internalName")  # a union with name
    z.field_string(veh, "useHintString")
    z.field_string(veh, "vehPhysDef.physPresetName")
    field_asset(z, veh, "vehPhysDef.physPreset", "PHYSPRESET")
    z.field_string(veh, "vehPhysDef.physMassName")
    z.elements(veh, "vehPhysDef.physMass", 1, align=3)
    z.field_string(veh, "vehPhysDef.accelGraphName")
    for path in ("treadDefaultFx", "handBrakeDefaultFx", "handBrakeLeftFx", "handBrakeRightFx", "boostFx"):
        field_asset(z, veh, path, "FX")
    field_asset(z, veh, "vehHelicopterGroundFx", "FX")
    field_asset(z, veh, "vehHelicopterGroundWaterFx", "FX")
    z.field_string(veh, "vehDiveboatSteeringGraphName")
    z.field_string(veh, "turretWeaponName")
    field_asset(z, veh, "turretWeapon", "WEAPON")
    for path in VEHICLE_SOUNDS:
        field_snd(z, veh, path)
    field_asset(z, veh, "trophyExplodeFx", "FX")
    field_asset(z, veh, "trophyFlashFx", "FX")
    for path in ("compassFriendlyIcon", "compassEnemyIcon", "compassFriendlyAltIcon", "compassEnemyAltIcon"):
        field_asset(z, veh, path, "MATERIAL")
    for path in VEHICLE_SOUNDS_LATE:
        field_snd(z, veh, path)
    z.field_string(veh, "surfaceSndPrefix")
    for i in range(VEHICLE_SURFACE_SOUNDS):
        field_snd(z, veh, f"surfaceSnds[{i}]")
    z.field_string(veh, "soundTriggerOverrideZone")
    z.pop()
    return name


@walker("FONT")
def font(z):
    glyphs = z.struct("Font_s")
    z.push(VIRTUAL)
    name = z.field_string(glyphs, "fontName")
    glyphs.touch("name")  # a union with fontName
    field_asset(z, glyphs, "material", "MATERIAL")
    field_asset(z, glyphs, "glowMaterial", "MATERIAL")
    z.elements(glyphs, "glyphs", glyphs["glyphCount"], align=3)
    z.pop()
    return name


@walker("REVERB_PRESET")
def reverb_preset(z):
    """ReverbPreset: a name and sixteen floats. Another asset x64-zt omits, so the
    struct is the X360 PDB's."""
    preset = z.struct("ReverbPreset")
    z.push(VIRTUAL)
    name = z.field_string(preset, "p_name")
    z.pop()
    return name


@walker("SOUND_SUBMIX")
def sound_submix(z):
    """SndSubmixList. x64-zt comments this asset out of its XAssetHeader, so the
    struct comes from the X360 PDB, which is the only source that has it."""
    submixes = z.struct("SndSubmixList")
    z.push(VIRTUAL)
    name = z.field_string(submixes, "submixName")
    if follows(submixes["head"]):
        z.align(3)
        for submix in z.array("SndSubmix", submixes["count"]):
            z.field_string(submix, "submixName")
    z.pop()
    return name


@walker("PARTICLE_SIM_ANIMATION")
def particle_sim_animation(z):
    anim = z.struct("FxParticleSimAnimation")
    z.push(VIRTUAL)
    name = z.field_string(anim, "name")
    field_asset(z, anim, "material", "MATERIAL")
    z.elements(anim, "particleData", anim["header.particleDataCount"], align=31)
    z.elements(anim, "frames", anim["header.frameCount"], align=3)
    z.elements(anim, "colorTable", anim["header.colorTableSize"], align=3)
    z.pop()
    return name


@walker("PHYSCONSTRAINT")
def phys_constraint(z):
    constraint = z.struct("PhysConstraint")
    z.push(VIRTUAL)
    name = z.field_string(constraint, "name")
    z.pop()
    return name


@walker("PHYSWATERPRESET")
def phys_water_preset(z):
    preset = z.struct("PhysWaterPreset")
    z.push(VIRTUAL)
    name = z.field_string(preset, "name")
    for i in range(7):
        field_asset(z, preset, f"fx{i}", "FX")
    z.pop()
    return name


@walker("SKELETON_SCRIPT")
def skeleton_script(z):
    script = z.struct("SkeletonScript")
    z.push(VIRTUAL)
    name = z.field_string(script, "name")
    z.elements(script, "ikData.solverIDs", script["ikData.numSolvers"])
    z.elements(script, "ikData.floatParams", script["ikData.numFloatParams"], align=3)
    z.elements(script, "ikData.intParams", script["ikData.numIntParams"], align=3)
    z.elements(script, "ikData.stringParams", script["ikData.numStringParams"], align=3)
    z.elements(script, "code", script["codeSize"], align=3)
    z.pop()
    return name


@walker("PHYSCOLLMAP")
def phys_collmap(z):
    """S1 stores a geom as polytope data; IW6 stores a brush wrapper."""
    collmap = z.struct("PhysCollmap")
    z.push(VIRTUAL)
    name = z.field_string(collmap, "name")
    if follows(collmap["geoms"]):
        z.align(3)
        for geom in z.array("PhysGeomInfo", collmap["count"]):
            if not follows(geom["data"]):
                continue
            z.align(3)
            poly = z.struct("dmPolytopeData")
            verts, faces = poly["m_vertexCount"], poly["m_faceCount"]
            z.elements(poly, "m_aVertices", verts, align=15)
            z.elements(poly, "m_aPlanes", faces, align=15)
            z.elements(poly, "m_aSubEdges", poly["m_subEdgeCount"], align=3)
            z.elements(poly, "m_aFaceSubEdges", faces)
            z.elements(poly, "m_surfaceTypes", faces, align=1)
            z.elements(poly, "m_vertexMaterials", verts, align=1)
    z.pop()
    return name


def polytope_data(z, poly):
    """dmPolytopeData: a convex hull, written the same way by a collmap and by the
    physics world."""
    verts, faces = poly["m_vertexCount"], poly["m_faceCount"]
    z.elements(poly, "m_aVertices", verts, align=15)
    z.elements(poly, "m_aPlanes", faces, align=15)
    z.elements(poly, "m_aSubEdges", poly["m_subEdgeCount"], align=3)
    z.elements(poly, "m_aFaceSubEdges", faces)
    z.elements(poly, "m_surfaceTypes", faces, align=1)
    z.elements(poly, "m_vertexMaterials", verts, align=1)


@walker("PHYSWORLDMAP")
def phys_world(z):
    """The map's physics geometry: a hull or a triangle mesh per brush model."""
    world = z.struct("PhysWorld")
    z.push(VIRTUAL)
    name = z.field_string(world, "name")
    brush_models = z.elements(world, "brushModels", world["brushModelCount"], align=3)
    polytopes, meshes = None, None
    if follows(world["polytopeDatas"]):
        z.align(3)
        records = z.array("dmPolytopeData", world["polytopeCount"])
        polytopes = records[0].at if records else None
        for poly in records:
            polytope_data(z, poly)
    if follows(world["meshDatas"]):
        z.align(3)
        records = z.array("dmMeshData", world["meshDataCount"])
        meshes = records[0].at if records else None
        for mesh in records:
            z.elements(mesh, "m_pRoot", mesh["m_nodeCount"], align=15)
            z.elements(mesh, "m_aVertices", mesh["m_vertexCount"], align=15)
            z.elements(mesh, "m_aTriangles", mesh["m_triangleCount"], align=3)
    if follows(world["waterVolumeDefs"]):
        z.align(3)
        for volume in z.array("PhysWaterVolumeDef", world["waterVolumeDefCount"]):
            field_asset(z, volume, "physWaterPreset", "PHYSWATERPRESET")
    z.pop()
    z.record(
        "PHYSWORLDMAP",
        name,
        {
            "brushModels_at": brush_models,
            "brushModelCount": world["brushModelCount"],
            "polytopes_at": polytopes,
            "polytopeCount": world["polytopeCount"],
            "meshes_at": meshes,
            "meshDataCount": world["meshDataCount"],
        },
    )
    return name


def clip_info(z, info, p=""):
    """ClipInfo: the collision itself, in the order S1 regrouped it into. IW6 writes
    the same data as a flat list; S1 splits it into a tree and a data block per kind
    (brushes, patches, static models), and writes the two trees before either's data.

    Returns the file offset of each array an exporter needs, `None` where the zone
    aliases one rather than carrying it, plus the per-element lists that only a walk
    can produce: a name a handle resolved to, and an offset a pointer that *follows*
    stood for (nothing in the file records either).
    """
    at = {"materials": [], "brushSides": None, "brushes": None, "brush_sides": [], "leafbrush_nodes": [], "staticModels": []}
    # A map writes its planes and its leaf-brush list once and points at them from
    # both its ClipInfos, so on the second the pointer is a reference rather than
    # data that follows. `located` is where those bytes are; missing it reads the
    # array as absent and exports every brush as its own bounding box.
    at["planes"] = z.elements(info, p + "planes", info[p + "planeCount"], align=3) or z.located(info[p + "planes"])
    if follows(info[p + "materials"]):
        z.align(3)
        for material in z.array("ClipMaterial", info[p + "numMaterials"]):
            at["materials"].append((z.field_string(material, "name"), material["surfaceFlags"], material["contents"]))
    tree = p + "bCollisionTree."
    at["leafbrushNodes"] = None
    if follows(info[tree + "leafbrushNodes"]):
        z.align(3)
        nodes = z.array("cLeafBrushNode_s", info[tree + "leafbrushNodesCount"])
        at["leafbrushNodes"] = nodes[0].at if nodes else None
        for node in nodes:
            if node["leafBrushCount"] > 0:
                at["leafbrush_nodes"].append(z.elements(node, "data.leaf.brushes", node["leafBrushCount"], align=1))
            else:
                node.touch("data.leaf.brushes")
                at["leafbrush_nodes"].append(None)
    at["leafbrushes"] = z.elements(info, tree + "leafbrushes", info[tree + "numLeafBrushes"], align=1) or z.located(
        info[tree + "leafbrushes"]
    )
    at["aabbTrees"] = z.elements(info, p + "pCollisionTree.aabbTrees", info[p + "pCollisionTree.aabbTreeCount"], align=15)
    z.elements(info, p + "sCollisionTree.smodelNodes", info[p + "sCollisionTree.smodelNodeCount"], align=3)
    brushes = p + "bCollisionData."
    at["brushSides"] = z.elements(info, brushes + "brushSides", info[brushes + "numBrushSides"], align=3)
    at["brushEdges"] = z.elements(info, brushes + "brushEdges", info[brushes + "numBrushEdges"])
    if follows(info[brushes + "brushes"]):
        z.align(127)
        records = z.array("cbrush_t", info[brushes + "numBrushes"])
        at["brushes"] = records[0].at if records else None
        for brush in records:
            # A brush's sides are a reference into brushSides, written above; `located`
            # turns it into a file offset, which the dumper checks lands on an element.
            at["brush_sides"].append(z.located(brush["sides"]))
            z.elements(brush, "sides", 1, align=3)
            z.elements(brush, "baseAdjacentSide", 1)
    at["brushBounds"] = z.elements(info, brushes + "brushBounds", info[brushes + "numBrushes"], align=127)
    at["brushContents"] = z.elements(info, brushes + "brushContents", info[brushes + "numBrushes"], align=3)
    patches = p + "pCollisionData."
    at["verts"] = z.elements(info, patches + "verts", info[patches + "vertCount"], align=3)
    tris = info[patches + "triCount"]
    at["triIndices"] = z.elements(info, patches + "triIndices", 3 * tris, align=1)
    at["triEdgeIsWalkable"] = None
    if follows(info[patches + "triEdgeIsWalkable"]):
        # One bit per triangle edge, rounded up to a whole number of 4-byte words.
        at["triEdgeIsWalkable"] = z.take(((3 * tris + 31) >> 3) & ~3)
    at["borders"] = z.elements(info, patches + "borders", info[patches + "borderCount"], align=3)
    if follows(info[patches + "partitions"]):
        z.align(3)
        records = z.array("CollisionPartition", info[patches + "partitionCount"])
        at["partitions"] = records[0].at if records else None
        for partition in records:
            z.elements(partition, "borders", 1, align=3)
    smodels = p + "sCollisionData."
    at["staticModelList"] = None
    if follows(info[smodels + "staticModelList"]):
        z.align(3)
        records = z.array("cStaticModel_s", info[smodels + "numStaticModels"])
        at["staticModelList"] = records[0].at if records else None
        for smodel in records:
            model = field_asset(z, smodel, "xmodel", "XMODEL")
            at["staticModels"].append(model[1] if model else None)
    return at


def dyn_entities(z, cm, index):
    """One of the two dynamic-entity lists: the defs in VIRTUAL, the state in RUNTIME.

    Returns (file offset of the array, the model each entry names)."""
    count = cm[f"dynEntCount[{index}]"]
    start, models = None, []
    if follows(cm[f"dynEntDefList[{index}]"]):
        z.align(3)
        records = z.array("DynEntityDef", count)
        start = records[0].at if records else None
        for entity in records:
            model = field_asset(z, entity, "baseModel", "XMODEL")
            models.append(model[1] if model else None)
            field_asset(z, entity, "destroyFx", "FX")
            # A whole snd_alias_list_t, not Load_SndAliasCustom's name-only stub: one
            # dynamic entity on mp_comeback carries its sound inline, and reading nine
            # bytes where the zone wrote a 32-byte header left the next model a byte late.
            field_asset(z, entity, "sound", "SOUND")
            field_asset(z, entity, "physPreset", "PHYSPRESET")
            z.elements(entity, "hinge", 1, align=3)
            z.elements(entity, "linkTo", 1, align=3)
    return start, models


@walker("CLIPMAP")
def clip_map(z):
    """The map's collision. Nothing implements this for S1, so the order below is
    IW6's clipmap rewritten around S1's regrouped ClipInfo, and the evidence that it
    is right is the zone: the assets after it read, and every block cursor lands on
    the size the zone header declares."""
    cm = z.struct("clipMap_t")
    z.push(VIRTUAL)
    name = z.field_string(cm, "name")
    at = clip_info(z, cm, "info.")
    z.push(TEMP)
    if follows(cm["pInfo"]):
        # pInfo is written -2 on every map, so the loader calls DB_InsertPointer and
        # the 8-byte VIRTUAL slot it reserves is charged even though the ClipInfo
        # behind it loads into TEMP. Missing it puts every VIRTUAL address after the
        # clipmap's collision 8 bytes low, which only an alias reveals.
        z.align(3)
        if cm["pInfo"] & 0xFFFFFFFF == INSERT:
            z.insert_pointer()
        clip_info(z, z.struct("ClipInfo"))
    z.pop()
    if follows(cm["nodes"]):
        z.align(3)
        for node in z.array("cNode_t", cm["numNodes"]):
            z.elements(node, "plane", 1, align=3)
    leafs_at = z.elements(cm, "leafs", cm["numLeafs"], align=3)
    cmodels_at, foreign = None, []
    if follows(cm["cmodels"]):
        z.align(3)
        records = z.array("cmodel_t", cm["numSubModels"])
        cmodels_at = records[0].at if records else None
        for model in records:
            # Every stock submodel's ClipInfo is a reference to the map's own. One that
            # followed would be a ClipInfo written inline that nothing here walks, so the
            # zone would not read past it -- record it rather than quietly sharing.
            foreign.append(follows(model["info"]))
            model.touch("info")
    field_asset(z, cm, "mapEnts", "MAP_ENTS")
    if follows(cm["stages"]):
        z.align(3)
        for stage in z.array("Stage", cm["stageCount"]):
            z.field_string(stage, "name")
    map_triggers(z, cm, "stageTrigger.")
    dyn_ents = [dyn_entities(z, cm, 0), dyn_entities(z, cm, 1)]
    z.push(RUNTIME)
    for kind in ("dynEntPoseList", "dynEntClientList", "dynEntCollList"):
        for index in (0, 1):
            z.elements(cm, f"{kind}[{index}]", cm[f"dynEntCount[{index}]"], align=3)
    z.pop()
    z.elements(cm, "dynEntAnchorNames", cm["dynEntAnchorCount"], align=3)
    scriptables(z, cm)
    grapple(z, cm)
    z.pop()
    lists = ("materials", "brush_sides", "leafbrush_nodes", "staticModels")
    found = {f"{key}_at": value for key, value in at.items() if key not in lists}
    found.update({key: at[key] for key in lists})
    found.update(
        at=cm.at,
        leafs_at=leafs_at,
        cmodels_at=cmodels_at,
        foreignClipInfo=foreign,
        dynEntDefList_at=[dyn_ents[0][0], dyn_ents[1][0]],
        dynEntModels=[dyn_ents[0][1], dyn_ents[1][1]],
        dynEntCount=[cm["dynEntCount[0]"], cm["dynEntCount[1]"]],
        checksum=cm["checksum"],
        numNodes=cm["numNodes"],
        numLeafs=cm["numLeafs"],
        numSubModels=cm["numSubModels"],
        planeCount=cm["info.planeCount"],
        numMaterials=cm["info.numMaterials"],
        leafbrushNodesCount=cm["info.bCollisionTree.leafbrushNodesCount"],
        numLeafBrushes=cm["info.bCollisionTree.numLeafBrushes"],
        aabbTreeCount=cm["info.pCollisionTree.aabbTreeCount"],
        numBrushes=cm["info.bCollisionData.numBrushes"],
        numBrushSides=cm["info.bCollisionData.numBrushSides"],
        vertCount=cm["info.pCollisionData.vertCount"],
        triCount=cm["info.pCollisionData.triCount"],
        borderCount=cm["info.pCollisionData.borderCount"],
        partitionCount=cm["info.pCollisionData.partitionCount"],
        numStaticModels=cm["info.sCollisionData.numStaticModels"],
    )
    z.record("CLIPMAP", name, found)
    return name


# ScriptableEventType. Only the cases that carry something to read are named.
EVENT_MODEL, EVENT_FX, EVENT_STOP_FX, EVENT_SOUND, EVENT_ANIMATION = 0, 1, 2, 3, 4
EVENT_PHYSICSLAUNCH, EVENT_LIGHTSETTINGS = 7, 8
EVENT_SHAKE, EVENT_TRANSLATE, EVENT_ROTATE = 10, 11, 12
NOTETRACK_FX, NOTETRACK_SOUND = 0, 1


def scriptable_event(z, event):
    """One ScriptableEventDef. Its union is read by its type and nothing else, so an
    unnamed type must carry no pointer -- which z.check() is what proves."""
    kind = event["type"]
    if kind == EVENT_MODEL:
        field_asset(z, event, "data.setModel.model", "XMODEL")
    elif kind == EVENT_FX:
        field_asset(z, event, "data.playFx.handle", "FX")
    elif kind == EVENT_STOP_FX:
        field_asset(z, event, "data.stopFx.handle", "FX")
    elif kind == EVENT_SOUND:
        field_snd(z, event, "data.playSound.alias")
    elif kind == EVENT_ANIMATION:
        z.field_string(event, "data.playAnim.animName")
    elif kind == EVENT_PHYSICSLAUNCH:
        field_asset(z, event, "data.physicsLaunch.model", "XMODEL")
    elif kind == EVENT_LIGHTSETTINGS:
        z.field_string(event, "data.lightSettings.noteworthy")
    elif kind == EVENT_SHAKE:
        z.field_string(event, "data.shake.rumbleName")
    elif kind == EVENT_TRANSLATE:
        z.field_string(event, "data.translate.noteworthy")
    elif kind == EVENT_ROTATE:
        z.field_string(event, "data.rotate.noteworthy")


def scriptable_def(z):
    """A ScriptableDef written inline. S1 has a SCRIPTABLE asset type, but a map's
    clipmap does not reference one: it carries the definition itself, so this is the
    asset's own writer with the header bits dropped. Returns the def's record, which
    is what sizes the instance's buffers.

    It is loaded like any asset that follows inline (Zone.handle): the ScriptableDef
    itself into TEMP, everything behind it into VIRTUAL. Reading the 64-byte struct
    from VIRTUAL instead puts every address after the first definition 64 bytes high,
    which the materialHandles alias of its own base model catches at once.
    """
    z.push(TEMP)
    z.align(3)
    definition = z.struct("ScriptableDef")
    z.push(VIRTUAL)
    z.field_string(definition, "name")
    field_asset(z, definition, "baseModel", "XMODEL")
    z.field_string(definition, "baseCollisionBrush")
    z.field_string(definition, "destroyedCollisionBrush")
    if follows(definition["parts"]):
        z.align(3)
        for part in z.array("ScriptablePartDef", definition["partCount"]):
            if not follows(part["states"]):
                continue
            z.align(3)
            for state in z.array("ScriptableStateDef", part["stateCount"]):
                if not follows(state["onEnterEvents"]):
                    continue
                z.align(3)
                for event in z.array("ScriptableEventDef", state["onEnterEventCount"]):
                    scriptable_event(z, event)
    if follows(definition["notetracks"]):
        z.align(3)
        for track in z.array("ScriptableNotetrackDef", definition["notetrackCount"]):
            if track["type"] == NOTETRACK_SOUND:
                field_snd(z, track, "data.playSound.alias")
            elif track["type"] == NOTETRACK_FX:
                field_asset(z, track, "data.playFx.handle", "FX")
    z.pop()
    z.pop()
    return definition


def _aliased_def(z, defs, pointer, base, stride):
    """The definition an instance's handle alias names, when the address does not
    match ours exactly.

    An alias always names the `def` field of an earlier instance, so its offset is
    the array's base plus a whole number of strides. If ours is off by a constant,
    the remainder says by how much -- which is a *measurement of drift earlier in
    the walk*, not something to paper over, so it is recorded for the report rather
    than swallowed.
    """
    block, offset = reference(pointer)
    index, remainder = divmod(offset - base, stride)
    if remainder and 0 <= index < len(defs) + 64:
        z.found.setdefault("DRIFT", {})["scriptable def alias"] = remainder
    for (_, cursor), definition in defs.items():
        if cursor == base + index * stride:
            return definition
    raise ValueError(f"clipmap: a scriptable aliases a def at {(block, offset)}, {remainder} past instance {index}")


def scriptables(z, cm):
    """ScriptableMapEnts: the map's destructible props.

    A map's clipmap does not reference SCRIPTABLE assets the way IW6's does -- it
    carries each definition inline the first time it is used. The later instances
    of the same prop hold an *alias to the first instance's handle field*, not to
    the definition, so the definitions are keyed here by the address of the handle
    that loaded them, which is what makes them findable again. Sizing the
    instance's buffers needs that: they are as long as its definition says.
    """
    s = "scriptableMapEnts."
    defs, stride = {}, z.layout.size("ScriptableInstance")
    if follows(cm[s + "instances"]):
        z.align(3)
        instances = z.array("ScriptableInstance", cm[s + "instanceCount"])
        base = instances[0].cursor if instances else 0
        for instance in instances:
            pointer = instance["def"]
            if follows(pointer):
                definition = defs[instance.address("def")] = scriptable_def(z)
            elif pointer:
                definition = defs.get(reference(pointer)) or _aliased_def(z, defs, pointer, base, stride)
            else:
                definition = None
            if follows(instance["eventConstantsBuf"]):
                z.take(definition["eventConstantsSize"])
            # One record per target, not one per instance: a scriptable that drives
            # several lights carries a light axis and colour for each.
            z.elements(instance, "targetData", instance["targetCount"])
            z.push(RUNTIME)
            instance.touch("currentModel")
            if follows(instance["partStates"]):
                z.align(3)
                z.array("ScriptableInstancePartState", definition["partCount"])
            if follows(instance["eventStreamBuf"]):
                z.take(definition["eventStreamSize"])
            z.pop()
    if follows(cm[s + "animEntries"]):
        z.align(3)
        for entry in z.array("ScriptableAnimationEntry", cm[s + "animEntryCount"]):
            z.field_string(entry, "animName")
            entry.touch("runtimeBuf")


def grapple(z, cm):
    """grapple_data_t, which S1 adds and IW6 has no counterpart for: a sphere tree over
    the surfaces the grapple can attach to."""
    g = "grapple.magnetTree."
    if follows(cm[g + "tree"]):
        z.align(3)
        for node in z.array("sphere_tree_t", cm[g + "treeCount"]):
            z.elements(node, "objIdx", node["numObjects"], align=3)
    z.elements(cm, g + "objects", cm[g + "numObjects"], align=3)
    z.elements(cm, "grapple.magnets", cm["grapple.magnetCount"], align=3)


@walker("RAWFILE")
def rawfile(z):
    raw = z.struct("RawFile")
    z.push(VIRTUAL)
    name = z.field_string(raw, "name")
    size = raw["compressedLen"] or raw["len"] + 1
    buffer = z.elements(raw, "buffer", size, size=1)
    z.pop()
    z.record("RAWFILE", name, Raw(name, buffer, raw["compressedLen"], raw["len"]))
    return name


# A string table's cells, row-major: `cells[row * columns + column]`.
Table = namedtuple("Table", "name columns rows cells")


@walker("STRINGTABLE")
def stringtable(z):
    """x64-zt's shared StringTable writer: the name, then the cells on an 8-byte boundary,
    each cell's string behind it. The MP tables are in the localized patch zones
    (`english/eng_patch_code_post_gfx_mp.ff` holds the costume tables)."""
    table = z.struct("StringTable")
    z.push(VIRTUAL)
    name = z.field_string(table, "name")
    cells = []
    if follows(table["values"]):
        z.align(3)
        cells = [z.field_string(cell, "string") for cell in z.array("StringTableCell", table["columnCount"] * table["rowCount"])]
    z.pop()
    z.record("STRINGTABLE", name, Table(name, table["columnCount"], table["rowCount"], cells))
    return name


@walker("LOCALIZE_ENTRY")
def localize_entry(z):
    """The localized zones' text: a value and its key, both inline strings."""
    entry = z.struct("LocalizeEntry")
    z.push(VIRTUAL)
    z.field_string(entry, "value")
    name = z.field_string(entry, "name")
    z.pop()
    return name


def _menu(z):
    raise NotImplementedError("an inline menuDef_t, which no zone read so far has carried")


@walker("MENULIST")
def menu_list(z):
    """MenuList. The four in patch_common_mp.ff name no menus, so a menu itself is refused."""
    menus = z.struct("MenuList")
    z.push(VIRTUAL)
    name = z.field_string(menus, "name")
    z.handles(menus, "menus", menus["menuCount"], _menu, "MENU")
    z.pop()
    return name


@walker("LUA_FILE")
def lua_file(z):
    """x64-zt's shared LuaFile writer: the name, then `len` bytes on a 16-byte boundary."""
    lua = z.struct("LuaFile")
    z.push(VIRTUAL)
    name = z.field_string(lua, "name")
    z.elements(lua, "buffer", lua["len"], align=15, size=1)
    z.pop()
    return name


@walker("SCRIPTFILE")
def scriptfile(z):
    script = z.struct("ScriptFile")
    z.push(VIRTUAL)
    name = z.field_string(script, "name")
    z.push(SCRIPT)
    z.elements(script, "buffer", script["compressedLen"], size=1)
    z.elements(script, "bytecode", script["bytecodeLen"], size=1)
    z.pop()
    z.pop()
    return name


@walker("COMWORLD")
def comworld(z):
    world = z.struct("ComWorld")
    z.push(VIRTUAL)
    name = z.field_string(world, "name")
    if follows(world["primaryLights"]):
        z.align(3)
        for light in z.array("ComPrimaryLight", world["primaryLightCount"]):
            z.field_string(light, "defName")
    z.elements(world, "primaryLightEnvs", world["primaryLightEnvCount"], align=3)
    z.pop()
    return name


def gfx_globals(z):
    """XGfxGlobals, which sits between the script strings and the asset list."""
    g = z.struct("XGfxGlobals")
    depth_stencil = z.elements(g, "depthStencilStateBits", g["depthStencilStateCount"], align=3)
    blend = z.elements(g, "blendStateBits", g["blendStateCount"], align=3)
    # The deduplicated D3D11 states every GfxStateBits names by index, and so the
    # only independent account of what its six loadBits words hold
    # (scripts/cod/s1/dumpers/material.py's check_state_bits).
    if depth_stencil is not None:
        count = g["depthStencilStateCount"]
        z.record("GFXSTATE", "depthStencil", list(struct.unpack_from(f"<{count}Q", z.data, depth_stencil)))
    if blend is not None:
        count = g["blendStateCount"]
        z.record("GFXSTATE", "blend", [list(struct.unpack_from("<3I", z.data, blend + 12 * i)) for i in range(count)])
    z.push(RUNTIME)
    for path, count in (("depthStencilStates", "depthStencilStateCount"), ("blendStates", "blendStateCount")):
        if follows(g[path]):
            z.align(3)
            z.take(z.layout.size("GfxZoneTableEntry") * g[count])
    z.pop()
    z.elements(g, "perPrimConstantBufferSizes", g["perPrimConstantBufferCount"], align=3)
    z.elements(g, "perObjConstantBufferSizes", g["perObjConstantBufferCount"], align=3)
    z.elements(g, "stableConstantBufferSizes", g["stableConstantBufferCount"], align=3)
    z.push(RUNTIME)
    for path in ("perPrimConstantBuffers", "perObjConstantBuffers", "stableConstantBuffers"):
        if follows(g[path]):
            z.align(3)
            z.take(z.layout.size("GfxZoneTableEntry") * g[path.replace("Buffers", "BufferCount")])
    z.pop()


# --- the walk ---------------------------------------------------------------


class ZoneWalk:
    def __init__(self, data, stream_files=(), layout=None, zone_type=Zone):
        self.z = zone_type(data, layout or Layout(), stream_files)
        self.assets = []  # (type name, name, header file offset), as IW6's walk keeps them
        self.failed = None
        self.globals_skipped = 0

    def header(self):
        """Consume XFile and XAssetList, and stop on the asset entries."""
        z = self.z
        # The XFile header is read before the blocks it declares are set up, so its
        # 72 bytes are not charged to TEMP -- which is what makes TEMP's high-water
        # mark match the header exactly.
        z.pos += 72
        head = struct.unpack_from("<5Q", z.data, z.take(40))
        string_count, strings, asset_count, _assets, globals_ = head
        z.push(VIRTUAL)
        z.push(VIRTUAL)
        if string_count and follows(strings):
            z.script_strings = z.strings_at(z.take(8 * string_count), string_count)
        z.pop()
        if follows(globals_):
            inner = z.u64(z.take(8))
            if follows(inner):
                gfx_globals(z)
        z.pop()
        z.push(VIRTUAL)
        z.align(3)
        self.asset_base = z.blocks[VIRTUAL]
        start = z.take(16 * asset_count)
        self.entries = [struct.unpack_from("<QQ", z.data, start + 16 * i) for i in range(asset_count)]
        for i, (kind, _) in enumerate(self.entries):
            z.slots[self.asset_base + 16 * i + 8] = (assets.ASSET_TYPES.get(kind, kind), None)

    def walk(self, stop=None):
        """Walk every asset (or up to the first of type `stop`). Returns the index reached."""
        z = self.z
        for i, (kind, pointer) in enumerate(self.entries):
            typename = assets.ASSET_TYPES.get(kind, f"type{kind}")
            if typename == stop:
                return i
            if typename not in WALKERS:
                self.failed = (i, typename, "no walker")
                return i
            at = z.pos
            try:
                result = z.handle(pointer, WALKERS[typename], typename)
                name = result[1] if result else None
            except Exception as error:  # noqa: BLE001 - reported with its position
                self.failed = (i, typename, f"{type(error).__name__}: {error} (header at 0x{at:x})")
                return i
            z.slots[self.asset_base + 16 * i + 8] = (typename, name)
            self.assets.append((typename, name, at))
            z.check()
        return len(self.entries)


def walk_zone(path, stop=None, zone_type=Zone):
    """Walk a zone (up to the first asset of type `stop`). Returns (ZoneWalk, World or None).
    `zone_type` is the Zone to walk with; aliases.CheckedZone checks as it goes."""
    stream_files, zone = ff.read_ff(path)
    walk = ZoneWalk(zone, stream_files, zone_type=zone_type)
    walk.header()
    WORLDS.clear()
    walk.walk(stop)
    return walk, WORLDS[-1] if WORLDS else None


def walk_map(path, stop=None):
    """Walk a map's zone through its GfxWorld. Returns (ZoneWalk, World)."""
    walk, world = walk_zone(path, stop)
    if world is None:
        raise RuntimeError(f"stopped before the world: {walk.failed}")
    return walk, world


def report(path, show=24, zone_type=Zone):
    """Walk one zone and print the checks that say whether the walk is right."""
    walk, _ = walk_zone(path, zone_type=zone_type)
    zone = walk.z.data
    print(f"=== {os.path.basename(path)}: {len(walk.entries)} assets, walked {len(walk.assets)}")
    if walk.globals_skipped:
        print(f"    skipped {walk.globals_skipped} bytes of XGfxGlobals")
    for typename, name, _at in walk.assets[-show:]:
        print(f"    {typename:26s} {name}")
    if hasattr(walk.z, "alias_report"):
        print("\n".join(walk.z.alias_report(walk.assets)))
    if walk.failed:
        i, typename, why = walk.failed
        at = walk.z.pos
        print(f"    STOPPED at asset {i} ({typename}): {why}")
        print(f"    zone offset 0x{at:x}; the next 96 bytes:")
        for o in range(at, min(at + 96, len(zone)), 16):
            text = bytes(c if 32 <= c < 127 else 46 for c in zone[o : o + 16]).decode()
            print(f"      {o:08x}  {zone[o : o + 16].hex(' ')}  {text}")
        return False
    print(f"    ended at 0x{walk.z.pos:x} of 0x{len(zone):x}")
    for what, amount in walk.z.found.get("DRIFT", {}).items():
        print(f"      DRIFT {what}: the zone's own pointers are {amount} bytes ahead of our cursor")
    unhandled = collections.Counter(f"{typename}.{path}" for typename, path, _ in walk.z.unhandled)
    for field, count in unhandled.most_common(8):
        print(f"      UNHANDLED POINTER {field} x{count}")
    # Each streamed image takes its entries in asset order, so a whole walk takes them all.
    streams = len(walk.z.stream_files)
    print(f"      stream entries: took {walk.z.stream_cursor:,} of {streams:,}")
    exact = walk.z.pos == len(zone) and walk.z.stream_cursor == streams and not getattr(walk.z, "alias_misses", None)
    # TEMP is the block the loader reuses, so its header size is a high-water
    # mark and the cursor to compare it with is the peak, not the end.
    for block, (cursor, peak, size) in enumerate(zip(walk.z.blocks, walk.z.block_peak, walk.z.block_sizes, strict=True)):
        reached = peak if block == TEMP else cursor
        flag = "ok" if reached == size else f"OFF BY {reached - size}"
        exact = exact and reached == size
        print(f"      block {block}: reached {reached:>12,}  header {size:>12,}  {flag}")
    return exact


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    # PATHDATA's walker, for a `<map>_path.ff`. Set here by hand: run as __main__, this
    # module is not the `walkers` that `paths` registers into.
    from .paths import pathdata

    WALKERS.setdefault("PATHDATA", pathdata)
    show = int(sys.argv[sys.argv.index("--show") + 1]) if "--show" in sys.argv else 24
    ok = True
    for arg in sys.argv[1:]:
        if arg.startswith("--") or arg.isdigit():
            continue
        ok = report(arg, show) and ok
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
