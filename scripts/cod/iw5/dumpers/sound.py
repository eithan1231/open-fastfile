"""`sound` and `loadedsound`: the alias lists as JSON, and the PCM they load.

`sound_aliases/<name>.json` is one `snd_alias_list_t`, every variant in zone
order, in game units with nothing decoded: `distMin`/`distMax` are the map's
inches and `flags` the raw int (the only named sound-alias bitfield anywhere is
another game's). Which half of `SoundFile::u` is live is `type` alone, as the zone
code selects it: `SAT_LOADED` is a LoadedSound, anything else the inline
`dir`/`name` pair. A name another zone defines keeps the comma the zone spells it
with (`,null.wav`); scripts/cod/sound.py strips it.

`sound/<name>` is one LoadedSound as a PCM `.wav`, at the name an alias's
`loaded.name` spells. The samples are what the `SetSoundData` action kept
(zonecode/actions.py); MW3 loads nothing but PCM, and any other format is
counted and left out rather than written as a file a decoder would misread.
"""

import json
import struct

from ...iw6.dumpers.common import asset_path
from . import GAME, dumper

ALIAS_FOLDER = "sound_aliases"
PCM_FOLDER = "sound"
WAVE_FORMAT_PCM = 1
ALIAS_FIELDS = (
    "sequence volMin volMax volModIndex pitchMin pitchMax distMin distMax velocityMin flags masterPriority "
    "masterPercentage slavePercentage probability lfePercentage centerPercentage startDelay envelopMin "
    "envelopMax envelopPercentage"
).split()
NAME_FIELDS = ("aliasName", "subtitle", "secondaryAliasName", "chainAliasName", "mixerGroup")
SPEAKERS = 6  # MSSChannelMap.speakers
CHANNEL_MAP = struct.Struct("<i" + "iiff" * SPEAKERS)  # speakerCount, then {speaker, numLevels, levels[2]}


def sat_names(enums):
    """IW5's snd_alias_type_t, index -> name, from the load program's enum values."""
    names = {v: k for k, v in reversed(list(enums.items())) if k.startswith("SAT_") and k != "SAT_COUNT"}
    return [names.get(i) for i in range(enums["SAT_COUNT"])]


def name_of(value):
    if value is None:
        return None
    return value if isinstance(value, str) else value.name


def sound_file(sf, types):
    if sf is None:
        return None
    kind = sf["type"]
    out = {"type": kind, "typeName": types[kind] if kind < len(types) else None, "exists": sf["exists"]}
    if types[kind : kind + 1] == ["SAT_LOADED"]:
        loaded = sf["u.loadSnd"]
        out["loaded"] = None if loaded is None else {"name": name_of(loaded)}
        out["streamed"] = None
    else:
        out["loaded"] = None
        out["streamed"] = {"dir": sf["u.streamSnd.dir"], "name": sf["u.streamSnd.name"]}
    return out


def speaker_map(sm):
    if sm is None:
        return None
    raw = sm.bytes("channelMaps")
    rows = []
    for row in range(2):
        maps = []
        for col in range(2):
            v = CHANNEL_MAP.unpack_from(raw, (row * 2 + col) * CHANNEL_MAP.size)
            speakers = [
                {"speaker": v[1 + 4 * i], "numLevels": v[2 + 4 * i], "levels": [v[3 + 4 * i], v[4 + 4 * i]]}
                for i in range(SPEAKERS)
            ]
            maps.append({"speakerCount": v[0], "speakers": speakers})
        rows.append(maps)
    return {"isDefault": bool(sm["isDefault"]), "name": sm["name"], "channelMaps": rows}


def curve_name(curve):
    """A SndCurve by its `filename`, which a stub from another zone spells with its comma."""
    if curve is None:
        return None
    return curve if isinstance(curve, str) else curve.record["filename"]


def alias(entry, types):
    out = {key: entry[key] for key in NAME_FIELDS}
    out.update({key: entry[key] for key in ALIAS_FIELDS})
    out["soundFile"] = sound_file(entry["soundFile"], types)
    out["volumeFalloffCurve"] = curve_name(entry["volumeFalloffCurve"])
    out["speakerMap"] = speaker_map(entry["speakerMap"])
    return out


def alias_list(asset, types):
    rec = asset.record
    return {
        "_type": "sound_alias",
        "_version": 1,
        "_game": GAME,
        "name": asset.name,
        "aliasName": rec["aliasName"],
        "count": rec["count"],
        "entries": [alias(e, types) for e in list(rec["head"] or ())[: rec["count"]]],
    }


@dumper("sound")
def write_aliases(walk, out, ctx=None):
    types = sat_names(walk.program.data["enums"])
    found = walk.by_type("sound")
    written = 0
    for asset in found:
        if asset.name.startswith(","):
            continue
        with open(asset_path(out, f"{ALIAS_FOLDER}/{asset.name}.json"), "w", encoding="utf-8") as fh:
            fh.write(json.dumps(alias_list(asset, types), indent=4, sort_keys=True, ensure_ascii=False) + "\n")
        written += 1
    print(f"      {written} of {len(found)} alias lists written")


def wav(channels, rate, bits, pcm):
    """A canonical 44-byte-header PCM RIFF around `pcm`."""
    block = channels * (bits // 8)
    fmt = struct.pack("<HHIIHH", WAVE_FORMAT_PCM, channels, rate, rate * block, block, bits)
    body = b"WAVE" + b"fmt " + struct.pack("<I", len(fmt)) + fmt + b"data" + struct.pack("<I", len(pcm)) + bytes(pcm)
    if len(pcm) & 1:
        body += b"\0"  # a RIFF chunk is padded to an even length
    return b"RIFF" + struct.pack("<I", len(body)) + body


@dumper("loadedsound")
def write_pcm(walk, out, ctx=None):
    found = walk.by_type("loadedsound")
    written, other = 0, []
    for asset in found:
        if asset.name.startswith(","):
            continue
        snd = asset.record["sound"]
        if snd["info.format"] != WAVE_FORMAT_PCM:
            other.append(f"{asset.name} (format {snd['info.format']})")
            continue
        pcm = snd.captured("SetSoundData") or b""
        with open(asset_path(out, f"{PCM_FOLDER}/{asset.name}"), "wb") as fh:
            fh.write(wav(snd["info.channels"], snd["info.rate"], snd["info.bits"], pcm))
        written += 1
    print(f"      {written} of {len(found)} loaded sounds written")
    if other:
        print(f"      !! {len(other)} not PCM, not written: {', '.join(other[:6])}")
