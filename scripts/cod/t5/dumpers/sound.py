"""`sound`: T5's sound bank, both halves -- every alias list as JSON, and every loaded sound as audio.

A T5 zone keeps one `SndBank` (`mpl_nuked.all`, `mpl_common.all` ...) holding its
alias lists and, for a loaded alias, the audio itself, so this one kind writes
what IW's `sound` and `loadedsound` write between them (`loadedsound`
writes nothing on T5, see `__init__`).

`sound_aliases/<list>.json` is one `snd_alias_list_t`, its `bank`, and every entry
with every field as the zone holds it: volumes, pitches and distances are 16-bit
integers and the one-byte fields are written unsigned; `soundFile` says which half
of the union is live by `type` alone (`SAT_LOADED` a LoadedSound, anything else a
StreamedSound). Nothing is decoded; scripts/cod/sound.py decides what each means.

A loaded sound is written at its own name (`sound\\amb\\...\\x.wav` with the
separators turned), whatever its format, as a RIFF file a stock decoder plays:

- format 7, xWMA: WMA packets of a fixed size, and a `dpds` chunk -- the bytes
  decoded by the end of each packet -- which is `seek_table` exactly. The byte
  rate is the packet size over eight WMA frames of 2048 samples;
- format 6, Microsoft ADPCM at 512 frames a block, with the format's seven
  standard coefficient pairs; refused unless the data is whole blocks;
- format 0, 16-bit PCM.

Anything else is counted and not written, as OAT's SndBankDumperT5 skips it.
"""

import struct
from collections import Counter

from ...iw5.dumpers.sound import wav
from ...iw6.dumpers.common import asset_path, write_json

ALIAS_FOLDER = "sound_aliases"
SAT_NAMES = ("SAT_UNKNOWN", "SAT_LOADED", "SAT_STREAMED", "SAT_PRIMED")
SAT_LOADED = 1
PCMS16, MSADPCM, WMA = 0, 6, 7
ADPCM_FRAMES_PER_BLOCK = 512
ADPCM_COEFFICIENTS = ((256, 0), (512, -256), (0, 0), (192, 64), (240, 0), (460, -208), (392, -232))
WORDS = (
    "flags duck contextType contextValue fluxTime startDelay reverbSend centerSend volMin volMax teamVolMod "
    "pitchMin pitchMax teamPitchMod distMin distMax distReverbMax envelopMin envelopMax envelopPercentage"
).split()
BYTES = (
    "minPriorityThreshold maxPriorityThreshold probability occlusionLevel occlusionWetDry minPriority maxPriority "
    "pan dryCurve wetCurve dryMinCurve wetMinCurve limitCount entityLimitCount snapshotGroup"
).split()


def loaded_json(loaded):
    snd = "sound."
    table = loaded[snd + "seek_table"]
    count = loaded[snd + "seek_table_count"]
    return {
        "name": loaded["name"],
        "format": loaded[snd + "format"],
        "frameCount": loaded[snd + "frame_count"],
        "frameRate": loaded[snd + "frame_rate"],
        "channelCount": loaded[snd + "channel_count"],
        "headerSize": loaded[snd + "header_size"],
        "blockSize": loaded[snd + "block_size"],
        "dataSize": loaded[snd + "data_size"],
        "version": loaded[snd + "version"],
        "bufferSize": loaded[snd + "buffer_size"],
        "channelFlags": loaded[snd + "channel_flags"],
        "flags": loaded[snd + "flags"],
        "seekTable": [v for (v,) in table.view(0, count).unpack("<I")] if table is not None and count else [],
    }


def sound_file(sf):
    if sf is None:
        return None
    kind = sf["type"]
    entry = {
        "type": kind,
        "typeName": SAT_NAMES[kind] if 0 <= kind < len(SAT_NAMES) else None,
        "exists": sf["exists"],
        "loaded": None,
        "streamed": None,
    }
    if kind == SAT_LOADED:
        loaded = sf["u.loadSnd"]
        if loaded is not None:
            entry["loaded"] = loaded_json(loaded)
    else:
        streamed = sf["u.streamSnd"]
        if streamed is not None:
            primed = streamed["primeSnd"]
            entry["streamed"] = {"filename": streamed["filename"], "primed": primed["name"] if primed is not None else None}
    return entry


def alias(entry):
    out = {
        "name": entry["name"],
        "id": entry["id"],
        "subtitle": entry["subtitle"],
        "secondaryname": entry["secondaryname"],
        "soundFile": sound_file(entry["soundFile"]),
    }
    out.update((key, entry[key]) for key in WORDS)
    out.update((key, entry[key] & 0xFF) for key in BYTES)
    return out


def alias_list(bank, lst):
    head = lst["head"]
    count = lst["count"]
    return {
        "_type": "sound_alias",
        "_version": 1,
        "_game": "t5",
        "name": lst["name"],
        "bank": bank,
        "id": lst["id"],
        "count": count,
        "sequence": lst["sequence"],
        "entries": [alias(e) for e in list(head or ())[: max(count, 0)]],
    }


def chunk(tag, data):
    return tag + struct.pack("<I", len(data)) + bytes(data) + (b"\0" if len(data) % 2 else b"")


def riff(form, *chunks):
    body = form + b"".join(chunks)
    return b"RIFF" + struct.pack("<I", len(body)) + body


def xwma(snd, data, seek):
    block_align = (snd["data_size"] // snd["seek_table_count"]) & 0xFFFF
    avg = (block_align * snd["frame_rate"] + 8192) // 16384
    fmt = struct.pack("<HHIIHHH", 0x161, snd["channel_count"], snd["frame_rate"], avg, block_align, 16, 0)
    return riff(b"XWMA", chunk(b"fmt ", fmt), chunk(b"dpds", seek), chunk(b"data", data))


def adpcm_block_align(snd):
    channels = snd["channel_count"]
    return (ADPCM_FRAMES_PER_BLOCK - 2) * channels // 2 + 7 * channels


def whole_adpcm_blocks(snd):
    blocks = (snd["frame_count"] + ADPCM_FRAMES_PER_BLOCK - 1) // ADPCM_FRAMES_PER_BLOCK
    return blocks * adpcm_block_align(snd) == snd["data_size"]


def ms_adpcm(snd, data):
    align = adpcm_block_align(snd)
    rate = snd["frame_rate"]
    fmt = struct.pack(
        "<HHIIHHHHH",
        2,
        snd["channel_count"],
        rate,
        (rate * align // ADPCM_FRAMES_PER_BLOCK) & 0xFFFFFFFF,
        align,
        4,
        32,
        ADPCM_FRAMES_PER_BLOCK,
        7,
    )
    fmt += b"".join(struct.pack("<hh", *pair) for pair in ADPCM_COEFFICIENTS)
    return riff(b"WAVE", chunk(b"fmt ", fmt), chunk(b"fact", struct.pack("<I", snd["frame_count"])), chunk(b"data", data))


def audio(loaded, skipped):
    """The RIFF file of one LoadedSound, or None (and why, in `skipped`)."""
    snd = loaded["sound"]
    data = snd["data"]
    if not loaded["name"] or data is None:
        return None
    body = bytes(data.bytes()[: snd["data_size"]])
    fmt = snd["format"]
    if fmt == WMA:
        table = snd["seek_table"]
        if not snd["seek_table_count"] or table is None:
            skipped["WMA with no packet table"] += 1
            return None
        return xwma(snd, body, bytes(table.view(0, snd["seek_table_count"]).bytes()))
    if fmt == MSADPCM:
        if not whole_adpcm_blocks(snd):
            skipped["ADPCM that is not 512-frame blocks"] += 1
            return None
        return ms_adpcm(snd, body)
    if fmt == PCMS16:
        return wav(snd["channel_count"], snd["frame_rate"], 16, body)
    skipped[f"format {fmt}"] += 1
    return None


def write(walk, out, ctx=None):
    lists, sounds, skipped, done = 0, 0, Counter(), set()
    for asset in walk.by_type("soundbank"):
        if asset.name.startswith(","):
            continue
        bank = asset.record
        for lst in list(bank["alias"] or ())[: bank["aliasCount"]]:
            if not lst["name"]:
                continue
            write_json(asset_path(out, f"{ALIAS_FOLDER}/{lst['name']}.json"), alias_list(asset.name, lst))
            lists += 1
            for entry in list(lst["head"] or ())[: max(lst["count"], 0)]:
                sf = entry["soundFile"]
                loaded = sf["u.loadSnd"] if sf is not None and sf["type"] == SAT_LOADED else None
                if loaded is None or loaded.address in done:
                    continue
                done.add(loaded.address)
                blob = audio(loaded, skipped)
                if blob is not None:
                    with open(asset_path(out, loaded["name"].replace("\\", "/")), "wb") as fh:
                        fh.write(blob)
                    sounds += 1
    line = f"      {lists} alias list(s), {sounds} loaded sound(s) written"
    if skipped:
        line += "; not written: " + "; ".join(f"{n} {why}" for why, n in skipped.most_common())
    print(line)
