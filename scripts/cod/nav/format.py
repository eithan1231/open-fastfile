"""The `nav.bin` encoder: plain records in, the bytes docs/engine/nav-format.md describes out.

Deterministic by construction: the same `NavData` always gives the same bytes
(sections in a fixed order, links stably grouped by node, strings interned in
first-use order, META as sorted compact JSON). The conformance fixture
(`conformance.py`) holds the encoder to that, byte for byte, and the TypeScript
decoder reads the same bytes.

Positions are engine metres, Y up, already converted from the source's units:
nothing here knows a game.
"""

import json
import math
import struct
import zlib
from dataclasses import dataclass, field

from .vocab import (
    ABILITIES,
    HEADER_FLAGS,
    LINK_FLAGS,
    LINK_KINDS,
    NODE_FLAGS,
    NODE_TYPES,
    SECTION_FLAGS,
    STANCES,
    TRAVERSAL_KINDS,
)

MAGIC = b"3DNV"
MAJOR = 1
MINOR = 0
HEADER_SIZE = 32
TABLE_ENTRY_SIZE = 16
ALIGN = 8

NODE_STRIDE = 32
LINK_STRIDE = 12
TRAV_STRIDE = 16

#: "None" in a u32 or u16 index field.
NO_INDEX_32 = 0xFFFFFFFF
NO_INDEX_16 = 0xFFFF

#: The sections this encoder writes, in file order, and their versions.
KNOWN_SECTIONS = {"NODE": 1, "LINK": 1, "TRAV": 1, "STRS": 1, "META": 1}
#: Tags a later version will define; a caller may not write them as raw sections.
RESERVED_TAGS = {"VIS ", "ZONE", "DYNG", "DSTA", "COVR", "ABIL", "BLKR", "POLY", "PNOD"}


class NavEncodeError(ValueError):
    """The records cannot be written as a valid file."""


@dataclass(frozen=True)
class Node:
    """A place. `yaw` is radians about +Y, facing (-sin yaw, 0, -cos yaw); None = no facing."""

    position: tuple[float, float, float]
    type: str = "PATH"
    yaw: float | None = None
    floor_z: bool = False
    group: int | None = None  # a dynamic group: the position is then in its frame
    abilities: int = 0
    stance: int = 0
    source: int | None = None  # the node's index in the data it came from
    name: str = ""


@dataclass(frozen=True)
class Link:
    """A directed edge. `game_cost` is the source's own number, never a distance; None = none."""

    from_node: int
    to_node: int
    kind: str = "WALK"
    game_cost: float | None = None
    flags: int = 0
    traversal: int | None = None


@dataclass(frozen=True)
class Traversal:
    """A special move from `begin` to `end`, named by the source's `animscript`."""

    begin: int
    end: int
    kind: str = "UNKNOWN"
    animscript: str = ""


@dataclass(frozen=True)
class RawSection:
    """A section this encoder does not model, written as given (a later version's, or a test's)."""

    tag: str
    version: int
    payload: bytes
    required: bool = False


@dataclass
class NavData:
    """Everything one `nav.bin` holds. `links` None writes no LINK section at all."""

    nodes: list[Node]
    links: list[Link] | None = None
    traversals: list[Traversal] = field(default_factory=list)
    flags: int = 0
    meta: dict | None = None
    #: What the source had that this file leaves out, by kind (e.g. "dynamicNodes": 37); into META.
    skipped: dict[str, int] = field(default_factory=dict)
    extra: list[RawSection] = field(default_factory=list)


def yaw16(yaw):
    """Radians -> the u16 fraction of a full turn a NODE stores (rounded half up, wrapped)."""
    return math.floor(yaw / (2 * math.pi) * 65536 + 0.5) % 65536


def encode(nav):
    """`nav` as the bytes of a `nav.bin`. Raises NavEncodeError on anything the format cannot hold."""
    _check_bits("header flags", nav.flags, HEADER_FLAGS, 0xFFFFFFFF)
    strings = _Strings()
    for n in nav.nodes:
        strings.add(n.name)
    for t in nav.traversals:
        strings.add(t.animscript)

    sections = [("NODE", KNOWN_SECTIONS["NODE"], True, _node_section(nav.nodes, strings))]
    if nav.links is not None:
        sections.append(("LINK", KNOWN_SECTIONS["LINK"], True, _link_section(nav, len(nav.nodes))))
    if nav.traversals:
        sections.append(("TRAV", KNOWN_SECTIONS["TRAV"], True, _trav_section(nav.traversals, len(nav.nodes), strings)))
    if len(strings) > 1:
        sections.append(("STRS", KNOWN_SECTIONS["STRS"], True, strings.section()))
    meta = dict(nav.meta or {})
    if nav.skipped:
        meta["skipped"] = dict(nav.skipped)
    if meta:
        text = json.dumps(meta, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
        sections.append(("META", KNOWN_SECTIONS["META"], False, text.encode("utf-8")))
    for raw in nav.extra:
        tag = raw.tag
        if len(tag) != 4 or not tag.isascii() or tag in KNOWN_SECTIONS or tag in RESERVED_TAGS:
            raise NavEncodeError(f"raw section tag {tag!r} is not a free four-character ASCII tag")
        if not 0 <= raw.version <= 0xFFFF:
            raise NavEncodeError(f"raw section {tag} version {raw.version} does not fit a u16")
        sections.append((tag, raw.version, raw.required, bytes(raw.payload)))
    return _assemble(nav.flags, sections)


# ---- sections ----------------------------------------------------------------------------


def _node_section(nodes, strings):
    out = bytearray(struct.pack("<II", len(nodes), NODE_STRIDE))
    for i, n in enumerate(nodes):
        where = f"node {i}"
        if n.type not in NODE_TYPES:
            raise NavEncodeError(f"{where}: unknown type {n.type!r}")
        _check_bits(f"{where} abilities", n.abilities, ABILITIES, 0xFFFFFFFF)
        _check_bits(f"{where} stance", n.stance, STANCES, 0xFF)
        if n.group is not None and not 0 <= n.group < NO_INDEX_16:
            raise NavEncodeError(f"{where}: group {n.group} out of range")
        if n.source is not None and not 0 <= n.source < NO_INDEX_32:
            raise NavEncodeError(f"{where}: source {n.source} out of range")
        flags = 0
        if n.yaw is not None:
            flags |= NODE_FLAGS["HAS_YAW"]
        if n.floor_z:
            flags |= NODE_FLAGS["FLOOR_Z"]
        if n.group is not None:
            flags |= NODE_FLAGS["DYNAMIC"]
        x, y, z = (_f32(v, f"{where} position") for v in n.position)
        out += struct.pack(
            "<fffHBBIIIHBB",
            x,
            y,
            z,
            yaw16(n.yaw) if n.yaw is not None else 0,
            NODE_TYPES[n.type],
            flags,
            n.abilities,
            NO_INDEX_32 if n.source is None else n.source,
            strings.index(n.name),
            NO_INDEX_16 if n.group is None else n.group,
            n.stance,
            0,
        )
    return bytes(out)


def _link_section(nav, node_count):
    links = nav.links
    travs = nav.traversals
    if len(travs) > NO_INDEX_16:
        raise NavEncodeError(f"{len(travs)} traversals: a link can index at most {NO_INDEX_16}")
    for i, link in enumerate(links):
        where = f"link {i} ({link.from_node} -> {link.to_node})"
        if not (0 <= link.from_node < node_count and 0 <= link.to_node < node_count):
            raise NavEncodeError(f"{where}: node out of range")
        if link.kind not in LINK_KINDS:
            raise NavEncodeError(f"{where}: unknown kind {link.kind!r}")
        _check_bits(f"{where} flags", link.flags, LINK_FLAGS, 0xFF)
        traverse = link.kind == "TRAVERSE"
        if traverse != (link.traversal is not None):
            raise NavEncodeError(f"{where}: a TRAVERSE link names its traversal, and only it does")
        if traverse:
            if not 0 <= link.traversal < len(travs):
                raise NavEncodeError(f"{where}: traversal {link.traversal} out of range")
            t = travs[link.traversal]
            if (t.begin, t.end) != (link.from_node, link.to_node):
                raise NavEncodeError(f"{where}: traversal {link.traversal} runs {t.begin} -> {t.end}")
        if link.flags & LINK_FLAGS["NEGOTIATION"] and not traverse:
            raise NavEncodeError(f"{where}: NEGOTIATION is on a traversal's own link only")

    # CSR: grouped by node, stably, so links keep the order the caller gave within a node.
    ordered = sorted(links, key=lambda link: link.from_node)
    first = [0] * (node_count + 1)
    for link in ordered:
        first[link.from_node + 1] += 1
    for i in range(node_count):
        first[i + 1] += first[i]

    out = bytearray(struct.pack("<IIII", len(ordered), LINK_STRIDE, node_count, 0))
    out += struct.pack(f"<{node_count + 1}I", *first)
    out += bytes(-len(out) % ALIGN)
    for link in ordered:
        cost = math.nan if link.game_cost is None else _f32(link.game_cost, "link game cost")
        out += struct.pack(
            "<IfBBH",
            link.to_node,
            cost,
            LINK_KINDS[link.kind],
            link.flags,
            NO_INDEX_16 if link.traversal is None else link.traversal,
        )
    return bytes(out)


def _trav_section(travs, node_count, strings):
    out = bytearray(struct.pack("<II", len(travs), TRAV_STRIDE))
    for i, t in enumerate(travs):
        if not (0 <= t.begin < node_count and 0 <= t.end < node_count):
            raise NavEncodeError(f"traversal {i}: node out of range")
        if t.kind not in TRAVERSAL_KINDS:
            raise NavEncodeError(f"traversal {i}: unknown kind {t.kind!r}")
        # Byte 9 is the record's flags, none defined in version 1; 10-11 are reserved.
        out += struct.pack("<IIBBHI", t.begin, t.end, TRAVERSAL_KINDS[t.kind], 0, 0, strings.index(t.animscript))
    return bytes(out)


class _Strings:
    """The STRS table: index 0 is "", the rest in first-use order."""

    def __init__(self):
        self._index = {"": 0}

    def __len__(self):
        return len(self._index)

    def add(self, s):
        self._index.setdefault(s, len(self._index))

    def index(self, s):
        return self._index[s]

    def section(self):
        blobs = [s.encode("utf-8") for s in self._index]
        offsets = [0]
        for b in blobs:
            offsets.append(offsets[-1] + len(b))
        head = struct.pack(f"<II{len(offsets)}I", len(blobs), 0, *offsets)
        return head + b"".join(blobs)


# ---- the file ----------------------------------------------------------------------------


def _assemble(flags, sections):
    table_offset = HEADER_SIZE
    cursor = _aligned(table_offset + TABLE_ENTRY_SIZE * len(sections))
    table = bytearray()
    body = bytearray()
    for tag, version, required, payload in sections:
        table += struct.pack(
            "<4sHHII", tag.encode("ascii"), version, SECTION_FLAGS["REQUIRED"] if required else 0, cursor, len(payload)
        )
        body += payload + bytes(-len(payload) % ALIGN)
        cursor += _aligned(len(payload))
    after_header = bytes(table) + bytes(-(table_offset + len(table)) % ALIGN) + bytes(body)
    length = HEADER_SIZE + len(after_header)
    crc = zlib.crc32(after_header) & 0xFFFFFFFF
    header = struct.pack("<4sHHIIIIII", MAGIC, MAJOR, MINOR, flags, length, len(sections), table_offset, crc, 0)
    return header + after_header


def _aligned(n):
    return n + (-n % ALIGN)


def _f32(value, what):
    value = float(value)
    if not math.isfinite(value) or abs(value) > 3.4028234663852886e38:
        raise NavEncodeError(f"{what}: {value} is not a finite f32")
    return value


def _check_bits(what, value, table, limit):
    known = 0
    for bit in table.values():
        known |= bit
    if not 0 <= value <= limit or value & ~known:
        raise NavEncodeError(f"{what}: {value:#x} sets bits no name covers")
