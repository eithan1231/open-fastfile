"""`material`: `materials/<name>.json`, in OpenAssetTools' material schema, which scripts/cod/materials.py reads.

Everything is the zone's own `Material`: the technique set, the texture table, the
constants, `stateBitsEntry`, the state-bits table decoded from its two `loadBits`
words, `stateFlags`, `sortKey`, `gameFlags` and `cameraRegion`.

A texture slot and a constant are stored as a hash of their name. Where the name
can be recovered it is written instead, from the same two sources OAT's material
dumper uses: a fixed list of known names, and the names in the constant tables of
the zone's own shaders (`shaders.py`). A name found neither way keeps its hash, so
the zone decides which slots are named, exactly as it does for OAT.

IW4's Material is IW5's with 48 techniques rather than 54 and no displacement-map
semantic, and OAT writes both through one template, so this writer is IW4's too.

A material named with a leading comma is another zone's, and only its header is
here. It is not written: the export dumps the map after its companion zones, and a
stub would replace the companion's real material.
"""

import base64
import struct

from ...iw6.dumpers.common import asset_path, write_json
from ...materials import material_file_stem
from . import dumper
from .common import plain
from .shaders import ZoneNames

# The JSON spellings of the enums a material holds (OAT's JsonMaterial<G>.h), by value.
SEMANTICS = (
    "2D function colorMap detailMap unused2 normalMap unused3 unused4 specularMap unused5 unused6 waterMap displacementMap"
).split()
SEMANTICS_BY_GAME = {"iw4": SEMANTICS[:-1], "iw5": SEMANTICS}  # IW4 has no TS_DISPLACEMENT_MAP
WATER_MAP = 11
CAMERA_REGIONS = ("litOpaque", "litTrans", "emissive", "depthHack", "none")
FILTERS = ("disabled", "nearest", "linear", "aniso2x", "aniso4x")
MIPMAPS = ("disabled", "nearest", "linear")
BLENDS = "disabled zero one srccolor invsrccolor srcalpha invsrcalpha destalpha invdestalpha destcolor invdestcolor".split()
BLEND_OPS = ("disabled", "add", "subtract", "revsubtract", "min", "max")
STENCIL_OPS = ("keep", "zero", "replace", "incrsat", "decrsat", "invert", "incr", "decr")
STENCIL_FUNCS = ("never", "less", "equal", "lessequal", "greater", "notequal", "greaterequal", "always")
POLYGON_OFFSETS = ("offset0", "offset1", "offset2", "offsetShadowmap")
# GFXS_ALPHA_TEST_* and GFXS_DEPTHTEST_* values, which OAT names only when enabled.
ALPHA_TESTS = {1: "gt0", 2: "lt128", 3: "ge128"}
DEPTH_TESTS = {0: "always", 1: "less", 2: "equal", 3: "less_equal"}
CULL_FACES = {1: "none", 2: "back", 3: "front"}

CONSTANT_NAME = 12  # MaterialConstantDef.name keeps this much of the name


def enum(names, value):
    """An enum as nlohmann writes it: its name, or the first name for a value it does not know."""
    return names[value] if 0 <= value < len(names) else names[0]


def bits(word, first, count):
    return (word >> first) & ((1 << count) - 1)


def state_bits(word0, word1):
    """One GfxStateBits, decoded from its two load words (GfxStateBitsLoadBitsStructured)."""
    entry = {
        "srcBlendRgb": enum(BLENDS, bits(word0, 0, 4)),
        "dstBlendRgb": enum(BLENDS, bits(word0, 4, 4)),
        "blendOpRgb": enum(BLEND_OPS, bits(word0, 8, 3)),
        "alphaTest": "disabled" if bits(word0, 11, 1) else ALPHA_TESTS.get(bits(word0, 12, 2)),
        "cullFace": CULL_FACES.get(bits(word0, 14, 2)),
        "srcBlendAlpha": enum(BLENDS, bits(word0, 16, 4)),
        "dstBlendAlpha": enum(BLENDS, bits(word0, 20, 4)),
        "blendOpAlpha": enum(BLEND_OPS, bits(word0, 24, 3)),
        "colorWriteRgb": bool(bits(word0, 27, 1)),
        "colorWriteAlpha": bool(bits(word0, 28, 1)),
        "gammaWrite": bool(bits(word0, 30, 1)),
        "polymodeLine": bool(bits(word0, 31, 1)),
        "depthWrite": bool(bits(word1, 0, 1)),
        "depthTest": "disabled" if bits(word1, 1, 1) else DEPTH_TESTS[bits(word1, 2, 2)],
        "polygonOffset": POLYGON_OFFSETS[bits(word1, 4, 2)],
    }
    for side, enabled, first in (("stencilFront", 6, 8), ("stencilBack", 7, 20)):
        if bits(word1, enabled, 1):
            entry[side] = {
                "pass": STENCIL_OPS[bits(word1, first, 3)],
                "fail": STENCIL_OPS[bits(word1, first + 3, 3)],
                "zfail": STENCIL_OPS[bits(word1, first + 6, 3)],
                "func": STENCIL_FUNCS[bits(word1, first + 9, 3)],
            }
    return entry


def sampler_state(raw):
    """MaterialTextureDefSamplerState: filter:3, mipMap:2, clampU, clampV, clampW."""
    return {
        "clampU": bool(raw & 0x20),
        "clampV": bool(raw & 0x40),
        "clampW": bool(raw & 0x80),
        "filter": enum(FILTERS, raw & 7),
        "mipMap": enum(MIPMAPS, (raw >> 3) & 3),
    }


def water(record):
    """A water_t as OAT writes it; its two tables are base64 of the zone's bytes."""
    count = record["M"] * record["N"]
    out = {
        "floatTime": record["writable.floatTime"],
        "m": record["M"],
        "n": record["N"],
        "h0": base64.b64encode(bytes(record["H0"].bytes()[: 8 * count])).decode() if record["H0"] is not None else "",
        "wTerm": base64.b64encode(bytes(record["wTerm"].bytes()[: 4 * count])).decode() if record["wTerm"] is not None else "",
        "lx": record["Lx"],
        "lz": record["Lz"],
        "gravity": record["gravity"],
        "windvel": record["windvel"],
        "winddir": list(record["winddir"]),
        "amplitude": record["amplitude"],
        "codeConstant": list(record["codeConstant"]),
    }
    return out


def texture(tex, names, semantics=SEMANTICS):
    entry = {}
    name = names.texture(tex["nameHash"])
    if name is not None:
        entry["name"] = name
    else:
        entry.update(nameHash=tex["nameHash"], nameStart=chr(tex["nameStart"] & 0xFF), nameEnd=chr(tex["nameEnd"] & 0xFF))
    semantic = tex["semantic"]
    entry["semantic"] = enum(semantics, semantic)
    entry["samplerState"] = sampler_state(tex.bytes("samplerState")[0])
    info = tex["u"]
    if semantic == WATER_MAP:
        record = info["water"] if info is not None else None
        entry["image"] = ""
        if record is not None:
            entry["image"] = plain(record["image"]) or ""
            entry["water"] = water(record)
    else:
        entry["image"] = (plain(info["image"]) if info is not None else None) or ""
    return entry


def constant(record, names):
    """A MaterialConstantDef: the name when it is whole or known, else its hash and the stored part."""
    raw = record.bytes("name")
    fragment = bytes(raw).split(b"\0", 1)[0].decode("latin-1")
    name_hash = record["nameHash"]
    entry = {}
    if len(fragment) < CONSTANT_NAME or names.hash(fragment) == name_hash:
        entry["name"] = fragment
    elif names.constant(name_hash) is not None:
        entry["name"] = names.constant(name_hash)
    else:
        entry.update(nameFragment=fragment, nameHash=name_hash)
    entry["literal"] = list(record.unpack("<4f", "literal"))
    return entry


def material_json(asset, names, game):
    m = asset.record
    textures = m["textureTable"]
    constants = m["constantTable"]
    states = m["stateBitsTable"]
    entry = m.bytes("stateBitsEntry")  # a byte per technique: 48 on IW4, 54 on IW5
    return {
        "$schema": "http://openassettools.dev/schema/material.v1.json",
        "_game": game,
        "_type": "material",
        "_version": 1,
        "cameraRegion": enum(CAMERA_REGIONS, m["cameraRegion"]),
        "constants": [constant(c, names) for c in (constants or ())][: m["constantCount"]],
        "gameFlags": [f"{1 << i:x}" for i in range(8) if m["info.gameFlags"] & (1 << i)],
        "sortKey": m["info.sortKey"],
        "stateBits": [state_bits(*s.unpack("<2I", "loadBits")) for s in (states or ())][: m["stateBitsCount"]],
        "stateBitsEntry": list(struct.unpack(f"<{len(entry)}b", entry)),
        "stateFlags": m["stateFlags"],
        "surfaceTypeBits": m["info.surfaceTypeBits"],
        "techniqueSet": plain(m["techniqueSet"]) or "",
        "textureAtlas": {"columns": m["info.textureAtlasColumnCount"], "rows": m["info.textureAtlasRowCount"]},
        "textures": [texture(t, names, SEMANTICS_BY_GAME[game]) for t in (textures or ())][: m["textureCount"]],
    }


@dumper("material")
def write(walk, out, ctx=None):
    names = ZoneNames(walk)
    written = 0
    for asset in walk.by_type("material"):
        if asset.name.startswith(","):
            continue
        write_json(asset_path(out, f"materials/{material_file_stem(asset.name)}.json"), material_json(asset, names, walk.game))
        written += 1
    print(f"      {written} material(s) written; {len(names.textures)} texture and {len(names.constants)} constant names known")
