"""The asset list at the head of an Advanced Warfare zone.

    python3 -m scripts.cod.s1.assets <map.ff> [...]   a histogram of the asset types a zone holds

The zone begins with `XFile`, then `XAssetList`: a script-string list, then the
asset entries. Reading that much needs no struct layout, so it is the first
thing that can be checked against a real zone -- in particular the PC's
`XAssetType` numbering, which the X360 symbols do not carry (ASSET_TYPES).
"""

import struct
import sys

from . import ff

# The PC build's XAssetType, from x64-zt's `s1/structs.hpp` (the clone this repo
# already keeps for IW6). The X360 symbols carry a different, older enum -- three
# phys types, five D3D11 shader types and two sound types are missing from it, and
# its SOUND_EVENT is gone on the PC -- so the console numbering cannot be used.
#
# Ten of these were derived from the zones before the header was found, and all ten
# agree: CLIPMAP 24, COMWORLD 25, GLASSWORLD 26, PATHDATA 27, MAP_ENTS 29, GFXWORLD 31,
# FX 42, RAWFILE 49, SCRIPTFILE 50, NET_CONST_STRINGS 57. There is no transient-zone
# type: the X360 build has one and the PC build does not (README, "The asset types").
ASSET_TYPES = dict(
    enumerate(
        (
            "PHYSPRESET",
            "PHYSCOLLMAP",
            "PHYSWATERPRESET",
            "PHYSWORLDMAP",
            "PHYSCONSTRAINT",
            "XANIMPARTS",
            "XMODEL_SURFS",
            "XMODEL",
            "MATERIAL",
            "COMPUTESHADER",
            "VERTEXSHADER",
            "HULLSHADER",
            "DOMAINSHADER",
            "PIXELSHADER",
            "VERTEXDECL",
            "TECHNIQUE_SET",
            "IMAGE",
            "SOUND",
            "SOUND_SUBMIX",
            "SOUND_CURVE",
            "LPF_CURVE",
            "REVERB_CURVE",
            "SOUND_CONTEXT",
            "LOADED_SOUND",
            "CLIPMAP",
            "COMWORLD",
            "GLASSWORLD",
            "PATHDATA",
            "VEHICLE_TRACK",
            "MAP_ENTS",
            "FXWORLD",
            "GFXWORLD",
            "LIGHT_DEF",
            "UI_MAP",
            "FONT",
            "MENULIST",
            "MENU",
            "ANIMCLASS",
            "LOCALIZE_ENTRY",
            "ATTACHMENT",
            "WEAPON",
            "SNDDRIVER_GLOBALS",
            "FX",
            "IMPACT_FX",
            "SURFACE_FX",
            "AITYPE",
            "MPTYPE",
            "CHARACTER",
            "XMODELALIAS",
            "RAWFILE",
            "SCRIPTFILE",
            "STRINGTABLE",
            "LEADERBOARD",
            "STRUCTURED_DATA_DEF",
            "TRACER",
            "VEHICLE",
            "ADDON_MAP_ENTS",
            "NET_CONST_STRINGS",
            "REVERB_PRESET",
            "LUA_FILE",
            "SCRIPTABLE",
            "EQUIPMENT_SND_TABLE",
            "VECTORFIELD",
            "DOPPLER_PRESET",
            "PARTICLE_SIM_ANIMATION",
            "LASER",
            "SKELETON_SCRIPT",
            "CLUT",
        )
    )
)
TYPE_LIMIT = len(ASSET_TYPES)

POINTER_TAG = 0xFDFDFDF0_00000000
FOLLOWS, INSERT = 0xFFFFFFFF, 0xFFFFFFFE


def is_pointer(value):
    return value & 0xFFFFFFF0_00000000 == POINTER_TAG


def follows(value):
    return value != 0 and is_pointer(value) and value & 0xFFFFFFFF in (FOLLOWS, INSERT)


def asset_list(zone):
    """(script strings, [(type, pointer)]) -- the header, read without any struct layout."""
    at = 72  # XFile: u64 size, u64 externalSize, u64 blockSize[7]
    string_count, strings, asset_count, assets, globals_ = struct.unpack_from("<5Q", zone, at)
    at += 40
    script_strings = []
    if string_count and follows(strings):
        slots = at
        at += 8 * string_count
        for i in range(string_count):
            if not follows(struct.unpack_from("<Q", zone, slots + 8 * i)[0]):
                script_strings.append(None)
                continue
            end = zone.index(b"\0", at)
            script_strings.append(zone[at:end].decode("latin-1"))
            at = end + 1
    if follows(globals_):
        # Load_XGlobalsPtr: the slot itself is inline, and only a zone that carries
        # the gfx globals writes anything behind it (walkers.gfx_globals).
        inner = struct.unpack_from("<Q", zone, at)[0]
        at += 8
        if follows(inner):
            # XGfxGlobals is a PC-only D3D11 struct that neither X360 build declares, so
            # its length is unknown. The asset list is found by its own shape instead:
            # `asset_count` entries of (a small type number, then a zone pointer or null).
            at = find_asset_list(zone, at, asset_count)
    entries = [struct.unpack_from("<QQ", zone, at + 16 * i) for i in range(asset_count)]
    return script_strings, entries, assets


def find_asset_list(zone, start, count):
    """The first offset at or after `start` where `count` XAsset entries begin."""
    limit = len(zone) - 16 * count
    at = start
    while at <= limit:
        kinds = set()
        for i in range(count):
            kind, pointer = struct.unpack_from("<QQ", zone, at + 16 * i)
            # Every entry names a real type and carries a header pointer; a zone's
            # list is never all one type, which is what rules out a run of zeros.
            if kind >= TYPE_LIMIT or not is_pointer(pointer):
                break
            kinds.add(kind)
        else:
            if len(kinds) > 1 or count < 3:
                return at
            kinds.clear()
        at += 4  # a zone is packed densely: alignment moves block cursors, not the file
    raise ValueError(f"no run of {count} asset entries after 0x{start:x}")


def main():
    for path in sys.argv[1:]:
        streams, zone = ff.read_ff(path)
        strings, entries, _ = asset_list(zone)
        if entries is None:
            print(f"=== {path.split('/')[-1]}: carries XGfxGlobals; asset list not reachable here")
            continue
        counts = {}
        for kind, _ in entries:
            counts[kind] = counts.get(kind, 0) + 1
        print(f"=== {path.split('/')[-1]}: {len(entries)} assets, {len(strings)} script strings")
        for kind in sorted(counts):
            print(f"   {kind:>3}  {ASSET_TYPES.get(kind, '(unidentified)'):28s} {counts[kind]:>6}")


if __name__ == "__main__":
    main()
