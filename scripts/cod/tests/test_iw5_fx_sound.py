"""The IW5 fx, sound and loadedsound dumpers.

The synthetic tests build real `Record`s over packed bytes with IW5's own struct
layouts, and pin the three places a misread yields a plausible wrong effect or
sound: an elem type written as a name, the spawn union chosen by position, sample
arrays that exist only where their pointer does; and which half of a SoundFile is
live. The real zones are dumped and compared with A0's golden OAT dump where both
are installed ($COD_GOLDEN, default .cache/cod/golden).
"""

import io
import os
import struct
import wave

import pytest

from scripts.cod import equiv
from scripts.cod import sound as sound_stage
from scripts.cod.iw5.dumpers import DUMPERS
from scripts.cod.iw5.dumpers import fx as fx_dumper
from scripts.cod.iw5.dumpers import sound as sound_dumper
from scripts.cod.zonecode import program
from scripts.cod.zonecode.values import Array, Asset, Record

from .test_iw5_assets import GOLDEN, golden_subset, zone_or_skip


@pytest.fixture(scope="module")
def iw5():
    if not os.path.exists(program.path_for("iw5")):
        pytest.skip("no IW5 zonecode.json (reverse/x86-zone/build.sh iw5)")
    return program.load("iw5")


class Heap:
    """A zone's bytes, grown one struct at a time, and what a walk hands a writer over them."""

    def __init__(self, prog):
        self.program, self.data, self.game = prog, bytearray(), "iw5"

    def record(self, struct_name, **values):
        """A zeroed struct with `values` ({member path: number or tuple}) packed at their offsets."""
        info = self.program.struct(struct_name)
        at = len(self.data)
        self.data += bytes(info.size)
        rec = Record(self, info, at, 3, at)
        for path, value in values.items():
            offset, member, mods, _ = info.locate(path.replace("__", "."))
            scalar = member.get("element") if mods else member["scalar"]
            code = ("f" if scalar["size"] == 4 else "d") if scalar["float"] else "BHIQ"[scalar["size"].bit_length() - 1]
            if not scalar["float"] and scalar["signed"]:
                code = code.lower()
            value = value if isinstance(value, tuple) else (value,)
            struct.pack_into(f"<{len(value)}{code}", self.data, at + offset, *value)
        return rec

    def array(self, struct_name, records):
        info = self.program.struct(struct_name)
        at = records[0].at if records else len(self.data)
        return Array(self, struct_name, info.size, at, 3, at, len(records), items=list(records), info=info)

    def raw(self, struct_name, count, fmt, values):
        """`count` elements of a struct with no pointers, packed from `values` with `fmt` each."""
        info = self.program.struct(struct_name)
        at = len(self.data)
        for v in values:
            self.data += struct.pack(fmt, *v)
        return Array(self, struct_name, info.size, at, 3, at, count, info=info)


def ref(heap, name):
    rec = heap.record("FxEffectDefRef")
    rec.set("name", name)
    return rec


def elem(heap, elem_type, visuals, vel=1, vis=1, **values):
    rec = heap.record("FxElemDef", elemType=elem_type, velIntervalCount=vel, visStateIntervalCount=vis, **values)
    rec.set("visuals", visuals)
    for key in ("effectOnImpact", "effectOnDeath", "effectEmitted"):
        rec.set(key, ref(heap, None))
    rec.set("extended", heap.record("FxElemExtendedDefPtr"))
    rec.set("velSamples", heap.raw("FxElemVelStateSample", vel + 1, "<24f", [[float(i)] * 24 for i in range(vel + 1)]))
    return rec


def material(name):
    return Asset(4, "material", name, None, 0)


@pytest.fixture
def effect(iw5):
    heap = Heap(iw5)
    enums = iw5.data["enums"]
    # Looping: a billboard sprite.
    sprite_vis = heap.record("FxElemDefVisuals")
    instance = heap.record("FxElemVisuals")
    instance.set("material", material(",gfx_smoke"))
    sprite_vis.set("instance", instance)
    sprite = elem(
        heap,
        enums["FX_ELEM_TYPE_SPRITE_BILLBOARD"],
        sprite_vis,
        visualCount=1,
        spawn__looping__intervalMsec=50,
        spawn__looping__count=10,
    )
    sprite.set("visSamples", heap.raw("FxElemVisStateSample", 2, "<4B5f4B5f", [(1, 2, 3, 4, 0.5, 1, 2, 3, 4) * 2] * 2))
    # OneShot: a cloud, whose index 4 is T5's LINE.
    cloud_vis = heap.record("FxElemDefVisuals")
    cloud_inst = heap.record("FxElemVisuals")
    cloud_inst.set("material", material("gfx_cloud"))
    cloud_vis.set("instance", cloud_inst)
    cloud = elem(
        heap,
        enums["FX_ELEM_TYPE_CLOUD"],
        cloud_vis,
        visualCount=1,
        spawn__oneShot__count__base=3,
        spawn__oneShot__count__amplitude=2,
    )
    cloud.set("visSamples", heap.raw("FxElemVisStateSample", 2, "<4B5f4B5f", [(0,) * 18] * 2))
    # Emission: a runner, which carries no visSamples, with two effects to pick between.
    runner_vis = heap.record("FxElemDefVisuals")
    entries = [heap.record("FxElemVisuals"), heap.record("FxElemVisuals")]
    for rec, name in zip(entries, ("fire/a", "fire/b"), strict=True):
        rec.set("effectDef", ref(heap, name))
    runner_vis.set("array", heap.array("FxElemVisuals", entries))
    runner = elem(heap, enums["FX_ELEM_TYPE_RUNNER"], runner_vis, vel=2, visualCount=2, spawn__oneShot__count__base=1)
    runner.set("visSamples", None)
    runner.set("effectOnDeath", ref(heap, "fire/death"))
    # And a decal, reading its mark pairs.
    decal_vis = heap.record("FxElemDefVisuals")
    mark = heap.record("FxElemMarkVisuals")
    mark.set("materials", [material(",mark_a"), None])
    decal_vis.set("markArray", [mark])
    decal = elem(heap, enums["FX_ELEM_TYPE_DECAL"], decal_vis, visualCount=1)
    decal.set("visSamples", None)

    fx = heap.record("FxEffectDef", elemDefCountLooping=1, elemDefCountOneShot=1, elemDefCountEmission=2, flags=3)
    fx.set("elemDefs", heap.array("FxElemDef", [sprite, cloud, runner, decal]))
    return fx_dumper.Writer(heap).effect(Asset(42, "fx", "fire/test", fx, 0))


def test_elem_types_are_iw5_s_names_from_the_load_program(iw5):
    names = fx_dumper.elem_type_names(iw5.data["enums"])
    assert names[4] == "CLOUD" and names[12] == "RUNNER" and len(names) == 13
    with pytest.raises(SystemExit, match="not 0.."):
        fx_dumper.elem_type_names({"FX_ELEM_TYPE_A": 0, "FX_ELEM_TYPE_C": 2, "FX_ELEM_TYPE_COUNT": 3})


def test_an_elem_s_spawn_union_is_chosen_by_its_position(effect):
    sprite, cloud, runner, decal = effect["elems"]
    assert [e["spawnKind"] for e in effect["elems"]] == ["looping", "oneShot", "emission", "emission"]
    assert sprite["spawn"] == {"kind": "looping", "intervalMsec": 50, "count": 10}
    assert cloud["spawn"] == {"kind": "oneShot", "count": {"base": 3, "amplitude": 2}}
    assert effect["elemCounts"] == {"looping": 1, "oneShot": 1, "emission": 2, "total": 4}


def test_types_are_written_as_names_and_visuals_by_the_member_the_type_selects(effect):
    sprite, cloud, runner, decal = effect["elems"]
    assert (cloud["type"], cloud["typeIndex"]) == ("CLOUD", 4)
    assert sprite["visuals"] == {"kind": "material", "name": ",gfx_smoke"}  # a stub keeps its comma
    assert runner["visuals"] == {
        "kind": "array",
        "entries": [{"kind": "effect", "name": "fire/a"}, {"kind": "effect", "name": "fire/b"}],
    }
    assert runner["effectOnDeath"] == "fire/death" and runner["effectOnImpact"] is None
    assert decal["visuals"] == {"kind": "markArray", "marks": [{"materials": [",mark_a", None]}]}


def test_sample_arrays_are_one_longer_than_their_intervals_where_the_pointer_exists(effect):
    sprite, cloud, runner, decal = effect["elems"]
    assert len(sprite["velSamples"]) == 2 and len(runner["velSamples"]) == 3
    assert len(sprite["visSamples"]) == 2 and runner["visSamples"] == []
    assert sprite["visSamples"][0]["base"] == {
        "color": [1, 2, 3, 4],
        "rotationDelta": 0.5,
        "rotationTotal": 1.0,
        "size": [2.0, 3.0],
        "scale": 4.0,
    }
    assert runner["velSamples"][2]["world"]["totalDelta"] == {"base": [2.0] * 3, "amplitude": [2.0] * 3}


# -- Sound -----------------------------------------------------------------------------------------


@pytest.fixture
def aliases(iw5):
    heap = Heap(iw5)
    enums = iw5.data["enums"]
    loaded = heap.record("SoundFile", type=enums["SAT_LOADED"], exists=1)
    ref_ = heap.record("SoundFileRef")
    ref_.set("loadSnd", Asset(17, "loadedsound", ",null.wav", None, 0))
    loaded.set("u", ref_)
    streamed = heap.record("SoundFile", type=enums["SAT_STREAMED"], exists=1)
    ref_ = heap.record("SoundFileRef")
    pair = heap.record("StreamedSound")
    pair.set("dir", "explosions")
    pair.set("name", "boom.wav")
    ref_.set("streamSnd", pair)
    streamed.set("u", ref_)
    speakers = (1, *(0, 1, 0.5, 0.0) * 6) * 4
    speaker_map = heap.record("SpeakerMap", isDefault=1)
    struct.pack_into("<" + ("i" + "iiff" * 6) * 4, heap.data, speaker_map.at + 8, *speakers)
    speaker_map.set("name", "")
    curve = Asset(18, "soundcurve", ",weapon2", heap.record("SndCurve"), 0)
    curve.record.set("filename", ",weapon2")
    entries = []
    for i, sf in enumerate((loaded, streamed)):
        rec = heap.record("snd_alias_t", sequence=i, distMin=7.0, distMax=8000.0, flags=0x280 | i, masterPriority=50)
        rec.set("aliasName", "boom")
        rec.set("soundFile", sf)
        rec.set("volumeFalloffCurve", curve)
        rec.set("speakerMap", speaker_map)
        entries.append(rec)
    head = heap.record("snd_alias_list_t", count=2)
    head.set("aliasName", "boom")
    head.set("head", heap.array("snd_alias_t", entries))
    return sound_dumper.alias_list(Asset(2, "sound", "boom", head, 0), sound_dumper.sat_names(enums))


def test_a_sound_file_s_union_is_decided_by_its_type(aliases):
    loaded, streamed = (e["soundFile"] for e in aliases["entries"])
    assert loaded == {"type": 1, "typeName": "SAT_LOADED", "exists": 1, "loaded": {"name": ",null.wav"}, "streamed": None}
    assert streamed["loaded"] is None and streamed["streamed"] == {"dir": "explosions", "name": "boom.wav"}
    assert [sound_stage.clip_file(e) for e in aliases["entries"]] == [
        ("SAT_LOADED", "null", "null.wav"),
        ("SAT_STREAMED", "explosions/boom", "sound/explosions/boom.wav"),
    ]


def test_an_alias_is_game_units_and_raw_flags(aliases):
    first = aliases["entries"][0]
    assert (first["distMin"], first["distMax"], first["flags"], first["masterPriority"]) == (7.0, 8000.0, 0x280, 50)
    assert first["volumeFalloffCurve"] == ",weapon2" and first["mixerGroup"] is None
    assert first["speakerMap"]["isDefault"] is True
    assert first["speakerMap"]["channelMaps"][0][0]["speakers"][0] == {"speaker": 0, "numLevels": 1, "levels": [0.5, 0.0]}


def test_a_loaded_sound_is_a_pcm_wav_whose_riff_size_is_its_own():
    pcm = struct.pack("<5h", 0, 100, -100, 5, 7)
    data = sound_dumper.wav(1, 22050, 16, pcm)
    assert struct.unpack_from("<I", data, 4)[0] == len(data) - 8 and len(data) % 2 == 0
    with wave.open(io.BytesIO(data)) as w:
        assert (w.getnchannels(), w.getframerate(), w.getsampwidth()) == (1, 22050, 2)
        assert w.readframes(w.getnframes()) == pcm
    oat = data[:4] + struct.pack("<I", 36) + data[8:]  # OAT's WavWriter: a constant RIFF size
    assert equiv.compare_riff(oat, data) is None


# -- The real zones -------------------------------------------------------------------------------


KINDS = (("fx", "fx"), ("sound", "snd"), ("loadedsound", "snd"))


@pytest.fixture(scope="module")
def dumps(tmp_path_factory):
    from scripts.cod.iw5.backend import Backend

    dome = zone_or_skip("mp_dome")
    out = tmp_path_factory.mktemp("iw5-fx-sound")
    backend = Backend()
    for kind, sub in KINDS:
        backend.dump(dome, str(out / sub), kind)
    return out


def test_every_kind_is_registered():
    assert {kind for kind, _ in KINDS} <= set(DUMPERS)


@pytest.mark.parametrize("sub", ["fx", "snd"])
def test_the_dome_loses_nothing_the_golden_dump_holds(dumps, sub, tmp_path):
    golden = os.path.join(GOLDEN, "work", "dome-mw3", sub)
    if not os.path.isdir(golden):
        pytest.skip(f"no golden dump at {golden}")
    report = equiv.compare_trees(golden_subset(golden, str(dumps / sub), str(tmp_path / "golden")), str(dumps / sub))
    assert not report.failed, report.files
    assert report.compared > 50 and report.count(equiv.EXTRA) == 0
