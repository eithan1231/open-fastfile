"""Black Ops II's lightmap, baked into the flat irradiance the engine adds, and the sun it was lit against.

What the game does, read from its world shaders and t6mp.exe
(reverse/t6-lightmap/README.md, re-checked by its verify.py):

- A GfxWorld's `draw.lightmaps[i].secondary` is one R8G8B8A8_UNORM image of **three
  pages stacked down it**, and a vertex's lightmap coordinate (u, v) addresses page k
  at (u, v/3 + k/3). The primary slot is empty.
- Pages 0 and 1 are RGBD: a colour is `rgb / (a + 1e-6)`, the bytes read as 0..1.
  Page 0 is the texel's ambient colour **A**, page 1 its directional colour **B**.
- Page 2's RGB is the direction **D** that B arrives from, `rgb * 2 - 1`, in world
  space; its alpha is the sun's baked visibility.
- The diffuse light at a pixel is `A + B * sat(dot(D, N)) + sunDiffuse * shadow *
  sat(dot(L, N))`, N the surface normal. The sun is added live, gated by the sun
  shadow map (or, where that has no cascade, page 2's alpha), and `sunDiffuse` is
  `sunCd.rgb * sunCd.w` of `GfxWorld.sunParse`, unscaled; L its angles' forward.

The engine takes a lightmap as flat irradiance (no direction) and has no normal maps,
so N is the interpolated vertex normal whatever it draws. This bakes
`A + B * sat(dot(D, N))` per texel with exactly that N, rasterised from the world's
own triangles in lightmap space, which is the game's value at every texel centre; the
bilinear filter is taken after the dot rather than before it. The sun stays live: the
engine casts it, in the same units, from `Lighting.sun`.

Units: nothing is normalised. A lightmap texel stores E / range, and the intensities
put one unit of the game's irradiance at one unit of three's, for the bake and the
sun alike (ENGINE_* below), so their ratio is the game's.
"""

import math
import os
import struct
from array import array
from collections import namedtuple

from .. import dxgi
from ..files import read_bytes, read_json
from .vertices import unit_vec

R8G8B8A8_UNORM = 28
PAGES = 3  # ambient, directional colour, direction + sun visibility
RGBD_EPSILON = 1e-6  # the shaders' `add r, a, l(9.99999997e-07)` before the divide

#: Three's light scales (packages/client/src/scene/lights.ts): a directional light's
#: `intensity` is multiplied by DIRECTIONAL_SCALE, and a lightmap texel by
#: `lightmap-intensity` * LIGHTMAP_SCALE, into the same irradiance.
#: scripts/cod/tests/test_t6_lightmap.py fails if either drifts from lights.ts.
ENGINE_DIRECTIONAL_SCALE = 20.0
ENGINE_LIGHTMAP_SCALE = 18.0

#: The share of texel channels the 8-bit encode may clip; what sets `range` (as IW6's).
CLIP = 0.001
#: How many texel rings past a chart's triangles get a normal, so the bilinear filter
#: at a chart's edge reads a baked texel rather than an unbaked one.
DILATE = 2

#: What the export writes: `pages` is [(width, height, rgb bytes of E / range)] per
#: lightmap, stacked by lightmap.py; `visibility` the sun visibility per lightmap, one
#: byte a texel; `sun` the world's sun; `fill` a stand-in for the light grid.
Bake = namedtuple("Bake", "pages visibility range sun fill")
#: The world's sun as the game builds it (0x440ae0): pitch and yaw in degrees, the
#: linear colour normalised to a peak of 1, and the engine intensity that carries
#: sunCd.w times that peak.
Sun = namedtuple("Sun", "pitch yaw color intensity")
#: An ambient light: linear colour (peak 1) and engine intensity.
Fill = namedtuple("Fill", "color intensity")


class LightmapError(ValueError):
    """The world's lightmap is not what this decoder reads."""


def decode_page(payload, width, page_height, page, x, y):
    """The four 0..1 channels of one texel of one page."""
    at = ((page * page_height + y) * width + x) * 4
    r, g, b, a = payload[at : at + 4]
    return r / 255.0, g / 255.0, b / 255.0, a / 255.0


def rgbd(r, g, b, a):
    """An RGBD texel as the shaders decode it: rgb / (a + 1e-6)."""
    scale = 1.0 / (a + RGBD_EPSILON)
    return r * scale, g * scale, b * scale


def texel_light(payload, width, page_height, x, y, normal):
    """(A + B * sat(dot(D, N)) as RGB, sun visibility 0..1) at one texel; N None means none known."""
    ar, ag, ab = rgbd(*decode_page(payload, width, page_height, 0, x, y))
    br, bg, bb = rgbd(*decode_page(payload, width, page_height, 1, x, y))
    dr, dg, db, vis = decode_page(payload, width, page_height, 2, x, y)
    if normal is None:
        return (ar, ag, ab), vis
    w = (dr * 2 - 1) * normal[0] + (dg * 2 - 1) * normal[1] + (db * 2 - 1) * normal[2]
    w = min(1.0, max(0.0, w))
    return (ar + br * w, ag + bg * w, ab + bb * w), vis


def rasterise_normals(width, height, triangles):
    """(normals, covered) over one page: the interpolated, renormalised vertex normal at every
    texel centre a triangle covers, in lightmap space. `triangles` yields
    ((u, v, normal) x 3); texel (x, y)'s centre is ((x + 0.5) / width, (y + 0.5) / height)."""
    normals = array("f", bytes(12 * width * height))
    covered = bytearray(width * height)
    for (u0, v0, n0), (u1, v1, n1), (u2, v2, n2) in triangles:
        x0, y0, x1, y1, x2, y2 = u0 * width, v0 * height, u1 * width, v1 * height, u2 * width, v2 * height
        area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0)
        if area == 0.0:
            continue
        inv = 1.0 / area
        lo_x, hi_x = max(0, math.floor(min(x0, x1, x2) - 0.5)), min(width - 1, math.ceil(max(x0, x1, x2) - 0.5))
        lo_y, hi_y = max(0, math.floor(min(y0, y1, y2) - 0.5)), min(height - 1, math.ceil(max(y0, y1, y2) - 0.5))
        hit = False
        for ty in range(lo_y, hi_y + 1):
            cy = ty + 0.5
            for tx in range(lo_x, hi_x + 1):
                cx = tx + 0.5
                b0 = ((x1 - cx) * (y2 - cy) - (x2 - cx) * (y1 - cy)) * inv
                b1 = ((x2 - cx) * (y0 - cy) - (x0 - cx) * (y2 - cy)) * inv
                b2 = 1.0 - b0 - b1
                if b0 < -1e-6 or b1 < -1e-6 or b2 < -1e-6:
                    continue
                _put(normals, covered, ty * width + tx, n0, n1, n2, b0, b1, b2)
                hit = True
        if not hit:
            # A sliver between texel centres still owns the texel its centroid is in.
            tx = min(width - 1, max(0, int((x0 + x1 + x2) / 3)))
            ty = min(height - 1, max(0, int((y0 + y1 + y2) / 3)))
            if not covered[ty * width + tx]:
                _put(normals, covered, ty * width + tx, n0, n1, n2, 1 / 3, 1 / 3, 1 / 3)
    return normals, covered


def _put(normals, covered, at, n0, n1, n2, b0, b1, b2):
    nx = n0[0] * b0 + n1[0] * b1 + n2[0] * b2
    ny = n0[1] * b0 + n1[1] * b1 + n2[1] * b2
    nz = n0[2] * b0 + n1[2] * b1 + n2[2] * b2
    length = math.sqrt(nx * nx + ny * ny + nz * nz)
    if length == 0.0:
        return
    normals[3 * at : 3 * at + 3] = array("f", (nx / length, ny / length, nz / length))
    covered[at] = 1


def dilate(normals, covered, width, height, rings=DILATE):
    """Give each unbaked texel next to a baked one the mean of its baked neighbours' normals."""
    for _ in range(rings):
        grown = []
        for at in range(width * height):
            if covered[at]:
                continue
            x, y = at % width, at // width
            sx = sy = sz = 0.0
            for ny in range(max(0, y - 1), min(height, y + 2)):
                for nx in range(max(0, x - 1), min(width, x + 2)):
                    n = ny * width + nx
                    if covered[n]:
                        sx += normals[3 * n]
                        sy += normals[3 * n + 1]
                        sz += normals[3 * n + 2]
            length = math.sqrt(sx * sx + sy * sy + sz * sz)
            if length > 0.0:
                grown.append((at, sx / length, sy / length, sz / length))
        for at, nx, ny, nz in grown:
            normals[3 * at : 3 * at + 3] = array("f", (nx, ny, nz))
            covered[at] = 2
    return normals, covered


def world_triangles(manifest, vertices, indices, lightmap):
    """((u, v, normal) x 3) for every triangle of every surface on lightmap `lightmap`, in
    the game's world space (the space D is in). `vertices` is the dump's 44-byte IW layout."""
    stride = manifest["vertexStride"]
    for surface in manifest["surfaces"]:
        if surface.get("lightmapIndex") != lightmap:
            continue
        base, first = surface["baseIndex"], surface["firstVertex"]
        for t in range(surface["triCount"]):
            tri = []
            for k in range(3):
                at = (first + indices[base + 3 * t + k]) * stride
                lu, lv, packed = struct.unpack_from("<2fI", vertices, at + 28)
                tri.append((lu, lv, unit_vec(packed)))
            yield tri


def secondary_path(index, name):
    """The dumped file for a lightmap image name (`*lightmap0_secondary`), from textures.texture_index."""
    # T6's image dumper writes `*` as `_` (iw5/dumpers/image.py's file_name).
    path = index.get(name) or index.get(name.replace("*", "_"))
    if path is None:
        raise LightmapError(f"{name} was not dumped")
    return path


def bake_lightmap(path, triangles):
    """([E per texel as RGB floats], [visibility bytes], width, page height) of one lightmap."""
    fmt, width, height, payload = dxgi.read_dds(path)
    if fmt != R8G8B8A8_UNORM or height % PAGES:
        raise LightmapError(f"{path}: DXGI format {fmt}, {width}x{height}; expected R8G8B8A8_UNORM, three pages stacked")
    page_height = height // PAGES
    normals, covered = rasterise_normals(width, page_height, triangles)
    dilate(normals, covered, width, page_height)
    light, visibility = [], bytearray(width * page_height)
    for y in range(page_height):
        for x in range(width):
            at = y * width + x
            normal = normals[3 * at : 3 * at + 3] if covered[at] else None
            rgb, vis = texel_light(payload, width, page_height, x, y, normal)
            light.append(rgb)
            visibility[at] = round(vis * 255)
    return light, visibility, width, page_height, covered


def encode_range(lights):
    """The power of two covering all but CLIP of the baked channels (IW6's rule)."""
    channels = sorted(c for light in lights for rgb in light[::7] for c in rgb)
    if not channels:
        return 1.0
    top = channels[min(len(channels) - 1, int(len(channels) * (1.0 - CLIP)))]
    scale = 1.0
    while scale < top:
        scale *= 2.0
    return scale


def world_sun(manifest):
    """The Sun of `GfxWorld.sunParse`, or None when the dump has none."""
    sun = manifest.get("sun")
    if not sun:
        return None
    r, g, b, strength = sun["sunCd"]
    peak = max(r, g, b)
    if peak <= 0.0 or strength <= 0.0:
        return None
    pitch, yaw, _roll = sun["angles"]
    return Sun(pitch, yaw, (r / peak, g / peak, b / peak), strength * peak / ENGINE_DIRECTIONAL_SCALE)


def shade_fill(lights, visibilities, covered_maps):
    """A Fill at the median baked light of texels the sun does not reach.

    Not the game's: it has no ambient term (its `ambientColor` is 0 on the maps read)
    and lights a model from its light grid, which is not exported. The engine's props
    get only the sun and ambient lights, so without one a prop in shadow is black; the
    median of the shaded bake is the least the shell is brightened by standing in for it.
    """
    samples = []
    for light, vis, covered in zip(lights, visibilities, covered_maps, strict=True):
        for at in range(0, len(light), 5):
            if covered[at] == 1 and vis[at] < 128 and max(light[at]) > 0.0:
                samples.append(light[at])
    if not samples:
        return None
    lum = sorted((0.2126 * r + 0.7152 * g + 0.0722 * b, (r, g, b)) for r, g, b in samples)
    median, (r, g, b) = lum[len(lum) // 2]
    peak = max(r, g, b)
    return Fill((r / peak, g / peak, b / peak), median / ENGINE_LIGHTMAP_SCALE) if peak > 0 else None


def bake(index, manifest_path):
    """The world's Bake from its dumped lightmaps and gfxworld; None when it has no lightmap."""
    manifest = read_json(manifest_path)
    names = [entry.get("secondary") for entry in manifest.get("lightmaps", [])]
    if not any(names):
        return None
    base = os.path.dirname(os.path.abspath(manifest_path))
    vertices = read_bytes(os.path.join(base, os.path.basename(manifest["vertexFile"])))
    blob = read_bytes(os.path.join(base, os.path.basename(manifest["indexFile"])))
    indices = struct.unpack(f"<{len(blob) // 2}H", blob)
    lights, visibilities, sizes, covered_maps = [], [], [], []
    for number, name in enumerate(names):
        if not name:
            raise LightmapError(f"lightmap {number} has no secondary image")
        light, visibility, width, height, covered = bake_lightmap(
            secondary_path(index, name), world_triangles(manifest, vertices, indices, number)
        )
        lights.append(light)
        visibilities.append(visibility)
        sizes.append((width, height))
        covered_maps.append(covered)
    scale = encode_range(lights)
    pages = [(w, h, light) for (w, h), light in zip(sizes, lights, strict=True)]
    return Bake(
        pages,
        [(w, h, v) for (w, h), v in zip(sizes, visibilities, strict=True)],
        scale,
        world_sun(manifest),
        shade_fill(lights, visibilities, covered_maps),
    )
