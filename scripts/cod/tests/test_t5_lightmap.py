"""Black Ops' lightmap (scripts/cod/t5/lightmap.py): the lit shaders' decode, baked per texel.

The decode is read from `pimp_shader_lmap_*` (reverse/t5-fx/shaders.py --techset
wc_l_sm_r0c0n0s0): an R5G6B5 secondary of two pages, a G16R16 secondaryB of two
scales, summed as `A + D * w(d)` once the normal map is flat. Built files check the
arithmetic and the layout; nothing here needs the game.
"""

import math
import struct

import pytest

from scripts.cod import lightmap
from scripts.cod.iw5.dumpers.image import FORMATS, Texture, dds_bytes
from scripts.cod.t5 import lightmap as t5
from scripts.cod.t5.dumpers.gfxworld import SUN_COLOR


def pack565(r, g, b):
    return (round(r * 31) << 11) | (round(g * 63) << 5) | round(b * 31)


def write(path, fmt, width, height, payload):
    path.write_bytes(dds_bytes(Texture(fmt, 0, width, height, 1, 1, [payload])))
    return str(path)


def test_a_page_colour_is_the_shaders_chroma_times_its_scale():
    # Grey is r = b = 1/4: all three channels equal the scale.
    assert t5.page_colour(0.25, 0.25, 2.0) == pytest.approx((2.0, 2.0, 2.0))
    assert t5.page_colour(0.5, 0.0, 1.0) == pytest.approx((2.0, 1.0, 0.0))


def test_the_direction_weight_peaks_where_the_direction_is_zero():
    assert t5.direction_weight(0.5, 0.5) == pytest.approx(1.0)
    assert t5.direction_weight(1.0, 1.0) == pytest.approx(0.4 + 0.6 * math.exp(-8.0))


def test_a_texel_is_the_ambient_page_plus_the_weighted_directional_one(tmp_path):
    """Two 1x1 pages stacked: the top with secondaryB's red, the bottom with its green."""
    top, bottom = pack565(0.25, 0.5, 0.25), pack565(0.5, 1.0, 0.0)
    secondary = write(tmp_path / "s.dds", "R5G6B5", 1, 2, struct.pack("<2H", top, bottom))
    scales = struct.pack("<2H", round(65535 * 1.0 / t5.SCALE), round(65535 * 2.0 / t5.SCALE))
    secondary_b = write(tmp_path / "b.dds", "G16R16", 1, 1, scales)

    light, _visibility, width, height = t5.bake_lightmap(secondary, secondary_b)

    assert (width, height) == (1, 1)
    (tr, tg, tb), (br, bg, bb) = t5.rgb565(top), t5.rgb565(bottom)  # as the 5- and 6-bit channels hold them
    ambient, directional = t5.page_colour(tr, tb, 1.0), t5.page_colour(br, bb, 2.0)
    weight = t5.direction_weight(tg, bg)
    assert light[0] == pytest.approx([a + d * weight for a, d in zip(ambient, directional, strict=True)], rel=1e-4)
    # Not the pages swapped, nor the scales: the directional page is the red one here.
    assert light[0][0] > light[0][2] + 1.0


def test_the_two_lightmap_formats_are_written_rather_than_skipped():
    """A dump that skipped them left every Black Ops map with no lightmap at all."""
    assert FORMATS["R5G6B5"].bytes == 2 and FORMATS["G16R16"].bytes == 4


def test_black_ops_is_baked_and_hands_its_sun_over():
    assert lightmap.BAKED_GAMES["t5"] is t5
    # sunParse.sunSettings: control, angles, ambient, sunDiffuse (the shaders' sunDiffuse), ...
    assert SUN_COLOR.size == 100
