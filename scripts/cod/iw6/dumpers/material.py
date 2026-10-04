"""`material`: `materials/<name>.json`, in OpenAssetTools' material schema.

Everything scripts/cod/materials.py reads is here: the technique set, the texture
table, the constants, `stateBitsEntry` (412 techniques; -1 where the technique
set has none), the state-bits table decoded from its raw `loadBits`,
`stateFlags`, `sortKey`, `gameFlags` and `cameraRegion`. How the decodes were
established: reverse/iw6-zone/README.md#render-state.

A material named with a leading comma is only a header naming another zone's
material. It is not written: the export dumps the map after its companion zones,
and the stub would replace the companion's real material.
"""

import struct
from collections import namedtuple

from ...materials import colour_map, material_file_stem
from ..records import TextureDef
from ..renderstate import camera_region, game_flags, sampler_state, state_bits
from ..zone import Record
from . import GAME, dumper
from .common import asset_path, plain, write_json

# IMG_TS (x64-zt structs.hpp), as OpenAssetTools names the ones it shares.
SEMANTICS = (
    "2D",
    "function",
    "colorMap",
    "detailMap",
    "unused2",
    "normalMap",
    "unused3",
    "unused4",
    "specularMap",
    "unused5",
    "oceanFlowDisplacementMap",
    "waterMap",
    "oceanDisplacementMap",
    "displacementMap",
    "parallaxMap",
)

# Texture slot names, recognised by MaterialTextureDef.nameHash. Checked against
# every world material of mp_prisonbreak; a slot not listed keeps its hash.
# revealMap is a mask, not a colour, although its semantic says colorMap.
_SLOTS = ("colorMap", "normalMap", "specularMap", "detailMap", "displacementMap", "revealMap")
SLOT_NAMES = (*_SLOTS, *(f"{slot}{n}" for slot in _SLOTS for n in range(1, 5)), "detailNormalMap")

UNUSED = 0xFF  # a stateBitsEntry for a technique the set does not have
CONSTANT_NAME = 12  # MaterialConstantDef.name holds this much of the name


def slot_hash(name):
    """R_HashString: djb2 with xor, case-blind, from 0 (OpenAssetTools Common::R_HashString)."""
    value = 0
    for byte in name.lower().encode():
        value = ((value * 33) ^ byte) & 0xFFFFFFFF
    return value


SLOTS_BY_HASH = {slot_hash(name): name for name in SLOT_NAMES}

# Constant names longer than MaterialConstantDef.name keeps, recognised by nameHash
# (each matched on mp_prisonbreak). Any other long name keeps its hash and fragment.
LONG_CONSTANTS = (
    *(f"displacementParms{n}" for n in ("", 1, 2, 3, 4)),
    *(f"revealParams{n}" for n in (1, 2, 3, 4)),
    *(f"flagWave{n}Parms" for n in (0, 1, 2)),
    "falloffBeginColor",
    "falloffEndColor",
    "atlasBlendParms",
    "eyeOffsetParms",
    "fakeLightParams",
    "distortionScale",
    "heatMapDetail",
)
CONSTANTS_BY_HASH = {slot_hash(name): name for name in LONG_CONSTANTS}


def texture(tex: TextureDef):
    entry = {}
    if tex.name_hash in SLOTS_BY_HASH:
        entry["name"] = SLOTS_BY_HASH[tex.name_hash]
    else:
        entry.update(nameHash=tex.name_hash, nameStart=tex.name_start, nameEnd=tex.name_end)
    entry["semantic"] = SEMANTICS[tex.semantic] if tex.semantic < len(SEMANTICS) else tex.semantic
    entry["samplerState"] = sampler_state(tex.sampler)
    entry["image"] = plain(tex.image) or ""
    return entry


# What a model's GLB needs to know about a material it names: its technique set and the
# images the pipeline would pick from its JSON.
MaterialSummary = namedtuple("MaterialSummary", "technique_set colour_map normal_map")


def summary(material):
    """A records.Material as a MaterialSummary."""
    textures = [texture(t) for t in material.textures]
    normals = [t for t in textures if t["semantic"] == "normalMap"]
    normal = next((t for t in normals if t.get("name") == "normalMap"), normals[0] if normals else {})
    return MaterialSummary(
        plain(material.technique_set) or "", colour_map({"textures": textures}, GAME) or None, normal.get("image") or None
    )


def summaries(walked):
    """Material name -> MaterialSummary for every material this zone or an earlier walk defines."""
    library = dict((walked.library or {}).get("materials", {}))
    for name, material in walked.zone.found.get("MATERIAL", {}).items():
        if not name.startswith(","):
            library[name] = summary(material)
    return library


def constant(name_hash, name, literal):
    """A MaterialConstantDef as OAT writes it: the name when it is known, else its hash and stored part."""
    fragment = name.split(b"\0", 1)[0].decode("latin-1")
    entry = {}
    if len(fragment) < CONSTANT_NAME or slot_hash(fragment) == name_hash:
        entry["name"] = fragment
    elif name_hash in CONSTANTS_BY_HASH:
        entry["name"] = CONSTANTS_BY_HASH[name_hash]
    else:
        entry.update(nameHash=name_hash, nameFragment=fragment)
    entry["literal"] = list(literal)
    return entry


def table(zone, typename, at, count):
    """`count` records of `typename` at file offset `at`."""
    if at is None:
        return []
    size = zone.layout.size(typename)
    return [Record(zone, typename, at + size * i, None, None) for i in range(count)]


def material_json(zone, material):
    header = Record(zone, "Material", material.at, None, None)
    constants = [
        constant(c["nameHash"], c.bytes("name"), struct.unpack("<4f", c.bytes("literal")))
        for c in table(zone, "MaterialConstantDef", material.constants, header["constantCount"])
    ]
    states = [
        state_bits([s[f"loadBits[{k}]"] for k in range(3)])
        for s in table(zone, "GfxStateBits", material.state_bits, header["stateBitsCount"])
    ]
    return {
        "_type": "material",
        "_version": 1,
        "_game": GAME,
        "cameraRegion": camera_region(header["cameraRegion"]),
        "constants": constants,
        "gameFlags": game_flags(header["info.gameFlags"]),
        "sortKey": header["info.sortKey"],
        "stateBits": states,
        "stateBitsEntry": [-1 if e == UNUSED else e for e in header.bytes("stateBitsEntry")],
        "stateFlags": header["stateFlags"],
        "surfaceTypeBits": header["info.surfaceTypeBits"],
        "techniqueSet": plain(material.technique_set) or "",
        "textureAtlas": {"columns": header["info.textureAtlasColumnCount"], "rows": header["info.textureAtlasRowCount"]},
        "textures": [texture(t) for t in material.textures],
    }


@dumper("material")
def write(walked, out):
    for name, material in walked.zone.found.get("MATERIAL", {}).items():
        if name.startswith(","):
            continue
        write_json(asset_path(out, f"materials/{material_file_stem(name)}.json"), material_json(walked.zone, material))
