"""`xmodel`: each placed model's LOD 0 as `model_export/<name>_lod0.glb`, and `xmodel/<name>.json`.

Only LOD 0, rigid: the placements are static, and the vertex's colour (whose
meaning is open) is left white. Positions are CoD units, as the zone keeps them.
"""

from ... import xmodel_glb as glb
from ...iw6.dumpers.common import asset_path, write_json
from .. import models
from ..materials import COLOUR_SLOT
from . import GAME, dumper

SCHEMA = "http://openassettools.dev/schema/xmodel.v1.json"


def lod_data(name, walked, mesh, mats, item):
    positions, normals, uvs, _colours, surfaces = models.decode(item, mesh)
    lod = glb.ModelLodData(f"{name}_lod0", positions=positions, normals=normals, uvs=uvs, colours=[glb.WHITE] * len(positions))
    index = {}
    for s, (first, tris) in enumerate(surfaces):
        m = mats[s] if mats else None
        key = m.name if m else "t9_unresolved"
        if key not in index:
            index[key] = len(lod.materials)
            # The colour map only: the image dump writes no normal maps.
            lod.materials.append(glb.ModelMaterial(key, m.image_name(COLOUR_SLOT) if m else None))
        lod.surfaces.append(glb.Surface(index[key], first, [tuple(t) for t in tris]))
    return lod


@dumper("xmodel")
def write(walked, out):
    written = missing = empty = 0
    for h, (xm, mesh, mats) in sorted(walked.models.items()):
        name = f"{h:016x}"
        item = mesh.item(walked.zone.data, walked.packages)
        if item is None:
            missing += 1
            continue
        if not mesh.surface_count:
            empty += 1  # nothing to draw; a GLB of no nodes has no root to scale
            continue
        glb.write(asset_path(out, f"model_export/{name}_lod0.glb"), lod_data(name, walked, mesh, mats, item))
        data = {
            "$schema": SCHEMA,
            "_game": GAME,
            "_type": "xmodel",
            "_version": 2,
            "flags": 0,
            "lods": [{"distance": xm["distances"][0], "file": f"model_export/{name}_lod0.glb"}],
            "type": "rigid",
        }
        write_json(asset_path(out, f"xmodel/{name}.json"), data)
        written += 1
    placed = len({p[0] for p in walked.placements[0]})
    print(
        f"      xmodel: {written} of {placed} placed models written; "
        f"{missing} whose mesh is in no installed package, {empty} with no surfaces"
    )
