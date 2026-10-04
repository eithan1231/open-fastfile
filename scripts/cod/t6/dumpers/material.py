"""`material`: `materials/<name>.json` in OpenAssetTools' T6 material schema, which scripts/cod/materials.py reads.

IW5's writer (iw5/dumpers/material.py) with T6's spellings, from OAT's
JsonMaterialT6 and MaterialJsonDumper (T6_Assets.h for the numbers):

- 36 techniques (`stateBitsEntry`): DEPTH_PREPASS 0, UNLIT 2, EMISSIVE 3, LIT 4;
- a texture holds its image directly (no union, no water), and `isMatureContent`;
- texture semantics as T5's, with `occlusionMap` at 0xA;
- the load bits are IW's but for the alpha test, one bit (12): 0 `gt0`, 1 `ge128`
  (GfxAlphaTest_e), and no `gammaWrite`;
- camera regions are T6's ten; game flags 0x40 `CASTS_SHADOW` and 0x4 `NO_MARKS`.

A slot's name is recovered from its hash, OAT's R_HashString (djb2 with xor,
case-blind: iw6's `slot_hash`), against OAT's list of T6's known names
(`scripts/cod/data/t6/material_names.json`, from `reverse/x86-zone/build.sh t6`). The zone's shaders
are DXBC, whose constant tables are not read yet, so a slot whose name is on no
list keeps its hash; the semantic alone is what the pipeline decides on.
"""

import json
import os
import struct

from ...iw5.dumpers import material as iw
from ...iw5.dumpers.common import plain
from ...iw6.dumpers.common import asset_path, write_json
from ...iw6.dumpers.material import slot_hash
from ...materials import material_file_stem
from ...zonecode import program

SEMANTICS = (
    "2D function colorMap unused1 unused2 normalMap unused3 unused4 specularMap unused5 occlusionMap unused6 "
    + " ".join(f"color{i}Map" for i in range(16))
    + " throwMap"
).split()
CAMERA_REGIONS = (
    "litOpaque litTrans litQuasiOpaque emissiveOpaque emissiveTrans emissiveFx lightMapOpaque depthHack unused sonar none"
).split()
ALPHA_TESTS = {0: "gt0", 1: "ge128"}  # GfxAlphaTest_e: one bit
GAME_FLAGS = {0x4: "NO_MARKS", 0x40: "CASTS_SHADOW"}  # OAT's first name for a value; the rest print as hex


def names_path():
    return os.path.join(os.path.dirname(program.path_for("t6")), "material_names.json")


class ZoneNames:
    """Hash -> name for texture slots and constants, from OAT's T6 lists."""

    def __init__(self, walk=None):
        path = names_path()
        if not os.path.exists(path):
            raise SystemExit(f"no T6 material name list at {path}: it ships in scripts/cod/data/ (scripts/cod/data/README.md)")
        with open(path, encoding="utf-8") as fh:
            known = json.load(fh)
        self.textures = {slot_hash(name): name for name in reversed(known["textures"])}
        self.constants = {slot_hash(name): name for name in reversed(known["constants"])}

    @staticmethod
    def hash(name):
        return slot_hash(name)

    def texture(self, name_hash):
        return self.textures.get(name_hash)

    def constant(self, name_hash):
        return self.constants.get(name_hash)


def state_bits(word0, word1):
    entry = iw.state_bits(word0, word1)
    del entry["gammaWrite"]
    entry["alphaTest"] = "disabled" if iw.bits(word0, 11, 1) else ALPHA_TESTS[iw.bits(word0, 12, 1)]
    return entry


def texture(tex, names):
    entry = {}
    name = names.texture(tex["nameHash"])
    if name is not None:
        entry["name"] = name
    else:
        entry.update(nameHash=tex["nameHash"], nameStart=chr(tex["nameStart"] & 0xFF), nameEnd=chr(tex["nameEnd"] & 0xFF))
    entry["semantic"] = iw.enum(SEMANTICS, tex["semantic"])
    entry["samplerState"] = iw.sampler_state(tex.bytes("samplerState")[0])
    entry["image"] = plain(tex["image"]) or ""
    entry["isMatureContent"] = bool(tex["isMatureContent"])
    return entry


def material_json(asset, names):
    m = asset.record
    entry = m.bytes("stateBitsEntry")
    flags = m["info.gameFlags"]
    return {
        "$schema": "http://openassettools.dev/schema/material.v1.json",
        "_game": "t6",
        "_type": "material",
        "_version": 1,
        "cameraRegion": iw.enum(CAMERA_REGIONS, m["cameraRegion"]),
        "constants": [iw.constant(c, names) for c in list(m["constantTable"] or ())[: m["constantCount"]]],
        "contents": m["info.contents"],
        "gameFlags": [GAME_FLAGS.get(1 << i, f"{1 << i:x}") for i in range(32) if flags & (1 << i)],
        "layeredSurfaceTypes": m["info.layeredSurfaceTypes"],
        "sortKey": m["info.sortKey"],
        "stateBits": [state_bits(*s.unpack("<2I", "loadBits")) for s in list(m["stateBitsTable"] or ())[: m["stateBitsCount"]]],
        "stateBitsEntry": list(struct.unpack(f"<{len(entry)}b", entry)),
        "stateFlags": m["stateFlags"],
        "surfaceFlags": m["info.surfaceFlags"],
        "surfaceTypeBits": m["info.surfaceTypeBits"],
        "techniqueSet": plain(m["techniqueSet"]) or "",
        "textureAtlas": {"columns": m["info.textureAtlasColumnCount"], "rows": m["info.textureAtlasRowCount"]},
        "textures": [texture(t, names) for t in list(m["textureTable"] or ())[: m["textureCount"]]],
        "thermalMaterial": plain(m["thermalMaterial"]) or "",
    }


def write(walk, out, ctx=None):
    names = ZoneNames(walk)
    written = 0
    for asset in walk.by_type("material"):
        if asset.name.startswith(","):
            continue
        write_json(asset_path(out, f"materials/{material_file_stem(asset.name)}.json"), material_json(asset, names))
        written += 1
    print(f"      {written} material(s) written; {len(names.textures)} texture and {len(names.constants)} constant names known")
