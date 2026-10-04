"""`sound`: T6's sound bank -- every alias list as JSON, each entry saying which bank file holds its recording.

A T6 zone's `SndBank` (`mpl_la.all`, `mpl_common.all`, `zmb_classic_transit.all`)
holds the alias lists and none of the audio: that is in the `.sabl`/`.sabs` files
in `<game>/sound`, keyed by `assetId` (t6/sab.py). So the audio is not written
here. Each entry records where it is -- the bank file, and the entry's rate,
channels, frame count and format -- and scripts/cod/sound.py reads the recording
out of the bank when a table actually names it. A map's aliases reach 794
recordings and 136 MB of PCM (mp_la), of which a world ships a few dozen.

`sound_aliases/<list>.json` is one `SndAliasList` with every entry's fields as the
zone holds them: volumes, pitches and distances are 16-bit integers, the one-byte
fields unsigned, and `SndAliasFlags` as its two raw words `flags0`/`flags1`.
Nothing is converted; sound.py decides what each means.

Three things are checked as the lists are written, each against data the zone
does not derive from the others, and counted in the log line when they disagree:
a list's `id` is `snd_hash` of its name, an entry's `assetId` is `snd_hash` of its
`assetFileName`, and `flags0`'s looping bit (0) and load type (bits 15-16) agree
with the bank entry's looping byte and with which kind of bank file holds it.
"""

import functools
import struct
from collections import Counter

from ...iw6.dumpers.common import asset_path, write_json
from .. import sab

ALIAS_FOLDER = "sound_aliases"
LOAD_TYPES = ("SAT_UNKNOWN", "SAT_LOADED", "SAT_STREAMED", "SAT_PRIMED")
# The bank file each load type is kept in: loaded audio in `.sabl`, streamed and primed in `.sabs`.
BANK_KIND = {1: "sabl", 2: "sabs", 3: "sabs"}
LOOPING = 0x1
LOAD_SHIFT, LOAD_MASK = 15, 0x3
WORDS = (
    "duck contextType contextValue stopOnPlay futzPatch fluxTime startDelay reverbSend centerSend volMin volMax "
    "pitchMin pitchMax distMin distMax distReverbMax envelopMin envelopMax envelopPercentage fadeIn fadeOut dopplerScale"
).split()
BYTES = (
    "minPriorityThreshold maxPriorityThreshold probability occlusionLevel minPriority maxPriority pan limitCount "
    "entityLimitCount duckGroup"
).split()


@functools.lru_cache(maxsize=2)
def banks_for(sound_dir):
    return sab.Banks(sound_dir)


def bank_json(found):
    bank, entry = found
    return {
        "path": bank.path,
        "file": bank.name,
        "offset": entry.offset,
        "size": entry.size,
        "format": sab.FORMAT_NAMES.get(entry.format, entry.format),
        "frameRate": sab.FRAME_RATES[entry.rate_index] if entry.rate_index < len(sab.FRAME_RATES) else None,
        "channels": entry.channels,
        "frameCount": entry.frames,
        "looping": entry.looping,
    }


def alias(entry, banks, checks):
    flags0, flags1 = struct.unpack("<II", entry.bytes("flags"))
    load = (flags0 >> LOAD_SHIFT) & LOAD_MASK
    asset_id, file_name = entry["assetId"], entry["assetFileName"]
    found = banks.find(asset_id) if asset_id else None
    if file_name and sab.snd_hash(file_name) != asset_id:
        checks["an assetId that is not the hash of its file name"] += 1
    if found:
        if bool(flags0 & LOOPING) != bool(found[1].looping):
            checks["a looping bit the bank entry disagrees with"] += 1
        if BANK_KIND.get(load) != found[0].name.rsplit(".", 1)[-1]:
            checks["a load type in the other kind of bank file"] += 1
    elif asset_id:
        checks["a recording in no bank file"] += 1
    out = {
        "name": entry["name"],
        "id": entry["id"],
        "subtitle": entry["subtitle"],
        "secondaryName": entry["secondaryName"],
        "assetId": asset_id,
        "assetFileName": file_name,
        "flags0": flags0,
        "flags1": flags1,
        "soundFile": {
            "typeName": LOAD_TYPES[load],
            "exists": found is not None,
            "path": sab.clip_path(file_name) if file_name else None,
            "bank": bank_json(found) if found else None,
        },
    }
    out.update((key, entry[key]) for key in WORDS)
    out.update((key, entry[key] & 0xFF) for key in BYTES)
    return out


def alias_list(bank_name, lst, banks, checks):
    count = lst["count"]
    if sab.snd_hash(lst["name"]) != lst["id"]:
        checks["a list id that is not the hash of its name"] += 1
    return {
        "_type": "sound_alias",
        "_version": 1,
        "_game": "t6",
        "name": lst["name"],
        "bank": bank_name,
        "id": lst["id"],
        "count": count,
        "sequence": lst["sequence"],
        "entries": [alias(e, banks, checks) for e in list(lst["head"] or ())[: max(count, 0)]],
    }


def write(walk, out, ctx=None):
    banks = banks_for(sab.sound_dir_for(walk.path))
    lists, recordings, checks = 0, set(), Counter()
    for asset in walk.by_type("soundbank"):
        bank = asset.record
        if asset.name.startswith(",") or bank["alias"] is None:
            continue  # a reference, or `zmb_common.all`: a bank with no aliases, only its files
        for lst in list(bank["alias"])[: bank["aliasCount"]]:
            if not lst["name"]:
                continue
            data = alias_list(asset.name, lst, banks, checks)
            write_json(asset_path(out, f"{ALIAS_FOLDER}/{lst['name']}.json"), data)
            lists += 1
            recordings |= {e["assetId"] for e in data["entries"] if e["soundFile"]["exists"]}
    line = f"      {lists} alias list(s) naming {len(recordings)} recording(s) in {len(banks.banks)} bank file(s)"
    if checks:
        line += "; DISAGREE: " + "; ".join(f"{n} {why}" for why, n in checks.most_common())
    print(line)
