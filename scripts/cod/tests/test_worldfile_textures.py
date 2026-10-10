import json
import struct
import zipfile

import pytest
from PIL import Image

from scripts.cod.materials import material_images
from scripts.cod.textures import convert_textures, decode_iwi, export_loadscreen, export_minimap
from scripts.cod.worldfile import Overrides, _hex, parse_vision, world_category


def test_hex_reads_both_colour_scales():
    assert _hex([1, 0.5, 0]) == "#ff8000"
    assert _hex([255, 128, 0]) == "#ff8000"


def test_world_category():
    assert world_category("mp_dome", "MW3") == "MW3 Multiplayer"
    assert world_category("so_deltacamp", "MW3") == "MW3 Special Ops"
    assert world_category("zombie_theater", "BO") == "BO Zombies"
    assert world_category("nacht_der_untoten", "BO") == "BO Zombies"
    assert world_category("zm_transit", "BO2") == "BO2 Zombies"
    assert world_category("cuba", "BO") == "BO Campaign"


def test_parse_vision(tmp_path):
    path = tmp_path / "mp_x.vision"
    path.write_text(
        'r_filmEnable "1"\nr_filmLightTint "1.1 1 0.9"\nr_filmMediumTint "1 1 1"\n'
        'r_filmDarkTint "0.9 1 1.1"\nr_filmDesaturation "0.2"\n'
    )
    assert parse_vision(str(path)) == {
        "light-tint": "1.1 1.0 0.9",
        "medium-tint": "1.0 1.0 1.0",
        "dark-tint": "0.9 1.0 1.1",
        "desaturation": 0.2,
        "desaturation-dark": 0.0,
    }
    path.write_text('r_filmEnable "0"\n')
    assert parse_vision(str(path)) == {}
    assert parse_vision(None) == {}


def test_parse_vision_reads_black_ops_names(tmp_path):
    """T5 says `Mid` for `Medium` and keeps a saturation per zone; it used to read as no grade at all."""
    path = tmp_path / "zombie_x.vision"
    path.write_text(
        'r_filmEnable "1"\nr_filmLightTint "1 1 1"\nr_filmMidTint "1.01 1.01 1.03"\n'
        'r_filmDarkTint "0.88 0.95 1.01"\nr_filmSaturation "0.6737 0.7509 0.6105"\n'
    )
    props = parse_vision(str(path))
    assert props["medium-tint"] == "1.01 1.01 1.03"
    assert props["desaturation"] == pytest.approx(0.3895)
    assert props["desaturation-dark"] == pytest.approx(0.3263)


def test_overrides_apply_and_note_what_they_replaced(tmp_path):
    (tmp_path / "_overrides.json").write_text(json.dumps({"world": {"sky": "#123456"}, "append": ["light x { type: ambient }"]}))
    o = Overrides(str(tmp_path))
    assert o.render("world", {"sky": "#ffffff", "visibility": 600}) == [
        "  // _overrides.json: world.sky was #ffffff",
        "  sky: #123456",
        "  visibility: 600",
    ]
    assert o.appended()[-1] == "light x { type: ambient }"


@pytest.mark.parametrize("bad", [{"wrold": {}}, {"world": {"skye": 1}}, {"append": "not a list"}])
def test_overrides_reject_typos(tmp_path, bad):
    (tmp_path / "_overrides.json").write_text(json.dumps(bad))
    with pytest.raises(SystemExit):
        Overrides(str(tmp_path))


def iwi(version, fmt, w, h, payload):
    header = b"IWi" + bytes([version])
    if version == 8:
        header += struct.pack("<I", 0)  # only v8 has the flags dword
    header += bytes([fmt, 0]) + struct.pack("<HHH", w, h, 1) + b"\0" * 16
    return header + payload


@pytest.mark.parametrize("version", [6, 8, 13])
def test_decode_iwi_finds_the_format_byte_in_every_version(tmp_path, version):
    path = tmp_path / "t.iwi"
    path.write_bytes(iwi(version, 2, 1, 1, bytes([10, 20, 30])))  # RGB24, one pixel
    img, fmt, w, h = decode_iwi(str(path))
    assert (fmt, w, h) == ("RGB24", 1, 1)
    assert img.getpixel((0, 0)) == (10, 20, 30)


def test_decode_iwi_swaps_argb32_to_rgba(tmp_path):
    path = tmp_path / "t.iwi"
    path.write_bytes(iwi(8, 1, 1, 1, bytes([30, 20, 10, 255])))  # stored B, G, R, A
    img, *_ = decode_iwi(str(path))
    assert img.getpixel((0, 0)) == (10, 20, 30, 255)


def test_the_minimap_comes_from_the_image_dump_when_no_archive_has_it(tmp_path):
    """Ghosts ships no .iwd: its compass picture is an ordinary zone image.

    And a run that cannot reach the picture at all keeps the one a previous
    export wrote: deleting it would take the world's HUD map with it
    (worldfile.write_minimap_world removes minimap.world without an image).
    """
    dump, assets, empty = tmp_path / "img" / "images", tmp_path / "assets", tmp_path / "nothing"
    dump.mkdir(parents=True), assets.mkdir(), empty.mkdir()
    (dump / "compass_map_mp_x.iwi").write_bytes(iwi(8, 4, 2, 2, bytes([1, 2, 3, 4])))  # A8, 2x2

    path, source, size = export_minimap(str(empty), "mp_x", str(assets), str(tmp_path / "img"))
    assert (path, source, size) == (str(assets / "minimap.png"), "compass_map_mp_x.iwi", (2, 2))

    kept = export_minimap(str(empty), "mp_x", str(assets), str(empty))
    assert kept == (path, "minimap.png (kept)", (2, 2))

    (assets / "minimap.png").unlink()
    assert export_minimap(str(empty), "mp_x", str(assets), str(empty)) == (None, None, None)


def test_the_minimap_is_the_image_the_compass_material_names(tmp_path):
    """BO2's mp_nuketown_2020 draws `compass_map_mp_nuketown2020`: looking for the
    zone's name alone found nothing and exported the world with no HUD map."""
    dump, assets, empty = tmp_path / "img" / "images", tmp_path / "assets", tmp_path / "nothing"
    mats = tmp_path / "mat" / "materials"
    dump.mkdir(parents=True), assets.mkdir(), empty.mkdir(), mats.mkdir(parents=True)
    (dump / "compass_map_mp_x2.iwi").write_bytes(iwi(8, 4, 2, 2, bytes([1, 2, 3, 4])))
    (mats / "compass_map_mp_x_2.json").write_text(
        json.dumps({"textures": [{"name": "colorMap", "semantic": "2D", "image": "compass_map_mp_x2"}]})
    )
    assert export_minimap(str(empty), "mp_x_2", str(assets), str(tmp_path / "img")) == (None, None, None)

    aliases = material_images(str(mats), "compass_map_mp_x_2")
    assert aliases == ("compass_map_mp_x2",)
    assert material_images(str(mats), "compass_map_mp_y") == ()
    path, source, size = export_minimap(str(empty), "mp_x_2", str(assets), str(tmp_path / "img"), aliases)
    assert (source, size) == ("compass_map_mp_x2.iwi", (2, 2))


def test_an_aw_loading_screen_is_the_one_its_load_zone_holds(tmp_path):
    """AW names the picture after the map's short name: `mp_lab2_load.ff` holds
    `s1_loadscreen_mp_lab`, beside eight `img_load_*` HUD pieces. The zone is the
    map's own, so its one loading screen is the map's; two would be a guess."""
    dump, assets, empty = tmp_path / "load" / "images", tmp_path / "assets", tmp_path / "nothing"
    dump.mkdir(parents=True), assets.mkdir(), empty.mkdir()
    Image.new("RGB", (16, 9), (200, 10, 10)).save(dump / "s1_loadscreen_mp_lab.dds")
    Image.new("RGB", (4, 4)).save(dump / "img_load_map_bg.dds")

    path, source = export_loadscreen(str(empty), "mp_lab2", str(assets), str(tmp_path / "load"))
    assert (path, source) == (str(assets / "loadscreen.jpg"), "s1_loadscreen_mp_lab.dds")
    assert Image.open(path).size == (16, 9)

    Image.new("RGB", (16, 9)).save(dump / "s1_loadscreen_mp_other.dds")
    assert export_loadscreen(str(empty), "mp_lab2", str(assets), str(tmp_path / "load")) == (None, None)
    # The exact name still wins when there are several.
    Image.new("RGB", (16, 9)).save(dump / "loadscreen_mp_lab2.dds")
    assert export_loadscreen(str(empty), "mp_lab2", str(assets), str(tmp_path / "load"))[1] == "loadscreen_mp_lab2.dds"


def test_an_image_the_dump_lacks_is_read_from_the_iwd_search_path(tmp_path):
    """A zone can name an image by reference only (BO1's fxt_smk_puff); its pixels are in an .iwd."""
    dump, iwds, out = tmp_path / "img", tmp_path / "main", tmp_path / "out"
    dump.mkdir(), iwds.mkdir()
    with zipfile.ZipFile(iwds / "iw_04.iwd", "w") as z:
        z.writestr("images/fxt_puff.iwi", iwi(8, 1, 1, 1, bytes([30, 20, 10, 128])))

    assert convert_textures(str(dump), {"fxt_puff", "gone"}, str(out))[1] == ["fxt_puff", "gone"]
    ok, missing, failed = convert_textures(str(dump), {"fxt_puff", "gone"}, str(out), search=str(iwds))
    assert (ok, missing, failed) == (1, ["gone"], 0)
    assert Image.open(out / "fxt_puff.png").getpixel((0, 0)) == (10, 20, 30, 128)
