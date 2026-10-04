"""One writer per dump kind, keyed by the name `Backend.dump` takes, in the dump tree's schema with `_game: "t9"`.

What is not in the zone as T9 reads it today is written as a placeholder the
later stages accept, and said here so that it is not mistaken for the map's:

- **gfxworld**: the world's own surfaces only (brush model 0), with `models`
  holding just that one; the other brush models (doors, destructibles) need the
  entity keys that place them, which are hashes not yet read. No lightmap: T9
  keeps none, so there is no second UV set to write.
- **clipmap**: brushes whose sides are their vertices' convex hull (the zone's
  own side records are not read), one material per contents value, and soup
  partitions as ground (their 10-bit material is not yet a contents value);
  `cmodels`, `staticModels` and `dynEnts` hold only the world.
- **material**: a colour and a normal map, and no state bits: every surface is
  opaque. A texture table another material shares is not followed yet, so such
  a material has no textures.
- **mapents**: the entity lists' records, with the keys and values that
  resolved to strings.
"""

GAME = "t9"
DUMPERS = {}
COMPLETE = set()
PARTS = {}


def dumper(kind, parts=None):
    def register(fn):
        DUMPERS[kind] = fn
        if parts is None:
            COMPLETE.add(kind)
        else:
            PARTS[kind] = frozenset(parts)
        return fn

    return register


from . import clipmap, gfxworld, image, mapents, material, xmodel  # noqa: E402, F401  (each registers itself)
