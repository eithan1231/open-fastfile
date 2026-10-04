"""`attachment`: each weapon attachment as OpenAssetTools' JSON, `attachment/<name>.json`.

The JSON is the zone's `WeaponAttachment` member for member: its model arrays
as the names that are set, then each attribute block the attachment points at
(a block it does not point at is left out), then its scales. Each JSON key is
the struct member's own name, so a block is written from its struct definition
in the load program rather than a hand-kept key list. Enums are written as
OAT spells them (`scripts/cod/data/iw5/attachment_enums.json`, beside the load program, from
reverse/x86-zone/layout/infostring.py); an asset by its name without a stub's
comma, a sound by its alias name; a null name or asset is left out.
"""

import json
import os
import struct

from ...zonecode import program
from . import GAME, dumper
from .common import plain

FOLDER = "attachment"
MODEL_ARRAYS = (("worldModels", 16), ("viewModels", 16), ("reticleViewModels", 8))
BLOCKS = (
    "ammoGeneral sight reload addOns general aimAssist ammunition damage locationDamage idleSettings "
    "adsSettings adsSettingsMain hipSpread gunKick viewKick adsOverlay ui rumbles projectile"
).split()
SCALES = (
    "ammunitionScale damageScale damageScaleMin stateTimersScale fireTimersScale idleSettingsScale "
    "adsSettingsScale adsSettingsScaleMain hipSpreadScale gunKickScale viewKickScale viewCenterScale"
).split()


def load_enums():
    path = os.path.join(os.path.dirname(program.path_for("iw5")), "attachment_enums.json")
    if not os.path.exists(path):
        raise SystemExit(f"no IW5 attachment enum table at {path}: it ships in scripts/cod/data/ (scripts/cod/data/README.md)")
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)["enums"]


def f32(value):
    return struct.unpack("<f", struct.pack("<f", value))[0]


class Writer:
    def __init__(self, walk, spellings):
        values = walk.program.data["enums"]
        # {C enum type: {value: JSON string}}; nlohmann writes the first entry for a value it lacks.
        self.enums = {t: {values[k]: v for k, v in table.items()} for t, table in spellings.items()}
        self.first = {t: next(iter(table.values())) for t, table in spellings.items()}

    def enum(self, kind, value):
        if kind not in self.enums:
            return value
        return self.enums[kind].get(value, self.first[kind])

    def member(self, out, record, m):
        """Write one struct member into `out`, as OAT's JSON writes it."""
        name, kind, value = m["name"], m["type"], record[m["name"]]
        pointer = any("ptr" in mod for mod in m.get("mods", ()))
        if kind == "SndAliasCustom":
            alias = value["name.soundName"] if value is not None and value["name"] is not None else None
            if alias is not None:
                out[name] = alias
        elif m.get("type_kind") == "struct" and not pointer:
            for sub in value.info.defn["members"]:  # an embedded struct is flattened into its parent
                self.member(out, value, sub)
        elif pointer:
            text = plain(value) if not isinstance(value, str) else value
            if text is not None:
                out[name] = text
        elif m.get("type_kind") == "enum":
            out[name] = self.enum(kind, value)
        elif kind == "bool":
            out[name] = bool(value)
        elif kind == "float":
            out[name] = f32(value)
        else:
            out[name] = value

    def block(self, record):
        out = {}
        for m in record.info.defn["members"]:
            self.member(out, record, m)
        return out

    def attachment(self, record):
        data = {"_game": GAME, "_type": "attachment", "_version": 1}
        if record["szDisplayName"] is not None:
            data["displayName"] = record["szDisplayName"]
        members = {m["name"]: m for m in record.info.defn["members"]}
        for key in ("type", "weaponType", "weapClass"):
            data[key] = self.enum(members[key]["type"], record[key])
        for key, count in MODEL_ARRAYS:
            models = record[key]
            data[key] = [plain(model) for model in list(models or ())[:count] if model is not None]
        for key in BLOCKS:
            if record[key] is not None:
                data[key] = self.block(record[key])
        for key in SCALES:
            data[key] = f32(record[key])
        data["loadIndex"] = record["loadIndex"]
        data["hideIronSightsWithThisAttachment"] = bool(record["hideIronSightsWithThisAttachment"])
        data["shareAmmoWithAlt"] = bool(record["shareAmmoWithAlt"])
        return data


@dumper("attachment")
def write(walk, out, ctx=None):
    writer = Writer(walk, load_enums())
    found = walk.by_type("attachment")
    written = 0
    for asset in found:
        if asset.name.startswith(","):
            continue
        path = os.path.join(out, FOLDER, f"{asset.name}.json")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(json.dumps(writer.attachment(asset.record), indent=4, sort_keys=True, ensure_ascii=False) + "\n")
        written += 1
    print(f"      {written} of {len(found)} attachments written")
