"""`pathdata`: a map's AI path nodes and their links, from `<map>_path.ff`.

The schema is IW6's (scripts/cod/iw6/dumpers/pathdata.py, `pathdata_json`),
plus each node's `pathAbility` (0 on every node of every MP map). The walk is
`scripts/cod/s1/paths.py`. S1 numbers its node types as Ghosts does
(reverse/cod-pathdata §4), and its "angles given" spawnflag is 0x80000.
"""

import struct

from ...iw6.dumpers.common import asset_path, write_json
from ...iw6.dumpers.pathdata import LINK, STRING_FIELDS, node_record, pathdata_json, require_closed, script_string, tree_leaves
from .. import paths  # noqa: F401  (registers the PATHDATA walker)
from . import GAME, dumper


@dumper("pathdata")
def write(walked, out):
    zone = walked.zone
    string = script_string(zone)
    for name, found in zone.found.get("PATHDATA", {}).items():
        require_closed(zone, name)
        p = found["p"]
        header = {k: p[k] for k in ("nodeCount", "zoneCount", "version")}
        nodes = []
        for i, (node, at) in enumerate(zip(found["nodes"], found["links"], strict=True)):
            fields = {k: node[f"constant.{k}"] for k in ("type", "spawnflags", "pathAbility", *STRING_FIELDS)}
            fields["origin"] = struct.unpack("<3f", node.bytes("constant.vLocalOrigin"))
            fields["angle"] = struct.unpack_from("<f", node.bytes("constant.___u9"))[0]  # {fAngle, forward[2]}
            fields["parent"] = struct.unpack("<I", node.bytes("constant.parent"))[0]
            count = node["constant.totalLinkCount"] if at is not None else 0
            links = [LINK.unpack_from(zone.data, at + LINK.size * k) for k in range(count)]
            nodes.append(node_record(i, fields, links, string))
        groups = [(parent, sorted(tree_leaves(tree))) for parent, tree in found["groups"]]
        blob = found["blobs"]["pathZones"]
        zones = zone.data[blob[0] : blob[0] + blob[1]] if blob else None
        write_json(asset_path(out, f"{name}.pathdata.json"), pathdata_json(GAME, name, header, nodes, groups, zones))
