"""The effect closure, the unit conversions, and the two conventions read from the data."""

import json
import os

import pytest

from scripts.cod import fx, worldfile
from scripts.cod.units import UNITS_PER_M


def rng(base, amplitude=0.0):
    return {"base": base, "amplitude": amplitude}


def elem(**over):
    """A minimal dumped elem; every field the converter touches, overridable."""
    zero3 = [rng(0.0), rng(0.0), rng(0.0)]
    vel = {
        "velocity": {"base": [0.0, 0.0, 0.0], "amplitude": [0.0, 0.0, 0.0]},
        "totalDelta": {"base": [0.0, 0.0, 0.0], "amplitude": [0.0, 0.0, 0.0]},
    }
    vis = {"color": [255, 255, 255, 255], "rotationDelta": 0.0, "rotationTotal": 0.0, "size": [0.0, 0.0], "scale": 1.0}
    out = {
        "index": 0,
        "type": "SPRITE_BILLBOARD",
        "spawnKind": "looping",
        "spawn": {"kind": "looping", "intervalMsec": 100, "count": 4},
        "spawnDelayMsec": rng(0),
        "lifeSpanMsec": rng(1000),
        "spawnOrigin": zero3,
        "spawnOffsetRadius": rng(0.0),
        "spawnOffsetHeight": rng(0.0),
        "spawnAngles": zero3,
        "angularVelocity": zero3,
        "initialRotation": rng(0.0),
        "gravity": rng(0.0),
        "atlas": {"behavior": 0, "index": 0, "fps": 0, "loopCount": 0, "colIndexBits": 0, "rowIndexBits": 0, "entryCount": 1},
        "sortOrder": 0,
        "visuals": {"kind": "material", "name": "gfx_a"},
        "velSamples": [{"local": vel, "world": vel}],
        "visSamples": [{"base": vis, "amplitude": vis}],
        "effectOnImpact": None,
        "effectOnDeath": None,
        "effectEmitted": None,
        "randomSeed": 7,
        "flags": 0,
        "spawnRange": rng(0.0),
        "fadeInRange": rng(0.0),
        "fadeOutRange": rng(0.0),
        "spawnFrustumCullRadius": 0.0,
        "lightingFrac": 0,
    }
    out.update(over)
    return out


def effect(name, elems=None, looping=1):
    elems = elems if elems is not None else [elem()]
    return {
        "_type": "fx",
        "_version": 1,
        "_game": "iw5",
        "name": name,
        "elemCounts": {"looping": looping, "oneShot": len(elems) - looping, "emission": 0, "total": len(elems)},
        "elems": elems,
    }


# -- the closure -----------------------------------------------------------------


def test_closure_follows_children_and_runners():
    defs = {
        "a": effect("a", [elem(effectOnDeath="b"), elem(type="RUNNER", visuals={"kind": "effect", "name": "c"})]),
        "b": effect("b"),
        "c": effect("c", [elem(effectEmitted="d")]),
        "d": effect("d"),
        "unused": effect("unused"),
    }
    names, missing = fx.closure(defs, {"a"})
    assert names == {"a", "b", "c", "d"}
    assert missing == set()


def test_closure_terminates_on_a_cycle():
    defs = {"a": effect("a", [elem(effectOnDeath="b")]), "b": effect("b", [elem(effectOnDeath="a")])}
    names, missing = fx.closure(defs, {"a"})
    assert names == {"a", "b"}


def test_closure_reports_a_child_it_cannot_find():
    """A child in a zone that was not dumped would otherwise play as an empty effect."""
    defs = {"a": effect("a", [elem(effectOnDeath="gone")])}
    names, missing = fx.closure(defs, {"a"})
    assert names == {"a"}
    assert missing == {"gone"}


def test_effect_names_match_case_insensitively():
    """12 maps call loadfx("smoke/battlefield_smokebank_S") for an asset stored as `..._s`.

    Every fx and visual name in MW3's zones is lower case; only the scripts are
    not. Matched exactly, each of those maps silently loses an effect -- it simply
    never plays, and nothing reports it.
    """
    assert fx.ref("smoke/battlefield_smokebank_S") == "smoke/battlefield_smokebank_s"
    defs = {"smoke/battlefield_smokebank_s": effect("smoke/battlefield_smokebank_s")}
    names, missing = fx.closure(defs, {"smoke/battlefield_smokebank_S"})
    assert names == {"smoke/battlefield_smokebank_s"} and missing == set()


def test_a_world_file_places_an_effect_the_script_miscapitalised(tmp_path):
    data = _meta(
        [{"create": "createOneshotEffect", "fxid": "bank", "at": [0.0, 0.0, 0.0]}],
        {"bank": "smoke/battlefield_smokebank_S"},
    )
    path, _, n_places, _, unknown = worldfile.write_fx_world(str(tmp_path), "mp_x", data, {"smoke/battlefield_smokebank_s"})
    assert n_places == 1 and not unknown
    assert '"smoke/battlefield_smokebank_s"' in open(path).read()


def test_a_companion_zone_marker_is_not_part_of_the_name():
    """A leading comma is linkage. Left on, every lookup misses and nothing draws."""
    assert fx.ref(",gfx_wind_hl_atlas") == "gfx_wind_hl_atlas"
    assert fx.ref("gfx_wind_hl_atlas") == "gfx_wind_hl_atlas"
    defs = {"a": effect("a", [elem(effectOnDeath=",b")]), "b": effect("b")}
    names, missing = fx.closure(defs, {",a"})
    assert names == {"a", "b"} and missing == set()


# -- the two conventions, as read off the dump ----------------------------------


def test_a_range_is_base_plus_signed_amplitude():
    """Not base=min/amplitude=span: spawnAngles ship base 2pi, amplitude -4pi.

    Read as min/span that interval is inside out, and a full-turn spread collapses.
    """
    converted = fx.convert(effect("a", [elem(initialRotation=rng(6.28, -12.56))]))
    assert converted["elems"][0]["initialRotation"] == pytest.approx([6.28, -12.56])


def test_negating_an_axis_flips_both_halves_of_a_range():
    """The CoD -> engine swap negates Y, and a signed amplitude has to come with it."""
    e = elem(spawnOrigin=[rng(0.0), rng(100.0, 50.0), rng(0.0)])
    origin = fx.convert(effect("a", [e]))["elems"][0]["spawnOrigin"]
    # CoD y becomes engine -z, base and amplitude alike.
    assert origin[2] == pytest.approx([-100.0 / UNITS_PER_M, -50.0 / UNITS_PER_M])


def test_velocity_stays_per_millisecond_in_metres():
    """Velocity and totalDelta are kept per millisecond, only converted to metres.

    totalDelta integrates velocity over *sample index*, so the runtime recovers
    travel by multiplying by one step's duration. Converting to per-second here
    would bake in a time scale the data does not have.
    """
    vel = {
        "velocity": {"base": [0.05, 0.0, 0.0], "amplitude": [0.0, 0.0, 0.0]},
        "totalDelta": {"base": [0.05, 0.0, 0.0], "amplitude": [0.0, 0.0, 0.0]},
    }
    e = elem(lifeSpanMsec=rng(10000), velSamples=[{"local": vel, "world": vel}])
    out = fx.convert(effect("a", [e]))["elems"][0]
    assert out["velSamples"][0]["local"]["velocity"]["base"][0] == pytest.approx(0.05 / UNITS_PER_M)
    assert out["velSamples"][0]["local"]["totalDelta"]["base"][0] == pytest.approx(0.05 / UNITS_PER_M)


def test_colour_is_stored_blue_green_red_alpha():
    """Read in stored order, blood is blue and dome's tan sandstorm is blue-grey."""
    vis = {"color": [139, 171, 201, 79], "rotationDelta": 0.0, "rotationTotal": 0.0, "size": [0.0, 0.0], "scale": 0.0}
    e = elem(visSamples=[{"base": vis, "amplitude": vis}])
    colour = fx.convert(effect("a", [e]))["elems"][0]["visSamples"][0]["base"]["color"]
    assert colour == pytest.approx([201 / 255, 171 / 255, 139 / 255, 79 / 255])


def test_distances_become_metres_and_angles_stay_in_game_order():
    """Angles build a Quake axis at run time, so they keep (pitch, yaw, roll) order."""
    e = elem(
        spawnRange=rng(0.0, 5000.0),
        fadeOutRange=rng(50.0, 50.0),
        spawnFrustumCullRadius=4000.0,
        gravity=rng(0.5, 0.25),
        spawnAngles=[rng(1.0), rng(2.0), rng(3.0)],
    )
    out = fx.convert(effect("a", [e]))["elems"][0]
    assert out["spawnRange"] == pytest.approx([0.0, 5000 / UNITS_PER_M])
    assert out["fadeOutRange"] == pytest.approx([50 / UNITS_PER_M, 50 / UNITS_PER_M])
    assert out["spawnFrustumCullRadius"] == pytest.approx(4000 / UNITS_PER_M)
    # A multiple of 800 units/s^2: left as authored for the runtime to scale.
    assert out["gravity"] == pytest.approx([0.5, 0.25])
    assert [r[0] for r in out["spawnAngles"]] == pytest.approx([1.0, 2.0, 3.0])


def test_flags_travel_with_the_elem():
    """The runtime needs them: which velocity frame applies, gravity, non-uniform size."""
    e = elem(flags=-(2**31) | 0x10000000)
    assert fx.convert(effect("a", [e]))["elems"][0]["flags"] == 0x90000000


def test_msec_becomes_seconds_and_colour_becomes_unit_range():
    out = fx.convert(effect("a", [elem(lifeSpanMsec=rng(3000, 500))]))["elems"][0]
    assert out["life"] == pytest.approx([3.0, 0.5])
    assert out["spawn"] == {"kind": "looping", "interval": pytest.approx(0.1), "count": 4}
    assert out["visSamples"][0]["base"]["color"] == pytest.approx([1.0, 1.0, 1.0, 1.0])


def test_a_looping_count_of_int_max_means_for_ever():
    e = elem(spawn={"kind": "looping", "intervalMsec": 600, "count": fx.SPAWN_FOREVER})
    assert fx.convert(effect("a", [e]))["elems"][0]["spawn"]["count"] is None


def test_a_one_shot_elem_keeps_its_count_range():
    """Read as looping instead, this elem spawns nothing at all and says nothing about it."""
    e = elem(spawnKind="oneShot", spawn={"kind": "oneShot", "count": rng(1, 2)})
    assert fx.convert(effect("a", [e], looping=0))["elems"][0]["spawn"] == {"kind": "oneShot", "count": [1, 2]}


# -- the world file --------------------------------------------------------------


def _meta(placements, aliases):
    return {"fx": {"effects": aliases, "placements": placements}}


def test_every_effect_named_in_the_world_file_was_exported(tmp_path):
    """The likeliest silent breakage: a name the engine cannot resolve just never plays."""
    data = _meta(
        [
            {"create": "createOneshotEffect", "fxid": "storm", "at": [1.0, 2.0, 3.0], "angles": [0, 90, 0]},
            {"create": "createOneshotEffect", "fxid": "absent", "at": [0.0, 0.0, 0.0]},
            {"create": "createLoopSound", "at": [0.0, 0.0, 0.0]},
        ],
        {"storm": "weather/storm", "absent": "smoke/absent"},
    )
    path, n_effects, n_places, skipped, unknown = worldfile.write_fx_world(str(tmp_path), "mp_x", data, {"weather/storm"})
    text = open(path).read()

    assert n_places == 1 and skipped == 1 and unknown == {"absent"}
    assert '"weather/storm"' in text
    assert "smoke/absent" not in text
    for line in text.splitlines():
        if line.startswith("effect "):
            assert '"weather/storm"' in line


def test_placements_of_one_effect_get_distinct_names(tmp_path):
    data = _meta([{"create": "createOneshotEffect", "fxid": "s", "at": [0.0, 0.0, 0.0]} for _ in range(3)], {"s": "w/s"})
    path, _, n_places, _, _ = worldfile.write_fx_world(str(tmp_path), "mp_x", data, {"w/s"})
    names = [line.split()[1] for line in open(path).read().splitlines() if line.startswith("effect ")]
    assert n_places == 3
    assert names == ["s_0", "s_1", "s_2"] and len(set(names)) == 3


def test_free_text_effect_ids_become_identifiers(tmp_path):
    """boardwalk and shipbreaker name effects "fire/fire_barrel_trash" and "Dripping blood"."""
    ids = ["fire/barrel", "Dripping blood", "2nd"]
    data = _meta([{"create": "createOneshotEffect", "fxid": i, "at": [0.0, 0.0, 0.0]} for i in ids], dict.fromkeys(ids, "w/s"))
    path, _, _, _, _ = worldfile.write_fx_world(str(tmp_path), "mp_x", data, {"w/s"})
    names = [line.split()[1] for line in open(path).read().splitlines() if line.startswith("effect ")]
    assert names == ["fire_barrel_0", "Dripping_blood_0", "_2nd_0"]


def test_a_map_that_places_nothing_leaves_no_stale_file(tmp_path):
    stale = tmp_path / "fx.world"
    stale.write_text('effect old { fx: "gone" }\n')
    path, _, _, _, _ = worldfile.write_fx_world(str(tmp_path), "mp_x", _meta([], {}), set())
    assert path is None
    assert not os.path.exists(stale)


def test_numbers_are_written_fixed_point(tmp_path):
    """The DSL tokenizer has no exponent rule, so 1e-05 is a parse error, not a small number."""
    data = _meta([{"create": "createOneshotEffect", "fxid": "s", "at": [0.000001, 2.0, 3.0]}], {"s": "w/s"})
    path, _, _, _, _ = worldfile.write_fx_world(str(tmp_path), "mp_x", data, {"w/s"})
    assert "e-" not in open(path).read()


def _material_dump(root, name, image, techset="effect_zfeather_blend"):
    """A material dump shaped like OAT's, enough for material_render_state to read."""
    root.mkdir(parents=True, exist_ok=True)
    (root / (name + ".json")).write_text(
        json.dumps(
            {
                "techniqueSet": techset,
                "sortKey": 48,
                "constants": [{"name": "featherParms", "literal": [0.0125, 80.0, 0.0, 0.0]}],
                "textures": [{"semantic": "colorMap", "image": image}],
                "stateBits": [],
            }
        )
    )


def test_effects_json_round_trips(tmp_path):
    src = tmp_path / "fx"
    (src / "weather").mkdir(parents=True)
    (src / "weather" / "storm.json").write_text(json.dumps(effect("weather/storm")))
    mats = tmp_path / "mat" / "materials"
    _material_dump(mats, "gfx_a", "sand_sheet")

    effects, missing, images, counts = fx.export_fx(str(src), {"weather/storm"}, str(tmp_path / "out"), str(mats))
    assert set(effects) == {"weather/storm"} and not missing
    assert images == {"gfx_a": "sand_sheet"}
    assert counts == {"SPRITE_BILLBOARD": 1}

    written = json.loads((tmp_path / "out" / "effects.json").read_text())
    assert written["_version"] == 5 and "weather/storm" in written["effects"]
    assert written["fadeQuantise"] == "floor" and "game" not in written
    entry = written["materials"]["gfx_a"]
    assert entry["texture"] == "sand_sheet.png"
    # With no drawn state in the dump, the factors default to a straight alpha
    # blend -- what every zfeather particle material in MW3 actually uses.
    assert (entry["blendSrc"], entry["blendDst"]) == ("srcalpha", "invsrcalpha")
    assert entry["featherDepth"] == pytest.approx(80 / UNITS_PER_M)
    assert entry["sortKey"] == 48 and entry["fog"] is True


def test_a_material_carries_how_the_game_blends_it(tmp_path):
    """Assuming "additive particle" is wrong for every one of dome's fx materials.

    They are all `alpha`; drawn additively they saturate to white blobs on a
    bright sky rather than hanging as haze, which reads as a lighting fault.
    """
    src = tmp_path / "fx"
    (src / "weather").mkdir(parents=True)
    (src / "weather" / "storm.json").write_text(json.dumps(effect("weather/storm")))
    mats = tmp_path / "mat" / "materials"
    _material_dump(mats, "gfx_a", "sheet", techset="effect_zfeather_blend_nofog")

    fx.export_fx(str(src), {"weather/storm"}, str(tmp_path / "out"), str(mats))
    entry = json.loads((tmp_path / "out" / "effects.json").read_text())["materials"]["gfx_a"]
    assert entry["blend"] == "alpha"
    # `nofog` opts a sheet out of the world's fog, for the ones meant to read at any distance.
    assert entry["fog"] is False


def test_rewriting_effects_reproduces_a_full_export(tmp_path):
    """`--effects-only` must write the same fx.world a full export did, or every run churns a committed file."""
    from scripts.cod import export

    src = tmp_path / "fx"
    (src / "weather").mkdir(parents=True)
    (src / "weather" / "storm.json").write_text(json.dumps(effect("weather/storm", [elem(), elem(type="TAIL")])))
    world = tmp_path / "world"
    (world / "assets").mkdir(parents=True)
    (world / "world.world").write_text('include "props.world"\n')
    meta = _meta(
        [{"create": "createOneshotEffect", "fxid": "s", "at": [1.0, 2.0, 3.0], "angles": [272, 270, 6]}], {"s": "weather/storm"}
    )
    (world / "export_metadata.json").write_text(json.dumps(meta))

    effects, _, _, counts = fx.export_fx(str(src), {"weather/storm"}, str(world / "assets" / "fx"))
    worldfile.write_fx_world(str(world), "mp_x", meta, set(effects), counts)
    full = (world / "fx.world").read_text()

    assert export.rewrite_effects("mp_x", str(world))
    assert (world / "fx.world").read_text() == full
    assert 'include "fx.world"' in (world / "world.world").read_text()


# -- Black Ops (T5) --------------------------------------------------------------------------------


def test_a_world_s_global_wind_comes_from_its_fx_script_dvars():
    data = {"scripts": {"maps/mp/mp_x_fx.gsc": {"dvars": {"enable_global_wind": 1, "wind_global_vector": "-110 -160 -140"}}}}
    assert fx.global_wind(data) == pytest.approx(239.4, abs=0.1)
    data["scripts"]["maps/mp/mp_x_fx.gsc"]["dvars"]["enable_global_wind"] = 0
    assert fx.global_wind(data) == 0.0
    assert fx.global_wind({}) == 0.0


def test_wind_moves_life_and_spawn_interval_toward_their_max_wind_values():
    windy = elem(lifeSpanMsec=rng(1000, 200), maxWindStrength=400, lifespanAtMaxWind=3000, spawnIntervalAtMaxWind=500)
    out = fx._convert_elem(windy, wind=200)  # half the strongest wind
    assert out["life"] == pytest.approx([2.0, 0.1])  # lerp(1000 + 200r, 3000, 0.5), in seconds
    assert out["spawn"]["interval"] == pytest.approx(0.3)
    # No max strength, or no wind: untouched.
    assert fx._convert_elem(elem(maxWindStrength=0, lifespanAtMaxWind=3000), wind=200)["life"] == [1.0, 0.0]
    assert fx._convert_elem(windy)["life"] == pytest.approx([1.0, 0.2])


def test_a_t5_atlas_unpacks_its_cell_count_and_index_range():
    t5 = {"behavior": 3, "index": 4, "fps": 0, "loopCount": 0, "colIndexBits": 2, "rowIndexBits": 2}
    out = fx._convert_elem(elem(atlas={**t5, "entryCountAndIndexRange": (3 << 9) | 16}))["atlas"]
    assert out["entryCount"] == 16 and out["indexRange"] == 3 and "entryCountAndIndexRange" not in out


def test_t5_conventions_are_written_as_engine_properties():
    atlas = {"behavior": 3, "index": 0, "fps": 0, "loopCount": 0, "colIndexBits": 0, "rowIndexBits": 0, "entryCount": 4}
    effects = {
        "e": {
            "elems": [
                {"type": "SPRITE_BILLBOARD", "flags": 0x180000, "atlas": dict(atlas)},
                {"type": "TAIL", "flags": 0, "atlas": {**atlas, "behavior": 0}},
            ]
        }
    }
    assert fx.conventions(effects, "iw5") == "floor"
    assert "facing" not in effects["e"]["elems"][0] and "ranged" not in effects["e"]["elems"][0]["atlas"]

    assert fx.conventions(effects, "t5") == "round"
    sprite, tail = effects["e"]["elems"]
    assert sprite["facing"] == "viewpoint-up" and sprite["atlas"]["ranged"] is True and "rolls" not in sprite
    assert tail["rolls"] is True and "facing" not in tail and "ranged" not in tail["atlas"]


def test_trim_and_pivot_are_written_only_where_they_change_the_quad():
    def shape(union, flags=0, pivot=(0.0, 0.0)):
        out = fx._convert_elem(elem(union=union, flags=flags, billboardPivot=list(pivot)))
        return {k: out[k] for k in ("trim", "pivot") if k in out}

    full = {"kind": "billboard", "topWidth": 1.0, "bottomWidth": 1.0}
    assert shape(full) == {}
    assert shape({"kind": "billboard", "topWidth": 0.29, "bottomWidth": 1.7}) == {"trim": [0.29, 1.0]}  # clamped
    assert shape(full, pivot=(0.0, -1.0)) == {}  # a pivot without its flag
    assert shape(full, flags=0x200000, pivot=(0.0, -1.0)) == {"pivot": [0.0, -1.0]}
    assert shape({"kind": "cloudDensityRange", "base": 3, "amplitude": 0}) == {}


def test_a_t5_technique_set_says_what_its_shader_writes():
    feather = {"featherParms": [0.2, 5.0, 0, 0]}
    assert fx._shader("effect_zfeather", feather) == {"output": "straight", "fogFade": False}
    assert fx._shader("effect_add_nofog", {}) == {"output": "alpha", "fogFade": True}
    assert fx._shader("effect_zfeather_add_nofog", feather) == {"output": "luma", "fogFade": True}
    falloff = fx._shader(
        "effect_zfeather_falloff_eyeoffset",
        {
            "falloffParms": [0, 0, 4.5, -0.1],
            "falloffBeginColor": [1, 1, 1, 1],
            "falloffEndColor": [0.5] * 4,
            "eyeOffsetParms": [10, 0, 0, 0],
        },
    )
    assert falloff["falloff"] == {"scale": 4.5, "bias": -0.1, "begin": [1, 1, 1, 1], "end": [0.5] * 4}
    assert falloff["eyeOffset"] == pytest.approx(10 / UNITS_PER_M)
    assert fx._shader("distortion_scale_zfeather", feather) == {"undrawn": "distortion"}


def test_a_loop_effect_repeats_after_its_own_delay(tmp_path):
    """Black Ops' loopfx: `delay` is when the first instance starts and how long each waits for the next."""
    data = _meta(
        [
            {"create": "createLoopEffect", "fxid": "snow", "at": [1.0, 2.0, 3.0], "delay": 1.5},
            {"create": "createLoopEffect", "fxid": "snow", "at": [0.0, 0.0, 0.0], "delay": 0},
        ],
        {"snow": "weather/snow"},
    )
    path, _, n_places, skipped, _ = worldfile.write_fx_world(str(tmp_path), "mp_x", data, {"weather/snow"})
    lines = [line for line in open(path).read().splitlines() if line.startswith("effect ")]
    assert n_places == 2 and skipped == 0
    assert "delay: 1.500" in lines[0] and "repeat: 1.500" in lines[0]
    assert "repeat" not in lines[1]  # no wait: it plays once and is never polled again


def test_a_cloud_carries_its_density_and_its_material_has_no_fog():
    out = fx._convert_elem(elem(type="CLOUD", union={"kind": "cloudDensityRange", "base": 1024, "amplitude": 0}))
    assert out["cloudDensity"] == [1024, 0] and "trim" not in out
    assert fx._shader("particle_cloud_outdoor", {}) == {"output": "straight", "fogFade": False, "fog": False}
    assert fx._shader("particle_cloud_add", {})["output"] == "alpha"
