"""`mapents`: the entity lump as text, `<map>.ents`, beside where OpenAssetTools puts it.

Keys are script-string numbers, as on IW5; scripts/cod/entities.py recognises
the ones the pipeline needs by their values.

The map's spawn points are not in the lump: the linker moves every `mp_*_spawn*`
into `MapEnts.spawnList`, a table of 44-byte records (x64-zt's H1
`SpawnPointEntityRecord`). They are appended here as the entities they were, so
that the metadata and the world file find them as they do on every other game.
"""

import struct

from ...entities import S1_KEY_NAMES
from ...iw6.dumpers.common import asset_path
from . import dumper

# u16 index, pad, then name/target/script_noteworthy/targetname as u32 script
# strings, then origin and angles.
SPAWN_RECORD = struct.Struct("<H2x4I6f")
KEYS = {name: number for number, name in S1_KEY_NAMES.items()}


def short(value):
    """A float32 as the fewest digits that read back as the same float32."""
    for digits in range(1, 10):
        text = f"{value:.{digits}g}"
        if struct.pack("<f", float(text)) == struct.pack("<f", value):
            return text
    return repr(value)


def spawn_entities(zone, at, count):
    """The spawn table as `.ents` blocks. A record with an empty name is refused, not guessed."""
    strings = zone.script_strings

    def string(index):
        return strings[index] if 0 < index < len(strings) and strings[index] else ""

    blocks = []
    for k in range(count):
        _index, name, target, noteworthy, targetname, *floats = SPAWN_RECORD.unpack_from(zone.data, at + SPAWN_RECORD.size * k)
        classname = string(name)
        if not classname.startswith("mp_") or "spawn" not in classname:
            raise SystemExit(f"spawn record {k} of {count} is named {classname!r}: the spawn table is misread")
        pairs = [
            (KEYS["classname"], classname),
            (KEYS["origin"], " ".join(short(v) for v in floats[:3])),
            (KEYS["angles"], " ".join(short(v) for v in floats[3:])),
        ]
        pairs += [
            (key, value) for key, value in ((KEYS["target"], string(target)), (KEYS["targetname"], string(targetname))) if value
        ]
        if string(noteworthy):
            pairs.append(("script_noteworthy", string(noteworthy)))
        blocks.append("{\n" + "".join(f'{key} "{value}"\n' for key, value in pairs) + "}\n")
    return "".join(blocks).encode("latin-1")


@dumper("mapents")
def write(walked, out):
    zone = walked.zone
    for name, ents in zone.found.get("MAPENTS", {}).items():
        at, length = ents["entity_string_at"], ents["numEntityChars"]
        text = zone.data[at : at + length].rstrip(b"\0") if at is not None else b""
        if ents.get("spawns_at") is not None and ents.get("spawnsCount"):
            text += (b"" if text.endswith(b"\n") or not text else b"\n") + spawn_entities(
                zone, ents["spawns_at"], ents["spawnsCount"]
            )
        with open(asset_path(out, f"{name}.ents"), "wb") as fh:
            fh.write(text)
