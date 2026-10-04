"""Black Ops II's sound: the bank files (t6/sab.py), the alias dump (t6/dumpers/sound.py) and its reading (sound.py).

Built here, bar two tests that read the installed game when it is there (its `sound`
folder, wherever cod.config.json, $COD_BO2_DIR or Steam puts it): every bank file's
layout, and one entry of each kind hashed, decoded and measured.
"""

import hashlib
import json
import os
import struct
import subprocess

import pytest

from scripts.cod import sound
from scripts.cod.t6 import sab
from scripts.cod.t6.dumpers import sound as t6_sound
from scripts.cod.units import UNITS_PER_M

from .installed import game_path

BO2_SOUND = game_path("bo2", "sound")
installed = pytest.mark.skipif(
    not os.path.exists(os.path.join(BO2_SOUND, "mpl_la.all.sabl")), reason="Black Ops II is not installed"
)


# -- The hash --------------------------------------------------------------------------------------


def test_the_hash_is_the_one_the_zones_store():
    """Values read from mp_la's zone: a list's `id` and an entry's `assetId`."""
    assert sab.snd_hash("amb_ad_travel") == 972208552
    assert sab.snd_hash("raw\\sound\\amb\\advertisements\\tiny_travel_ad.SL55.pc.snd") == 4043183584


def test_the_hash_ignores_case_and_keeps_zero_for_nothing():
    assert sab.snd_hash("AMB_Ad_Travel") == sab.snd_hash("amb_ad_travel")
    assert sab.snd_hash("") == 0
    assert sab.snd_hash(None) == 0


# -- A bank file -----------------------------------------------------------------------------------


def flac_blob(rate, channels, frames, bits=16):
    """A FLAC stream's first 42 bytes: the marker and a last-block STREAMINFO, then a few bytes of 'frames'."""
    packed = (rate << 44) | ((channels - 1) << 41) | ((bits - 1) << 36) | frames
    info = struct.pack(">HH", 4096, 4096) + b"\0" * 6 + packed.to_bytes(8, "big") + b"\0" * 16
    return b"fLaC" + bytes([0x80]) + len(info).to_bytes(3, "big") + info + b"\xff\xf8frames"


def build_bank(path, entries, gap=0, extra=0, bad_checksum=False):
    """A bank file laid out as the game's are: audio from 0x800, then the two tables, each padded to 2048."""
    data, rows, cursor = b"", [], sab.DATA_START
    for asset_id, blob, frames, channels, looping, fmt in entries:
        rows.append((asset_id, len(blob), cursor, frames, 6, channels, looping, fmt))
        data += blob
        cursor += len(blob) + gap
        data += b"\0" * gap
    entry_offset = sab._align(cursor)
    checksum_offset = entry_offset + sab._align(len(rows) * sab.ENTRY.size)
    size = checksum_offset + sab._align(len(rows) * 16) + extra
    sums = [hashlib.md5(e[1]).digest() for e in entries]
    if bad_checksum:
        sums[0] = b"\0" * 16
    head = sab.HEADER.pack(sab.MAGIC, 14, 20, 16, 64, len(rows), 8, 0, size, entry_offset, checksum_offset, b"c" * 16)
    head += b"x.all.sabl".ljust(64, b"\0") + b"\0" * (64 * 7)
    out = bytearray(size)
    out[: len(head)] = head
    out[sab.DATA_START : sab.DATA_START + len(data)] = data
    for i, row in enumerate(rows):
        sab.ENTRY.pack_into(out, entry_offset + i * sab.ENTRY.size, *row)
        out[checksum_offset + i * 16 : checksum_offset + (i + 1) * 16] = sums[i]
    path.write_bytes(bytes(out))
    return str(path)


PCM = struct.pack("<4h", 0, 100, -100, 0)  # four mono frames
ENTRIES = [(0x11, PCM, 4, 1, 1, sab.PCMS16), (0x22, flac_blob(48000, 2, 1234), 1234, 2, 0, sab.FLAC)]


def test_a_bank_reads_its_entries_and_dependencies(tmp_path):
    bank = sab.Bank(build_bank(tmp_path / "x.all.sabl", ENTRIES))
    assert [e.id for e in bank.entries] == [0x11, 0x22]
    assert bank.dependencies == ["x.all.sabl"]
    ext, blob = bank.clip(bank.entries[0])
    assert ext == ".wav" and blob[:4] == b"RIFF" and blob.endswith(PCM)
    assert struct.unpack_from("<I", blob, 24)[0] == 48000  # the rate index is 6
    ext, blob = bank.clip(bank.entries[1])
    assert ext == ".flac" and blob == ENTRIES[1][1]


@pytest.mark.parametrize(
    "layout, why",
    [({"gap": 2}, "expected"), ({"extra": 2048}, "after the checksum table"), ({"bad_checksum": True}, "checksum")],
)
def test_a_bank_that_is_not_packed_end_to_end_is_refused(tmp_path, layout, why):
    """A gap between entries or bytes after the tables is a wrong reading of the file, not a quirk of it."""
    path = build_bank(tmp_path / "x.all.sabl", ENTRIES, **layout)
    with pytest.raises(ValueError, match=why):
        bank = sab.Bank(path)
        bank.clip(bank.entries[0])


def test_the_header_size_must_be_the_files(tmp_path):
    path = build_bank(tmp_path / "x.all.sabl", ENTRIES)
    with open(path, "ab") as fh:
        fh.write(b"\0")
    with pytest.raises(ValueError, match="the header says"):
        sab.Bank(path)


def test_pcm_whose_size_is_not_its_frames_is_refused(tmp_path):
    bank = sab.Bank(build_bank(tmp_path / "x.all.sabl", [(0x11, PCM, 5, 1, 0, sab.PCMS16)]))
    with pytest.raises(ValueError, match="is not 5 frames"):
        bank.clip(bank.entries[0])


def test_a_flac_whose_streaminfo_disagrees_with_the_entry_is_refused(tmp_path):
    bank = sab.Bank(build_bank(tmp_path / "x.all.sabs", [(0x22, flac_blob(48000, 2, 1234), 1000, 2, 0, sab.FLAC)]))
    with pytest.raises(ValueError, match="FLAC"):
        bank.clip(bank.entries[0])


def test_streaminfo_fields():
    assert sab.flac_streaminfo(flac_blob(44100, 1, 99999, 24)) == {"rate": 44100, "channels": 1, "bits": 24, "frames": 99999}


def test_an_id_in_two_banks_is_kept_once_and_a_disagreement_is_named(tmp_path):
    build_bank(tmp_path / "a.all.sabl", ENTRIES)
    build_bank(tmp_path / "b.all.sabl", [(0x11, PCM, 4, 1, 1, sab.PCMS16)])
    build_bank(tmp_path / "c.all.sabl", [(0x11, PCM[::-1], 4, 1, 1, sab.PCMS16)])
    banks = sab.Banks(str(tmp_path))
    assert banks.find(0x11)[0].name == "a.all.sabl"
    assert banks.conflicts == [(0x11, "a.all.sabl", "c.all.sabl")]
    assert banks.find(0x99) is None


def test_a_recording_keeps_its_build_code_so_two_builds_of_one_source_stay_two():
    assert (
        sab.clip_path("raw\\sound\\amb\\advertisements\\tiny_travel_ad.SL55.pc.snd") == "amb/advertisements/tiny_travel_ad.SL55"
    )
    assert sab.clip_path("raw\\sound\\fly\\x.LN55.pc.snd") != sab.clip_path("raw\\sound\\fly\\x.LN65.pc.snd")


def test_the_sound_directory_is_beside_zone():
    assert sab.sound_dir_for("/g/zone/all/mp_la.ff") == os.path.normpath("/g/sound")


# -- The dump and its reading ----------------------------------------------------------------------


def t6_entry(**over):
    """One dumped T6 entry as t6/dumpers/sound.py writes it: raw integers and the two flag words."""
    out = {
        "name": "amb_x",
        "secondaryName": None,
        "assetId": 1,
        "assetFileName": "raw\\sound\\amb\\x.SL55.pc.snd",
        "flags0": 0x1 | 0x2 | (21 << 17) | (2 << 15),  # looping, 3D, grp_ambience, streamed
        "flags1": 0,
        "soundFile": {
            "typeName": "SAT_STREAMED",
            "exists": True,
            "path": "amb/x.SL55",
            "bank": {"path": "/g/sound/x.all.sabs", "offset": 2048},
        },
        "distMin": 50,
        "distMax": 1000,
        "startDelay": 100,
        "volMin": 1165,
        "volMax": 65535,
        "pitchMin": 27553,
        "pitchMax": 32767,
        "probability": 255,
    }
    out.update(over)
    return out


def t6_alias(name, entries):
    return {"_type": "sound_alias", "_version": 1, "_game": "t6", "name": name, "count": len(entries), "entries": entries}


def test_a_t6_entry_is_read_on_t5s_scales_with_its_own_flags():
    e = sound.t6_entry(t6_entry())
    assert e["volMin"] == pytest.approx(1165 / 65535)
    assert e["pitchMin"] == pytest.approx(2 ** (-3 / 12), abs=1e-4)
    assert e["probability"] == 1.0
    assert e["mixerGroup"] == "ambience"
    assert sound.t6_entry(t6_entry(flags0=15 << 17))["mixerGroup"] == "weapons"
    assert sound.t6_entry(t6_entry(flags0=18 << 17))["mixerGroup"] is None  # grp_foley: no channel says it


def test_a_t6_recording_is_read_out_of_its_bank_whatever_its_load_type():
    e = sound.t6_entry(t6_entry())
    assert sound.clip_file(e) == (sound.BANKED, "amb/x.sl55", ("/g/sound/x.all.sabs", 2048))
    gone = t6_entry(soundFile={"typeName": "SAT_LOADED", "exists": False, "path": "amb/x.SL55", "bank": None})
    assert sound.clip_file(sound.t6_entry(gone)) is None
    nothing = t6_entry(assetFileName=None, soundFile={"typeName": "SAT_UNKNOWN", "exists": False, "path": None, "bank": None})
    assert sound.clip_file(sound.t6_entry(nothing)) is None


def test_a_t6_alias_loops_and_is_placed_by_its_flags():
    row = sound.convert(t6_alias("amb_x", [sound.t6_entry(t6_entry())]))
    assert row["loop"] is True and row["spatial"] is True
    assert row["range"] == pytest.approx([50 / UNITS_PER_M, 1000 / UNITS_PER_M])
    assert row["channel"] == "ambience"
    flat = sound.convert(t6_alias("ui_x", [sound.t6_entry(t6_entry(flags0=0))]))
    assert flat["loop"] is False and flat["spatial"] is False


def test_t6_names_are_added_under_the_engines_spelling(tmp_path):
    for name in ("fly_step_run_plr_concrete", "fly_land_npc_metal", "mpl_hit_alert", "amb_x"):
        (tmp_path / f"{name}.json").write_text(json.dumps(t6_alias(name, [t6_entry()])))
    defs = sound.load_dump(str(tmp_path))
    assert {"step_run_plr_concrete", "land_metal", "mp_hit_alert", "fly_step_run_plr_concrete"} <= set(defs)
    assert sound.own_steps(defs)


def test_the_zombies_family_is_the_creature_and_the_round_not_one_maps_enemy():
    assert sound.family_of("zmb_vocals_zombie_attack") == "zombies"
    assert sound.family_of("zmb_zombie_spawn") == "zombies"
    assert sound.family_of("mus_zombie_round_start") == "zombies"
    assert sound.family_of("zmb_cha_ching") == "zombies"
    assert sound.family_of("zmb_vocals_screecher_attack") is None
    assert sound.family_of("zmb_avogadro_attack") is None
    assert sound.family_of("zmb_bus_horn_warn") is None


def test_a_family_closure_takes_what_it_layers_in_and_nothing_else():
    defs = {
        "zmb_zombie_arc": t6_alias("zmb_zombie_arc", [sound.t6_entry(t6_entry(secondaryName="zmb_sizzle"))]),
        "zmb_sizzle": t6_alias("zmb_sizzle", [sound.t6_entry(t6_entry())]),
        "fly_step_run_plr_dirt": t6_alias("fly_step_run_plr_dirt", [sound.t6_entry(t6_entry())]),
    }
    assert set(sound.family_closure(defs, "zombies")) == {"zmb_zombie_arc", "zmb_sizzle"}


class Entry:
    """A walked SndAlias, as much of one as the dumper reads."""

    def __init__(self, fields, flags):
        self.fields, self.flags = fields, flags

    def __getitem__(self, key):
        return self.fields[key]

    def bytes(self, path):
        assert path == "flags"
        return struct.pack("<II", *self.flags)


def test_the_dumper_names_where_each_recording_is_and_counts_what_disagrees(tmp_path):
    path = build_bank(tmp_path / "x.all.sabl", ENTRIES)
    banks = sab.Banks(str(tmp_path))
    file_name = "raw\\sound\\amb\\x.LL55.pc.snd"
    fields = dict.fromkeys(t6_sound.WORDS + t6_sound.BYTES, 0)
    fields.update(name="amb_x", id=sab.snd_hash("amb_x"), subtitle=None, secondaryName=None, assetFileName=file_name)
    checks = __import__("collections").Counter()

    right = t6_sound.alias(Entry({**fields, "assetId": 0x11}, (0x1 | (1 << 15), 0)), banks, checks)
    assert right["soundFile"]["exists"] and right["soundFile"]["bank"]["path"] == path
    assert right["soundFile"]["path"] == "amb/x.LL55"
    assert set(checks) == {"an assetId that is not the hash of its file name"}  # 0x11 is not its hash

    checks.clear()
    # Says it does not loop and is streamed; the bank entry loops and is in a `.sabl`.
    t6_sound.alias(Entry({**fields, "assetId": 0x11}, (2 << 15, 0)), banks, checks)
    assert checks["a looping bit the bank entry disagrees with"] == 1
    assert checks["a load type in the other kind of bank file"] == 1


# -- The installed game ----------------------------------------------------------------------------


@installed
def test_every_installed_bank_is_laid_out_as_read_and_agrees_where_two_hold_one_id():
    banks = sab.Banks(BO2_SOUND)
    assert len(banks.banks) > 100
    assert banks.conflicts == []
    for bank in banks.banks:
        kind = bank.name.rsplit(".", 1)[-1]
        assert {e.format for e in bank.entries} <= ({sab.PCMS16} if kind == "sabl" else {sab.FLAC}), bank.name
        assert {e.rate_index for e in bank.entries} <= {6}, bank.name


@installed
@pytest.mark.skipif(not subprocess.run(["which", "ffprobe"], capture_output=True).returncode == 0, reason="no ffprobe")
def test_an_installed_entry_of_each_kind_decodes_to_the_length_its_entry_gives(tmp_path):
    """A stock decoder, not our reading of the header, says how long each one is."""
    for name in ("mpl_la.all.sabl", "mpl_la.all.sabs"):
        bank = sab.Bank(os.path.join(BO2_SOUND, name))
        entry = min(bank.entries, key=lambda e: e.size)
        ext, blob = bank.clip(entry)
        out = tmp_path / f"clip{ext}"
        out.write_bytes(blob)
        probe = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-count_packets",
                "-show_entries",
                "stream=sample_rate,channels,duration_ts",
                "-of",
                "json",
                str(out),
            ],
            capture_output=True,
            check=True,
            text=True,
        )
        stream = json.loads(probe.stdout)["streams"][0]
        assert int(stream["sample_rate"]) == 48000 and int(stream["channels"]) == entry.channels
        decoded = subprocess.run(["ffmpeg", "-v", "error", "-i", str(out), "-f", "s16le", "-"], capture_output=True, check=True)
        assert len(decoded.stdout) == entry.frames * entry.channels * 2, name
