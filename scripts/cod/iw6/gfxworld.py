"""Walk a map zone through its GfxWorld: the world walker, and walk_map().

    python3 -m scripts.cod.iw6.gfxworld <map.ff>     walk it and report the world

Every asset before the world is walked (walkers.py), so that the world's
material handles, which point at asset-list slots or at materials embedded
earlier, resolve to names. The world walk mirrors x64-zt's gfx_world::write
(assets/gfxworld.cpp) with the loader's handles; runtime-block arrays move the
runtime cursor but are not in the file.
"""

import struct
import sys
from collections import namedtuple

from . import durango
from .ff import read_ff
from .records import Placement
from .walkers import ASSET_TYPES, WALKERS, ZoneWalk, field_asset, walker
from .zone import RUNTIME, VIRTUAL, follows

# `vertices`, `indices`, `models` and `instances` are file offsets of the arrays behind
# draw.vd.vertices, draw.indices, models (GfxBrushModel) and dpvs.smodelInsts.
World = namedtuple("World", "name base_name header vertices indices surfaces sky_surfaces materials placements instances models")
SKY_MATERIAL = "wc/sky_"  # skyStartSurfs does not name the sky shell; its material does
WORLDS = []  # the GfxWorld of the zone being walked, for the caller


@walker("GFXWORLD")
def gfxworld(z):
    w = z.struct("GfxWorld")
    z.push(VIRTUAL)
    name = z.field_string(w, "name")
    base_name = z.field_string(w, "baseName")

    sky_surfaces = set()  # what skyStartSurfs lists; not the sky shell (SKY_MATERIAL)
    if follows(w["skies"]):
        z.align(3)
        for sky in z.array("GfxSky", w["skyCount"]):
            start = z.elements(sky, "skyStartSurfs", sky["skySurfCount"], align=3)
            if start is not None:
                sky_surfaces.update(struct.unpack_from(f"<{sky['skySurfCount']}i", z.data, start))
            field_asset(z, sky, "skyImage", "IMAGE")
    cells = w["dpvsPlanes.cellCount"]
    z.elements(w, "dpvsPlanes.planes", w["planeCount"], align=3)
    z.elements(w, "dpvsPlanes.nodes", w["nodeCount"], align=1)
    z.push(RUNTIME)
    z.elements(w, "dpvsPlanes.sceneEntCellBits", cells << 9, align=3)
    z.pop()

    tree_counts = []
    if follows(w["aabbTreeCounts"]):
        z.align(3)
        tree_counts = [c["aabbTreeCount"] for c in z.array("GfxCellTreeCount", cells)]
    if follows(w["aabbTrees"]):
        z.align(127)
        for i, tree in enumerate(z.array("GfxCellTree", cells)):
            if follows(tree["aabbTree"]):
                z.align(3)
                for node in z.array("GfxAabbTree", tree_counts[i]):
                    z.elements(node, "smodelIndexes", node["smodelIndexCount"], align=1)
    if follows(w["cells"]):
        z.align(3)
        for cell in z.array("GfxCell", cells):
            if follows(cell["portals"]):
                z.align(3)
                for portal in z.array("GfxPortal", cell["portalCount"]):
                    z.elements(portal, "vertices", portal["vertexCount"], align=3)
                    portal.touch("writable.hullPoints", "writable.queuedParent")
            z.elements(cell, "reflectionProbes", cell["reflectionProbeCount"], align=0)
            z.elements(cell, "reflectionProbeReferences", cell["reflectionProbeReferenceCount"], align=0)

    probes = w["draw.reflectionProbeCount"]
    z.handles(w, "draw.reflectionProbes", probes, WALKERS["IMAGE"], "IMAGE")
    if follows(w["draw.reflectionProbeOrigins"]):
        z.align(3)
        for origin in z.array("GfxReflectionProbe", probes):
            z.elements(origin, "probeVolumes", origin["probeVolumeCount"], align=3)
    z.push(RUNTIME)
    z.elements(w, "draw.reflectionProbeTextures", probes, align=3)
    z.pop()
    references = w["draw.reflectionProbeReferenceCount"]
    z.elements(w, "draw.reflectionProbeReferenceOrigins", references, align=3)
    z.elements(w, "draw.reflectionProbeReferences", references, align=0)
    lightmaps = w["draw.lightmapCount"]
    if follows(w["draw.lightmaps"]):
        z.align(3)
        for lightmap in z.array("GfxLightmapArray", lightmaps):
            field_asset(z, lightmap, "primary", "IMAGE")
            field_asset(z, lightmap, "secondary", "IMAGE")
    z.push(RUNTIME)
    z.elements(w, "draw.lightmapPrimaryTextures", lightmaps, align=3)
    z.elements(w, "draw.lightmapSecondaryTextures", lightmaps, align=3)
    z.pop()
    field_asset(z, w, "draw.lightmapOverridePrimary", "IMAGE")
    field_asset(z, w, "draw.lightmapOverrideSecondary", "IMAGE")

    vertices = z.elements(w, "draw.vd.vertices", w["draw.vertexCount"], align=3)
    z.elements(w, "draw.vld.data", w["draw.vertexLayerDataSize"], align=0)
    indices = z.elements(w, "draw.indices", w["draw.indexCount"], align=1)
    w.touch("draw.vd.worldVb", "draw.vld.layerVb", "draw.indexBuffer")

    g = "lightGrid."
    axis = w[g + "rowAxis"]
    mins = struct.unpack("<3H", w.bytes(g + "mins"))
    maxs = struct.unpack("<3H", w.bytes(g + "maxs"))
    z.elements(w, g + "rowDataStart", maxs[axis] - mins[axis] + 1, align=1)
    z.elements(w, g + "rawRowData", w[g + "rawRowDataSize"], align=0)
    z.elements(w, g + "entries", w[g + "entryCount"], align=3)
    z.elements(w, g + "colors", w[g + "colorCount"], align=3)
    z.elements(w, g + "stageLightingContrastGain", w[g + "stageCount"], align=3)
    z.elements(w, g + "paletteEntryAddress", w[g + "paletteEntryCount"], align=3)
    z.elements(w, g + "paletteBitstream", w[g + "paletteBitstreamSize"], align=0)
    z.elements(w, g + "tree.p_nodeTable", w[g + "tree.nodeCount"], align=3)
    z.elements(w, g + "tree.p_leafTable", w[g + "tree.leafTableSize"], align=0)

    models = z.elements(w, "models", w["modelCount"], align=3)
    if follows(w["materialMemory"]):
        z.align(3)
        for memory in z.array("MaterialMemory", w["materialMemoryCount"]):
            field_asset(z, memory, "material", "MATERIAL")
    field_asset(z, w, "sun.spriteMaterial", "MATERIAL")
    field_asset(z, w, "sun.flareMaterial", "MATERIAL")
    field_asset(z, w, "outdoorImage", "IMAGE")

    lights = w["primaryLightCount"]
    shadowed = lights - w["lastSunPrimaryLightIndex"] - 1
    dyn_models, dyn_brushes = w["dpvsDyn.dynEntClientCount[0]"], w["dpvsDyn.dynEntClientCount[1]"]
    z.push(RUNTIME)
    z.elements(w, "cellCasterBits", cells * ((cells + 31) >> 5), align=3)
    z.elements(w, "cellHasSunLitSurfsBits", (cells + 31) >> 5, align=3)
    z.elements(w, "sceneDynModel", dyn_models, align=3)
    z.elements(w, "sceneDynBrush", dyn_brushes, align=3)
    z.elements(w, "primaryLightEntityShadowVis", shadowed << 13, align=3)
    z.elements(w, "primaryLightDynEntShadowVis[0]", dyn_models * shadowed, align=3)
    z.elements(w, "primaryLightDynEntShadowVis[1]", dyn_brushes * shadowed, align=3)
    z.elements(w, "nonSunPrimaryLightForModelDynEnt", dyn_models, align=1)
    z.pop()

    for path in ("shadowGeom", "shadowGeomOptimized"):
        if follows(w[path]):
            z.align(3)
            for geometry in z.array("GfxShadowGeometry", lights):
                z.elements(geometry, "sortedSurfIndex", geometry["surfaceCount"], align=3)
                z.elements(geometry, "smodelIndex", geometry["smodelCount"], align=1)
    if follows(w["lightRegion"]):
        z.align(3)
        for region in z.array("GfxLightRegion", lights):
            if follows(region["hulls"]):
                z.align(3)
                for hull in z.array("GfxLightRegionHull", region["hullCount"]):
                    z.elements(hull, "axis", hull["axisCount"], align=3)

    d = "dpvs."
    smodels, surface_vis, smodel_vis = w[d + "smodelCount"], w[d + "surfaceVisDataCount"], w[d + "smodelVisDataCount"]
    z.push(RUNTIME)
    for i in range(3):
        z.elements(w, f"{d}smodelVisData[{i}]", smodel_vis, align=127)
    for i in range(3):
        z.elements(w, f"{d}surfaceVisData[{i}]", surface_vis, align=127)
    for i in range(3):
        z.elements(w, f"{d}unknownData01[{i}]", smodel_vis + 1, align=127)
    for i in range(3):
        z.elements(w, f"{d}unknownData02[{i}]", surface_vis, align=127)
    z.pop()
    z.elements(w, d + "lodData", smodels + 1, align=3)
    z.push(RUNTIME)
    for i in range(3):
        z.elements(w, f"{d}tessellationCutoffVisData[{i}]", surface_vis, align=127)
    z.pop()
    z.elements(w, d + "sortedSurfIndex", w[d + "staticSurfaceCount"], align=3)
    instances = z.elements(w, d + "smodelInsts", smodels, align=3)

    surfaces, materials = [], []
    if follows(w[d + "surfaces"]):
        z.align(3)
        surfaces = z.array("GfxSurface", w["surfaceCount"])
        for surface in surfaces:
            materials.append(field_asset(z, surface, "material", "MATERIAL"))
    z.elements(w, d + "surfacesBounds", w["surfaceCount"], align=3)
    placements = []
    if follows(w[d + "smodelDrawInsts"]):
        z.align(3)
        info = "vertexLightingInfo."
        for inst in z.array("GfxStaticModelDrawInst", smodels):
            model = field_asset(z, inst, "model", "XMODEL")
            placements.append(placement(inst, model))
            z.elements(inst, info + "lightingValues", inst[info + "numLightingValues"], align=3)
            inst.touch(info + "lightingValuesVb", info + "lightingValuesSb")

    z.push(RUNTIME)
    z.elements(w, d + "surfaceMaterials", w["surfaceCount"], align=7)
    z.elements(w, d + "surfaceCastsSunShadow", surface_vis, align=127)
    z.elements(w, d + "surfaceCastsSunShadowOpt", w[d + "sunShadowOptCount"] * w[d + "sunSurfVisDataCount"], align=127)
    for path in ("constantBuffersLit", "constantBuffersAmbient"):
        z.elements(w, d + path, smodels, align=7)
    z.pop()

    z.push(RUNTIME)
    words = (w["dpvsDyn.dynEntClientWordCount[0]"], w["dpvsDyn.dynEntClientWordCount[1]"])
    z.elements(w, "dpvsDyn.dynEntCellBits[0]", words[0] * cells, align=3)
    z.elements(w, "dpvsDyn.dynEntCellBits[1]", words[1] * cells, align=3)
    for j in range(3):
        for i in range(2):
            z.elements(w, f"dpvsDyn.dynEntVisData[{i}][{j}]", 32 * words[i], align=15)
    z.pop()

    z.elements(w, "heroOnlyLights", w["heroOnlyLightCount"], align=3)
    z.elements(w, "umbraTomeData", w["umbraTomeSize"], align=15)
    w.touch("umbraTomePtr")
    z.pop()
    WORLDS.append(World(name, base_name, w, vertices, indices, surfaces, sky_surfaces, materials, placements, instances, models))
    return name


def placement(inst, model):
    at = inst.zone.layout.resolve(inst.type, "placement")[0] + inst.at
    values = struct.unpack_from("<13f", inst.zone.data, at)
    axis = (values[3:6], values[6:9], values[9:12])
    return Placement(model[1] if model else None, values[0:3], axis, values[12])


def walk_zone(path, stop=None):
    """Walk a zone (up to the first asset of type `stop`). Returns (ZoneWalk, World or None).

    Asset types without a Python walker (weapons, menus, ...) are run through the
    Durango loader when $IW6_DURANGO names its folder (emulated.py)."""
    stream_files, zone = read_ff(path)
    walk = ZoneWalk(zone, ASSET_TYPES, stream_files=stream_files)
    if durango.folder():
        from . import emulated  # needs capstone, so only imported when it can run

        emulated.use(walk)
    walk.header()
    WORLDS.clear()
    walk.walk(stop)
    return walk, WORLDS[-1] if WORLDS else None


def walk_map(path, stop=None):
    """Walk a map's zone through its GfxWorld. Returns (ZoneWalk, World)."""
    walk, world = walk_zone(path, stop)
    if world is None:
        raise RuntimeError(f"stopped before the world: {walk.failed}")
    return walk, world


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    walk, world = walk_map(sys.argv[1])
    z, w = walk.z, world.header
    resolved = sum(1 for m in world.materials if m and m[1])
    print(
        f"{len(walk.assets)} assets walked; stopped at {walk.failed}\n"
        f"GfxWorld: {w['draw.vertexCount']} vertices, {w['draw.indexCount'] // 3} triangles, "
        f"{len(world.surfaces)} surfaces, materials named on {resolved}"
    )
    if z.unhandled:
        print(f"{len(z.unhandled)} inline pointers no walker read, e.g. {z.unhandled[:5]}")


if __name__ == "__main__":
    main()
