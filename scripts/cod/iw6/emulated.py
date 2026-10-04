"""Asset types walked by running the Durango loader (emulate.py) instead of a Python walker.

    use(zone_walk)   register an emulated walker for every type walkers.py lacks

The type -> loader table is read from Load_XAssetHeader's switch, so a type's
stem (Load_<stem>Ptr or Load_<stem>Handle) names both the struct and its body,
Load_<struct>, whose var<struct> global the Ptr function sets before calling it.
"""

import re

import capstone
from capstone import x86

from . import durango, walkers
from .emulate import Emulator, block_base
from .records import Loaded

# Stems whose body and struct names differ from the stem.
BODIES = {
    "snd_alias_list": "snd_alias_list_t",
    "clipMap": "clipMap_t",
    "menuDef": "menuDef_t",
    "SndCurve": "SndCurve",
    "LpfCurve": "SndCurve",
    "ReverbCurve": "SndCurve",
}


def asset_loaders(image, types):
    """XAssetType name -> Load_<stem>Ptr/Handle, from Load_XAssetHeader's switch."""
    md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_64)
    md.detail = True
    va = next(v for v, n in image.symbols.items() if n.startswith("?Load_XAssetHeader@"))
    end = image.end(va)
    table, case = {}, None
    for ins in md.disasm(image.exe.read(va, end - va), va):
        if ins.mnemonic == "test" and ins.op_str == "edx, edx":
            case = 0
        elif ins.mnemonic == "cmp" and ins.op_str.startswith("edx, "):
            case = int(ins.op_str.split(", ")[1], 0)
        elif ins.mnemonic == "jmp" and ins.operands[0].type == x86.X86_OP_IMM and case is not None:
            name = re.sub(r"^\?([^@]+)@.*", r"\1", image.symbols.get(ins.operands[0].imm, ""))
            if name.startswith("Load_") and case in types:
                table[types[case]] = name
            case = None
    return table


def stem(loader):
    return re.sub(r"(Ptr|Handle|_ptr)$", "", loader[len("Load_") :])


_IMAGES = {}


def emulated(typename, body):
    def walk_asset(z):
        emulator = z.emulator
        header = block_base(z.block) + z.blocks[z.block]
        emulator.put64(emulator.by_name["var" + body], header)
        emulator.call("Load_" + body, rcx=1)
        emulator.last_header = emulator.register(header)
        name = emulator.u64(header)
        where = (name >> 44) - 1
        name = z.strings.get((where, name - block_base(where)))
        z.record(typename, name, Loaded(body, emulator.last_header))
        return name

    walk_asset.emulated = True
    return walk_asset


def use(walk, folder=None):
    """Give `walk` an emulator, and emulated walkers for the types Python does not walk.

    `folder` holds the Durango build; $IW6_DURANGO by default."""
    folder = folder or durango.folder()
    if not folder:
        raise RuntimeError(
            f"no Durango build: set ${durango.ENV} or cod.config.json's `{durango.KEY}` "
            f"to the folder holding {durango.STEM}.exe and .map"
        )
    image = _IMAGES.get(folder) or _IMAGES.setdefault(folder, durango.Image(folder))
    loaders = asset_loaders(image, walk.types)
    python_types = {t for t, w in walkers.WALKERS.items() if not getattr(w, "emulated", False)}
    python = {stem(loader): (t, walkers.WALKERS[t]) for t, loader in loaders.items() if t in python_types}
    emulator = Emulator(image, walk.z, python)
    for typename, loader in loaders.items():
        if typename in python_types:
            continue
        body = BODIES.get(stem(loader), stem(loader))
        if "var" + body in emulator.by_name and "Load_" + body in emulator.by_name:
            walkers.WALKERS[typename] = emulated(typename, body)
    walk.z.emulator = emulator
    return emulator
