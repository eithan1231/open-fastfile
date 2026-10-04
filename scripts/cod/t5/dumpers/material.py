"""`material`: `materials/<name>.json` in OpenAssetTools' T5 material schema, which scripts/cod/materials.py reads.

IW5's writer (iw5/dumpers/material.py) with T5's spellings, from OAT's
JsonMaterialT5 and MaterialJsonDumperT5:

- 130 techniques (`stateBitsEntry`), `layeredSurfaceTypes`, and `isMatureContent` on each texture;
- camera regions `lit`, `decal`, `emissive`, `none`; texture semantics with
  `unused1` where IW has `detailMap`, and `color0Map`..`color15Map`, `throwMap`;
- a state has no `gammaWrite`, and alpha test 2 is `ge255` where IW's is `lt128`;
- game flag 0x40 is `CASTS_SHADOW`, and 0x100 and 0x200 exist.

Names come from the same two places (iw5/dumpers/shaders.py): T5's own list of
known names (`scripts/cod/data/t5/material_names.json`, from OAT), and the constant tables of
the shaders in the zone's technique sets, where IW4/IW5 have shaders as assets of
their own.
"""

import json
import os
import struct

from ...iw5.dumpers import material as iw
from ...iw5.dumpers import shaders
from ...iw5.dumpers.common import plain
from ...iw6.dumpers.common import asset_path, write_json
from ...materials import material_file_stem
from ...zonecode import program

SEMANTICS = (
    "2D function colorMap unused1 unused2 normalMap unused3 unused4 specularMap unused5 unused6 waterMap "
    + " ".join(f"color{i}Map" for i in range(16))
    + " throwMap"
).split()
CAMERA_REGIONS = ("lit", "decal", "emissive", "none")
ALPHA_TESTS = {1: "gt0", 2: "ge255", 3: "ge128"}
GAME_FLAGS = {0x40: "CASTS_SHADOW"}  # the first name OAT's enum table gives a value; the rest print as hex


CTAB_HEADER = struct.Struct("<7I")  # Size, Creator, Version, Constants, ConstantInfo, Flags, Target
CONSTANT_INFO = struct.Struct("<IHHHHII")  # Name, RegisterSet, RegisterIndex, RegisterCount, Reserved, TypeInfo, DefaultValue
TYPE_INFO_SIZE = 16
REGISTER_SETS, PARAMETER_CLASSES, PARAMETER_TYPES = 4, 6, 20  # d3d9::RegisterSet/ParameterClass/ParameterType MAX


def _fits(comment, at):
    """A NUL-terminated string starts at `at` and ends inside the comment (StringFitsInComment)."""
    return 0 <= at < len(comment) and b"\0" in comment[at:]


def constant_table(program, size):
    """[(name, register set)] of a D3D9 shader's CTAB, reading no further than `size` bytes: a
    port of OAT's d3d9::ShaderAnalyser, which gives nothing unless the whole table checks out."""
    if (
        size < 4
        or len(program) < 4
        or (struct.unpack_from("<I", program, 0)[0] >> 16) not in (0x4658, 0x5458, 0x7FFE, 0x7FFF, 0xFFFE, 0xFFFF)
    ):
        return []
    words = len(program) // 4
    pos, offset, comment = 1, 4, None
    while pos < words and struct.unpack_from("<I", program, 4 * pos)[0] != 0xFFFF and offset + 3 < size:
        token = struct.unpack_from("<I", program, 4 * pos)[0]
        if token & 0xFFFF == 0xFFFE:
            if offset + 4 >= size or pos + 1 >= words:
                return []
            length = token >> 16
            if struct.unpack_from("<I", program, 4 * (pos + 1))[0] == shaders.CTAB:
                if offset + 4 * (length + 1) > size:
                    return []
                comment = program[4 * (pos + 2) : 4 * (pos + 2) + 4 * (length - 1)]
                break
            pos += length
            offset += 4 * length
        pos += 1
        offset += 4
    if comment is None or len(comment) < CTAB_HEADER.size:
        return []
    table_size, creator, _version, count, info, _flags, target = CTAB_HEADER.unpack_from(comment, 0)
    if table_size != CTAB_HEADER.size or (creator and not _fits(comment, creator)) or (target and not _fits(comment, target)):
        return []
    out = []
    if count and info:
        if info + CONSTANT_INFO.size * count > len(comment):
            return []
        for k in range(count):
            name_at, register_set, _i, _c, _r, type_info, _d = CONSTANT_INFO.unpack_from(comment, info + CONSTANT_INFO.size * k)
            name = ""
            if name_at:
                if not _fits(comment, name_at):
                    return []
                name = comment[name_at : comment.index(b"\0", name_at)].decode("latin-1")
            register_set &= 0xFF  # the enums are uint8_t: OAT casts the stored u16 down
            if register_set >= REGISTER_SETS:
                return []
            if type_info:
                if type_info + TYPE_INFO_SIZE > len(comment):
                    return []
                klass, kind = struct.unpack_from("<HH", comment, type_info)
                if klass & 0xFF >= PARAMETER_CLASSES or kind & 0xFF >= PARAMETER_TYPES:
                    return []
            out.append((name, register_set))
    return out


def names_path():
    return os.path.join(os.path.dirname(program.path_for("t5")), "material_names.json")


class ZoneNames(shaders.ZoneNames):
    """Hash -> name for texture slots and constants: T5's known names, then its technique sets' shaders."""

    def __init__(self, walk):
        path = names_path()
        if not os.path.exists(path):
            raise SystemExit(f"no T5 material name list at {path}: it ships in scripts/cod/data/ (scripts/cod/data/README.md)")
        with open(path, encoding="utf-8") as fh:
            known = json.load(fh)
        self.textures, self.constants = {}, {}
        for name in known["constants"]:
            self._add(self.constants, name)
        for name in known["textures"]:
            self._add(self.textures, name)
        seen = set()
        for asset in walk.by_type("techniqueset"):
            for technique in asset.record["techniques"] or ():
                if technique is None or technique.address in seen:
                    continue
                seen.add(technique.address)
                for index in range(technique["passCount"]):
                    for shader in self._shaders(technique, index):
                        self._read(shader)

    @staticmethod
    def hash(name):
        """T5's R_HashString: djb2 with xor from 0, each byte OR 0x20 -- case-blind for letters, but
        `_` hashes as DEL, so this is not iw6's lower-casing `slot_hash` (OAT's djb2_xor_nocase)."""
        value = 0
        for byte in name.encode("latin-1"):
            value = ((value * 33) ^ (byte | 0x20)) & 0xFFFFFFFF
        return value

    @classmethod
    def _add(cls, table, name):
        key = cls.hash(name)
        if key in table:
            return False
        table[key] = name
        return True

    @staticmethod
    def _shaders(technique, index):
        passes = technique["passArray"]
        pass_ = passes[index] if passes is not None and index < len(passes) else None
        if pass_ is None:
            return []
        return [s for s in (pass_["vertexShader"], pass_["pixelShader"]) if s is not None]

    def _read(self, shader):
        program_ = shader["prog.loadDef.program"]
        if program_ is None:
            return
        # OAT's T5 lookup hands the analyser `programSize` -- a count of DWORDs -- as a size
        # in bytes, so only a constant table in the first quarter of a shader is read.
        # Which slots come out named depends on it, so the same limit is kept here.
        for name, register_set in constant_table(bytes(program_.bytes()), shader["prog.loadDef.programSize"]):
            if register_set == shaders.SAMPLER:
                if self._add(self.textures, name) and shaders.SAMPLER_SUFFIX in name:
                    cut = name.rfind(shaders.SAMPLER_SUFFIX)
                    self._add(self.textures, name[:cut] + name[cut + len(shaders.SAMPLER_SUFFIX) :])
            else:
                self._add(self.constants, name)


def state_bits(word0, word1):
    entry = iw.state_bits(word0, word1)
    del entry["gammaWrite"]
    entry["alphaTest"] = "disabled" if iw.bits(word0, 11, 1) else ALPHA_TESTS.get(iw.bits(word0, 12, 2))
    return entry


def texture(tex, names):
    entry = iw.texture(tex, names, SEMANTICS)
    entry["isMatureContent"] = bool(tex["isMatureContent"])
    return entry


def material_json(asset, names):
    m = asset.record
    entry = m.bytes("stateBitsEntry")
    flags = m["info.gameFlags"]
    return {
        "$schema": "http://openassettools.dev/schema/material.v1.json",
        "_game": "t5",
        "_type": "material",
        "_version": 1,
        "cameraRegion": iw.enum(CAMERA_REGIONS, m["cameraRegion"]),
        "constants": [iw.constant(c, names) for c in list(m["constantTable"] or ())[: m["constantCount"]]],
        "gameFlags": [GAME_FLAGS.get(1 << i, f"{1 << i:x}") for i in range(32) if flags & (1 << i)],
        "layeredSurfaceTypes": m["info.layeredSurfaceTypes"],
        "sortKey": m["info.sortKey"],
        "stateBits": [state_bits(*s.unpack("<2I", "loadBits")) for s in list(m["stateBitsTable"] or ())[: m["stateBitsCount"]]],
        "stateBitsEntry": list(struct.unpack(f"<{len(entry)}b", entry)),
        "stateFlags": m["stateFlags"],
        "surfaceTypeBits": m["info.surfaceTypeBits"],
        "techniqueSet": plain(m["techniqueSet"]) or "",
        "textureAtlas": {"columns": m["info.textureAtlasColumnCount"], "rows": m["info.textureAtlasRowCount"]},
        "textures": [texture(t, names) for t in list(m["textureTable"] or ())[: m["textureCount"]]],
    }


def write(walk, out, ctx=None):
    names = ZoneNames(walk)
    written = 0
    for asset in walk.by_type("material"):
        if asset.name.startswith(","):
            continue
        write_json(asset_path(out, f"materials/{material_file_stem(asset.name)}.json"), material_json(asset, names))
        written += 1
    print(f"      {written} material(s) written; {len(names.textures)} texture and {len(names.constants)} constant names known")
