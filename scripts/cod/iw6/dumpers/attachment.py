"""`attachment`: each `WeaponAttachment` as OpenAssetTools' JSON, under `attachment/<name>.json`.

IW6 describes an attachment the way IW5 does — one asset per attachment, with
its numbers in blocks a weapon's own values are replaced by — and the blocks
carry the same member names, so `scripts/cod/attachments.py` reads this dump
without knowing which game wrote it.

**They are not in a zone's asset list the way other assets are.** `assets.py`
counts 63 `ATTACHMENT` entries in `common_core_mp.ff`, and every one of them is
an alias: each attachment is loaded in full at the first weapon that lists it,
and the list entry then points at what that weapon already loaded. So the walk
records none of them under `ATTACHMENT`, and this writer reaches them the only
way they exist — through `WeaponCompleteDef.scopes` / `underBarrels` / `others`.

The shape is x64-zt's `WeaponAttachment` read member by member, so what is
written is whatever that struct declares: a block whose pointer is null is left
out, as OAT leaves out an empty `std::optional`. Two things differ from IW5's
dump on purpose:

- **`AttADSOverlay.overlay` is flattened.** IW5 keeps the four shaders, the
  reticle and the sizes directly on the block and OAT writes them there; IW6
  moved them into an `ADSOverlay`, which would otherwise nest one level deeper
  than `attachments.py` looks.
- **No sound or effect is written.** As in the weapon dump, a sound alias is
  resolved by `DB_FindXAssetHeader`, which the emulator stubs; nothing in
  `WeaponAttachment` is one today, and if the struct grows one it will be null
  rather than wrong.
"""

from ..memory import Struct
from . import dumper
from .clipmap import cstring
from .common import asset_path, plain, write_json
from .weapon import ATTACHMENT_ARRAYS, ENUMS, asset, number, pointers

FOLDER = "attachment"
SCHEMA_VERSION = 1

# The model arrays and their lengths, from x64-zt's iw6 weaponattachment.cpp.
MODEL_ARRAYS = {"worldModels": 64, "viewModels": 64, "reticleViewModels": 16}
# Members that are the asset's identity rather than part of its description.
SKIP = ("szInternalName", "name")
# x64-zt spells one block lower case; OAT's IW5 JSON calls it `ammoGeneral`.
RENAMED = {"szDisplayName": "displayName", "ammogeneral": "ammoGeneral"}
# The blocks whose own members are written as a nested object (`AttachmentType` is an enum, not one).
BLOCK, POINTER = "Att", 4
# `AttADSOverlay.overlay`, which IW5 keeps flat and OAT writes flat.
FLATTEN = "ADSOverlay"

KINDS = {"XModel", "Material", "TracerDef", "FxEffectDef"}
# A sound alias is a header the emulator never resolves (see the docstring): null, not wrong.
UNRESOLVED = {"snd_alias_list_t"}
PARTS = (
    "displayName type weaponType weapClass worldModels viewModels reticleViewModels ammoGeneral sight reload "
    "addOns general aimAssist ammunition damage locationDamage idleSettings adsSettings adsSettingsMain "
    "scopeDriftSettings scopeDriftSettingsMain hipSpread gunKick viewKick adsOverlay ui rumbles projectile "
    "ammunitionScale damageScale damageScaleMin stateTimersScale fireTimersScale idleSettingsScale "
    "adsSettingsScale adsSettingsScaleMain hipSpreadScale gunKickScale viewKickScale viewCenterScale loadIndex "
    "hideIronSightsWithThisAttachment shareAmmoWithAlt"
).split()


def scalar(record, member, field):
    """One member of a block, by what the layout says it is."""
    if field.base in ENUMS:
        names = ENUMS[field.base]
        index = record[member]
        return names[index] if 0 <= index < len(names) else ""
    if field.base == "bool":
        return bool(record[member])
    if field.base in UNRESOLVED:
        return None
    if field.base in KINDS:
        return asset(record.emulator, record[member], field.base) or None
    if field.kind == 4:  # a pointer to something else here is a string
        return plain(cstring(record.emulator, record[member]))
    return float(number(record[member])) if field.kind == 3 else record[member]


def block(emulator, typename, address):
    """One `Att*` block as an object; `ADSOverlay` is flattened into whatever holds it."""
    record = Struct(emulator, typename, address)
    out = {}
    for member, field in emulator.z.layout.fields[typename].items():
        if field.base == FLATTEN:
            out |= block(emulator, FLATTEN, address + field.offset)
        else:
            out[member] = scalar(record, member, field)
    return out


def attachment_json(emulator, address):
    """One `WeaponAttachment` in the shape OpenAssetTools' IW5 attachment dumper writes."""
    record = Struct(emulator, "WeaponAttachment", address)
    out = {"_game": "iw6", "_type": FOLDER, "_version": SCHEMA_VERSION}
    for member, field in emulator.z.layout.fields["WeaponAttachment"].items():
        if member in SKIP:
            continue
        key = RENAMED.get(member, member)
        if member in MODEL_ARRAYS:
            models = [asset(emulator, p, "XModel") for p in pointers(record, member, MODEL_ARRAYS[member])]
            out[key] = [m for m in models if m]
        elif field.kind == POINTER and field.base.startswith(BLOCK):
            target = record[member]
            if target:
                out[key] = block(emulator, field.base, target)
        elif key == "displayName":
            out[key] = cstring(emulator, record[member])
        else:
            out[key] = scalar(record, member, field)
    return out


def accepted(zone):
    """{name: address} of every attachment any weapon in this zone lists."""
    out = {}
    for loaded in zone.found.get("WEAPON", {}).values():
        complete = Struct.of(zone, loaded)
        for path, count in ATTACHMENT_ARRAYS:
            for pointer in pointers(complete, path, count):
                if not pointer:
                    continue
                name = cstring(zone.emulator, Struct(zone.emulator, "WeaponAttachment", pointer)["szInternalName"])
                if name:
                    out.setdefault(plain(name), pointer)
    return out


@dumper("attachment", parts=PARTS)
def write(walked, out):
    zone = walked.zone
    found = accepted(zone)
    for name, address in sorted(found.items()):
        write_json(asset_path(out, f"{FOLDER}/{name}.json"), attachment_json(zone.emulator, address))
    print(f"      {len(found)} attachment(s) written, reached through the weapons that list them")
