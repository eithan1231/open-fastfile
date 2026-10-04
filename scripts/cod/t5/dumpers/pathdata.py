"""`pathdata`: a map's AI path nodes and their links, from the map zone's own `GameWorldMp`.

The schema is IW6's (scripts/cod/iw6/dumpers/pathdata.py, `pathdata_json`), so
`scripts/cod/nav/from_pathdata.py` reads it as it reads Ghosts' and AW's. What
T5's records hold differs:

- the PathData is inline in the map's `GameWorldMp` (`GameWorldSp` in the zombies
  maps), not an asset of a path zone of its own;
- there is no zone graph, no dynamic group, no `version` and no node `parent`:
  `zoneCount` is 0, and `version` and `parent` are null;
- a link has no `flags` but four bad-place counts, `ubBadPlaceCount`;
- the array holds `nodeCount` nodes and then 128 runtime slots
  (reverse/cod-pathdata §1), which must be empty: a slot that is not means the
  count was misread, and nothing is written.

`origin` keeps the height the level designer authored (T5 does not drop a node
to the floor).
"""

import struct

from ...iw6.dumpers.common import asset_path, write_json
from ...iw6.dumpers.pathdata import STRING_FIELDS, node_record, pathdata_json

#: pathlink_s: fDist, nodeNum, disconnectCount, negotiationLink, ubBadPlaceCount[4].
LINK = struct.Struct("<fHBB4B")
#: The empty runtime slots after `nodeCount` (OAT's GameWorldMp.txt loads `nodeCount + 128`).
RUNTIME_SLOTS = 128


def links(node, count):
    """A node's links as the dump writes them."""
    array = node["constant.Links"]
    if not count:
        return []
    if array is None or len(array) != count:
        raise SystemExit(f"{node!r}: {count} links declared, {array!r} loaded")
    return [
        {"target": num, "fDist": dist, "negotiationLink": neg, "disconnectCount": disconnect, "ubBadPlaceCount": list(bad)}
        for dist, num, disconnect, neg, *bad in array.unpack(LINK.format)
    ]


def dump(name, path, walk, read_links=links):
    """One PathData (the `path` member of a GameWorldMp/Sp) as the dump's dict.

    `read_links(node, count)` reads a node's links: T6 has the same PathData with a
    link of its own (t6/dumpers/pathdata.py)."""
    count = path["nodeCount"]
    array = path["nodes"]
    if array is None or len(array) != count + RUNTIME_SLOTS:
        loaded = 0 if array is None else len(array)
        raise SystemExit(f"{name}: {count} path nodes declared, {loaded} loaded (expected {count} + {RUNTIME_SLOTS})")
    for i in range(count, count + RUNTIME_SLOTS):
        if any(array[i].bytes()):
            raise SystemExit(f"{name}: runtime path node slot {i} is not empty; nodeCount ({count}) is misread")

    def string(index):
        return walk.script_string(index) or "" if index else ""

    nodes = []
    for i in range(count):
        node = array[i]
        fields = {k: node[f"constant.{k}"] for k in ("type", "spawnflags", *STRING_FIELDS)}
        fields["origin"] = node.unpack("<3f", "constant.vOrigin")
        fields["angle"] = node["constant.fAngle"]
        fields["parent"] = None
        rec = node_record(i, fields, [], string)
        rec["links"] = read_links(node, node["constant.totalLinkCount"])
        for lk in rec["links"]:
            if lk["target"] >= count:
                raise SystemExit(f"{name}: node {i} links to node {lk['target']}, past the {count} declared")
        nodes.append(rec)
    header = {"nodeCount": count, "zoneCount": 0, "version": None}
    return pathdata_json(walk.game, name, header, nodes, [], None)


def write(walk, out, ctx=None, read_links=links):
    """Every map's PathData the zone holds: a GameWorldMp's in MP maps, a GameWorldSp's in the zombies maps."""
    for kind in ("gameworldmp", "gameworldsp"):
        for asset in walk.by_type(kind):
            data = dump(asset.name, asset.record["path"], walk, read_links)
            write_json(asset_path(out, f"{asset.name}.pathdata.json"), data)
