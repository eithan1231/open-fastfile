"""The T5 fx dumper, on records packed with Black Ops' own struct layouts.

It pins what differs from IW5's writer (test_iw5_fx_sound.py): T5's own type
names, bytes the zone code calls signed read as unsigned, the trail hanging off
the elem, and the `u` union chosen by type.
"""

import os

import pytest

from scripts.cod.t5.dumpers import fx as fx_dumper
from scripts.cod.zonecode import program
from scripts.cod.zonecode.values import Asset

from .test_iw5_fx_sound import Heap, material, ref


@pytest.fixture(scope="module")
def t5():
    if not os.path.exists(program.path_for("t5")):
        pytest.skip("no T5 zonecode.json (reverse/x86-zone/build.sh t5)")
    return program.load("t5")


def elem(heap, elem_type, visuals, vel=1, **values):
    rec = heap.record("FxElemDef", elemType=elem_type, velIntervalCount=vel, visStateIntervalCount=1, **values)
    rec.set("visuals", visuals)
    for key in ("effectOnImpact", "effectOnDeath", "effectEmitted", "effectAttached"):
        rec.set(key, ref(heap, None))
    rec.set("trailDef", None)
    rec.set("spawnSound.spawnSound", None)
    rec.set("velSamples", heap.raw("FxElemVelStateSample", vel + 1, "<24f", [[float(i)] * 24 for i in range(vel + 1)]))
    return rec


def instance(heap, name):
    vis = heap.record("FxElemDefVisuals")
    inst = heap.record("FxElemVisuals")
    inst.set("material", material(name))
    vis.set("instance", inst)
    return vis


@pytest.fixture
def effect(t5):
    heap = Heap(t5)
    heap.game = "t5"
    enums = t5.data["enums"]
    # A rotated sprite: index 2, which is IW5's TAIL.
    rotated = elem(
        heap,
        enums["FX_ELEM_TYPE_SPRITE_ROTATED"],
        instance(heap, "gfx_smoke"),
        visualCount=1,
        spawn__looping__intervalMsec=50,
        spawn__looping__count=10,
        sortOrder=-56,  # 200, stored in a signed char
        lightingFrac=-1,  # 255
        u__billboard__topWidth=0.25,
        u__billboard__bottomWidth=1.0,
        atlas__entryCountAndIndexRange=0x1F10,
    )
    rotated.set("visSamples", heap.raw("FxElemVisStateSample", 2, "<4B5f4B5f", [(200, 2, 3, 255, 0.5, 1, 2, 3, 4) * 2] * 2))
    # A cloud reads `u` as its density range.
    cloud = elem(heap, enums["FX_ELEM_TYPE_CLOUD"], instance(heap, "gfx_cloud"), visualCount=1, u__cloudDensityRange__base=3)
    cloud.set("visSamples", heap.raw("FxElemVisStateSample", 2, "<4B5f4B5f", [(0,) * 18] * 2))
    fx = heap.record("FxEffectDef", elemDefCountLooping=1, elemDefCountOneShot=1, flags=-127)
    fx.set("elemDefs", heap.array("FxElemDef", [rotated, cloud]))
    return fx_dumper.Writer(heap).effect(Asset(42, "fx", "smoke/test", fx, 0))


def test_types_are_t5_s_own_names(t5, effect):
    names = fx_dumper.elem_type_names(t5.data["enums"])
    assert names[2] == "SPRITE_ROTATED" and names[4] == "LINE" and names[12] == "RUNNER"
    rotated, cloud = effect["elems"]
    assert (rotated["type"], rotated["typeIndex"]) == ("SPRITE_ROTATED", 2)
    assert cloud["type"] == "CLOUD"


def test_bytes_the_zone_code_calls_signed_are_read_unsigned(effect):
    rotated, _cloud = effect["elems"]
    assert rotated["sortOrder"] == 200 and rotated["lightingFrac"] == 255
    assert rotated["visSamples"][0]["base"]["color"] == [200, 2, 3, 255]
    assert effect["flags"] == 129


def test_the_u_union_is_chosen_by_type_and_the_atlas_is_written_raw(effect):
    rotated, cloud = effect["elems"]
    assert rotated["union"] == {"kind": "billboard", "topWidth": 0.25, "bottomWidth": 1.0}
    assert cloud["union"] == {"kind": "cloudDensityRange", "base": 3, "amplitude": 0}
    assert rotated["atlas"]["entryCountAndIndexRange"] == 0x1F10 and "entryCount" not in rotated["atlas"]
    assert rotated["extended"] is None and rotated["effectAttached"] is None
