"""A map's baked lighting: the lightmap its zone ships, as `assets/lightmap.png`.

What each game's pages hold, and how each reading was established, is
docs/cod/reference.md#lightmaps. Three shapes:

- **IW4/IW5**: one pair of pages, and the signal this pipeline takes is the
  secondary's alpha, at full resolution.
- **T5** (Black Ops): an R5G6B5 secondary of two pages and a G16R16 secondaryB per
  lightmap, which the shaders combine into an ambient and a directional colour
  beside a live sun. `t5/lightmap.py` bakes their sum per texel, as T6's is, and
  hands the sun over with it.
- **IW6**: a pair per page. The secondary holds the page's **ambient** colour
  stacked over its **highlight** colour, both half-float RGBA; the two are
  summed into one irradiance and written as sRGB of `E / range`, where `range`
  is the power of two that covers the page. `lightmap-intensity` is solved so
  that a lit texel at IW6_LEVEL of the page is worth IW6_TARGET as an ambient
  light, whatever range it was stored under. The primary is the sun's own
  visibility, which the engine's live sun casts instead, so it goes beside the
  atlas for reference as on IW4/IW5.
- **S1** (Advanced Warfare): IW6's pages, names, formats and lobes, settled
  against its own zones (reverse/s1-zone/README.md#the-lightmap).
- **T6** (Black Ops II): one secondary per lightmap, three pages stacked down it
  -- an RGBD ambient colour, an RGBD directional colour, and the direction with
  the sun's visibility in alpha -- which the game's shaders sum as
  `A + B * sat(dot(D, N))` beside a live sun. `t6/lightmap.py` bakes that sum per
  texel with the surface's own normal, in the game's units, and hands the sun
  over with it so that their ratio is the game's.

A Ghosts map can have several lightmap pages, each a texture of its own in the
game and each its own size. They are stacked into one image, and `Atlas.uv`
says where each landed so that `shell.py` can move a surface's lightmap UVs
into its own page.
"""

import os
import re
from collections import namedtuple

from PIL import Image

from . import dxgi
from .t5 import lightmap as t5_lightmap
from .t6 import lightmap as t6_lightmap
from .textures import decode_texture, texture_index

#: What the export writes and what the world file needs to use it. `uv` is one
#: (scale u, offset u, scale v, offset v) per lightmap page, or None when the
#: page fills the image and nothing has to move; `intensity` is the
#: `lightmap-intensity` the world file gives the shell and the decal pass.
#: `sun` and `fill` are set where the bake's units are known against the game's
#: own sun (T6: t6/lightmap.py's Sun and Fill), and replace the worldspawn's.
Atlas = namedtuple("Atlas", "file uv intensity sun fill", defaults=(None, None))

LIGHTMAP = "lightmap.png"
PRIMARY = "lightmap-primary.png"

#: IW4/IW5 keep one pair, named with a leading underscore.
IW_SECONDARY = "_lightmap0_secondary"
IW_PRIMARY = "_lightmap0_primary"
#: 0.1 keeps that bake on the order of the ambient light it stands in for
#: (LIGHTMAP_SCALE in packages/client/src/scene/lights.ts).
IW_INTENSITY = 0.1

#: The games that keep IW6's pair per page; everything else is read as IW4/IW5.
PAGED_GAMES = ("iw6", "s1")
#: The games whose lightmap is not decoded yet, so none is written (see above).
UNREAD_GAMES = ()
#: The games whose lightmap is baked from its pages and its world (see above).
BAKED_GAMES = {"t5": t5_lightmap, "t6": t6_lightmap}
#: IW6 numbers its pages, under the `*` that marks a generated asset.
IW6_PAGE = re.compile(r"\*lightmap(\d+)_(primary|secondary)")
#: The share of texels the IW6 encode may clip, which is what sets an atlas's range.
IW6_CLIP = 0.001
#: What a lit texel at IW6_LEVEL of the page is worth as an ambient light, which
#: is what `lightmap-intensity` is solved for. The bake's own unit is not
#: comparable between maps -- mp_frag's is three times mp_prisonbreak's for the
#: same worldspawn `sunlight` -- so the level is normalised and the map's own sun
#: carries how bright the map is. 0.3 is mp_prisonbreak's own ratio of bake to
#: sun (about 1:15 on open ground), which is the dimmest of the nine zones measured.
IW6_TARGET = 0.3
IW6_LEVEL = 0.9

#: Linear 0..1 -> one sRGB byte, which is how three samples a lightmap
#: (configureLightmapTexture sets SRGBColorSpace). A table because the encode
#: runs per channel over every texel of a 2048-row page.
_SRGB_STEPS = 4096
_SRGB = bytes(
    round(255 * (12.92 * c if c <= 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055))
    for c in (i / (_SRGB_STEPS - 1) for i in range(_SRGB_STEPS))
)


def convert(img_root, out_dir, game, manifest_path=None):
    """Write the map's lightmap under `out_dir`; return an Atlas, or None when it has none.

    `manifest_path` is the world's `.gfxworld.json`, which a BAKED_GAMES lightmap
    needs for the surfaces it is baked against."""
    os.makedirs(out_dir, exist_ok=True)
    if game in UNREAD_GAMES:
        return None
    index = texture_index(img_root)
    if game in BAKED_GAMES:
        return _baked(BAKED_GAMES[game], index, out_dir, manifest_path)
    return _iw6(index, out_dir) if game in PAGED_GAMES else _iw(index, out_dir)


def _iw(index, out_dir):
    """IW4/IW5: the secondary's alpha, and the primary beside it for reference."""
    written = None
    if IW_SECONDARY in index:
        try:
            img, _, _, _ = decode_texture(index[IW_SECONDARY])
            img.convert("RGBA").getchannel("A").save(os.path.join(out_dir, LIGHTMAP))
            written = Atlas(LIGHTMAP, None, IW_INTENSITY)
        except Exception as e:
            print(f"      lightmap secondary: {e}")
    if IW_PRIMARY in index:
        try:
            img, _, _, _ = decode_texture(index[IW_PRIMARY])
            img.save(os.path.join(out_dir, PRIMARY))
        except Exception as e:
            print(f"      lightmap primary: {e}")
    return written


def _pages(index, half):
    """[(page number, file)] for one half of the IW6 pair, in page order."""
    found = []
    for name, path in index.items():
        match = IW6_PAGE.fullmatch(name)
        if match and match.group(2) == half:
            found.append((int(match.group(1)), path))
    return sorted(found)


def _read_secondary(pages):
    """[(page width, page height, payload)]: the page is the top half, the highlight the bottom."""
    out = []
    for number, path in pages:
        fmt, width, height, payload = dxgi.read_dds(path)
        if fmt != dxgi.R16G16B16A16_FLOAT:
            raise ValueError(f"lightmap page {number} is DXGI format {fmt}, not half-float RGBA")
        out.append((width, height // 2, payload))
    return out


def _scales(reads):
    """(range, level): what the encode divides by, and the luminance it is normalised at.

    `range` is the power of two covering all but IW6_CLIP of the summed
    channels, so the 8-bit encode clips almost nothing; `level` is the
    IW6_LEVEL quantile of the luminance of the texels that carry light, which is
    what `lightmap-intensity` is solved against. Both are sampled rather than
    measured over every texel: a page holds millions, and both are scales rather
    than values anything is compared against.
    """
    channels, lit = [], []
    for width, height, payload in reads:
        for y in range(0, height, 4):
            ambient = dxgi.rgba16f_row(payload, width, y)
            highlight = dxgi.rgba16f_row(payload, width, y + height)
            for i in range(0, width * 4, 16):
                rgb = [ambient[i + c] + highlight[i + c] for c in range(3)]
                channels.extend(rgb)
                luminance = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]
                if luminance > 0.0:
                    lit.append(luminance)
    if not channels or not lit:
        return 1.0, 1.0
    channels.sort()
    lit.sort()
    top = channels[min(len(channels) - 1, int(len(channels) * (1.0 - IW6_CLIP)))]
    scale = 1.0
    while scale < top:
        scale *= 2.0
    return scale, lit[min(len(lit) - 1, int(len(lit) * IW6_LEVEL))]


def _draw(buf, stride, top, page, scale):
    """Sum one page's two lobes into `buf` at row `top`, as sRGB of E / range."""
    width, height, payload = page
    steps = _SRGB_STEPS - 1
    factor = steps / scale
    for y in range(height):
        ambient = dxgi.rgba16f_row(payload, width, y)
        highlight = dxgi.rgba16f_row(payload, width, y + height)
        at = (top + y) * stride * 3
        buf[at : at + width * 3] = bytes(
            _SRGB[min(steps, int(value * factor + 0.5))] if value > 0.0 else 0
            for i in range(0, width * 4, 4)
            for value in (ambient[i] + highlight[i], ambient[i + 1] + highlight[i + 1], ambient[i + 2] + highlight[i + 2])
        )


def _stack(sizes):
    """(width, height, [(y, w, h)]) for pages stacked down one image, each left-aligned."""
    width = max(w for w, _h in sizes)
    rows, y = [], 0
    for w, h in sizes:
        rows.append((y, w, h))
        y += h
    return width, y, rows


def _iw6(index, out_dir):
    """Ghosts: ambient + highlight per page, stacked; the sun mask beside it."""
    reads = _read_secondary(_pages(index, "secondary"))
    if not reads:
        return None
    scale, level = _scales(reads)
    width, height, rows = _stack([(w, h) for w, h, _payload in reads])
    buf = bytearray(width * height * 3)
    for page, (top, _w, _h) in zip(reads, rows, strict=True):
        _draw(buf, width, top, page, scale)
    Image.frombytes("RGB", (width, height), bytes(buf)).save(os.path.join(out_dir, LIGHTMAP), optimize=True)

    uv = None
    if len(rows) > 1:
        uv = [(w / width, 0.0, h / height, top / height) for top, w, h in rows]
    _iw6_primary(index, out_dir)
    # A stored texel is E / scale, so this is what puts the page's IW6_LEVEL
    # texel at IW6_TARGET once the engine multiplies by it.
    return Atlas(LIGHTMAP, uv, round(IW6_TARGET * scale / level, 3))


def _iw6_primary(index, out_dir):
    """The sun-visibility masks, stacked the same way, at their own (2x) resolution.

    Nothing in the engine reads it: the live sun casts the shadows this holds.
    It is written for the same reason IW4/IW5's primary is -- it is the evidence
    for what the page means, and the only copy outside the fastfile.
    """
    masks = []
    for number, path in _pages(index, "primary"):
        fmt, width, height, payload = dxgi.read_dds(path)
        if fmt != dxgi.BC4_UNORM:
            print(f"      lightmap primary page {number}: DXGI format {fmt}, not BC4")
            return
        masks.append((width, height, dxgi.bc4(payload, width, height)))
    if not masks:
        return
    width, height, rows = _stack([(w, h) for w, h, _pixels in masks])
    buf = bytearray(width * height)
    for (mask_w, mask_h, pixels), (top, _w, _h) in zip(masks, rows, strict=True):
        for y in range(mask_h):
            at = (top + y) * width
            buf[at : at + mask_w] = pixels[y * mask_w : (y + 1) * mask_w]
    Image.frombytes("L", (width, height), bytes(buf)).save(os.path.join(out_dir, PRIMARY), optimize=True)


def _encode(value, factor, steps):
    return _SRGB[min(steps, int(value * factor + 0.5))] if value > 0.0 else 0


def _baked(baker, index, out_dir, manifest_path):
    """Black Ops and Black Ops II: the baked irradiance per lightmap, stacked; its sun visibility beside it."""
    if manifest_path is None:
        raise ValueError("a T5 or T6 lightmap is baked against its world: pass the .gfxworld.json")
    baked = baker.bake(index, manifest_path)
    if baked is None:
        return None
    width, height, rows = _stack([(w, h) for w, h, _light in baked.pages])
    steps = _SRGB_STEPS - 1
    factor = steps / baked.range
    buf = bytearray(width * height * 3)
    for (page_w, page_h, light), (top, _w, _h) in zip(baked.pages, rows, strict=True):
        for y in range(page_h):
            at = ((top + y) * width) * 3
            buf[at : at + page_w * 3] = bytes(
                _encode(c, factor, steps) for rgb in light[y * page_w : (y + 1) * page_w] for c in rgb
            )
    Image.frombytes("RGB", (width, height), bytes(buf)).save(os.path.join(out_dir, LIGHTMAP), optimize=True)

    vis = bytearray(width * height)
    for (page_w, page_h, pixels), (top, _w, _h) in zip(baked.visibility, rows, strict=True):
        for y in range(page_h):
            vis[(top + y) * width : (top + y) * width + page_w] = pixels[y * page_w : (y + 1) * page_w]
    Image.frombytes("L", (width, height), bytes(vis)).save(os.path.join(out_dir, PRIMARY), optimize=True)

    uv = [(w / width, 0.0, h / height, top / height) for top, w, h in rows] if len(rows) > 1 else None
    # A texel stores E / range, and three multiplies it by intensity * LIGHTMAP_SCALE.
    intensity = round(baked.range / t6_lightmap.ENGINE_LIGHTMAP_SCALE, 4)
    return Atlas(LIGHTMAP, uv, intensity, baked.sun, baked.fill)
