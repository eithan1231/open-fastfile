"""The PATHDATA walker (asset type 27): a map's AI path nodes, from `<map>_path.ff`.

Registered into `walkers.WALKERS` on import; `dumpers/pathdata.py` imports it,
and so does `python3 -m scripts.cod.s1.walkers` (to report on a path zone). The
load order is x64-zt's `s1/assets/aipaths.cpp` `write()`, which is IW6's
`Load_PathData` (reverse/iw6-zone/out/durango_load.c) plus S1's
`pathVisBulletBlockers` and the 32 `pathAbilities` names:

    PathData (TEMP), then in VIRTUAL: name, nodes[nodeCount] (4-aligned), each
    node's links, pathVis, nodeTree[nodeTreeCount] and any child that follows,
    dynamicNodeGroups and their trees, pathExposure, pathNoPeekVis,
    pathVisBulletBlockers, pathZones, pathDynStates, then each pathAbilities string.

It closes on all 16 AW path zones: the walk ends on the zone's last byte with
every block cursor (TEMP's peak) on the header's size. How that was found, and
what the data means: reverse/cod-pathdata/README.md.
"""

import struct

from ..iw6.zone import VIRTUAL, follows
from . import walkers


def _tree_info(z, rec):
    """pathnode_tree_info_t after its record: the children that follow, or a leaf's node list."""
    u = z.layout.resolve("pathnode_tree_t", "u")[0]
    rec.used.update((u, u + 8))
    axis = rec["axis"]
    if axis >= 0:
        kids = []
        for i in range(2):
            value = z.u64(rec.at + u + 8 * i)
            if follows(value):
                z.align(3)
                kids.append(_tree_info(z, z.struct("pathnode_tree_t")))
            else:
                kids.append({"alias": value})
        return {"axis": axis, "dist": rec["dist"], "children": kids}
    count, ptr = struct.unpack_from("<i4xQ", z.data, rec.at + u)
    nodes = []
    if follows(ptr):
        z.align(1)
        at = z.take(2 * count)
        nodes = list(struct.unpack_from(f"<{count}H", z.data, at))
    return {"axis": axis, "nodes": nodes}


def _tree_array(z, count):
    z.align(3)
    return [_tree_info(z, rec) for rec in z.array("pathnode_tree_t", count)]


def _blob(z, p, count, ptr):
    """(file offset, size) of a byte blob behind a pointer, or None."""
    at = z.elements(p, ptr, p[count], size=1)
    return (at, p[count]) if at is not None else None


@walkers.walker("PATHDATA")
def pathdata(z):
    p = z.struct("PathData")
    z.push(VIRTUAL)
    name = z.field_string(p, "name")
    nodes = []
    if follows(p["nodes"]):
        z.align(3)
        nodes = z.array("pathnode_t", p["nodeCount"])
    links = []
    for node in nodes:
        links.append(z.elements(node, "constant.Links", node["constant.totalLinkCount"], align=3))
    vis = _blob(z, p, "visBytes", "pathVis")
    tree = _tree_array(z, p["nodeTreeCount"]) if follows(p["nodeTree"]) else []
    groups = []
    if follows(p["dynamicNodeGroups"]):
        z.align(3)
        for g in z.array("PathDynamicNodeGroup", p["dynamicNodeGroupCount"]):
            gt = _tree_array(z, g["nodeTreeCount"]) if follows(g["nodeTree"]) else []
            groups.append((g["parentIndex"], gt))
    blobs = {"pathVis": vis}
    blobs |= {
        ptr: _blob(z, p, count, ptr)
        for count, ptr in (
            ("exposureBytes", "pathExposure"),
            ("noPeekVisBytes", "pathNoPeekVis"),
            ("visBulletBlockerBytes", "pathVisBulletBlockers"),
            ("zonesBytes", "pathZones"),
            ("dynStatesBytes", "pathDynStates"),
        )
    }
    base = z.layout.resolve("PathData", "pathAbilities")[0]
    abilities = []
    for i in range(32):
        p.used.add(base + 8 * i)
        abilities.append(z.string(z.u64(p.at + base + 8 * i)))
    z.pop()
    kept = {"p": p, "nodes": nodes, "links": links, "tree": tree, "groups": groups, "blobs": blobs, "abilities": abilities}
    z.record("PATHDATA", name, kept)
    return name
