"""A T9 material (asset type 10): its technique set and texture table, and what its images are.

The record is 0x150 bytes: XHash, +0x30 an alias to the technique set (type
15), +0x38 the texture table (-1: inline after the record; otherwise a pointer
to an identical table another material loaded, which is not resolved yet), and
+0x140 the texture count. The table is T8's MaterialTextureDef in 24 bytes:
u64 image alias, u32 slot-name hash, f32 1.0, f32 1.0, u32 shader slot.

The slot hashes are not FNV of their names, so they are named by what they hold
across mp_kgb's tables (reverse/t9-zone/types_material.py): `a0ab1041` is the
colour map (always sRGB), `59d30d0f` the normal map. There are no state bits
here yet, so every material is drawn opaque (materials.TECHNIQUES_BY_GAME).
"""

from .zone import IMAGE, NULL, name_of, texture_table

COLOUR_SLOT = 0xA0AB1041
NORMAL_SLOT = 0x59D30D0F
SLOTS = {COLOUR_SLOT: ("colorMap", "colorMap"), NORMAL_SLOT: ("normalMap", "normalMap")}
TEXTURE_TABLE = 0x38


class Material:
    """One material, its stub resolved: its name, technique set and the images in its known slots."""

    def __init__(self, zones, zone, h):
        self.zone, self.at = zone, h
        self.name = name_of(zone.u64(h))
        # Named by list entry: a technique set's name is a hash no table here reverses.
        techset = zone.alias(zone.u64(h + 0x30))
        self.techset = f"techset_{zone.name}_{techset}" if techset is not None else ""
        self.images = {}  # slot -> (image zone, record)
        self.shared_table = zone.u64(h + TEXTURE_TABLE) != NULL
        if self.shared_table:
            return
        table = texture_table(zone, h, zone.index.material_end(h))
        if table is None:
            return
        for image, slot in table[1]:
            if slot not in SLOTS:
                continue
            izone, ih = zones.entry(zone, zone.alias(image), IMAGE)
            if izone is not None:
                self.images[slot] = (izone, ih)

    def image_name(self, slot):
        found = self.images.get(slot)
        return name_of(found[0].u64(found[1])) if found else None

    def json(self, game):
        textures = []
        for slot, (semantic, name) in SLOTS.items():
            image = self.image_name(slot)
            if image:
                textures.append({"semantic": semantic, "name": name, "image": image})
        return {"_game": game, "_type": "material", "name": self.name, "techniqueSet": self.techset, "textures": textures}
