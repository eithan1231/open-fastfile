"""What the IW5 writers share: asset names, and the JSON shapes of the world manifests.

The manifests write vectors as `{"x", "y", "z"}` objects, and Bounds as corners:
the dump schema for IW4, IW5 and T5 (IW6 and S1 write plain lists);
scripts/cod/units.py's `vec` reads both.
"""

import struct

F32 = struct.Struct("<f")


def f32(x):
    """`x` rounded to single precision, as the game's own float arithmetic leaves it."""
    return F32.unpack(F32.pack(x))[0]


def vec3(v):
    return {"x": v[0], "y": v[1], "z": v[2]}


def vec4(v):
    return {"x": v[0], "y": v[1], "z": v[2], "w": v[3]}


def mid_half(raw):
    """A Bounds (six floats: midpoint, half size) as it is stored."""
    return {"midPoint": vec3(raw[:3]), "halfSize": vec3(raw[3:])}


def corners(raw):
    """A Bounds (six floats: midpoint, half size) as its two corners."""
    mid, half = raw[:3], raw[3:]
    return {
        "mins": vec3([f32(m - h) for m, h in zip(mid, half, strict=True)]),
        "maxs": vec3([f32(m + h) for m, h in zip(mid, half, strict=True)]),
    }


def plain(asset):
    """The name of what a pointer resolved to (an Asset, or a string), without the comma
    that marks another zone's; None for a null pointer or a nameless asset."""
    if asset is None:
        return None
    name = asset if isinstance(asset, str) else asset.name
    return name.removeprefix(",") if name else None
