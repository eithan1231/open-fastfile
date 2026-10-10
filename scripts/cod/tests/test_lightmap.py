import struct

import pytest
from PIL import Image

from scripts.cod import dxgi, lightmap
from scripts.cod.iw6.images import dds
from scripts.cod.shell import move_lightmap_uvs


def bc4_block(r0, r1, selectors):
    """One BC4 block: two endpoints and sixteen 3-bit selectors, in 4x4 texel order."""
    bits = 0
    for i, s in enumerate(selectors):
        bits |= s << (3 * i)
    return bytes((r0, r1)) + bits.to_bytes(6, "little")


def test_bc4_reads_both_palettes_and_keeps_texel_order():
    # r0 > r1: six interpolated values, no explicit 0 or 255.
    eight = bc4_block(210, 10, list(range(8)) + [0] * 8)
    # r0 <= r1: four interpolated values, then an explicit 0 and 255.
    six = bc4_block(10, 210, list(range(8)) + [0] * 8)
    payload = eight + six
    pixels = dxgi.bc4(payload, 8, 4)
    row = lambda y: list(pixels[y * 8 : y * 8 + 8])  # noqa: E731 - four one-line row reads

    assert row(0)[:4] == [210, 10, round(6 * 210 / 7 + 10 / 7), round(5 * 210 / 7 + 2 * 10 / 7)]
    assert row(1)[:4] == [
        round(4 * 210 / 7 + 3 * 10 / 7),
        round(3 * 210 / 7 + 4 * 10 / 7),
        round(2 * 210 / 7 + 5 * 10 / 7),
        round(210 / 7 + 6 * 10 / 7),
    ]
    assert row(0)[4:] == [10, 210, round(4 * 10 / 5 + 210 / 5), round(3 * 10 / 5 + 2 * 210 / 5)]
    # The second block's last two selectors are the explicit ends.
    assert row(1)[4:] == [round(2 * 10 / 5 + 3 * 210 / 5), round(10 / 5 + 4 * 210 / 5), 0, 255]
    # Selector 0 everywhere below: each block's first endpoint.
    assert row(2) == [210] * 4 + [10] * 4 and row(3) == row(2)


def test_rgba16f_row_reads_ieee_half_floats():
    halves = (0x3C00, 0xC000, 0x0000, 0x7BFF, 0x3800, 0xBC00, 0x0001, 0x4000)
    payload = struct.pack("<8H", *halves)
    row = dxgi.rgba16f_row(payload, 2, 0)
    assert row == pytest.approx((1.0, -2.0, 0.0, 65504.0, 0.5, -1.0, 6e-8, 2.0), rel=1e-3, abs=1e-8)
    # A second row is a whole row on: width * 8 bytes, not width * 4.
    assert dxgi.rgba16f_row(payload + payload, 2, 1) == row


def test_read_dds_takes_the_dx10_header_the_iw6_dump_writes(tmp_path):
    path = tmp_path / "half.dds"
    payload = struct.pack("<8H", *([0x3C00] * 8))
    path.write_bytes(dds(dxgi.R16G16B16A16_FLOAT, 2, 1, 1, payload))
    fmt, width, height, data = dxgi.read_dds(str(path))
    assert (fmt, width, height) == (dxgi.R16G16B16A16_FLOAT, 2, 1)
    assert dxgi.rgba16f_row(data, 2, 0) == (1.0,) * 8


def half(value):
    return struct.pack("<e", value)


def write_page(path, width, height, ambient, highlight):
    """A Ghosts lightmap secondary: `width` x `height` of ambient over the same of highlight."""
    rows = b"".join(b"".join(half(c) for c in ambient) * width for _ in range(height))
    rows += b"".join(b"".join(half(c) for c in highlight) * width for _ in range(height))
    path.write_bytes(dds(dxgi.R16G16B16A16_FLOAT, width, height * 2, 1, rows))


def test_a_ghosts_lightmap_sums_its_ambient_and_highlight_lobes(tmp_path):
    img, out = tmp_path / "img", tmp_path / "assets"
    img.mkdir()
    ambient, highlight = (0.25, 0.5, 0.125, 0.0), (0.75, 0.5, 0.375, 0.0)
    write_page(img / "*lightmap0_secondary.dds", 4, 4, ambient, highlight)

    atlas = lightmap.convert(str(img), str(out), "iw6")
    # Every texel sums to (1, 1, 0.5), so the range covering them is 1 and the
    # intensity puts that one texel's luminance at IW6_TARGET.
    luminance = 0.2126 + 0.7152 + 0.0722 * 0.5
    assert atlas == lightmap.Atlas(lightmap.LIGHTMAP, None, pytest.approx(lightmap.IW6_TARGET / luminance, abs=5e-4))
    page = Image.open(out / lightmap.LIGHTMAP)
    assert page.size == (4, 4)
    # sRGB, which is how the engine samples a lightmap: 1.0 -> 255, 0.5 -> 188.
    assert page.getpixel((2, 2)) == (255, 255, 188)
    assert not (out / lightmap.PRIMARY).exists()  # no primary page in the dump, no reference copy


def test_a_page_the_range_does_not_cover_is_clipped_not_rescaled(tmp_path):
    img, out = tmp_path / "img", tmp_path / "assets"
    img.mkdir()
    write_page(img / "*lightmap0_secondary.dds", 4, 4, (3.0, 1.0, 0.5, 0.0), (0.0, 0.0, 0.0, 0.0))

    atlas = lightmap.convert(str(img), str(out), "iw6")
    # The range is the power of two above 3; the level is the one luminance present.
    luminance = 0.2126 * 3 + 0.7152 + 0.0722 * 0.5
    assert atlas.intensity == pytest.approx(lightmap.IW6_TARGET * 4 / luminance, abs=5e-4)
    # 3, 1 and 0.5 of a range of 4: sRGB(0.75), sRGB(0.25), sRGB(0.125).
    assert Image.open(out / lightmap.LIGHTMAP).getpixel((0, 0)) == (225, 137, 99)


def test_a_brighter_bake_is_not_a_brighter_world(tmp_path):
    # The bake's own unit is not comparable between maps, so two pages of the
    # same shape and different brightness reconstruct to the same light.
    def intensity(value):
        img, out = tmp_path / f"img{value}", tmp_path / f"assets{value}"
        img.mkdir()
        write_page(img / "*lightmap0_secondary.dds", 4, 4, (value, value, value, 0.0), (0.0, 0.0, 0.0, 0.0))
        atlas = lightmap.convert(str(img), str(out), "iw6")
        texel = Image.open(out / lightmap.LIGHTMAP).getpixel((0, 0))[0] / 255.0
        linear = texel / 12.92 if texel <= 0.04045 else ((texel + 0.055) / 1.055) ** 2.4
        return linear * atlas.intensity

    assert intensity(0.25) == pytest.approx(intensity(3.0), rel=0.02)


def test_two_lightmap_pages_stack_and_each_surface_moves_into_its_own(tmp_path):
    img, out = tmp_path / "img", tmp_path / "assets"
    img.mkdir()
    write_page(img / "*lightmap0_secondary.dds", 4, 4, (0.5, 0.5, 0.5, 0), (0, 0, 0, 0))
    write_page(img / "*lightmap1_secondary.dds", 2, 8, (0.25, 0.25, 0.25, 0), (0, 0, 0, 0))

    atlas = lightmap.convert(str(img), str(out), "iw6")
    assert Image.open(out / lightmap.LIGHTMAP).size == (4, 12)  # widest page wide, both pages tall
    assert atlas.uv == [(1.0, 0.0, 4 / 12, 0.0), (0.5, 0.0, 8 / 12, 4 / 12)]

    # A surface's own UVs are 0..1 over its page; page 1 is half as wide as the image.
    lmp = [0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 1.0]
    surfaces = [
        {"firstVertex": 0, "baseIndex": 0, "triCount": 1, "lightmapIndex": 0},
        {"firstVertex": 2, "baseIndex": 3, "triCount": 1, "lightmapIndex": 1},
    ]
    moved, conflicts = move_lightmap_uvs(lmp, surfaces, (0, 1, 1, 0, 1, 1), atlas.uv)
    assert (moved, conflicts) == (4, 0)
    assert lmp == pytest.approx([0.0, 0.0, 1.0, 4 / 12, 0.0, 4 / 12, 0.5, 1.0])


def test_a_surface_on_no_lightmap_page_keeps_its_uvs():
    # 31 is "none", and such a surface's lightmap UVs are unused and out of range.
    lmp = [900.0, 0.5]
    surface = [{"firstVertex": 0, "baseIndex": 0, "triCount": 1, "lightmapIndex": 31}]
    assert move_lightmap_uvs(lmp, surface, (0, 0, 0), [(0.5, 0.0, 0.5, 0.5)]) == (0, 0)
    assert lmp == [900.0, 0.5]


def test_no_lightmap_in_the_dump_is_no_atlas_rather_than_an_empty_one(tmp_path):
    img, out = tmp_path / "img", tmp_path / "assets"
    img.mkdir()
    assert lightmap.convert(str(img), str(out), "iw6") is None
    assert lightmap.convert(str(img), str(out), "iw5") is None


def test_an_aw_page_is_read_exactly_as_a_ghosts_page(tmp_path):
    """S1's secondary is half its primary's width and as tall -- 2048x8192 against
    4096x8192 on mp_prison -- which is Ghosts' shape: two lobes stacked down a
    page, and a sun mask at twice the page in both axes. Read across instead, each
    chart would be split between two unrelated halves."""
    outs = {}
    for game in ("iw6", "s1"):
        img, out = tmp_path / f"img_{game}", tmp_path / f"assets_{game}"
        img.mkdir()
        write_page(img / "*lightmap0_secondary.dds", 2, 4, (0.5, 0.25, 0.125, 0), (0.25, 0.25, 0.125, 0))
        write_page(img / "*lightmap1_secondary.dds", 1, 2, (1.0, 1.0, 1.0, 0), (0, 0, 0, 0))
        mask = bc4_block(255, 0, [0] * 16) * 2  # 4x8 over two blocks: 2x the 2x4 page
        (img / "*lightmap0_primary.dds").write_bytes(dds(dxgi.BC4_UNORM, 4, 8, 1, mask))
        outs[game] = (lightmap.convert(str(img), str(out), game), (out / lightmap.LIGHTMAP).read_bytes())
        assert Image.open(out / lightmap.PRIMARY).size == (4, 8)
    assert outs["s1"] == outs["iw6"]
    atlas = outs["s1"][0]
    assert atlas.uv == [(1.0, 0.0, 4 / 6, 0.0), (0.5, 0.0, 2 / 6, 4 / 6)]


def test_a_game_without_pages_does_not_read_them(tmp_path):
    img, out = tmp_path / "img", tmp_path / "assets"
    img.mkdir()
    write_page(img / "*lightmap0_secondary.dds", 4, 4, (0.5, 0.5, 0.5, 0), (0, 0, 0, 0))
    assert lightmap.PAGED_GAMES == ("iw6", "s1")
    for game in ("iw4", "iw5"):
        assert lightmap.convert(str(img), str(out), game) is None
