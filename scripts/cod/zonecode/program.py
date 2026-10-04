"""A game's load program: `scripts/cod/data/<g>/zonecode.json`, read once.

The file is generated from OpenAssetTools' ZoneCode by reverse/x86-zone (its README
documents the schema, and proves every loader it describes identical to OAT's
generated one), and ships in the repo (scripts/cod/data/README.md). `$ZONECODE_<G>`
names another copy; the game's other tables are read from beside whichever is used.
"""

import json
import os
from functools import lru_cache

from ..zone.spec import SPECS
from .values import StructInfo

DATA = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")


def path_for(game):
    return os.environ.get(f"ZONECODE_{game.upper()}", os.path.join(DATA, game, "zonecode.json"))


class Program:
    """zonecode.json as the walker uses it: structs by name, asset types by index, loaders by struct."""

    def __init__(self, data, spec=None):
        self.data = data
        self.game = data["game"].lower()
        self.spec = spec or SPECS[self.game]
        if data["pointer_size"] != self.spec.pointer_size:
            raise ValueError(
                f"{self.game}: zonecode.json has {data['pointer_size']}-byte pointers, the zone spec {self.spec.pointer_size}"
            )
        names = tuple(b["name"] for b in sorted(data["blocks"], key=lambda b: b["index"]))
        # XFILE_BLOCK_TEMP <-> TEMP: the two must name the same blocks in the same order.
        short = tuple(n.removeprefix("XFILE_BLOCK_") for n in names)
        if short != self.spec.blocks:
            raise ValueError(f"{self.game}: zonecode.json's blocks {short} are not the zone spec's {self.spec.blocks}")
        self.block_index = {name: i for i, name in enumerate(names)}
        runtime = {b["index"] for b in data["blocks"] if b["type"] == "runtime"}
        if runtime != set(self.spec.runtime_blocks):
            raise ValueError(f"{self.game}: runtime blocks {sorted(runtime)} disagree with the zone spec")
        self.asset_types = {t["index"]: t for t in data["asset_types"]}
        self.loaders = {a["struct"]: a for a in data["assets"]}
        # The type OAT registers a struct's assets under: its loader's (`AssetClipMapPvs`), whatever
        # type the XAsset entry gave. T5 and IW4 load clipMap_t for two types, and OAT lists both
        # as `clipmap`. A nested handle names its struct, so it means that type too.
        declared = {a["struct"]: a["name"].removeprefix("Asset").upper() for a in data["assets"]}
        self.type_of = {}
        for t in data["asset_types"]:
            if "struct" in t:
                own = t["enum"].removeprefix("ASSET_TYPE_").replace("_", "") == declared.get(t["struct"])
                if own or t["struct"] not in self.type_of:
                    self.type_of[t["struct"]] = t
        self._structs = {}

    @classmethod
    def from_file(cls, path, spec=None):
        with open(path, encoding="utf-8") as fh:
            return cls(json.load(fh), spec)

    def struct(self, name):
        info = self._structs.get(name)
        if info is None:
            defn = self.data["structs"].get(name)
            if defn is None:
                raise KeyError(f"{self.game}: no struct {name!r} in zonecode.json")
            info = self._structs[name] = StructInfo(self, defn)
        return info


@lru_cache(maxsize=4)
def load(game):
    """The program for `game` (`iw4`, `iw5`, `t5`), from the generated zonecode.json."""
    path = path_for(game)
    if not os.path.exists(path):
        raise FileNotFoundError(f"no load program at {path}: it ships in scripts/cod/data/ (scripts/cod/data/README.md)")
    return Program.from_file(path)
