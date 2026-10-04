"""`attachment`: each `WeaponAttachment` as JSON, under `attachment/<name>.json`.

**An S1 attachment is a list of edits to the weapon it is fitted to**, not
IW5's and IW6's blocks of replacement values: `fields[i]` changes the
`WeaponDef` member at byte `fieldOffsets[i]`, setting it or scaling it. So
the dump keeps that shape -- each edit under the weapon-file key the weapon
dumper writes for the member (dumpers/weapon.py), with its operation and its
value in that key's units -- and `scripts/cod/attachments.py` applies them to
a weapon's own infostring (`s1_entry`). Nothing else about the file is IW6's
beyond `_type` and the model arrays.

Every edit names a member **and** says what kind of value it holds, which is
the independent check on the `WeaponDef` layout: across common_mp and
patch_common_mp, all 697 edits land on a member of the declared kind, at 150
distinct offsets. `edit` refuses one that does not.

Like IW6's, they are reached through the weapons: most of the asset list's
entries are aliases of an attachment a weapon loaded inline (walkers.py).
"""

import struct

from ...iw6.dumpers.common import asset_path, plain, write_json
from . import dumper
from .weapon import ANIMS, ENUMS, OVERLAY, PAIRS, TIMERS, VECTORS, WEAPDEF, _members, key_of

FOLDER = "attachment"
SCHEMA_VERSION = 1

# WAFieldType -> what the member it edits must be, and how its value reads.
KINDS = {
    0: "string",
    4: "int",
    6: "bool",
    7: "float",
    9: "ms",  # an int of milliseconds, set in milliseconds
    10: "fx",
    11: "model",
    12: "anim",
    13: "material",
    15: "sound",
    16: "tracer",
}
# The layout's own account of each kind: (Field.kind, base type) as walkers.Layout holds them.
POINTEE = {
    "string": "",
    "fx": "FxEffectDef",
    "model": "XModel",
    "material": "Material",
    "sound": "snd_alias_list_t",
    "tracer": "TracerDef",
}
KIND_POINTER, KIND_FLOAT = 4, 3
# WAFieldCode. x64-zt names 4 "add" and 6 "multiply"; every code-4 edit in the
# zones is a factor between 0.4 and 1.5 (an extended magazine's clip size by 1.5,
# a grip's recoil by 0.9), where an addition would be meaningless. No 6 occurs.
OPS = {0: "set", 3: "set", 4: "scale"}
FLAGS = (
    "hideIronSightsWithThisAttachment showMasterRail showSideRail shareAmmoWithAlt knifeAlwaysAttached "
    "useDualFOV riotShield adsSceneBlur automaticAttachment"
).split()
MODEL_ARRAYS = ("worldModels", "viewModels", "reticleViewModels")


def members(layout, typename="WeaponDef", base=0, prefix=""):
    """{byte offset: (member path, Field)} for every scalar and pointer of `typename`, nested structs flattened."""
    out = {}
    for name, field in layout.fields[typename].items():
        if field.kind != KIND_POINTER and field.base in layout.fields and field.base != "scr_string_t":
            out.update(members(layout, field.base, base + field.offset, f"{prefix}{name}."))
        elif field.elem and field.size > field.elem:
            for i in range(field.size // field.elem):
                out.setdefault(base + field.offset + i * field.elem, (f"{prefix}{name}[{i}]", field))
        else:
            out.setdefault(base + field.offset, (prefix + name, field))
    return out


def weapon_keys():
    """{member path: (weapon-file key, how the weapon dumper reads it)}, for every member it writes."""
    out = {member: (key_of(member), kind) for kind, member in _members(WEAPDEF)}
    out |= {f"stateTimers.{m}": (key_of(m), kind) for kind, m in _members(TIMERS)}
    out |= {f"overlay.{m}": ("adsOverlay" + m[0].upper() + m[1:], kind) for kind, m in _members(OVERLAY)}
    for member, suffixes in VECTORS.items():
        out |= {f"{member}[{i}]": (member + s, "float") for i, s in enumerate(suffixes)}
    for member, keys in PAIRS.items():
        out |= {f"{member}[{i}]": (key, "float") for i, key in enumerate(keys)}
    return out


def _kind_of(field):
    if field.kind == KIND_POINTER:
        return "pointer", field.base
    if field.base == "bool":
        return "bool", None
    return ("float", None) if field.kind == KIND_FLOAT else ("int", None)


def edit(member, field, kind, op, parm, where):
    """One edit's value in the weapon file's units, after checking it against the member it edits."""
    have, base = _kind_of(field)
    want = {"int": "int", "ms": "int", "bool": "bool", "float": "float"}.get(kind, "pointer")
    if have != want or (want == "pointer" and base != POINTEE[kind]):
        raise SystemExit(f"{where}: a {kind} edit lands on {member}, which is {have} {base or ''}")
    if want == "pointer":
        return plain(parm)
    if kind == "bool":
        return bool(parm[0])
    if op == "scale" or kind == "float":
        return float(f"{struct.unpack_from('<f', parm)[0]:g}")
    value = struct.unpack_from("<i", parm)[0]
    if field.base in ENUMS:  # written as the weapon file spells it: `Single Shot`, not 1
        names = ENUMS[field.base]
        return names[value] if 0 <= value < len(names) else str(value)
    return value / 1000.0 if kind == "ms" else value


def fields(zone, found, offsets_at, where):
    """The attachment's edits, each under the weapon-file key of the member it edits."""
    layout = zone.layout
    table, keys = members(layout), weapon_keys()
    slots = {slot: key for key, slot in ANIMS.items()}
    count = len(found)
    offsets = struct.unpack_from(f"<{count}H", zone.data, offsets_at) if count else ()
    out = []
    for offset, (index, code, op_code, parm) in zip(offsets, found, strict=True):
        kind, op = KINDS.get(code), OPS.get(op_code)
        if kind is None or op is None:
            raise SystemExit(f"{where}: an edit of type {code}, code {op_code}, which no source names")
        if kind == "anim":
            out.append({"key": slots.get(index), "slot": index, "type": kind, "op": op, "value": plain(parm)})
            continue
        if offset not in table:
            raise SystemExit(f"{where}: an edit at byte {offset}, which is no WeaponDef member")
        member, field = table[offset]
        key = keys.get(member, (None,))[0]
        entry = {"key": key, "member": member, "type": kind, "op": op}
        entry["value"] = edit(member, field, kind, op, parm, where)
        out.append(entry)
    return out


def attachment_json(zone, attach, name):
    """One attachment as its own record plus its edits."""
    record = attach.record
    out = {"_game": "s1", "_type": FOLDER, "_version": SCHEMA_VERSION, "displayName": attach.display or ""}
    for member, enum in (("type", "AttachmentType"), ("weaponType", "weapType_t"), ("weapClass", "weapClass_t")):
        value, names = record[member], ENUMS[enum]
        out[member] = names[value] if 0 <= value < len(names) else str(value)
    for member in MODEL_ARRAYS:
        out[member] = [plain(m) for m in attach.models.get(member) or [] if m]
    out |= {flag: bool(record[flag]) for flag in FLAGS}
    out["fields"] = fields(zone, attach.fields, attach.offsets, name)
    return out


@dumper("attachment", parts=("displayName", "type", "worldModels", "viewModels", "fields", *FLAGS))
def write(walked, out):
    zone = walked.zone
    found = {n: a for n, a in zone.found.get("ATTACHMENT", {}).items() if n and not n.startswith(",")}
    for name, attach in sorted(found.items()):
        write_json(asset_path(out, f"{FOLDER}/{name}.json"), attachment_json(zone, attach, name))
    if found:
        print(f"      {len(found)} attachment(s) written, reached through the weapons that list them")
