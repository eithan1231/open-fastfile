"""Black Ops II's lightmap (scripts/cod/t6/lightmap.py): the game's decode, baked per texel, and its sun.

The decode is the one reverse/t6-lightmap/verify.py reads out of every lit world
shader: pages 0 and 1 RGBD, page 2 a direction in RGB and the sun's visibility in
alpha, summed as `A + B * sat(dot(D, N))`. Built pages check the arithmetic; two
tests read the installed game when it is there (as test_t6.py finds it) and check what a wrong
page order or a wrong sun could not satisfy.
"""

import math
import os
import re
import struct
from pathlib import Path

import pytest
from PIL import Image

from scripts.cod import lightmap
from scripts.cod.iw6.images import dds
from scripts.cod.t6 import lightmap as t6
from scripts.cod.t6 import vertices
from scripts.cod.t6.dumpers import gfxworld
from scripts.cod.worldfile import GAMES, write_world_file

from .test_props_gate import a_world
from .test_t6 import BO2_ZONES, packed_unit_vec

LIGHTS_TS = Path(__file__).resolve().parents[3] / "packages/client/src/scene/lights.ts"
UP, DOWN = packed_unit_vec(0, 0, 511), packed_unit_vec(0, 0, -511)
# 60 degrees off +z towards +x: sat(dot(+z, N)) = 0.5.
TILTED = packed_unit_vec(round(511 * math.sin(math.pi / 3)), 0, round(511 * 0.5))


def test_the_engine_scales_are_the_ones_lights_ts_multiplies_by():
    """The bake and the sun are written in three's units through these two numbers; if
    lights.ts moves either, the ratio of lightmap to sun stops being the game's."""
    source = LIGHTS_TS.read_text()
    value = {name: float(v) for name, v in re.findall(r"export const (\w+) = (\d+(?:\.\d+)?);", source)}
    assert value["DIRECTIONAL_SCALE"] == t6.ENGINE_DIRECTIONAL_SCALE
    assert "export const LIGHTMAP_SCALE = AMBIENT_SCALE;" in source
    assert value["AMBIENT_SCALE"] == t6.ENGINE_LIGHTMAP_SCALE


def secondary(width, height, ambient, directional, direction):
    """A T6 secondary: `width` x `height` pages of RGBA8 texels, stacked ambient, directional, direction."""
    return dds(
        t6.R8G8B8A8_UNORM,
        width,
        height * 3,
        1,
        b"".join(bytes(px) * (width * height) for px in (ambient, directional, direction)),
    )


def quad(normal, lightmap_index=0):
    """A manifest, vertices and indices: one surface of two triangles over the whole lightmap."""
    corners = [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)]
    verts = b"".join(gfxworld.IW_VERTEX.pack(u, v, 0.0, 1.0, b"\xff" * 4, 0.0, 0.0, u, v, normal, 0) for u, v in corners)
    indices = struct.pack("<6H", 0, 1, 2, 0, 2, 3)
    surface = {"firstVertex": 0, "vertexCount": 4, "triCount": 2, "baseIndex": 0, "lightmapIndex": lightmap_index}
    manifest = {
        "_game": "t6",
        "vertexStride": 44,
        "vertexCount": 4,
        "indexCount": 6,
        "vertexFile": "w.vertices.bin",
        "indexFile": "w.indices.bin",
        "surfaces": [surface],
        "lightmaps": [{"secondary": "*lightmap0_secondary"}],
        "sun": {"angles": [-43.0, 90.61, 0.0], "sunCd": [0.98, 0.63, 0.29, 20.0], "ambientColor": [0, 0, 0, 0]},
    }
    return manifest, verts, indices


def export(tmp_path, normal, page=None):
    import json

    img, out, gw = tmp_path / "img", tmp_path / "assets", tmp_path / "gw"
    for d in (img, gw):
        d.mkdir(parents=True, exist_ok=True)
    # A = (0.5, 0.25, 0) / 0.5, B = (1, 1, 1) / 1, D = +z; visibility 255.
    (img / "_lightmap0_secondary.dds").write_bytes(
        page or secondary(4, 4, (128, 64, 0, 128), (255, 255, 255, 255), (128, 128, 255, 255))
    )
    manifest, verts, indices = quad(normal)
    (gw / "w.gfxworld.json").write_text(json.dumps(manifest))
    (gw / "w.vertices.bin").write_bytes(verts)
    (gw / "w.indices.bin").write_bytes(indices)
    return lightmap.convert(str(img), str(out), "t6", str(gw / "w.gfxworld.json")), out


def linear(byte):
    c = byte / 255
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def baked(atlas, out):
    """The first texel of the written lightmap back in the game's units (E, not E / range)."""
    rgb = Image.open(out / lightmap.LIGHTMAP).getpixel((1, 1))
    return [linear(c) * atlas.intensity * t6.ENGINE_LIGHTMAP_SCALE for c in rgb]


@pytest.mark.parametrize(
    ("normal", "weight"),
    [(UP, 1.0), (TILTED, 0.5), (DOWN, 0.0)],
)
def test_a_texel_is_ambient_plus_directional_times_the_clamped_cosine(tmp_path, normal, weight):
    """E = A + B * sat(dot(D, N)), with A and B RGBD (rgb / (a + 1e-6)) and D = rgb * 2 - 1."""
    atlas, out = export(tmp_path, normal)
    a = [c / 255 / (128 / 255 + 1e-6) for c in (128, 64, 0)]
    b = 1 / (1 + 1e-6)
    d_dot_up = 255 / 255 * 2 - 1
    n = vertices.unit_vec(normal)
    w = max(0.0, min(1.0, (128 / 255 * 2 - 1) * (n[0] + n[1]) + d_dot_up * n[2]))
    assert w == pytest.approx(weight, abs=0.01)
    expected = [c + b * w for c in a]
    # The PNG holds sRGB of E / range: within one 8-bit step of the decode.
    assert baked(atlas, out) == pytest.approx(expected, rel=0.02, abs=0.02)
    assert atlas.uv is None and atlas.file == lightmap.LIGHTMAP


def test_the_three_pages_are_read_in_order(tmp_path):
    """Swap the ambient and directional pages and the texel changes: the order is load-bearing."""
    one, out_one = export(tmp_path / "a", UP, secondary(4, 4, (255, 0, 0, 255), (0, 0, 255, 255), (128, 128, 255, 255)))
    assert baked(one, out_one) == pytest.approx([1.0, 0.0, 1.0], abs=0.02)
    two, out_two = export(tmp_path / "b", DOWN, secondary(4, 4, (255, 0, 0, 255), (0, 0, 255, 255), (128, 128, 255, 255)))
    assert baked(two, out_two) == pytest.approx([1.0, 0.0, 0.0], abs=0.02)


def test_the_sun_visibility_is_written_beside_the_lightmap(tmp_path):
    atlas, out = export(tmp_path, UP, secondary(4, 4, (0, 0, 0, 255), (0, 0, 0, 255), (128, 128, 255, 77)))
    assert Image.open(out / lightmap.PRIMARY).getpixel((2, 3)) == 77
    assert atlas is not None


def test_the_sun_and_the_bake_are_in_one_unit(tmp_path):
    """The game adds sunCd.rgb * sunCd.w to the bake unscaled (t6mp.exe 0x440ae0,
    0x418d6f), so three's sun must carry the same number against the same lightmap."""
    atlas, _out = export(tmp_path, UP)
    sun = atlas.sun
    assert (sun.pitch, sun.yaw) == (-43.0, 90.61)
    assert max(sun.color) == pytest.approx(1.0)
    assert [c * sun.intensity * t6.ENGINE_DIRECTIONAL_SCALE for c in sun.color] == pytest.approx(
        [0.98 * 20, 0.63 * 20, 0.29 * 20]
    )
    # A texel of 1.0 in the PNG is `range` game units of irradiance.
    assert atlas.intensity * t6.ENGINE_LIGHTMAP_SCALE == pytest.approx(2.0, rel=1e-3)


def test_uncovered_texels_next_to_a_chart_are_baked_with_its_normal():
    normals, covered = t6.rasterise_normals(8, 8, [[(0.0, 0.0, (0, 0, 1)), (0.5, 0.0, (0, 0, 1)), (0.0, 0.5, (0, 0, 1))]])
    assert covered[0] == 1 and not covered[7 * 8 + 7]
    ring = 2 * 8 + 2  # centre (2.5, 2.5): just past the hypotenuse x + y = 4
    assert not covered[ring]
    t6.dilate(normals, covered, 8, 8, rings=1)
    assert covered[ring] == 2 and list(normals[3 * ring : 3 * ring + 3]) == pytest.approx([0, 0, 1])
    assert not covered[7 * 8 + 7] and not covered[5 * 8 + 5]


def test_a_second_lightmap_is_stacked_under_the_first(tmp_path):
    import json

    img, out, gw = tmp_path / "img", tmp_path / "assets", tmp_path / "gw"
    img.mkdir()
    gw.mkdir()
    (img / "_lightmap0_secondary.dds").write_bytes(secondary(4, 4, (255, 255, 255, 255), (0, 0, 0, 255), (128, 128, 255, 255)))
    (img / "_lightmap1_secondary.dds").write_bytes(secondary(2, 2, (0, 255, 0, 255), (0, 0, 0, 255), (128, 128, 255, 255)))
    manifest, verts, indices = quad(UP)
    manifest["lightmaps"].append({"secondary": "*lightmap1_secondary"})
    manifest["surfaces"].append(dict(manifest["surfaces"][0], lightmapIndex=1))
    (gw / "w.gfxworld.json").write_text(json.dumps(manifest))
    (gw / "w.vertices.bin").write_bytes(verts)
    (gw / "w.indices.bin").write_bytes(indices)
    atlas = lightmap.convert(str(img), str(out), "t6", str(gw / "w.gfxworld.json"))
    assert atlas.uv == [(1.0, 0.0, 4 / 6, 0.0), (0.5, 0.0, 2 / 6, 4 / 6)]
    image = Image.open(out / lightmap.LIGHTMAP)
    assert image.size == (4, 6) and image.getpixel((0, 0))[1] == image.getpixel((1, 5))[1] > 200
    assert image.getpixel((0, 5))[0] == 0


def test_the_world_file_takes_the_bakes_sun_and_fill(tmp_path):
    ents, assets = a_world(tmp_path)
    sun = t6.Sun(-43.0, 90.61, (1.0, 0.5, 0.25), 0.982)
    atlas = lightmap.Atlas("lightmap.png", None, 0.889, sun, t6.Fill((1.0, 1.0, 1.0), 0.033))
    path, _, found_sun, _ = write_world_file(str(tmp_path), "mp_la", ents, assets, None, GAMES["t6"], "t6", lightmap=atlas)
    text = open(path).read()
    line = next(x for x in text.splitlines() if x.startswith("light sun"))
    assert found_sun and "intensity: 0.982" in line and "color: #ffbc89" in line
    # AngleVectors(-43, 90.61): up and towards +y, which is the engine's -z.
    at = [float(v) for v in re.search(r"at: ([-\d.]+) ([-\d.]+) ([-\d.]+)", line).groups()]
    assert at[1] == pytest.approx(120 * math.sin(math.radians(43)), abs=0.1) and at[2] < -80
    assert "light fill { type: ambient, intensity: 0.033, color: #ffffff }" in text
    assert 'lightmap: "assets/lightmap.png"' in text and "lightmap-intensity: 0.889" in text


# -- the installed game ----------------------------------------------------------------------------


@pytest.fixture(scope="module")
def mp_la():
    if not os.path.exists(os.path.join(BO2_ZONES, "mp_la.ff")):
        pytest.skip("Black Ops II is not installed")
    from scripts.cod.zonecode import walk_fastfile

    return walk_fastfile(os.path.join(BO2_ZONES, "mp_la.ff")).by_type("gfxworld")[0].record


def test_mp_las_stored_sun_light_is_the_one_its_sun_parse_builds(mp_la):
    """GfxWorld.sunLight, as the linker stored it, is sunCd.rgb * sunCd.w along
    AngleVectors(angles) -- the construction read at t6mp.exe 0x440ae0, reproduced from
    the other copy the zone keeps. The export builds its sun from sunParse the same way."""
    parse = gfxworld.sun(mp_la)
    light = mp_la["sunLight"]
    r, g, b, strength = parse["sunCd"]
    assert light["type"] == 1
    assert light.unpack("<3f", "color") == pytest.approx((r * strength, g * strength, b * strength), rel=1e-6)
    pitch, yaw = (math.radians(a) for a in parse["angles"][:2])
    forward = (math.cos(pitch) * math.cos(yaw), math.cos(pitch) * math.sin(yaw), -math.sin(pitch))
    assert light.unpack("<3f", "dir") == pytest.approx(forward, abs=1e-5)


def test_mp_las_direction_page_is_unit_and_its_alpha_is_the_suns_visibility(mp_la):
    """Through each triangle's own lightmap coordinate: page 2's RGB is a unit vector,
    and its alpha is near zero on faces turned from the sun and not on faces towards it.
    Read from the wrong page, or against the wrong sun, neither holds."""
    from scripts.cod.t6.dumpers.image import from_loaddef

    surfaces, blob, index_bytes = gfxworld.convert(mp_la)
    image = mp_la["draw.lightmaps"][0]["secondary"].record
    fmt, width, height, _faces, pixels = from_loaddef(image, image.captured("LoadImageData"))
    assert fmt == t6.R8G8B8A8_UNORM and height % 3 == 0
    page_height = height // 3
    rows = list(gfxworld.IW_VERTEX.iter_unpack(blob))
    indices = struct.unpack(f"<{len(index_bytes) // 2}H", index_bytes)
    sun = gfxworld.sun(mp_la)["angles"]
    pitch, yaw = math.radians(sun[0]), math.radians(sun[1])
    to_sun = (math.cos(pitch) * math.cos(yaw), math.cos(pitch) * math.sin(yaw), -math.sin(pitch))
    unit, total, towards, away = 0, 0, [], []
    for s in surfaces:
        if s["lightmapIndex"] != 0:
            continue
        for k in range(s["triCount"]):
            tri = [rows[indices[s["baseIndex"] + 3 * k + i] + s["firstVertex"]] for i in range(3)]
            u, v = sum(t[7] for t in tri) / 3, sum(t[8] for t in tri) / 3
            x, y = min(width - 1, int(u * width)), min(page_height - 1, int(v * page_height))
            r, g, b, a = t6.decode_page(pixels, width, page_height, 2, x, y)
            total += 1
            unit += abs(math.sqrt((2 * r - 1) ** 2 + (2 * g - 1) ** 2 + (2 * b - 1) ** 2) - 1) < 0.02
            n = [sum(vertices.unit_vec(t[9])[i] for t in tri) for i in range(3)]
            facing = sum(p * q for p, q in zip(n, to_sun, strict=True)) / (math.sqrt(sum(c * c for c in n)) or 1)
            (towards if facing > 0.2 else away if facing < -0.2 else []).append(a)
    assert total > 100_000 and unit / total > 0.99
    assert sum(away) / len(away) < 0.1 < 0.25 < sum(towards) / len(towards)
