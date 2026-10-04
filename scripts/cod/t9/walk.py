"""One inflated T9 zone and everything the dumpers read from it, each found on first use."""

import os
from functools import cached_property

from . import ff, models, world, xpak
from .materials import COLOUR_SLOT, Material
from .zone import MATERIAL, Zone, name_of
from .zoneset import ZoneSet


class Walked:
    def __init__(self, path):
        self.path = path
        self.map = os.path.splitext(os.path.basename(path))[0]
        self.zone_dir = os.path.dirname(path)
        self.zone = Zone(ff.inflate(path), self.map)
        self.zones = ZoneSet(self.zone, self.zone_dir)
        self._materials = {}

    @cached_property
    def packages(self):
        return xpak.Packages(self.zone_dir)

    @cached_property
    def gfx(self):
        return world.GfxWorld(self.zone.data, self.map)

    @cached_property
    def clip(self):
        return world.Clip(self.zone.data)

    @cached_property
    def placements(self):
        return world.placements(self.zone.data)

    @cached_property
    def bsp(self):
        return world.bsp_name(self.map)

    def material(self, zone, j):
        """The Material list entry `j` of `zone` names (a stub resolved), or None when unknown."""
        mzone, h = self.zones.entry(zone, j, MATERIAL)
        if mzone is None:
            return None
        key = (mzone.name, h)
        if key not in self._materials:
            self._materials[key] = Material(self.zones, mzone, h)
        return self._materials[key]

    @cached_property
    def world_surfaces(self):
        """The world's own surfaces (brush model 0), each with its Material or None."""
        d, gfx = self.zone.data, self.gfx
        _, _, _, _, _, _, count, start = gfx.models[0]
        out = []
        for i in range(start, start + count):
            s = gfx.surface(d, i)
            s["material"] = self.material(self.zone, self.zone.alias(s["material"]))
            out.append(s)
        return out

    @cached_property
    def models(self):
        """{model name hash: (xmodel dict, LOD0 Mesh, [Material or None per surface])} for every placed model."""
        table = self.placements[1] or (0, 0)
        zm = models.ZoneModels(self.zone)
        out = {}
        for name in sorted({p[0] for p in self.placements[0]}):
            found = zm.resolve(name, table)
            if not found or found["xmodel"] is None:
                continue
            xm = zm.xmodel(found["xmodel"], found["meshes"])
            if not xm or xm["lods"][0][0] is None:
                continue
            k, entries = xm["lods"][0]
            mesh = zm.meshes[k]
            mats = [self.material(self.zone, j) for j in entries] if entries and len(entries) == mesh.surface_count else None
            out[name] = (xm, mesh, mats)
        return out

    @cached_property
    def used_materials(self):
        """{name: Material} of every material a world surface or a model's LOD0 draws with."""
        out = {}
        for s in self.world_surfaces:
            if s["material"]:
                out[s["material"].name] = s["material"]
        for _, _, mats in self.models.values():
            for m in mats or ():
                if m:
                    out[m.name] = m
        return out

    @cached_property
    def colour_images(self):
        """{name: (zone, record)} of the colour map of every used material."""
        out = {}
        for m in self.used_materials.values():
            found = m.images.get(COLOUR_SLOT)
            if found:
                out[name_of(found[0].u64(found[1]))] = found
        return out
