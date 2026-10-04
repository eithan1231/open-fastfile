"""`clipmap`: the brushes and the triangle soup, in the schema scripts/cod/collision.py reads.

A brush is written as its bounds plus the planes of its vertices' convex hull
that are not axial (the axial six are the bounds): the zone's own side records
are not read yet, and the hull of the vertices each brush owns is the same
volume (reverse/t9-zone/world_clip.py: every vertex inside its brush, each
used once). Each distinct contents value is one material, so a brush's faces
name it.

The soup's indices are u8, relative to a partition's 23-bit vertex base; the
schema's are u16 relative to `firstVertSegment * 1024`, so each index is
rewritten as `base % 1024 + index` under segment `base // 1024`. Partitions are
written as ground: their 10-bit material is not yet a contents value.
"""

import struct

from ...collision import VERT_SEGMENT
from ...iw6.dumpers.common import asset_path, write_json
from .. import world
from . import GAME, dumper

AXIAL = 0.9999
SOUP_CONTENTS = world.SOLID


def midpoint(mins, maxs):
    return {
        "midPoint": [(a + b) / 2 for a, b in zip(mins, maxs, strict=True)],
        "halfSize": [(b - a) / 2 for a, b in zip(mins, maxs, strict=True)],
    }


def brushes(d, clip, materials):
    index = {}
    out = []
    for i in range(clip.counts[2]):
        mins, maxs, contents, pts = clip.brush(d, i)
        m = index.get(contents)
        if m is None:
            m = index[contents] = len(materials)
            materials.append({"name": f"t9_contents_{contents:08x}", "surfaceFlags": 0, "contents": contents})
        sides = []
        if len(pts) >= 4:
            for normal, dist in world.hull_planes(pts):
                if max(abs(c) for c in normal) < AXIAL:
                    sides.append({"materialNum": m, "normal": list(normal), "dist": dist})
        out.append(
            {
                "numsides": len(sides),
                "axialMaterialNum": [[m, m, m], [m, m, m]],
                "contents": contents,
                "bounds": midpoint(mins, maxs),
                "sides": sides,
            }
        )
    return out


def soup(d, clip, out, name, data, materials):
    nverts, nidx, nparts = clip.counts[4:7]
    raw = d[clip.soup_indices : clip.soup_indices + nidx]
    tri_count = nidx // 3
    tris = bytearray(6 * tri_count)
    covered = bytearray(tri_count)
    partitions, leaves, by_material = [], [], {}
    for k in range(nparts):
        base, first, count, material = clip.partition(d, k)
        if first + count > tri_count:
            raise SystemExit(f"soup partition {k} runs past the {tri_count} soup triangles")
        segment, low = divmod(base, VERT_SEGMENT)
        for t in range(first, first + count):
            a, b, c = raw[3 * t : 3 * t + 3]
            if base + max(a, b, c) >= nverts:
                raise SystemExit(f"soup triangle {t} indexes past the {nverts} soup vertices")
            struct.pack_into("<3H", tris, 6 * t, low + a, low + b, low + c)
            covered[t] += 1
        partitions.append({"firstTri": first, "triCount": count, "firstVertSegment": segment, "borderCount": 0})
        m = by_material.get(material)
        if m is None:
            m = by_material[material] = len(materials)
            materials.append({"name": f"t9_soup_{material}", "surfaceFlags": 0, "contents": SOUP_CONTENTS})
        leaves.append({"materialIndex": m, "childCount": 0, "partition": k})
    if any(c != 1 for c in covered):
        raise SystemExit(
            f"the soup partitions cover {sum(1 for c in covered if c == 1)} of {tri_count} triangles once: they are misread"
        )
    with open(asset_path(out, f"{name}.clipmap_verts.bin"), "wb") as fh:
        fh.write(d[clip.soup : clip.soup + 12 * nverts])
    with open(asset_path(out, f"{name}.clipmap_tris.bin"), "wb") as fh:
        fh.write(tris)
    data.update(
        vertFile=f"{name}.clipmap_verts.bin",
        vertStride=12,
        vertCount=nverts,
        triFile=f"{name}.clipmap_tris.bin",
        triStride=2,
        triCount=tri_count,
        partitionCount=nparts,
    )
    return partitions, leaves


@dumper("clipmap")
def write(walked, out):
    d, clip = walked.zone.data, walked.clip
    name = walked.bsp
    data = {"_game": GAME, "_type": "clipmap", "_version": 1, "name": name}
    materials = []
    data["brushes"] = brushes(d, clip, materials)
    data["partitions"], data["aabbTrees"] = soup(d, clip, out, name, data, materials)
    data["materials"] = materials
    data["planeCount"] = clip.counts[0]
    data["cmodels"] = [{"brushes": [], "partitions": []}]
    data["staticModels"] = []
    data["dynEnts"] = [[], []]
    write_json(asset_path(out, f"{name}.clipmap.json"), data)
    print(f"      clipmap: {len(data['brushes'])} brushes, {data['triCount']} soup triangles, {len(materials)} materials")
