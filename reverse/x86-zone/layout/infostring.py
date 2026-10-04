#!/usr/bin/env python3
"""Turn OAT's weapon field table for one game into scripts/cod/data/<g>/weapon_fields.json.

    infostring.py <iw4|iw5|t5|t6> [-o scripts/cod/data/<g>/weapon_fields.json]

For IW5, beside it, attachment_enums.json: the spelling OAT's attachment JSON gives
each enum value (`JsonWeaponAttachment.h`), {C enum type: {enumerator: string}},
first entry first (nlohmann writes that one for a value it has no entry for).

A weapon file is an infostring, `WEAPONFILE\\key\\value\\...`, and which member each
key reads, and how, is a table in OAT's `ObjCommon/Game/<G>/Weapon/WeaponFields.h`:
one `{key, offsetof(WeaponFullDef, <path>), <type>}` row per key, plus the name
tables its enum types print through (in the same file on IW5, in
`InfoString/EnumStrings.h` on IW4). This keeps that table as data, the way
zonecode.py keeps the load program, so that scripts/cod/iw5/dumpers/weapon.py can
write every key OAT writes, with the same type, without a hand-copied list.

`WeaponFullDef` is OAT's own struct, not the game's: `WeaponCompleteDef` (T5:
`WeaponVariantDef`) and the `WeaponDef` it points at, side by side, then every array
either of them points at, inlined. A path keeps that shape (`weapDef.fFireDelay`,
`gunXModel[3]`); the dumper maps each head back onto the zone's two records.

T5 has a second table, `flameTableFields` (`FlameTableFields.h`), for the flame
tables a flamethrower's WeaponDef points at; it is written as `flame_fields`, its
paths relative to T5's `FlameTable`. T6 has it too, and two more for its attachment
assets: `attachment_fields` (`AttachmentFields.h`, paths relative to
`WeaponAttachment`) and `attachment_unique_fields` (`AttachmentUniqueFields.h`,
relative to OAT's `WeaponAttachmentUniqueFull`: the asset as `attachment.`, its
arrays inlined beside it, as `WeaponFullDef` does for a weapon).
"""

import argparse
import json
import os
import re

import oat

FIELDS = {g: ("src", "ObjCommon", "Game", g.upper(), "Weapon", "WeaponFields.h") for g in ("iw4", "iw5", "t5", "t6")}
NAME_TABLES = {
    "iw4": ("src", "ObjCommon", "Game", "IW4", "InfoString", "EnumStrings.h"),
    "iw5": FIELDS["iw5"],
    "t5": ("src", "ObjCommon", "Game", "T5", "Weapon", "WeaponStrings.h"),
    "t6": ("src", "ObjCommon", "Game", "T6", "Weapon", "WeaponStrings.h"),
}
FLAME_FIELDS = {g: ("src", "ObjCommon", "Game", g.upper(), "Weapon", "FlameTableFields.h") for g in ("t5", "t6")}
# T6's attachment assets: (the key written, the header, its table's name, the struct its paths are relative to).
EXTRA_TABLES = {
    "t6": (
        ("attachment_fields", "AttachmentFields.h", "attachment_fields", "WeaponAttachment"),
        ("attachment_unique_fields", "AttachmentUniqueFields.h", "attachment_unique_fields", "WeaponAttachmentUniqueFull"),
    )
}
ATTACHMENT_JSON = {"iw5": ("src", "ObjCommon", "Game", "IW5", "Weapon", "JsonWeaponAttachment.h")}

ROW = re.compile(r'\{\s*"(\w+)"\s*,\s*offsetof\(\s*WeaponFullDef\s*,\s*([^)]+?)\s*\)\s*,\s*(\w+)\s*\}')
FLAME_ROW = re.compile(r'\{\s*"(\w+)"\s*,\s*offsetof\(\s*FlameTable\s*,\s*([^)]+?)\s*\)\s*,\s*(\w+)\s*\}')


def struct_rows(struct):
    """The row pattern of a field table whose paths are relative to `struct`."""
    return re.compile(r'\{\s*"(\w+)"\s*,\s*offsetof\(\s*' + struct + r"\s*,\s*([^)]+?)\s*\)\s*,\s*(\w+)\s*\}")


NAMES = re.compile(r"inline\s+const\s+char\s*\*\s*(\w+)\s*\[\s*\]\s*\{(.*?)\};", re.S)
STRING = re.compile(r'"((?:[^"\\]|\\.)*)"')
JSON_ENUM = re.compile(r"NLOHMANN_JSON_SERIALIZE_ENUM\(\s*(\w+)\s*,\s*\{(.*?)\}\s*\)\s*;", re.S)
JSON_PAIR = re.compile(r'\{\s*(\w+)\s*,\s*"([^"]*)"\s*\}')


def parse(text, names_text=None):
    """{"fields": [[key, path, type]], "names": {table: [value]}} from WeaponFields.h, and from
    the header holding the name tables when that is another one."""
    table = text[text.index("weapon_fields[]") :]
    table = table[: table.index("};")]
    fields = [[key, path.replace(" ", ""), kind] for key, path, kind in ROW.findall(table)]
    names = {name: STRING.findall(body) for name, body in NAMES.findall(names_text or text)}
    return {"fields": fields, "names": names}


def json_enums(text):
    """{enum type: {enumerator: JSON string}} from a header's NLOHMANN_JSON_SERIALIZE_ENUM blocks."""
    return {name: dict(JSON_PAIR.findall(body)) for name, body in JSON_ENUM.findall(text)}


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("game", choices=sorted(FIELDS))
    ap.add_argument("-o", "--out")
    args = ap.parse_args()
    src = oat.path(*FIELDS[args.game])
    with open(src, encoding="utf-8") as fh:
        text = fh.read()
    names_src = oat.path(*NAME_TABLES[args.game])
    with open(names_src, encoding="utf-8") as fh:
        data = parse(text, fh.read())
    if not data["names"]:
        raise SystemExit(f"{names_src}: no name tables read")
    rows = text[text.index("weapon_fields[]") :].split("};")[0].count("offsetof(")
    if len(data["fields"]) != rows:
        raise SystemExit(f"{src}: read {len(data['fields'])} of {rows} field rows")
    if args.game in FLAME_FIELDS:
        flame_src = oat.path(*FLAME_FIELDS[args.game])
        with open(flame_src, encoding="utf-8") as fh:
            flame = fh.read()
        table = flame[flame.index("flameTableFields[]") :].split("};")[0]
        data["flame_fields"] = [[key, path.replace(" ", ""), kind] for key, path, kind in FLAME_ROW.findall(table)]
        if len(data["flame_fields"]) != table.count("offsetof("):
            raise SystemExit(f"{flame_src}: read {len(data['flame_fields'])} of {table.count('offsetof(')} flame rows")
    for key, header, name, struct in EXTRA_TABLES.get(args.game, ()):
        extra_src = oat.path("src", "ObjCommon", "Game", args.game.upper(), "Weapon", header)
        with open(extra_src, encoding="utf-8") as fh:
            extra = fh.read()
        table = extra[extra.index(f"{name}[]") :].split("};")[0]
        data[key] = [[k, path.replace(" ", ""), kind] for k, path, kind in struct_rows(struct).findall(table)]
        if len(data[key]) != table.count("offsetof("):
            raise SystemExit(f"{extra_src}: read {len(data[key])} of {table.count('offsetof(')} rows")
    out = args.out or oat.data_path(args.game, "weapon_fields.json")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as fh:
        json.dump({"game": args.game, "source": os.path.relpath(src, oat.OAT), **data}, fh, indent=1)
        fh.write("\n")
    print(f"{os.path.abspath(out)}: {len(data['fields'])} fields, {len(data['names'])} name tables")

    if args.game not in ATTACHMENT_JSON:
        return  # IW4 has no attachment asset: a weapon file per combination instead
    src = oat.path(*ATTACHMENT_JSON[args.game])
    with open(src, encoding="utf-8") as fh:
        text = fh.read()
    enums = json_enums(text)
    if len(enums) != text.count("NLOHMANN_JSON_SERIALIZE_ENUM(") or not all(enums.values()):
        raise SystemExit(f"{src}: read {len(enums)} enum tables, some empty or missed")
    out = os.path.join(os.path.dirname(out), "attachment_enums.json")
    with open(out, "w", encoding="utf-8") as fh:
        json.dump({"game": args.game, "source": os.path.relpath(src, oat.OAT), "enums": enums}, fh, indent=1)
        fh.write("\n")
    print(f"{os.path.abspath(out)}: {len(enums)} enum tables")


if __name__ == "__main__":
    main()
