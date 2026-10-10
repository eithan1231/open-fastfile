"""Black Ops' lightmap, baked into the flat irradiance the engine adds, and the sun it was lit against.

What the game does, read from the lit world shaders (`pimp_shader_lmap_*`, dumped with
`reverse/t5-fx/shaders.py --techset wc_l_sm_r0c0n0s0`):

- Each `draw.lightmaps[i]` has three images. The **secondary** is R5G6B5, two pages
  stacked down it: a coordinate (u, v) reads the top at (u, v/2) and the bottom at
  (u, v/2 + 1/2). **secondaryB** is G16R16 at the page's size: two scales, each
  read as 0..1 times 31.875. The **primary** is DXT1 at twice the page's size, and
  its green is the sun's baked visibility.
- A page's colour is `s * (4r, 2(1 - r - b), 4b)`: the top's with secondaryB's red
  is the ambient **A**, the bottom's with its green the directional **D**. The two
  pages' greens are a direction `d = (top.g, bottom.g) * 4 - 2` in tangent space.
- The diffuse light at a pixel is `A * w(n) + D * sat((dot(d, n) + 1) * w(d) * w(n))
  + sunDiffuse * visibility * sat(dot(N, L))`, with `w(x) = 0.4 + 0.6 exp(-|x|^2)`,
  n the normal map's tangent xy, and `sunDiffuse` the world's `sunCd.rgb * sunCd.w`
  (t5/dumpers/gfxworld.py). The material's `envMapParms.y` scales the first two
  terms; it is 1 on every world material read.

The engine draws no normal maps, so n = 0 and the bake per texel is `A + D * w(d)`:
no surface normal is needed. The sun stays live and is handed over in the same units,
through T6's Sun and its engine scales, so their ratio is the game's.
"""

import math
import struct

from PIL import Image

from ..files import read_bytes, read_json
from ..t6 import lightmap as t6
from ..textures import decode_texture

#: secondaryB's 0..1 scale, times this, is a page's brightness (the shaders' 31.875).
SCALE = 31.875
DDS_HEADER = 128  # a legacy DDS header: what the image dumper writes these two formats with


def page_colour(r, b, s):
    """One page's linear colour from its red and blue (0..1) and its scale."""
    return 4.0 * r * s, 2.0 * (1.0 - r - b) * s, 4.0 * b * s


def direction_weight(top_g, bottom_g):
    """w(d) for the direction the two pages' greens encode."""
    dx, dy = top_g * 4.0 - 2.0, bottom_g * 4.0 - 2.0
    return 0.4 + 0.6 * math.exp(-(dx * dx + dy * dy))


def rgb565(value):
    return ((value >> 11) & 31) / 31.0, ((value >> 5) & 63) / 63.0, (value & 31) / 31.0


def _payload(path, width, height, bytes_per_texel):
    data = read_bytes(path)
    size = width * height * bytes_per_texel
    if not path.lower().endswith(".dds") or len(data) < DDS_HEADER + size:
        raise t6.LightmapError(f"{path}: expected a {width}x{height} DDS of {bytes_per_texel} bytes a texel")
    return data[DDS_HEADER : DDS_HEADER + size]


def _size(path):
    height, width = struct.unpack_from("<2I", read_bytes(path), 12)
    return width, height


def bake_lightmap(secondary, secondary_b, primary=None):
    """([E per texel as RGB], [visibility bytes], width, page height) of one lightmap's files."""
    width, height = _size(secondary_b)
    if _size(secondary) != (width, 2 * height):
        raise t6.LightmapError(f"{secondary}: not two {width}x{height} pages stacked")
    colours = struct.unpack(f"<{width * height * 2}H", _payload(secondary, width, 2 * height, 2))
    scales = struct.unpack(f"<{width * height * 2}H", _payload(secondary_b, width, height, 4))
    light = []
    for at in range(width * height):
        tr, tg, tb = rgb565(colours[at])
        br, bg, bb = rgb565(colours[at + width * height])
        sa, sd = scales[2 * at] / 65535.0 * SCALE, scales[2 * at + 1] / 65535.0 * SCALE
        weight = direction_weight(tg, bg)
        ambient, directional = page_colour(tr, tb, sa), page_colour(br, bb, sd)
        light.append(tuple(a + d * weight for a, d in zip(ambient, directional, strict=True)))
    visibility = bytearray(width * height)
    if primary:
        img, _, _, _ = decode_texture(primary)
        visibility = bytearray(img.convert("RGB").resize((width, height), Image.BOX).getchannel("G").tobytes())
    return light, visibility, width, height


def bake(index, manifest_path):
    """The world's t6.Bake from its dumped lightmaps and gfxworld; None when it has no lightmap."""
    manifest = read_json(manifest_path)
    entries = [entry for entry in manifest.get("lightmaps", []) if entry.get("secondary")]
    if not entries:
        return None
    lights, visibilities, sizes = [], [], []
    for entry in entries:
        primary = entry.get("primary")
        light, visibility, width, height = bake_lightmap(
            t6.secondary_path(index, entry["secondary"]),
            t6.secondary_path(index, entry["secondaryB"]),
            t6.secondary_path(index, primary) if primary else None,
        )
        lights.append(light)
        visibilities.append(visibility)
        sizes.append((width, height))
    covered = [bytes([1]) * len(light) for light in lights]
    return t6.Bake(
        [(w, h, light) for (w, h), light in zip(sizes, lights, strict=True)],
        [(w, h, v) for (w, h), v in zip(sizes, visibilities, strict=True)],
        t6.encode_range(lights),
        t6.world_sun(manifest),
        t6.shade_fill(lights, visibilities, covered),
    )
