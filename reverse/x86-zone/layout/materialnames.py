#!/usr/bin/env python3
"""Turn OAT's list of known material constant and texture names for one game into data.

    materialnames.py t5|t6 [-o scripts/cod/data/<g>/material_names.json]

A material stores each texture slot and constant as a hash of its name. OAT's material
dumper names one back from two sources: the constant tables of the zone's shaders, and
a fixed list of the engine's own names (`KNOWN_CONSTANT_NAMES` and
`KNOWN_TEXTURE_DEF_NAMES` in `ObjWriting/Game/<G>/Material/MaterialConstantZoneState<G>.cpp`).
Which slots come out named is the lists' decision as much as the zone's, so this keeps
T5's and T6's as data, the way infostring.py keeps the weapon field table, for
scripts/cod/t5/dumpers/material.py and scripts/cod/t6/dumpers/material.py. (IW4's and IW5's lists are short and in
scripts/cod/iw5/dumpers/shaders.py.)
"""

import argparse
import json
import os
import re

import oat

SOURCES = {
    "t5": ("src", "ObjWriting", "Game", "T5", "Material", "MaterialConstantZoneStateT5.cpp"),
    "t6": ("src", "ObjWriting", "Game", "T6", "Material", "MaterialConstantZoneStateT6.cpp"),
}
ARRAY = re.compile(r"const\s+char\s*\*\s*(KNOWN_CONSTANT_NAMES|KNOWN_TEXTURE_DEF_NAMES)\s*\[\s*\]\s*\{(.*?)\};", re.S)
STRING = re.compile(r'"((?:[^"\\]|\\.)*)"')


def parse(text):
    """{"constants": [name], "textures": [name]}, in the source's order."""
    found = {name: STRING.findall(body) for name, body in ARRAY.findall(text)}
    return {"constants": found.get("KNOWN_CONSTANT_NAMES", []), "textures": found.get("KNOWN_TEXTURE_DEF_NAMES", [])}


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("game", choices=sorted(SOURCES))
    ap.add_argument("-o", "--out")
    args = ap.parse_args()
    src = oat.path(*SOURCES[args.game])
    with open(src, encoding="utf-8") as fh:
        text = fh.read()
    data = parse(text)
    for key, array in (("constants", "KNOWN_CONSTANT_NAMES"), ("textures", "KNOWN_TEXTURE_DEF_NAMES")):
        body = re.search(array + r"\s*\[\s*\]\s*\{(.*?)\};", text, re.S)
        if not data[key] or body is None or len(data[key]) != body.group(1).count('"') // 2:
            raise SystemExit(f"{src}: {array} not read whole")
    out = args.out or oat.data_path(args.game, "material_names.json")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as fh:
        json.dump({"game": args.game, "source": os.path.relpath(src, oat.OAT), **data}, fh, indent=1)
        fh.write("\n")
    print(f"{os.path.abspath(out)}: {len(data['constants'])} constant and {len(data['textures'])} texture names")


if __name__ == "__main__":
    main()
