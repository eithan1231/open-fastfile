"""`weapon`, `attachment`, `attachmentunique`: Black Ops II's weapon assets as OAT's infostrings.

- `weapon`: each WeaponVariantDef as a `WEAPONFILE` at `weapons/<name>`, every key of
  `scripts/cod/data/t6/weapon_fields.json` (OAT's `WeaponFields.h`), through IW5's writer
  (iw5/dumpers/weapon.py). OAT's `WeaponFullDef` is the variant def and the WeaponDef
  it points at with their arrays inlined, as on T5; which of the two holds each array
  is `ON_VARIANT`.
- `attachment`: each WeaponAttachment as an `ATTACHMENTFILE` at `attachment/<name>`,
  the table's `attachment_fields`: what fitting it does to *any* gun, mostly scales.
- `attachmentunique`: each WeaponAttachmentUnique as an `ATTACHMENTUNIQUEFILE` at
  `attachmentunique/<name>` (`attachment_unique_fields`): what it does to *one* gun,
  its model, tag, clips, sounds and hit-location multipliers. `au_<gun>_<attachment>`,
  and `au_<gun>_<a>+<b>` for a pair the game authored together.

A weapon's `attachments` and `attachmentUniques` are arrays indexed by attachment
type (`szAttachmentTypeNames`: 0 is `none`, whose entry is `defaultattachment`), the
uniques' pairs after the 63rd. Both are written as names, in that order, which is
what `attachmentType` in each asset says too (docs/cod/reference.md#black-ops-ii-weapons).
"""

import re

from ...iw5.dumpers import weapon as iw

WEAPON_HEADER = iw.HEADER
ATTACHMENT_HEADER = "ATTACHMENTFILE"
UNIQUE_HEADER = "ATTACHMENTUNIQUEFILE"
ATTACHMENT_FOLDER = "attachment"
UNIQUE_FOLDER = "attachmentunique"
# The WeaponFullDef arrays that are the variant def's; every other one is the WeaponDef's.
ON_VARIANT = {
    "szXAnims",
    "hideTags",
    "attachments",
    "attachmentUniques",
    "attachViewModel",
    "attachWorldModel",
    "attachViewModelTag",
    "attachWorldModelTag",
}
NOTETRACK_SOUNDS = 20  # WeaponDef.notetrackSoundMapKeys[20]
HIDE_TAGS = 32
ENUMS = {
    "WFT_BARRELTYPE": "barrelTypeNames",
    "AFT_ATTACHMENTTYPE": "szAttachmentTypeNames",
    "AUFT_ATTACHMENTTYPE": "szAttachmentTypeNames",
    "AFT_PENETRATE_TYPE": "penetrateTypeNames",
    "AFT_FIRETYPE": "szWeapFireTypeNames",
    "AUFT_OVERLAYRETICLE": "szWeapOverlayReticleNames",
}


class Weapon(iw.Weapon):
    """One T6 WeaponFullDef, read by the field table's paths."""

    def _indexed(self, path):
        """`szXAnims[WEAP_ANIM_IDLE]` -> `szXAnims[1]`, by the load program's enums; `v.x` -> `v.v[0]`."""
        path = re.sub(r"\[([A-Z_][A-Z0-9_]*)\]", lambda m: f"[{self.enums[m.group(1)]}]", path)
        # T6's vec3_t is a union of {x, y, z} and `v[3]`, and only `v` is named: `.x` is `.v[0]`.
        return re.sub(r"\.([xyz])$", lambda m: f".v[{'xyz'.index(m.group(1))}]", path)

    def _owner(self, path):
        path = self._indexed(path)
        head, _, rest = path.partition(".")
        if head in ("weapVariantDef", "weapDef"):
            return (self.weap_def if head == "weapDef" else self.complete), rest
        if path == "weaponCamo":  # OAT copies the camo's name into a char[64]
            return self.weap_def, path
        return (self.complete if path.split("[")[0] in ON_VARIANT else self.weap_def), path


class Unique(Weapon):
    """One WeaponAttachmentUniqueFull: the asset as `attachment.`, its arrays beside it."""

    def __init__(self, walk, record, enums):  # no WeaponDef to point at, unlike a weapon
        self.walk, self.complete, self.enums, self.weap_def = walk, record, enums, record

    def _owner(self, path):
        head, _, rest = self._indexed(path).partition(".")
        return self.complete, (rest if head == "attachment" else self._indexed(path))


class Attachment(Weapon):
    """One WeaponAttachment, whose paths are its own members."""

    def __init__(self, walk, record, enums):  # no WeaponDef to point at, unlike a weapon
        self.walk, self.complete, self.enums, self.weap_def = walk, record, enums, record

    def _owner(self, path):
        return self.complete, self._indexed(path)


def _names(values):
    return "\n".join(iw.plain(v) or "" for v in values if v is not None and iw.plain(v))


def value(record, key, path, kind, names):
    """The infostring value of one field: T6's own kinds here, the rest IW5's."""
    if kind == "WFT_NOTETRACKSOUNDMAP":
        keys = [record.script_string(i) for i in record.array(path, NOTETRACK_SOUNDS)]
        values = [record.script_string(i) for i in record.array(path.replace("Keys", "Values"), NOTETRACK_SOUNDS)]
        return "\n".join(f"{k} {v}" if v else k for k, v in zip(keys, values, strict=True) if k)
    if kind in ("WFT_HIDETAGS", "AUFT_HIDETAGS"):
        tags = [record.script_string(i) for i in record.array(path, HIDE_TAGS)]
        return "\n".join(t for t in tags if t)
    if kind in ("WFT_ATTACHMENTS", "WFT_ATTACHMENT_UNIQUES"):
        found = record.get(path)
        return _names(list(found)) if found is not None else ""
    if kind in ("WFT_WEAPON_CAMO", "AUFT_CAMO"):
        try:
            camo = record.get("weaponCamo" if kind == "WFT_WEAPON_CAMO" else path)
        except (AttributeError, KeyError):
            camo = None
        return iw.plain(camo) or "" if not isinstance(camo, int) else ""
    if kind == "WFT_BOUNCE_SOUND":
        sounds = record.get(path)
        first = sounds[0] if sounds is not None else None
        return first[: first.rfind("_default")] if isinstance(first, str) and "_default" in first else ""
    if kind == "AUFT_ANIM_NAME":
        v = record.get(path)
        return v if v is not None else ""
    if kind == "CSPFT_UINT":
        return str((record.get(path) or 0) & 0xFFFFFFFF)
    if kind in ENUMS:
        table, index = names[ENUMS[kind]], iw.signed((record.get(path) or 0) & 0xFFFFFFFF)
        return table[index] if 0 <= index < len(table) else ""
    return iw.value(record, key, path, kind, names)


def infostring(record, fields, names, header):
    return header + "".join(f"\\{key}\\{value(record, key, path, kind, names)}" for key, path, kind in fields)


def _own(found):
    return [asset for asset in found if not asset.name.startswith(",")]


def write(walk, out, ctx=None):
    table = iw.load_fields(walk.game)
    enums = walk.program.data["enums"]
    found = walk.by_type("weapon")
    written, graphs = 0, set()
    for asset in _own(found):
        weapon = Weapon(walk, asset.record, enums)
        iw.write_file(out, f"{iw.FOLDER}/{asset.name}", infostring(weapon, table["fields"], table["names"], WEAPON_HEADER))
        written += 1
        for name, text in iw.accuracy_graphs(weapon).items():
            if name not in graphs:
                graphs.add(name)
                iw.write_file(out, name, text)
    print(f"      {written} of {len(found)} weapons written, {len(graphs)} accuracy graph(s)")


def write_attachments(walk, out, ctx=None):
    table = iw.load_fields(walk.game)
    enums = walk.program.data["enums"]
    written = 0
    for asset in _own(walk.by_type("attachment")):
        record = Attachment(walk, asset.record, enums)
        text = infostring(record, table["attachment_fields"], table["names"], ATTACHMENT_HEADER)
        iw.write_file(out, f"{ATTACHMENT_FOLDER}/{asset.name}", text)
        written += 1
    print(f"      {written} attachment(s) written")


def write_uniques(walk, out, ctx=None):
    table = iw.load_fields(walk.game)
    enums = walk.program.data["enums"]
    written = 0
    for asset in _own(walk.by_type("attachmentunique")):
        record = Unique(walk, asset.record, enums)
        text = infostring(record, table["attachment_unique_fields"], table["names"], UNIQUE_HEADER)
        iw.write_file(out, f"{UNIQUE_FOLDER}/{asset.name}", text)
        written += 1
    print(f"      {written} attachment unique(s) written")
