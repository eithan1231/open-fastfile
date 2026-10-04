"""`pathdata`: a map's AI path nodes and their links, `<name>.pathdata.json`, from `<map>_path.ff`.

No OpenAssetTools kind matches this one: it is ours, an intermediate in game
units that `scripts/cod/nav/from_pathdata.py` turns into a `nav.bin`. So its
schema is written down here, once, and S1's dumper writes the same shape
(`pathdata_json`):

    {_game, _type: "pathdata", _version: 1, name, version, nodeCount, zoneCount,
     nodes: [{index, type, origin, angle, spawnflags, targetname, target, animscript,
              script_linkName, script_noteworthy, parent, dynamicGroup, zone, [pathAbility,]
              links: [{target, fDist, flags, negotiationLink, disconnectCount}]}],
     dynamicNodeGroups: [{parentIndex, nodes}],
     counts: {entityNodes, zoneNodes, dynamicNodes, links}}

What the data means is reverse/cod-pathdata/README.md: `type` is the game's own
number, `angle` the yaw in degrees, `origin` inches with Z up, `zone` 255 for none.
The last `zoneCount` nodes are the zone graph's (§6), which `counts` says rather
than this deciding to drop them.

Ghosts' PATHDATA has no Python walker: the emulated Durango loader
(`emulated.py`) loads it, and this reads the result out of the emulator's
memory by the PC layout (the path structs are the same size in both builds).
"""

import struct

from ..memory import Struct
from . import GAME, dumper
from .common import asset_path, write_json

VERSION = 1
NO_ZONE = 255


def pathdata_json(game, name, header, nodes, groups, zones):
    """The dump: `nodes` as `node_record` made them, `groups` [(parentIndex, [node, ...])],
    `zones` the per-node zone bytes (or None). Marks each node's dynamic group and zone."""
    count, zone_count = header["nodeCount"], header["zoneCount"]
    if len(nodes) != count:
        raise SystemExit(f"{name}: read {len(nodes)} path nodes of the {count} the header declares")
    member = {}
    for g, (_parent, listed) in enumerate(groups):
        for i in listed:
            if i in member or not 0 <= i < count:
                raise SystemExit(f"{name}: dynamic group {g} lists node {i}, which is out of range or in another group")
            member[i] = g
    for i, node in enumerate(nodes):
        node["dynamicGroup"] = member.get(i)
        node["zone"] = zones[i] if zones and i < len(zones) else NO_ZONE
    return {
        "_game": game,
        "_type": "pathdata",
        "_version": VERSION,
        "name": name,
        "version": header["version"],
        "nodeCount": count,
        "zoneCount": zone_count,
        "nodes": nodes,
        "dynamicNodeGroups": [{"parentIndex": parent, "nodes": sorted(listed)} for parent, listed in groups],
        "counts": {
            "entityNodes": count - zone_count,
            "zoneNodes": zone_count,
            "dynamicNodes": len(member),
            "links": sum(len(n["links"]) for n in nodes),
        },
    }


def node_record(index, fields, links, string):
    """One node of the dump. `fields` holds pathnode_constant_t's members by name (the
    string ones as script-string indices, `origin` and `angle` already read); `links`
    is [(fDist, nodeNum, disconnectCount, negotiationLink, flags)]."""
    rec = {
        "index": index,
        "type": fields["type"],
        "origin": list(fields["origin"]),
        "angle": fields["angle"],
        "spawnflags": fields["spawnflags"],
        "targetname": string(fields["targetname"]),
        "target": string(fields["target"]),
        "animscript": string(fields["animscript"]),
        "script_linkName": string(fields["script_linkName"]),
        "script_noteworthy": string(fields["script_noteworthy"]),
        "parent": fields["parent"],
    }
    if "pathAbility" in fields:
        rec["pathAbility"] = fields["pathAbility"]
    rec["links"] = [
        {"target": num, "fDist": dist, "flags": flags, "negotiationLink": neg, "disconnectCount": disconnect}
        for dist, num, disconnect, neg, flags in links
    ]
    return rec


def script_string(zone):
    """A scr_string_t reader over `zone`'s script strings: "" for none."""
    strings = zone.script_strings

    def string(index):
        return (strings[index] or "") if 0 < index < len(strings) else ""

    return string


def require_closed(zone, name):
    """Refuse a path zone whose walk did not close: it must end on the zone's last byte with
    every block but TEMP (reused, so a high-water mark) on the size its header declares.
    A path zone holds its PATHDATA and one rawfile, so an open walk means a misread graph."""
    reached, declared = list(zone.blocks[1:]), list(zone.block_sizes[1:])
    if zone.pos != len(zone.data) or reached != declared:
        raise SystemExit(
            f"{name}: the path zone's walk did not close (ended at {zone.pos} of {len(zone.data)}, "
            f"blocks {reached} against the header's {declared}); its path data would be misread"
        )


def tree_leaves(trees):
    """Every node index a pathnode_tree_t array lists in its leaves, from records that
    carry `axis` and either `nodes` (a leaf) or `children` (subtrees; an alias into the
    array is skipped, since the array itself is iterated)."""
    for t in trees:
        if "nodes" in t:
            yield from t["nodes"]
        else:
            yield from tree_leaves(k for k in t.get("children", ()) if "alias" not in k)


LINK = struct.Struct("<fHBBB3x")
STRING_FIELDS = ("targetname", "script_linkName", "script_noteworthy", "target", "animscript")


@dumper("pathdata")
def write(walked, out):
    zone = walked.zone
    string = script_string(zone)
    for name, loaded in zone.found.get("PATHDATA", {}).items():
        require_closed(zone, name)
        p = Struct.of(zone, loaded)
        header = {k: p[k] for k in ("nodeCount", "zoneCount", "version")}
        nodes = []
        for i, node in enumerate(p.array("nodes", "pathnode_t", header["nodeCount"])):
            fields = {k: node[f"constant.{k}"] for k in ("type", "spawnflags", *STRING_FIELDS)}
            fields["origin"] = struct.unpack("<3f", node.bytes("constant.vLocalOrigin"))
            fields["angle"] = struct.unpack_from("<f", node.bytes("constant.___u9"))[0]  # {fAngle, forward[2]}
            fields["parent"] = struct.unpack("<I", node.bytes("constant.parent"))[0]
            count = node["constant.totalLinkCount"]
            raw = node.data("constant.Links", LINK.size * count) if count else b""
            links = [LINK.unpack_from(raw, LINK.size * k) for k in range(count)] if raw else []
            nodes.append(node_record(i, fields, links, string))
        groups = [
            (g["parentIndex"], sorted(tree_leaves(_tree(g.array("nodeTree", "pathnode_tree_t", g["nodeTreeCount"])))))
            for g in p.array("dynamicNodeGroups", "PathDynamicNodeGroup", p["dynamicNodeGroupCount"])
        ]
        zones = p.data("pathZones", p["zonesBytes"]) if p["zonesBytes"] else None
        data = pathdata_json(GAME, name, header, nodes, groups, zones)
        write_json(asset_path(out, f"{name}.pathdata.json"), data)


def _tree(records):
    """A pathnode_tree_t array in emulator memory, as `tree_leaves` reads it. A child is a
    pointer into the same array (an alias in the zone), so it is marked and not followed."""
    out = []
    for t in records:
        raw = t.bytes("u")
        if t["axis"] >= 0:
            out.append({"axis": t["axis"], "children": [{"alias": True}, {"alias": True}]})
        else:
            count, ptr = struct.unpack("<i4xQ", raw)
            nodes = list(struct.unpack(f"<{count}H", t.emulator.read(ptr, 2 * count))) if ptr and count else []
            out.append({"axis": t["axis"], "nodes": nodes})
    return out
