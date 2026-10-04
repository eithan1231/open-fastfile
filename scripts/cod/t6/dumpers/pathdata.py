"""`pathdata`: a map's AI path nodes and their links, from the map zone's own `GameWorldMp`.

T5's dumper (t5/dumpers/pathdata.py) with T6's link. The PathData, the node and
its `nodeCount + 128` runtime slots are Black Ops' (the symbolised 2014 server's
PDB agrees with OAT's T6_Assets.h, reverse/cod-pathdata §T6); only `pathlink_s`
grew, to 16 bytes, with a `flags` byte and a fifth bad-place count:

    fDist f32, nodeNum u16, disconnectCount u8, negotiationLink u8, flags u8,
    ubBadPlaceCount[5] u8, 2 bytes of padding

`flags` is written as the game stored it: 0x08 a link wide enough for a
double-width AI, 0x20 one a quadrotor flies, 0x01/0x02 a safe cover shuffle, 0x10
a link the game has disconnected (never shipped). Every link, whatever its
flags, is a walk link first: the compiler only makes one a walker can take.
"""

import struct

from ...t5.dumpers import pathdata as t5

#: pathlink_s: fDist, nodeNum, disconnectCount, negotiationLink, flags, ubBadPlaceCount[5], pad.
LINK = struct.Struct("<fHBBB5B2x")


def links(node, count):
    """A node's links as the dump writes them."""
    array = node["constant.Links"]
    if not count:
        return []
    if array is None or len(array) != count or array.elem != LINK.size:
        raise SystemExit(f"{node!r}: {count} links of {LINK.size} bytes declared, {array!r} loaded")
    return [
        {
            "target": num,
            "fDist": dist,
            "flags": flags,
            "negotiationLink": neg,
            "disconnectCount": disconnect,
            "ubBadPlaceCount": list(bad),
        }
        for dist, num, disconnect, neg, flags, *bad in array.unpack(LINK.format)
    ]


def write(walk, out, ctx=None):
    """Every map's PathData the zone holds (a GameWorldMp's: every T6 MP map ships one)."""
    t5.write(walk, out, ctx, read_links=links)
