"""The zonecode interpreter (scripts/cod/zonecode) on zones built here from a small hand-made
load program, and on a real MW3 zone when one is installed.

The synthetic zones are written by `Writer`, which lays data out the way a zone linker
would (block cursors, alignment that moves only a cursor, runtime blocks with no bytes,
TEMP rewound on pop), independently of the walker that reads them back.
"""

import glob
import os
import struct

import pytest

from scripts.cod.zone.spec import IW5
from scripts.cod.zonecode import actions, program
from scripts.cod.zonecode.values import Array, Record
from scripts.cod.zonecode.walker import walk_zone

F, INS = 0xFFFFFFFF, 0xFFFFFFFE
TEMP, RUNTIME, VIRTUAL = 0, 2, 3
BLOCKS = [("TEMP", "temp"), ("PHYSICAL", "normal"), ("RUNTIME", "runtime"), ("VIRTUAL", "normal"), ("LARGE", "normal")]
BLOCKS += [("CALLBACK", "normal"), ("VERTEX", "normal"), ("INDEX", "normal"), ("SCRIPT", "normal")]


class Writer:
    """A zone as a linker writes it: bytes in stream order, and each block's cursor."""

    def __init__(self):
        self.out = bytearray()
        self.cursor = [0] * len(BLOCKS)
        self.peak = [0] * len(BLOCKS)
        self.block, self.stack = TEMP, []

    def push(self, block):
        self.stack.append((self.block, self.cursor[TEMP]))
        self.block = block

    def pop(self):
        leaving = self.block
        self.block, temp = self.stack.pop()
        if leaving == TEMP:
            self.cursor[TEMP] = temp

    def align(self, n):
        self.cursor[self.block] = -(-self.cursor[self.block] // n) * n

    def put(self, data):
        """Load `data` into the current block: its (block, offset)."""
        where = (self.block, self.cursor[self.block])
        if self.block != RUNTIME:
            self.out += data
        self.cursor[self.block] += len(data)
        self.peak[self.block] = max(self.peak[self.block], self.cursor[self.block])
        return where

    def words(self, *values):
        return self.put(struct.pack(f"<{len(values)}I", *values))

    def insert(self):
        self.align_block(VIRTUAL, 4)
        slot = self.cursor[VIRTUAL]
        self.cursor[VIRTUAL] += 4
        self.peak[VIRTUAL] = max(self.peak[VIRTUAL], self.cursor[VIRTUAL])
        return (VIRTUAL, slot)

    def align_block(self, block, n):
        self.cursor[block] = -(-self.cursor[block] // n) * n

    @staticmethod
    def ref(where, plus=0):
        block, offset = where
        return ((block << 28) | (offset + plus)) + 1

    def zone(self):
        return bytes(struct.pack("<11I", len(self.out), 0, *self.peak) + self.out)


def scalar(size=4, signed=True, is_float=False):
    return {"size": size, "signed": signed, "float": is_float}


def member(name, offset, type_, type_size, mods=(), struct_=None, **extra):
    size = 4 if mods and "ptr" in mods[0] else type_size
    m = {
        "name": name,
        "offset": offset,
        "size": size,
        "type": type_,
        "type_size": type_size,
        "struct": struct_,
        "mods": list(mods),
    }
    if not mods and struct_ is None:
        m["scalar"] = extra.pop("scalar", scalar())
    m.update(extra)
    return m


def field(struct_, *path, size=4, signed=True):
    return {
        "var": struct_,
        "struct": struct_,
        "path": [{"member": p, "deref": False} for p in path],
        "index": [],
        "is": "scalar",
        "size": size,
        "signed": signed,
        "float": False,
    }


def struct_def(name, size, members, load=None, leaf=False, asset=None):
    s = {"kind": "struct", "name": name, "size": size, "leaf": leaf, "members": members, "asset": asset}
    if load is not None:
        s["load"] = load
    return s


PTR, CHAR = [{"ptr": True}], scalar(1)
STRUCTS = {
    # Item: an asset with a string, a union picked by `kind`, a runtime-block array and a
    # reusable pointer array, the last only when `count` > 0.
    "Item": struct_def(
        "Item",
        24,
        [
            member("name", 0, "char", 1, PTR, element=CHAR),
            member("kind", 4, "int", 4),
            member("shape", 8, "Shape", 4, (), "Shape"),
            member("scratch", 12, "int", 4, PTR, element=scalar()),
            member("count", 16, "int", 4),
            member("parts", 20, "Part", 8, [{"ptr": True}, {"ptr": True}], "Part"),
        ],
        {
            "header": "full",
            "push": "XFILE_BLOCK_VIRTUAL",
            "body": [
                {"member": "name", "index": [], "kind": "single_pointer", "null_check": False, "do": {"string": True}},
                {"member": "shape", "index": [], "kind": "embedded", "do": {"load": "Shape", "at_start": False, "actions": []}},
                {
                    "member": "scratch",
                    "index": [],
                    "kind": "array_pointer",
                    "push": "XFILE_BLOCK_RUNTIME",
                    "null_check": True,
                    "alloc": 4,
                    "do": {"raw": 4},
                },
                {
                    "if": {"op": ">", "a": field("Item", "count"), "b": {"int": 0}},
                    "then": [
                        {
                            "member": "parts",
                            "index": [],
                            "kind": "pointer_array",
                            "null_check": True,
                            "alloc": 4,
                            "do": {"ptr_array": "Part", "count": field("Item", "count"), "at_start": True},
                        }
                    ],
                },
            ],
        },
        asset="AssetItem",
    ),
    "Shape": {
        "kind": "union",
        "name": "Shape",
        "size": 4,
        "leaf": False,
        "asset": None,
        "members": [
            member("ints", 0, "int", 4, PTR, element=scalar()),
            member("floats", 0, "float", 4, PTR, element=scalar(4, True, True)),
        ],
        "load": {
            "header": "none",
            "push": None,
            "body": [
                {
                    "select": [
                        {
                            "if": {"op": "==", "a": field("Item", "kind"), "b": {"enum": "KIND_INTS", "value": 1}},
                            "then": [
                                {
                                    "member": "ints",
                                    "index": [],
                                    "kind": "array_pointer",
                                    "null_check": True,
                                    "alloc": 4,
                                    "do": {"raw": 2},
                                }
                            ],
                        },
                        {
                            "if": None,
                            "then": [
                                {
                                    "member": "floats",
                                    "index": [],
                                    "kind": "array_pointer",
                                    "null_check": True,
                                    "alloc": 4,
                                    "do": {"raw": 3},
                                }
                            ],
                        },
                    ]
                }
            ],
        },
    },
    "Part": struct_def(
        "Part",
        8,
        [member("label", 0, "char", 1, PTR, element=CHAR), member("value", 4, "int", 4)],
        {
            "header": "full",
            "push": None,
            "body": [{"member": "label", "index": [], "kind": "single_pointer", "null_check": False, "do": {"string": True}}],
        },
    ),
    # Holder: an asset handle to an Item, and a Blob loaded in TEMP (reusable by alias, with
    # an insert slot) whose bytes the LoadImageData action keeps.
    "Holder": struct_def(
        "Holder",
        12,
        [
            member("name", 0, "char", 1, PTR, element=CHAR),
            member("item", 4, "Item", 24, PTR, "Item"),
            member("blob", 8, "Blob", 8, PTR, "Blob"),
        ],
        {
            "header": "full",
            "push": "XFILE_BLOCK_VIRTUAL",
            "body": [
                {"member": "name", "index": [], "kind": "single_pointer", "null_check": False, "do": {"string": True}},
                {"member": "item", "index": [], "kind": "single_pointer", "null_check": True, "do": {"asset": "Item"}},
                {
                    "member": "blob",
                    "index": [],
                    "kind": "single_pointer",
                    "push": "XFILE_BLOCK_TEMP",
                    "null_check": True,
                    "reuse": {"temp": True},
                    "alloc": 4,
                    "insert": True,
                    "do": {"load": "Blob", "at_start": True, "actions": [{"name": "LoadImageData", "args": ["Blob", "Holder"]}]},
                },
            ],
        },
        asset="AssetHolder",
    ),
    "Blob": struct_def(
        "Blob",
        8,
        [member("resourceSize", 0, "int", 4), member("data", 4, "char", 1, [{"array": 1}], element=CHAR)],
        {
            "header": {"partial": 4, "member": "data"},
            "push": None,
            "body": [{"member": "data", "index": [], "kind": "dynamic_array", "do": {"raw": field("Blob", "resourceSize")}}],
        },
    ),
}


def loader(struct_, ptr_arrays=()):
    return {
        "struct": struct_,
        "name": "Asset" + struct_,
        "asset_name": {"member": "name"},
        "entry": {"temp": True, "align": 4, "action": None},
        "ptr_arrays": list(ptr_arrays),
        "arrays": [],
        "loads": [],
        "referenced_assets": [],
    }


PROGRAM = {
    "game": "test",
    "pointer_size": 4,
    "blocks": [{"name": f"XFILE_BLOCK_{n}", "index": i, "type": t, "default": False} for i, (n, t) in enumerate(BLOCKS)],
    "asset_types": [
        {"index": 0, "enum": "ASSET_TYPE_ITEM", "listed": "item", "struct": "Item", "header_member": "item"},
        {"index": 1, "enum": "ASSET_TYPE_HOLDER", "listed": "holder", "struct": "Holder", "header_member": "holder"},
        {"index": 2, "enum": "ASSET_TYPE_NOTHING", "listed": "nothing", "skip": True},
    ],
    "assets": [loader("Item", [{"type": "Part", "struct": "Part", "reusable": True, "align": 4, "size": 8}]), loader("Holder")],
    "enums": {},
    "typedefs": {},
    "structs": STRUCTS,
}


@pytest.fixture
def prog(monkeypatch):
    monkeypatch.setitem(actions.ACTIONS, "test", {"LoadImageData": actions.load_image_data})
    return program.Program(PROGRAM, IW5)


def item(w, name, kind, shape, count, parts, scratch=True):
    """An Item following in TEMP; `shape` and `parts` write its VIRTUAL data. Returns what `parts` returned."""
    w.push(TEMP)
    w.align(4)
    w.words(F, kind, F if shape else 0, F if scratch else 0, count, F if parts else 0)
    w.push(VIRTUAL)
    w.put(name.encode() + b"\0")
    if shape:
        w.align(4)
        shape(w)
    if scratch:
        w.push(RUNTIME)
        w.align(4)
        w.put(bytes(16))
        w.pop()
    kept = parts(w) if parts else None
    w.pop()
    w.pop()
    return kept


def build_zone():
    w = Writer()
    w.put(struct.pack("<4I", 2, F, 5, F))  # the XAssetList, in TEMP as the game loads it
    w.push(VIRTUAL)
    w.align(4)
    w.words(F, 0)
    w.put(b"s0\0")
    w.align(4)
    assets = w.words(0, F, 1, F, 0, F, 2, 0, 1, F)
    marks = {}

    def alpha_parts(w):
        w.align(4)
        w.words(F, F)
        w.align(4)
        w.words(F, 7)
        w.put(b"p0\0")
        w.align(4)
        marks["part1"] = w.words(F, 8)
        w.put(b"p1\0")

    item(w, "alpha", 1, lambda w: w.words(11, 22), 2, alpha_parts)
    # h1: its item aliases XAsset 0's header slot; its blob is INSERT: loaded in TEMP, slot reserved.
    w.push(TEMP)
    w.align(4)
    w.words(F, w.ref(assets, 4), INS)
    w.push(VIRTUAL)
    w.put(b"h1\0")
    w.push(TEMP)
    w.align(4)
    marks["slot"] = w.insert()
    w.words(5)
    w.put(b"hello")
    w.pop()
    w.pop()
    w.pop()

    def beta_parts(w):
        w.align(4)
        w.words(w.ref(marks["part1"]), 0)  # a reference to alpha's second part, and a null

    item(w, "beta", 2, lambda w: w.put(struct.pack("<3f", 1.5, 2.5, 3.5)), 2, beta_parts, scratch=False)
    # h2: no item; its blob aliases h1's insert slot.
    w.push(TEMP)
    w.align(4)
    w.words(F, 0, w.ref(marks["slot"]))
    w.push(VIRTUAL)
    w.put(b"h2\0")
    w.pop()
    w.pop()
    w.pop()
    return w.zone()


def test_walks_a_synthetic_zone_exactly(prog):
    walk = walk_zone(build_zone(), prog, "synthetic.ff")
    assert walk.failed is None
    assert walk.check() == []
    assert walk.listing() == [("item", "alpha"), ("holder", "h1"), ("item", "beta"), ("holder", "h2")]
    assert walk.script_strings == ["s0", None]
    assert [t for t, _ in walk.entries] == [0, 1, 0, 2, 1]
    assert walk.entries[3][1] is None  # the skipped type loads nothing
    assert walk.loose == 0


def test_conditions_unions_and_the_runtime_block(prog):
    walk = walk_zone(build_zone(), prog)
    alpha, beta = walk.by_type("item")
    assert alpha.record["kind"] == 1 and list(alpha.record["shape"]["ints"]) == [11, 22]
    assert alpha.record["shape.floats"] is None  # the union's other case never ran
    assert list(beta.record["shape.floats"]) == [1.5, 2.5, 3.5]
    scratch = alpha.record["scratch"]
    assert isinstance(scratch, Array) and scratch.at is None and bytes(scratch.bytes()) == bytes(16)
    assert beta.record["scratch"] is None  # null, so null_check skipped it
    names, peaks, sizes = zip(*walk.blocks(), strict=True)
    assert peaks[RUNTIME] == 16 == sizes[RUNTIME]


def test_pointer_arrays_reuse_earlier_data(prog):
    walk = walk_zone(build_zone(), prog)
    alpha, beta = walk.by_type("item")
    parts = alpha.record["parts"]
    assert [p["label"] for p in parts] == ["p0", "p1"] and [p["value"] for p in parts] == [7, 8]
    assert beta.record["parts"][0] is parts[1]  # a reference is the very record loaded there
    assert beta.record["parts"][1] is None


def test_aliases_inserts_and_a_captured_action(prog):
    walk = walk_zone(build_zone(), prog)
    alpha = walk.by_type("item")[0]
    h1, h2 = walk.by_type("holder")
    assert h1.record["item"] is alpha  # an alias of XAsset 0's slot
    blob = h1.record["blob"]
    assert isinstance(blob, Record) and blob.block == TEMP
    assert bytes(h1.record.captured("LoadImageData")) == struct.pack("<i", 5) + b"hello"
    assert bytes(blob["data"].bytes()) == b"hello"
    assert h2.record["item"] is None
    assert h2.record["blob"] is blob  # an alias of h1's insert slot, though TEMP was reused since
    # Every asset header starts where TEMP was rewound to, past the XAssetList the game keeps there.
    assert {a.record.address for a in walk.assets} == {(TEMP, 16)}


def test_a_truncated_zone_names_where_it_stopped(prog):
    zone = build_zone()
    walk = walk_zone(zone[: len(zone) - 30], prog)
    assert walk.failed is not None
    assert walk.failed[0] == 2 and walk.check()
    assert "Item.shape: Shape.floats: read of 12 bytes" in walk.failed[1]


def test_the_listing_folds_localize_entries_and_quotes_names(prog):
    from scripts.cod.zonecode.listing import compare, rows

    walk = walk_zone(build_zone(), prog, "/x/zone_name.ff")
    walk.assets[1].name = ""
    walk.assets[2].listed = "localize"
    assert rows(walk) == [("localize", "zone_name"), ("item", "alpha"), ("holder", '""'), ("holder", "h2")]
    missing, extra = compare(rows(walk), [("item", "alpha"), ("holder", "h2"), ("holder", "h2")])
    assert missing == [("holder", "h2")] and ("localize", "zone_name") in extra


def depot_zone(name):
    """A retail MW3 zone from the 32-bit Steam depot scripts/cod/maps.json names, if installed."""
    from scripts.cod.maps import load_maps

    try:
        games, _maps = load_maps()
    except (OSError, ValueError, KeyError):
        return None
    for folder in games["mw3"]["zones"]:
        for path in glob.glob(os.path.join(folder, name + ".ff")):
            return path
    return None


@pytest.mark.skipif(not os.path.exists(program.path_for("iw5")), reason="no IW5 zonecode.json (reverse/x86-zone/build.sh iw5)")
def test_walks_mp_dome_to_the_end():
    path = depot_zone("mp_dome")
    if path is None:
        pytest.skip("MW3's mp_dome.ff is not installed")
    from scripts.cod.zonecode.walker import walk_fastfile

    walk = walk_fastfile(path)
    assert walk.check() == []
    assert len(walk.entries) == 792 and len(walk.assets) == 6984 and walk.loose == 0
    world = walk.by_type("gfxworld")[0]
    assert world.name == "maps/mp/mp_dome.d3dbsp" and world.record["baseName"] == "mp_dome"
    info = walk.by_type("clipmap")[0].record["pInfo"]
    brush = next(b for b in info["brushes"] if b["numsides"])
    sides = walk.span(brush["sides"], brush["numsides"])
    assert sides[0] is brush["sides"] and len(sides) == brush["numsides"]


def test_mw3_is_claimed_by_the_iw5_backend_and_an_unclaimed_file_exits(tmp_path, monkeypatch):
    from scripts.cod import backends
    from scripts.cod.iw5.backend import Backend as Iw5Backend

    mw3 = tmp_path / "mp_x.ff"
    mw3.write_bytes(b"IWff0100" + (1).to_bytes(4, "little") + bytes(64))
    other = tmp_path / "other.ff"
    other.write_bytes(b"not a fastfile at all")
    monkeypatch.setattr(Iw5Backend, "check", lambda self: None)
    assert Iw5Backend.claims(str(mw3)) and not Iw5Backend.claims(str(other))
    assert isinstance(backends.for_fastfile(str(mw3)), Iw5Backend)
    with pytest.raises(SystemExit, match="not a fastfile any backend reads"):
        backends.for_fastfile(str(other))
    with pytest.raises(SystemExit, match="dump 'soundbank'"):
        Iw5Backend().dump(str(mw3), str(tmp_path), "soundbank")  # T5's kind
