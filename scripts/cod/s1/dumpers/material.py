"""`material`: `materials/<name>.json`, in OpenAssetTools' material schema.

The constants and the sampler and game-flag decodes are IW6's: `MaterialConstantDef`
and `MaterialStateFlags` are declared identically for both games in x64-zt, and
`R_HashString` is the same function. What is S1's own is the *shape* of the
material -- 180 techniques where IW6 has 412, a 64-bit `surfaceTypeBits`, a
`GfxCameraRegionType` that numbers "none" 13, three texture semantics past the
end of the declared enum, and six state-bit words where IW6 has three
(`scripts/cod/s1/renderstate.py`).

`check_state_bits` runs before anything is written: every `GfxStateBits` in the
zone has to rebuild the three D3D11 states the linker cached from it, which is
what makes the six-word decode a measurement rather than a fit.

A material named with a leading comma is only a header naming another zone's
material. It is not written: the export dumps the map after its companion zones,
and the stub would replace the companion's real material.
"""

import struct

from ...iw6.dumpers.common import asset_path, plain, write_json
from ...iw6.dumpers.material import SEMANTICS, SLOT_NAMES, MaterialSummary, constant, slot_hash, table
from ...iw6.renderstate import game_flags, sampler_state
from ...iw6.zone import Record
from ...materials import colour_map, material_file_stem
from ..renderstate import cached_states, camera_region, state_bits
from . import GAME, dumper

UNUSED = 0xFF  # a stateBitsEntry for a technique the set does not have

# Slot names S1 uses and IW6 does not, each matched by hash and corroborated by
# the `nameStart`/`nameEnd` characters the zone stores beside it. Five more
# hashes are still unnamed; README.md#the-texture-slots has them and their ends.
S1_SLOTS = ("occlusionMap", "emissiveMap", "maskMap", "flowMap", "secondarySpecularMap")
SLOTS_BY_HASH = {
    slot_hash(name): name for name in (*SLOT_NAMES, *S1_SLOTS, *(f"{slot}{n}" for slot in S1_SLOTS for n in range(1, 5)))
}

# The top-level fields of the schema this writer fills.
FIELDS = (
    "cameraRegion",
    "constants",
    "gameFlags",
    "sortKey",
    "stateBits",
    "stateBitsEntry",
    "stateFlags",
    "surfaceTypeBits",
    "techniqueSet",
    "textureAtlas",
    "textures",
)

# Of the ten GfxDepthStencilMode slots a material caches, the one holding the
# state its own loadBits describe; the other nine are the engine's per-mode
# overrides (depth hack, hud outline, the cached spot stencils).
DEPTH_STENCIL_AS_WRITTEN = 9


def texture(tex):
    """One MaterialTextureDef as OAT writes it. A slot or semantic S1 does not share keeps its number."""
    entry = {}
    if tex.name_hash in SLOTS_BY_HASH:
        entry["name"] = SLOTS_BY_HASH[tex.name_hash]
    else:
        entry.update(nameHash=tex.name_hash, nameStart=tex.name_start, nameEnd=tex.name_end)
    entry["semantic"] = SEMANTICS[tex.semantic] if tex.semantic < len(SEMANTICS) else tex.semantic
    entry["samplerState"] = sampler_state(tex.sampler)
    entry["image"] = plain(tex.image) or ""
    return entry


def summary(material):
    """A records.Material as a MaterialSummary: what a model's GLB needs about a material it names."""
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


def state_entries(zone, material, count):
    """The raw six-word loadBits of each GfxStateBits, with the cached state bytes beside them."""
    out = []
    for record in table(zone, "GfxStateBits", material.state_bits, count):
        out.append(
            (
                [record[f"loadBits[{k}]"] for k in range(6)],
                record["rasterizerState"],
                record.bytes("depthStencilState")[DEPTH_STENCIL_AS_WRITTEN],
                record["blendState"],
            )
        )
    return out


def check_state_bits(walked):
    """Rebuild the zone's own D3D11 state tables from every material's loadBits; die on a disagreement.

    Three quantities the reader does not choose: the `rasterizerState` byte in the
    same struct, and the `depthStencilStateBits` and `blendStateBits` tables the
    zone deduplicates into `XGfxGlobals`, which each state names by index.
    """
    zone = walked.zone
    tables = zone.found.get("GFXSTATE", {})
    depth_stencil, blend = tables.get("depthStencil"), tables.get("blend")
    checked, bad = 0, []
    for name, material in zone.found.get("MATERIAL", {}).items():
        header = Record(zone, "Material", material.at, None, None)
        for load, rasterizer, ds_index, blend_index in state_entries(zone, material, header["stateBitsCount"]):
            want_raster, want_ds, want_blend = cached_states(load)
            checked += 1
            got = (rasterizer, depth_stencil and depth_stencil[ds_index], blend and blend[blend_index])
            expected = (want_raster, want_ds if depth_stencil else None, want_blend if blend else None)
            if got != expected and len(bad) < 5:
                bad.append(f"{name}: loadBits {[hex(w) for w in load]} -> {expected}, the zone caches {got}")
    if bad:
        raise SystemExit(
            "the S1 state-bits decode disagrees with the D3D11 states this zone cached from the same words:\n  "
            + "\n  ".join(bad)
            + "\n(scripts/cod/s1/renderstate.py)"
        )
    print(f"      state bits: {checked} entries rebuild the zone's own rasterizer, depth/stencil and blend states")


def material_json(zone, material):
    header = Record(zone, "Material", material.at, None, None)
    constants = [
        constant(c["nameHash"], c.bytes("name"), struct.unpack("<4f", c.bytes("literal")))
        for c in table(zone, "MaterialConstantDef", material.constants, header["constantCount"])
    ]
    states = [state_bits(load) for load, _, _, _ in state_entries(zone, material, header["stateBitsCount"])]
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
    check_state_bits(walked)
    for name, material in walked.zone.found.get("MATERIAL", {}).items():
        if name.startswith(","):
            continue
        write_json(asset_path(out, f"materials/{material_file_stem(name)}.json"), material_json(walked.zone, material))
