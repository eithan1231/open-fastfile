"""`weapon`: each weapon as a `WEAPONFILE` infostring under `weapons/<name>`, and the AI
accuracy graphs it names under `accuracy/aivsai/` and `accuracy/aivsplayer/`.

The keys, the order they are written in and which member each reads are
OpenAssetTools' field table for the walk's game, turned into data by
reverse/x86-zone/layout/infostring.py (`scripts/cod/data/<g>/weapon_fields.json`, beside the
load program). IW4's weapon is IW5's without attachments or overrides, and OAT's
two dumpers differ only in that, so this writer is IW4's too. A path in it is relative to OAT's `WeaponFullDef`, which is the
zone's `WeaponCompleteDef` and its `WeaponDef` with their fixed-length arrays
inlined: `weapCompleteDef.` and `weapDef.` name those two records, and the arrays
(`gunXModel[i]`, `szXAnims[...]`, `hideTags` ...) are the member of whichever of
the two holds it. A null pointer reads as zero or empty, as OAT's zeroed copy does.

How each type prints is OAT's: floats as C++ streams print them (`%g`),
milliseconds as seconds, assets by name without the comma a stub carries,
sounds by alias name, enums by the name tables in the same file.
"""

import json
import os
import re
import struct

from ...zonecode import program
from ...zonecode.values import mods_size
from . import dumper
from .common import plain

FOLDER = "weapons"
HEADER = "WEAPONFILE"
ACCURACY_HEADER = "WEAPONACCUFILE"
# How long each notetrack map is, (sounds, rumbles): the WeaponDef arrays' counts.
NOTETRACKS = {"iw4": (16, 16), "iw5": (24, 16), "t5": (20, 0)}
# The WeaponFullDef arrays that are the complete def's (T5's variant def's); every other one is the WeaponDef's.
ON_COMPLETE = {
    "iw4": {"szXAnims", "hideTags"},
    "iw5": {"szXAnims", "hideTags", "scopes", "underBarrels", "others"},
    "t5": {"szXAnims", "hideTags"},
}
# The first of a per-surface sound list, less its `_default` suffix: IW5's
# WFT_PER_SURFACE_TYPE_SOUND is what IW4 calls WFT_BOUNCE_SOUND.
SURFACE_SOUNDS = {"WFT_PER_SURFACE_TYPE_SOUND", "WFT_BOUNCE_SOUND"}
ENUM_TABLES = {
    "WFT_WEAPONTYPE": "szWeapTypeNames",
    "WFT_WEAPONCLASS": "szWeapClassNames",
    "WFT_OVERLAYRETICLE": "szWeapOverlayReticleNames",
    "WFT_PENETRATE_TYPE": "penetrateTypeNames",
    "WFT_IMPACT_TYPE": "impactTypeNames",
    "WFT_STANCE": "szWeapStanceNames",
    "WFT_PROJ_EXPLOSION": "szProjectileExplosionNames",
    "WFT_OFFHAND_CLASS": "offhandClassNames",
    "WFT_ANIMTYPE": "playerAnimTypeNames",
    "WFT_ACTIVE_RETICLE_TYPE": "activeReticleNames",
    "WFT_GUIDED_MISSILE_TYPE": "guidedMissileNames",
    "WFT_STICKINESS": "stickinessNames",
    "WFT_OVERLAYINTERFACE": "overlayInterfaceNames",
    "WFT_INVENTORYTYPE": "szWeapInventoryTypeNames",
    "WFT_FIRETYPE": "szWeapFireTypeNames",
    "WFT_AMMOCOUNTER_CLIPTYPE": "ammoCounterClipNames",
    "WFT_ICONRATIO_HUD": "weapIconRatioNames",
    "WFT_ICONRATIO_PICKUP": "weapIconRatioNames",
    "WFT_ICONRATIO_AMMOCOUNTER": "weapIconRatioNames",
    "WFT_ICONRATIO_KILL": "weapIconRatioNames",
    "WFT_ICONRATIO_DPAD": "weapIconRatioNames",
    "WFT_ICONRATIO_INDICATOR": "weapIconRatioNames",  # T5's from here on
    "WFT_OFFHAND_SLOT": "offhandSlotNames",
    "WFT_ROTATETYPE": "rotateTypeNames",
    "WFT_CLIPTYPE": "szWeapClipTypeNames",
}
ASSET_TYPES = {"CSPFT_FX", "CSPFT_XMODEL", "CSPFT_MATERIAL", "CSPFT_MATERIAL_STREAM", "CSPFT_PHYS_COLLMAP", "CSPFT_TRACER"}
# WeaponAttachmentCombination: which scope (1-based), under-barrel (1-based) and other attachments (a bit each).
SCOPE_BITS, UNDER_BARREL_BITS = 3, 2


def fields_path(game):
    return os.path.join(os.path.dirname(program.path_for(game)), "weapon_fields.json")


def load_fields(game):
    path = fields_path(game)
    if not os.path.exists(path):
        raise SystemExit(f"no {game} weapon field table at {path}: it ships in scripts/cod/data/ (scripts/cod/data/README.md)")
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def f32(value):
    return struct.unpack("<f", struct.pack("<f", value))[0]


def number(value):
    """A float as a C++ stream prints it by default: six significant digits."""
    text = f"{value:g}"
    return "-nan" if text == "nan" and struct.pack("<f", value)[3] & 0x80 else text


def signed(value):
    return value - (1 << 32) if value >= 1 << 31 else value


class Weapon:
    """One WeaponFullDef, read by the field table's paths."""

    def __init__(self, walk, complete, enums):
        self.walk, self.complete, self.enums = walk, complete, enums
        self.weap_def = complete["weapDef"]

    def script_string(self, index):
        return (self.walk.script_string(index) or "") if index is not None else ""

    def _owner(self, path):
        """(the record a WeaponFullDef path is read from, the path inside it)."""
        path = re.sub(r"\[([A-Z_][A-Z0-9_]*)\]", lambda m: f"[{self.enums[m.group(1)]}]", path)
        head, _, rest = path.partition(".")
        if head in ("weapCompleteDef", "weapVariantDef", "weapDef"):
            return (self.weap_def if head == "weapDef" else self.complete), rest
        return (self.complete if path.split("[")[0] in ON_COMPLETE[self.walk.game] else self.weap_def), path

    def int_at(self, path):
        """A CSPFT_INT as OAT reads one: four bytes at the field, whatever the member's own size.
        T5's table declares two bools so (`coolWhileFiring`, `fuelTankWeapon`), and each then
        reads the bytes after it too."""
        record, inner = self._owner(path)
        info = getattr(record, "info", None)
        if info is not None and record.at is not None and "[" not in inner:
            offset, member, mods, _ = info.locate(inner)
            if mods_size(member["type_size"], mods) < 4:
                return struct.unpack_from("<i", record.walk.data, record.at + offset)[0]
        return self.get(path)

    def get(self, path):
        """The value a WeaponFullDef path names, or None where a pointer on the way is null."""
        record, path = self._owner(path)
        if record is None:
            return None
        indexed = re.fullmatch(r"(.*)\[(\d+)\]", path)
        if not indexed:
            return record[path]
        # A trailing index is taken here: a vec3_t member reads as a tuple, a pointer as an array or None.
        values = record[indexed.group(1)]
        return values[int(indexed.group(2))] if values is not None else None

    def array(self, path, count):
        values = self.get(path)
        return list(values)[:count] if values is not None else [0] * count

    def attachment(self, fields):
        """The one attachment a WeaponAttachmentCombination names (GetNameForSingleWeaponAttachment)."""
        scope = fields & ((1 << SCOPE_BITS) - 1)
        under = (fields >> SCOPE_BITS) & ((1 << UNDER_BARREL_BITS) - 1)
        other = fields >> (SCOPE_BITS + UNDER_BARREL_BITS)
        if scope:
            slot = ("scopes", scope - 1)
        elif under:
            slot = ("underBarrels", under - 1)
        elif other:
            slot = ("others", (other & -other).bit_length() - 1)
        else:
            return ""
        slots = self.complete[slot[0]]
        attachment = slots[slot[1]] if slots is not None else None
        return attachment.name if attachment is not None else ""

    def combination(self, fields):
        return self.attachment(fields) if fields else "none"


def sound_name(sound):
    """A SndAliasCustom's alias name, or None."""
    if sound is None or sound["name"] is None:
        return None
    return sound["name.soundName"]


def value(weapon, key, path, kind, names):
    """The infostring value of one field."""
    if kind == "CSPFT_STRING" or kind == "WFT_ANIM_NAME":
        v = weapon.get(path)
        return v if v is not None else ""
    if kind in ("CSPFT_INT",):
        return str(signed((weapon.int_at(path) or 0) & 0xFFFFFFFF))
    if kind in ("CSPFT_BOOL", "CSPFT_QBOOLEAN"):
        return "1" if weapon.get(path) else "0"
    if kind == "CSPFT_FLOAT":
        return number(weapon.get(path) or 0.0)
    if kind == "CSPFT_MILLISECONDS":
        return number(f32(f32((weapon.get(path) or 0) & 0xFFFFFFFF) / 1000.0))
    if kind in ASSET_TYPES:
        asset = weapon.get(path)
        if isinstance(asset, int):
            # T5's linker shares a run of zeros between a null XModel*[16] and an earlier
            # array of another type, so the walk hands back that array's elements: nulls.
            if asset:
                raise ValueError(f"{key}: an asset pointer read as the integer {asset}")
            return ""
        return plain(asset) or ""
    if kind == "CSPFT_SOUND":
        return sound_name(weapon.get(path)) or ""
    if kind in ("CSPFT_SCRIPT_STRING", "WFT_EXPLOSION_TAG"):
        return weapon.script_string(weapon.get(path))
    if kind in ENUM_TABLES:
        table, index = names[ENUM_TABLES[kind]], signed((weapon.get(path) or 0) & 0xFFFFFFFF)
        return table[index] if 0 <= index < len(table) else ""
    if kind in SURFACE_SOUNDS:
        sounds = weapon.get(path)  # IW's per-surface aliases, or T5's per-surface alias names
        first = (sounds[0] if isinstance(sounds[0], str) else sound_name(sounds[0])) if sounds is not None else None
        return first[: first.rfind("_default")] if first and "_default" in first else ""
    if kind == "WFT_HIDETAGS":
        tags = [weapon.script_string(i) for i in weapon.array(path, 32)]
        return "\n".join(t for t in tags if t)
    if kind in ("WFT_NOTETRACKSOUNDMAP", "WFT_NOTETRACKRUMBLEMAP"):
        count = NOTETRACKS[weapon.walk.game][kind == "WFT_NOTETRACKRUMBLEMAP"]
        keys = [weapon.script_string(i) for i in weapon.array(path, count)]
        values = [weapon.script_string(i) for i in weapon.array(path.replace("Keys", "Values"), count)]
        return "\n".join(f"{k} {v}" if v else k for k, v in zip(keys, values, strict=True) if k)
    if kind == "WFT_ATTACHMENT":
        slots = [weapon.complete[s] for s in ("scopes", "underBarrels", "others")]
        return "\n".join(a.name for arr in slots if arr is not None for a in arr if a is not None)
    if kind in OVERRIDES:
        return OVERRIDES[kind](weapon, names)
    raise ValueError(f"{key}: no reader for field type {kind}")


def entries(weapon, count, array):
    records = weapon.complete[array]
    return list(records)[: weapon.complete[count]] if records is not None else []


def anim_overrides(weapon, names):
    lines = []
    for e in entries(weapon, "numAnimOverrides", "animOverrides"):
        tree = names["weapAnimFilesNames"]
        kind = f"{tree[e['animTreeType']]} " if e["animTreeType"] < len(tree) else ""
        anim, alt = e["overrideAnim"] or "none", e["altmodeAnim"] or "none"
        lines.append(
            f"{weapon.combination(e['attachment1.fields'])} {weapon.combination(e['attachment2.fields'])} "
            f"{kind}{anim} {alt} {signed(e['animTime'])} {signed(e['altTime'])}"
        )
    return "\n".join(lines)


def sound_overrides(weapon, names):
    lines = []
    for e in entries(weapon, "numSoundOverrides", "soundOverrides"):
        types = names["soundOverrideTypeNames"]
        kind = f"{types[e['soundType']]} " if e["soundType"] < len(types) else ""
        main, alt = sound_name(e["overrideSound"]) or "none", sound_name(e["altmodeSound"]) or "none"
        lines.append(
            f"{weapon.combination(e['attachment1.fields'])} {weapon.combination(e['attachment2.fields'])} {kind}{main} {alt}"
        )
    return "\n".join(lines)


def fx_overrides(weapon, names):
    lines = []
    for e in entries(weapon, "numFxOverrides", "fxOverrides"):
        types = names["fxOverrideTypeNames"]
        kind = f"{types[e['fxType']]} " if e["fxType"] < len(types) else ""
        main, alt = (e[k].name if e[k] is not None and e[k].name else "none" for k in ("overrideFx", "altmodeFx"))
        lines.append(
            f"{weapon.combination(e['attachment1.fields'])} {weapon.combination(e['attachment2.fields'])} {kind}{main} {alt}"
        )
    return "\n".join(lines)


def reload_overrides(weapon, names):
    return "\n".join(
        f"{weapon.combination(e['attachment.fields'])} {signed(e['reloadAddTime'])} {signed(e['reloadStartAddTime'])}"
        for e in entries(weapon, "numReloadStateTimerOverrides", "reloadOverrides")
    )


def notetrack_overrides(weapon, names):
    lines = []
    for e in entries(weapon, "numNotetrackOverrides", "notetrackOverrides"):
        keys, values = e["notetrackSoundMapKeys"], e["notetrackSoundMapValues"]
        if keys is None or values is None:
            continue
        attachment = weapon.combination(e["attachment.fields"])
        sounds = NOTETRACKS[weapon.walk.game][0]
        for k, v in zip(list(keys)[:sounds], list(values)[:sounds], strict=True):
            key, val = weapon.script_string(k), weapon.script_string(v)
            if key and val:
                lines.append(f"{attachment} {key} {val}")
    return "\n".join(lines)


OVERRIDES = {
    "WFT_ANIM_OVERRIDES": anim_overrides,
    "WFT_SOUND_OVERRIDES": sound_overrides,
    "WFT_FX_OVERRIDES": fx_overrides,
    "WFT_RELOAD_OVERRIDES": reload_overrides,
    "WFT_NOTETRACK_OVERRIDES": notetrack_overrides,
}


def infostring(weapon, table):
    values = {}
    for key, path, kind in table["fields"]:
        values[key] = value(weapon, key, path, kind, table["names"])
    return HEADER + "".join(f"\\{k}\\{v}" for k, v in values.items())


def accuracy_graphs(weapon):
    """{file: text} of the AI accuracy graphs a weapon names."""
    out = {}
    weap_def = weapon.weap_def
    if weap_def is None:
        return out
    for kind, prefix in (("aivsai", "AiVsAi"), ("aivsplayer", "AiVsPlayer")):
        name = weap_def[f"{kind[:2]}{prefix[2:]}AccuracyGraphName"]
        knots = weap_def[f"original{prefix}AccuracyGraphKnots"]
        if not name or knots is None:
            continue
        points = list(knots.unpack("<2f"))[: weap_def[f"original{prefix}AccuracyGraphKnotCount"]]
        lines = [ACCURACY_HEADER, "", str(len(points))] + [f"{x:.4f} {y:.4f}" for x, y in points]
        out[f"accuracy/{kind}/{name}"] = "\n".join(lines) + "\n"
    return out


def write_file(out, name, text):
    path = os.path.join(out, name)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="latin-1", newline="") as fh:
        fh.write(text)


@dumper("weapon")
def write(walk, out, ctx=None):
    table = load_fields(walk.game)
    enums = walk.program.data["enums"]
    found = walk.by_type("weapon")
    written, graphs = 0, set()
    for asset in found:
        if asset.name.startswith(","):
            continue
        weapon = Weapon(walk, asset.record, enums)
        write_file(out, f"{FOLDER}/{asset.name}", infostring(weapon, table))
        written += 1
        for name, text in accuracy_graphs(weapon).items():
            if name not in graphs:
                graphs.add(name)
                write_file(out, name, text)
    print(f"      {written} of {len(found)} weapons written, {len(graphs)} accuracy graph(s)")
