"""The map's own collision (its clipMap_t dump) as one .glb, split into named groups.

Collision is authored separately from anything visible: invisible walls, the
map boundary, ledges you cannot drop off. Three sources go in: brushes (convex
volumes, turned into triangles here), the triangle soup (terrain and patches),
and the partitions that index the soup. Each group carries its decoded contents
bits in glTF `extras`, which engine/colliderView.ts and engine/picking.ts read to
say what is blocking the player. Bit tables and index rules: docs/cod/reference.md#collision.
"""

import collections
import os
import struct
import sys

from . import brushmodels
from .brushmodels import part_of
from .files import read_bytes, read_json
from .gltf import ARRAY_BUFFER, ELEMENT_ARRAY_BUFFER, add_view, pack, write_glb
from .units import UNITS_PER_M, to_engine, vec3

#: Added to each rounded coordinate of a weld key so it fits an unsigned 32-bit field.
_WELD_BIAS = 1 << 31

SOLID = 0x00000001
PLAYERCLIP = 0x00010000
AICLIP = 0x00020000
VEHICLECLIP = 0x00000200
WATER = 0x00000020  # T5 and IW6

# Soup vertex indices are 16-bit; a partition's `firstVertSegment` supplies the
# high part in steps of this many vertices (IW4/IW5 and IW6). Getting it wrong is silent.
VERT_SEGMENT = 1024

# Clipping tolerance, relative to the brush's own size (see face_polygon).
EPS_REL = 1e-6

# What each contents bit stops, derived from the zones' own material tables.
CONTENTS_BITS_IW = (
    (0x00000001, "solid"),
    (0x00000002, "foliage"),
    (0x00000004, "camera"),
    (0x00000010, "glass"),
    (0x00000040, "projectile"),
    (0x00000080, "item"),
    (0x00000200, "vehicle"),
    (0x00000400, "sight"),
    (0x00001000, "sight2"),
    (0x00002000, "detail2"),
    (0x00010000, "player"),
    (0x00020000, "ai"),
    (0x01000000, "mantle"),
    (0x08000000, "detail"),
)
CONTENTS_BITS_T5 = (
    (0x00000001, "solid"),
    (0x00000010, "glass"),
    (0x00000020, "water"),
    (0x00000040, "projectile"),
    (0x00000080, "missile"),
    (0x00000200, "vehicle"),
    (0x00000400, "physics"),
    (0x00000800, "sky"),
    (0x00001000, "sight"),
    (0x00002000, "weapon"),
    (0x00010000, "player"),
    (0x00020000, "ai"),
    (0x08000000, "detail"),
    (0x10000000, "hint"),
)
# Black Ops II publishes its own answer, as Ghosts does: `infoParms[]` in the
# symbolised dedicated server (0xdd62c0, 20-byte rows) pairs each Radiant keyword
# with the bit it sets. The bits the pipeline decides on (solid, playerclip,
# monsterclip, water, mantle) are the ones read off mp_la's `clip_*` materials;
# the table renames four others (0x400 `itemclip`, 0x1000 `ai_nosight`, 0x2000
# `clipshot`, 0x10000000 `structural`). reverse/t6-traversal/README.md.
CONTENTS_BITS_T6 = (
    (0x00000001, "solid"),
    (0x00000002, "foliage"),
    (0x00000010, "glass"),
    (0x00000020, "water"),
    (0x00000040, "canshoot"),  # canShootClip
    (0x00000080, "missile"),  # clipmissile
    (0x00000200, "vehicle"),  # vehicleclip
    (0x00000400, "item"),  # itemclip; mp_la's `clip_physics`
    (0x00000800, "sky"),
    (0x00001000, "nosight"),  # ai_nosight
    (0x00002000, "clipshot"),
    (0x00010000, "player"),  # playerclip
    (0x00020000, "ai"),  # monsterclip
    (0x01000000, "mantle"),  # mantleOn / mantleOver / mount
    (0x08000000, "detail"),
    (0x10000000, "structural"),
    (0x80000000, "nodrop"),
)
# Ghosts publishes its own answer: the `infoParms` table in the Durango server
# build pairs each Radiant keyword with the bit it sets. Four of IW4/IW5's
# guessed labels were wrong (0x4, 0x400, 0x1000, 0x2000); the two the pipeline
# decides on, SOLID and PLAYERCLIP, are the same. docs/cod/reference.md#collision.
CONTENTS_BITS_IW6 = (
    (0x00000001, "solid"),
    (0x00000002, "foliage"),
    (0x00000004, "aideath"),  # aiclipallowdeath
    (0x00000010, "glass"),
    (0x00000020, "water"),
    (0x00000040, "canshoot"),  # canshootclip
    (0x00000080, "missile"),  # clipmissile
    (0x00000200, "vehicle"),  # vehicleclip
    (0x00000400, "item"),  # itemclip
    (0x00000800, "sky"),
    (0x00001000, "nosight"),  # ai_nosight
    (0x00002000, "clipshot"),
    (0x00010000, "player"),  # playerclip
    (0x00020000, "ai"),  # monsterclip
    (0x01000000, "mantle"),  # mantleOn / mantleOver
    (0x08000000, "detail"),
    (0x10000000, "structural"),
    (0x80000000, "nodrop"),
)
# Advanced Warfare publishes its own answer the same way Ghosts does: the X360
# server build's `infoParms[]` (89 rows of 20 bytes at 0x8301aba8, named by
# `6-s1_mp_fast_server.map`) names every contents bit, and every one it names is
# one of Ghosts'. reverse/s1-zone/README.md#the-contents-and-surface-tables.
CONTENTS_BITS_BY_GAME = {
    "iw4": CONTENTS_BITS_IW,
    "iw5": CONTENTS_BITS_IW,
    "t5": CONTENTS_BITS_T5,
    "t6": CONTENTS_BITS_T6,
    "iw6": CONTENTS_BITS_IW6,
    "s1": CONTENTS_BITS_IW6,
    # Cold War is Treyarch's line; T8's table is T5's in the bits the pipeline
    # decides on (solid 0x1, playerclip 0x10000, water 0x20). Inferred, not read
    # off a table of its own: reverse/t9-zone/README.md.
    "t9": CONTENTS_BITS_T5,
}

# Which kinds of surface enter the engine's collision. Everything reaches the
# .glb so the debug views can name it; the rest carry `collides: false`.
COLLIDING_ROLES = {"solid", "clip", "ground"}

#: Where a material's (or a T5 face's) surface type sits in its `surfaceFlags`:
#: `(flags >> 20) & SURFACE_TYPE_MASK_BY_GAME`. OpenAssetTools' IW4 `infoParms[]` is the proof —
#: `bark` sets 0x100000, `gravel` 0xb00000, `riotshield` 0x1d00000, each exactly
#: `index << 20` (docs/cod/reference.md#collision).
SURFACE_TYPE_SHIFT = 20
SURFACE_TYPE_MASK = 0x1F

#: Games whose surface-type field is wider than five bits. Advanced Warfare names
#: 52 surfaces, the last `cushion` 0x34, so its field runs to bit 25 and the next
#: flag above it is `mantleOn` 0x04000000. Masked to five bits its top 21 wrap
#: onto the bottom of the table, and every one of them is another real surface.
SURFACE_TYPE_MASK_BY_GAME = {"s1": 0x3F}

# The engine's own surface list, mirroring packages/shared/src/sim/surfaces.ts.
# The .glb stores an index into *this*, not into a game's own table, because the
# tables disagree: T5's 29 and 30 are `player` and `tallgrass` where IW's are
# `riotshield` and `slush`. tests/test_geometry.py reads the TypeScript and
# asserts the two lists are the same, because a silent shift here renames every
# surface in the game by one.
ENGINE_SURFACES = (
    "default", "bark", "brick", "carpet", "cloth", "concrete", "dirt", "flesh", "foliage", "glass", "grass",
    "gravel", "ice", "metal", "mud", "paper", "plaster", "rock", "sand", "snow", "water", "wood",
    "asphalt", "ceramic", "plastic", "rubber", "cushion", "fruit", "paintedmetal", "riotshield", "slush",
    "player", "tallgrass",
)  # fmt: skip

# Each game's own `surfaceTypeNames[]`, indexed by the flags' surface-type field.
SURFACE_TYPES_IW = ENGINE_SURFACES[:31]
SURFACE_TYPES_T5 = ENGINE_SURFACES[:29] + ("player", "tallgrass")
# Black Ops II's is T5's with `riotshield` appended (OAT's T6 SURF_TYPE_* enum).
SURFACE_TYPES_T6 = SURFACE_TYPES_T5 + ("riotshield",)
# Advanced Warfare's is not IW's with rows appended: it inserts `metal_grate` at
# 14 and moves `cushion` to the end, so 17 of IW's 31 indices mean something else.
# Each row is the engine surface AW's own `infoParms[]` keyword means -- its 22
# new types are wet/hollow/debris variants of one the engine already has, and
# `grass_tall` is the entry T5 contributed.
SURFACE_TYPES_S1 = (
    "default", "bark", "brick", "carpet", "cloth", "concrete", "dirt", "flesh", "foliage", "glass", "grass",
    "gravel", "ice", "metal", "metal", "mud", "paper", "plaster", "rock", "sand", "snow", "water",
    "wood", "asphalt", "ceramic", "plastic", "rubber", "fruit", "paintedmetal", "riotshield", "slush", "asphalt", "asphalt",
    "concrete", "concrete", "foliage", "foliage", "tallgrass", "metal", "metal", "metal", "metal", "metal", "plastic",
    "plastic", "rock", "rock", "water", "water", "wood", "wood", "wood", "cushion",
)  # fmt: skip
SURFACE_TYPES_BY_GAME = {
    "iw4": SURFACE_TYPES_IW,
    "iw5": SURFACE_TYPES_IW,
    "t5": SURFACE_TYPES_T5,
    "t6": SURFACE_TYPES_T6,
    "iw6": SURFACE_TYPES_IW,
    "s1": SURFACE_TYPES_S1,
    # Cold War's dump writes no surface flags yet, so every face is `default`.
    "t9": SURFACE_TYPES_T5,
}

# Whether a soup surface that blocks the player is one the engine collides with.
# On Ghosts it is: the soup carries thousands of triangles of curved invisible
# wall (`clip_nosight_rock` and the like, over the rock faces that bound a map),
# and leaving them out lets a player walk off the edge. Black Ops' soup clips are
# a couple of small volumes a map and are left out; this is the open call in
# docs/cod/games.md#black-ops-t5. IW4/IW5 soup has no clip contents at all.
# Advanced Warfare is Ghosts': 5,336 of mp_prison's 65,739 soup triangles are
# clip, most of them `clip_nosight_metal` and `clip_nosight_rock`.
# Black Ops II's code settles it: a soup leaf is traced whenever its material's
# contents meet the trace's mask (CM_TraceThroughAabbTree 0x6a79a1), and a live
# player's mask has playerclip (ClientThink_real 0x5bf69a). 128 to 3,853 triangles
# a map, most of them beside nothing else a player collides with.
SOUP_CLIPS_COLLIDE_BY_GAME = {"iw4": False, "iw5": False, "t5": False, "t6": True, "iw6": True, "s1": True, "t9": False}

# What a player's trace and a bullet's stop, where a game's code has said, as
# (player mask, bullet mask). Black Ops II: a live player's `pm->tracemask`
# 0x2818011 (ClientThink_real 0x5bf69a) and the bullet mask 0x280e833
# (Bullet_Trace 0x5aca50). With them the soup's role follows the code rather than
# the material's look: a wet floor that is player clip (mp_raid's 192 `_dripping`
# tiles, 0x322a0) is a floor, and `clip_physics` (itemclip 0x400) meets neither
# mask, so 1,600 of mp_dockside's triangles are no wall. Unread for other games.
SOUP_STOPS_BY_GAME = {"t6": (0x02818011, 0x0280E833)}

# Games whose brush faces carry their own `surfaceFlags` and contents and name no
# material (a side is `{contents, surfaceFlags}`, the axial faces `axialContents` and
# `axialSurfaceFlags`): Treyarch's clipmap, which Black Ops II keeps
# (t6/dumpers/clipmap.py). Every other game's faces name a material.
FACE_FLAG_GAMES = ("t5", "t6")


def blocks_player(contents):
    return bool(contents & (SOLID | PLAYERCLIP))


def brush_role(contents):
    """What one brush is in the .glb: `solid`, player `clip`, AI-only `ai-clip`, or None (left out).

    Monsterclip that no player is stopped by is written, as `collides: false` beside
    the rest, so a runtime building an AI channel from `blocks` finds it: a zombies
    window's climb-in is one (docs/cod/reference.md#collision).
    """
    if contents & SOLID:
        return "solid"
    if blocks_player(contents):
        return "clip"
    if contents & AICLIP:
        return "ai-clip"
    return None


def surface_of(flags, game):
    """The engine's surface index for one face's `surfaceFlags`, under `game`'s own table.

    The field is five bits wide except on S1, and no game fills it, so an index
    past the game's own table (or a game with no table) falls back to `default`.
    """
    names = SURFACE_TYPES_BY_GAME.get(game, ())
    index = (flags >> SURFACE_TYPE_SHIFT) & SURFACE_TYPE_MASK_BY_GAME.get(game, SURFACE_TYPE_MASK)
    if index >= len(names):
        return 0
    return ENGINE_SURFACES.index(names[index])


def blocks(contents, bits):
    """The named bits set in `contents`, in table order."""
    return [name for bit, name in bits if contents & bit]


def face_flags(brush, materials, game):
    """[(surfaceFlags, material name or None)] for every plane of `brush_planes(brush)`, in its order.

    IW4/IW5 faces name a material, whose flags these are; T5 and T6 faces carry
    the flags themselves and no material (FACE_FLAG_GAMES). The axial arrays are
    [0] the min faces, [1] the max faces, each indexed x y z, while `brush_planes`
    lists each axis max first.
    """
    t5 = game in FACE_FLAG_GAMES

    def read(value):
        if t5:
            return value & 0xFFFFFFFF, None
        if 0 <= value < len(materials):
            return materials[value].get("surfaceFlags", 0) & 0xFFFFFFFF, materials[value].get("name")
        return 0, None

    out = []
    if brush.get("bounds"):
        axial = brush["axialSurfaceFlags" if t5 else "axialMaterialNum"]
        for axis in range(3):
            out.append(read(axial[1][axis]))
            out.append(read(axial[0][axis]))
    for side in brush.get("sides", []):
        if "normal" in side:
            out.append(read(side.get("surfaceFlags", 0) if t5 else side.get("materialNum", -1)))
    return out


def group_of(contents):
    """Solid brushes share one group; clip-only brushes are grouped by their exact contents."""
    if contents & SOLID:
        return "solid"
    return f"clip:0x{contents & 0xFFFFFFFF:08x}"


def soup_role(contents, clips_collide=False, stops=None):
    """What one soup triangle is, from the material its AABB-tree leaf names.

    Black Ops and Ghosts both say; IW4/IW5 leaves name
    only ground materials, so their soup is all ground. `clips_collide` is the
    game's `SOUP_CLIPS_COLLIDE_BY_GAME`: with it, a clip surface that blocks the
    player is an ordinary wall, and one that stops only AI or vehicles still is not.

    `stops` is the game's `SOUP_STOPS_BY_GAME`, (player mask, bullet mask), where
    its code says: what meets both is ground; what meets only the player's is
    clip; what meets neither is not a wall. What meets only the bullet's stays
    ground, because the engine has no tree that stops shots and not players
    (docs/engine/collision.md#a-bullet-and-a-player-collide-with-different-things).
    """
    if contents is None:
        return "ground"
    if stops is not None:
        player, shot = contents & stops[0], contents & stops[1]
        if player:
            if shot:
                return "ground"
            return "clip" if clips_collide else "soup-clip"
        if contents & WATER:
            return "water"
        return "ground" if shot else "soup-clip"
    if contents & WATER:
        return "water"
    if contents & (PLAYERCLIP | AICLIP | VEHICLECLIP):
        return "clip" if clips_collide and blocks_player(contents) else "soup-clip"
    return "ground"


def face_polygon(planes, index, centre, radius):
    """The face of a convex volume lying on `planes[index]`, or None if that side is redundant.

    A quad on the plane, sized and centred on the brush (not the origin: at map
    scale, float precision is too coarse to clip reliably), clipped against
    every other plane.
    """
    nx, ny, nz, dist = planes[index]

    ax = min(range(3), key=lambda i: abs((nx, ny, nz)[i]))
    helper = [0.0, 0.0, 0.0]
    helper[ax] = 1.0
    ux = ny * helper[2] - nz * helper[1]
    uy = nz * helper[0] - nx * helper[2]
    uz = nx * helper[1] - ny * helper[0]
    ul = (ux * ux + uy * uy + uz * uz) ** 0.5
    if ul < 1e-9:
        return None
    ux, uy, uz = ux / ul, uy / ul, uz / ul
    vx = ny * uz - nz * uy
    vy = nz * ux - nx * uz
    vz = nx * uy - ny * ux

    off = nx * centre[0] + ny * centre[1] + nz * centre[2] - dist
    ox, oy, oz = centre[0] - nx * off, centre[1] - ny * off, centre[2] - nz * off
    poly = [
        (ox + (ux + vx) * radius, oy + (uy + vy) * radius, oz + (uz + vz) * radius),
        (ox + (ux - vx) * radius, oy + (uy - vy) * radius, oz + (uz - vz) * radius),
        (ox - (ux + vx) * radius, oy - (uy + vy) * radius, oz - (uz + vz) * radius),
        (ox - (ux - vx) * radius, oy - (uy - vy) * radius, oz - (uz - vz) * radius),
    ]
    eps = radius * EPS_REL

    for j, (px, py, pz, pd) in enumerate(planes):
        if j == index or not poly:
            continue
        dists = [px * x + py * y + pz * z - pd for (x, y, z) in poly]  # positive is outside
        out = []
        for k, cur in enumerate(poly):
            nxt = poly[(k + 1) % len(poly)]
            dc, dn = dists[k], dists[(k + 1) % len(poly)]
            if dc <= eps:
                out.append(cur)
            if (dc > eps) != (dn > eps):
                t = dc / (dc - dn)
                out.append(tuple(cur[i] + (nxt[i] - cur[i]) * t for i in range(3)))
        poly = out

    # Near-duplicate planes can let an interpolated vertex escape the hull, so
    # the result is verified against every half-space directly.
    tol = radius * 1e-3
    poly = [q for q in poly if all(px * q[0] + py * q[1] + pz * q[2] - pd <= tol for (px, py, pz, pd) in planes)]

    # Drop repeated vertices: the clip emits a vertex on the plane twice, which
    # would fan-triangulate into zero-area slivers.
    weld = max(radius * 1e-5, 1e-6)
    deduped = []
    for q in poly:
        if not deduped or max(abs(q[i] - deduped[-1][i]) for i in range(3)) > weld:
            deduped.append(q)
    while len(deduped) >= 2 and max(abs(deduped[0][i] - deduped[-1][i]) for i in range(3)) <= weld:
        deduped.pop()

    return deduped if len(deduped) >= 3 else None


def triangle_area(a, b, c):
    ux, uy, uz = (b[i] - a[i] for i in range(3))
    vx, vy, vz = (c[i] - a[i] for i in range(3))
    cx, cy, cz = uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx
    return 0.5 * (cx * cx + cy * cy + cz * cz) ** 0.5


def brush_planes(brush):
    """Every half-space bounding one brush (outward normals, CoD space).

    The six axial planes are implicit in the brush's bounds; `sides` holds only
    the extra bevel planes.
    """
    planes = []
    bounds = brush.get("bounds")
    if bounds:
        mid, half = vec3(bounds["midPoint"]), vec3(bounds["halfSize"])
        for axis in range(3):
            lo, hi = mid[axis] - half[axis], mid[axis] + half[axis]
            pos = [0.0, 0.0, 0.0]
            pos[axis] = 1.0
            planes.append((pos[0], pos[1], pos[2], hi))
            planes.append((-pos[0], -pos[1], -pos[2], -lo))

    for side in brush.get("sides", []):
        if "normal" in side:
            planes.append((side["normal"][0], side["normal"][1], side["normal"][2], side["dist"]))
    return planes


def brush_face_triangles(brush):
    """[(plane index, triangle)] for every face of one brush, fan-triangulated, in CoD space.

    The plane index is into `brush_planes(brush)`, which is the order
    `face_flags` reports in, so a triangle can be told what it is made of.
    """
    planes = brush_planes(brush)
    if len(planes) < 4:
        return []
    bounds = brush.get("bounds")
    if not bounds:
        return []
    centre = vec3(bounds["midPoint"])
    radius = 2.0 * sum(h * h for h in vec3(bounds["halfSize"])) ** 0.5
    min_area = max((radius * 1e-4) ** 2, 1e-9)

    tris = []
    for i in range(len(planes)):
        poly = face_polygon(planes, i, centre, radius)
        if not poly:
            continue
        for k in range(1, len(poly) - 1):
            tri = (poly[0], poly[k], poly[k + 1])
            if triangle_area(*tri) > min_area:
                tris.append((i, tri))
    return tris


def brush_triangles(brush):
    """Every face of one brush, fan-triangulated, in CoD space."""
    return [tri for _, tri in brush_face_triangles(brush)]


def write_collision_glb(path, positions, surfaces, groups, extras=None):
    """One glTF mesh per group over one shared vertex buffer; each node's `extras` names what it blocks.

    `surfaces` is one engine surface index per vertex, written as a `_SURFACE`
    attribute beside POSITION. A vertex attribute rather than a per-triangle
    sidecar in `extras`, because the engine's path from here to a BVH triangle
    runs through a glTF loader and a geometry merge, and a vertex attribute is
    the one thing both carry (docs/engine/collision.md#how-it-survives-the-trip-to-the-bvh).
    A per-type primitive would have been the other way, and would have multiplied
    the groups that picking and the debug views read by name. The weld below
    keeps a vertex's surface part of its identity, so all three vertices of a
    triangle agree and the engine reads only the first.
    """
    buf = bytearray()
    views = []
    add_view(buf, views, pack("f", positions), ARRAY_BUFFER)
    n_vert = len(positions) // 3
    xs, ys, zs = positions[0::3], positions[1::3], positions[2::3]
    accessors = [
        {
            "bufferView": 0,
            "componentType": 5126,
            "count": n_vert,
            "type": "VEC3",
            "min": [min(xs), min(ys), min(zs)],
            "max": [max(xs), max(ys), max(zs)],
        }
    ]
    add_view(buf, views, pack("B", surfaces), ARRAY_BUFFER)
    accessors.append({"bufferView": len(views) - 1, "componentType": 5121, "count": n_vert, "type": "SCALAR"})
    surface_accessor = len(accessors) - 1
    nodes, meshes = [], []
    for name, group in groups.items():
        idx = group["indices"]
        if not idx:
            continue
        add_view(buf, views, pack("I", idx), ELEMENT_ARRAY_BUFFER)
        accessors.append({"bufferView": len(views) - 1, "componentType": 5125, "count": len(idx), "type": "SCALAR"})
        attributes = {"POSITION": 0, "_SURFACE": surface_accessor}
        meshes.append({"name": name, "primitives": [{"attributes": attributes, "indices": len(accessors) - 1}]})
        nodes.append({"mesh": len(meshes) - 1, "name": name, "extras": group["extras"]})

    gltf = {
        "asset": {"version": "2.0", "generator": "scripts/cod/collision.py"},
        "scene": 0,
        "scenes": [{"nodes": list(range(len(nodes))), **({"extras": extras} if extras else {})}],
        "nodes": nodes,
        "meshes": meshes,
        "accessors": accessors,
        "bufferViews": views,
        "buffers": [{"byteLength": len(buf)}],
    }
    return write_glb(path, gltf, buf)


def export_collision(manifest_path, out_path, placements):
    """Write the collision .glb for one clipmap dump. `placements` comes from brushmodels.preflight."""
    manifest = read_json(manifest_path)
    base = os.path.dirname(os.path.abspath(manifest_path))

    game = manifest["_game"]
    if game not in CONTENTS_BITS_BY_GAME:
        sys.exit(f"manifest says _game={game!r}; there is no contents table for it in scripts/cod/collision.py.")
    bits = CONTENTS_BITS_BY_GAME[game]
    soup_clips_collide = SOUP_CLIPS_COLLIDE_BY_GAME[game]
    soup_stops = SOUP_STOPS_BY_GAME.get(game)

    def sibling(key):
        """A file the manifest names. The recorded name repeats the map's path prefix, so fall back to the basename."""
        rel = manifest.get(key)
        if not rel:
            return None
        for candidate in (os.path.join(base, rel), os.path.join(base, os.path.basename(rel))):
            if os.path.exists(candidate):
                return candidate
        return None

    positions = []
    # One engine surface index per vertex, parallel to `positions`: what CoD says
    # each face is made of, which is what a footstep is picked from. The weld
    # below keeps it part of a vertex's identity, so a triangle's three agree.
    surfaces = []
    groups = {}  # `solid` and `soup` first, then clip groups in the order met
    materials = manifest.get("materials", [])
    emitted = 0

    def group(name, contents=None, mats=(), role="clip", where=None):
        """The group `name`, or its copy for one removable brush model when `where` is one."""
        part = part_of(where)
        key = name if part is None else f"part:{part}/{name}"
        g = groups.get(key)
        if g is None:
            g = groups[key] = {
                "indices": [],
                "brushes": 0,
                "materials": set(),
                "brush_starts": [],
                "brush_materials": [],
                "extras": {"group": name, "collides": role in COLLIDING_ROLES},
            }
            if contents is not None:
                g["extras"]["contents"] = f"0x{contents:08x}"
                g["extras"]["blocks"] = blocks(contents, bits)
            if part is not None:
                g["part"] = part
                g["extras"].update(part=part, entity=where["entity"])
        g["materials"].update(mats)
        return g

    def emit(tri, g, surface):
        nonlocal emitted
        emitted += 1
        n = len(positions) // 3
        for p in tri:
            positions.extend(to_engine(p))
            surfaces.append(surface)
        g["indices"].extend((n, n + 1, n + 2))

    def clip_materials(brush):
        """The `clip*` material names on a brush's sides. T5 and T6 sides carry flags, not a material, so none."""
        if game in FACE_FLAG_GAMES:
            return set()
        names = set()
        for side in brush.get("sides", []):
            i = side.get("materialNum", -1)
            if 0 <= i < len(materials):
                name = materials[i].get("name", "")
                if name.startswith("clip"):
                    names.add(name)
        return names

    # Brush models: cmodels[N] lists the brushes and soup partitions submodel N
    # owns; they are moved to where their placer puts them. The rest is the world's.
    owned_brush, owned_part = {}, {}
    for n, m in enumerate(manifest["cmodels"]):
        if n:
            owned_brush.update((b, n) for b in m.get("brushes", ()))
            owned_part.update((p, n) for p in m.get("partitions", ()))
    submodel = collections.Counter()

    def placement(n, what):
        """Where submodel n goes, or None when it is not solid in game."""
        where = placements.get(n)
        if where is None:
            submodel[f"{what} with nothing placing them"] += 1
        elif not where["solid"]:
            submodel[f"{what} of {where['classname']} (not solid in game)"] += 1
            where = None
        return where

    # A brush model that can be absent (only some modes have it, or it is DYNAMICPATH)
    # is a part of its own, keyed by name: docs/cod/reference.md#game-mode-objects.
    parts = {f"*{n}": where for n, where in placements.items() if part_of(where)}

    # -- brushes --
    kept = dropped = degenerate = ai_only = 0
    drift_worst = 0.0
    for brush_index, brush in enumerate(manifest["brushes"]):
        where = None
        if brush_index in owned_brush:
            where = placement(owned_brush[brush_index], "brushes")
            if where is None:
                continue
        contents = brush.get("contents", 0) & 0xFFFFFFFF
        role = brush_role(contents)
        if role is None:
            dropped += 1
            continue
        tris = brush_face_triangles(brush)
        if not tris:
            degenerate += 1
            continue
        # Per face, not per brush: a crate is wood on top and metal on its band,
        # and `face_flags` lists a brush's planes in `brush_face_triangles`' order.
        flags = face_flags(brush, materials, game)
        face_surface = [surface_of(f, game) for f, _ in flags]

        # Self-check: no hull vertex may fall outside the brush's recorded bounds
        # (one-sided: a hull is inscribed in its box and may be smaller).
        if "bounds" in brush:
            pts = [c for _, t in tris for c in t]
            mid, half = vec3(brush["bounds"]["midPoint"]), vec3(brush["bounds"]["halfSize"])
            for axis in range(3):
                vals = [p[axis] for p in pts]
                lo, hi = mid[axis] - half[axis], mid[axis] + half[axis]
                drift_worst = max(drift_worst, lo - min(vals), max(vals) - hi, 0.0)

        if where:
            tris = [(i, tuple(brushmodels.place(where, p) for p in t)) for i, t in tris]
            submodel["brushes placed"] += 1

        name = group_of(contents)
        # Solid brushes often carry a clip material on one side; listing it would mislabel the group.
        mats = () if name == "solid" else clip_materials(brush)
        g = group(name, contents, mats, role=role, where=where)
        # Per-brush triangle ranges let a raycast hit name the one brush (clip groups only).
        if name != "solid":
            g["brush_starts"].append(len(g["indices"]) // 3)
            g["brush_materials"].append(",".join(sorted(mats)))
        for i, t in tris:
            emit(t, g, face_surface[i] if i < len(face_surface) else 0)
        g["brushes"] += 1
        kept += 1
        ai_only += role == "ai-clip"

    # -- triangle soup --
    soup = segmented = 0
    group("soup", role="ground")
    vert_path, tri_path = sibling("vertFile"), sibling("triFile")
    if vert_path and tri_path:
        verts = read_bytes(vert_path)
        tris = read_bytes(tri_path)
        vert_count = manifest["vertCount"]
        tri_count = manifest["triCount"]
        raw = struct.unpack(f"<{vert_count * 3}f", verts[: vert_count * 12])
        idx = struct.unpack(f"<{tri_count * 3}H", tris[: tri_count * 6])

        # Per-triangle vertex base from the partitions, which tile [0, triCount).
        bases = [0] * tri_count
        partitions = manifest.get("partitions")
        segmented_game = any("firstVertSegment" in part for part in (partitions or ()))
        if partitions and segmented_game:
            for part in partitions:
                base_index = part.get("firstVertSegment", 0) * VERT_SEGMENT
                if not base_index:
                    continue
                start = part.get("firstTri", 0)
                for t in range(start, min(start + part.get("triCount", 0), tri_count)):
                    bases[t] = base_index
        elif vert_count > 0xFFFF:
            # T5 partitions have no segment and index globally, which only works
            # under 65,536 vertices (true of all 34 stock zones). Refuse rather
            # than import a mis-indexed soup.
            sys.exit(
                f"{manifest_path} has {vert_count:,} collision vertices and its partitions "
                "carry no `firstVertSegment`: 16-bit indices cannot address it, and "
                "the soup would be silently mis-indexed."
            )

        segmented = sum(1 for b in bases if b)

        # Each triangle's material, from the AABB tree's leaves: its contents say
        # what the triangle stops (Black Ops and Ghosts only -- IW4/IW5 leaves
        # name ground materials), and its surface flags what it is made of, which
        # every game says. A partition may be named by several leaves; measured on
        # mp_dome all 2,166 agree on their material, and they tile the soup exactly.
        tri_contents = [None] * tri_count
        tri_surface = [0] * tri_count
        for node in manifest.get("aabbTrees", ()):
            if node.get("childCount") or "partition" not in node:
                continue
            part = partitions[node["partition"]]
            material = materials[node["materialIndex"]]
            value = material["contents"] & 0xFFFFFFFF
            surface = surface_of(material.get("surfaceFlags", 0) & 0xFFFFFFFF, game)
            for t in range(part["firstTri"], min(part["firstTri"] + part["triCount"], tri_count)):
                tri_contents[t] = value
                tri_surface[t] = surface
        tri_owner = [None] * tri_count
        for p, part in enumerate(partitions or ()):
            if p in owned_part:
                for t in range(part["firstTri"], min(part["firstTri"] + part["triCount"], tri_count)):
                    tri_owner[t] = owned_part[p]

        out_of_range = 0
        for t in range(tri_count):
            where = None
            if tri_owner[t] is not None:
                where = placement(tri_owner[t], "soup triangles")
                if where is None:
                    continue
            base_index = bases[t]
            a0 = idx[t * 3] + base_index
            b0 = idx[t * 3 + 1] + base_index
            c0 = idx[t * 3 + 2] + base_index
            if max(a0, b0, c0) >= vert_count:
                out_of_range += 1
                continue
            tri = tuple(tuple(raw[v * 3 : v * 3 + 3]) for v in (a0, b0, c0))
            if where:
                tri = tuple(brushmodels.place(where, p) for p in tri)
                submodel["soup triangles placed"] += 1
            contents = tri_contents[t]
            role = soup_role(contents, soup_clips_collide, soup_stops)
            if role == "ground":
                g = group("soup", role=role, where=where)
            else:
                g = group(f"clip:soup:0x{contents:08x}", contents, role=role, where=where)
            emit(tri, g, tri_surface[t])
            soup += 1
        if out_of_range:
            print(
                f"  WARNING: {out_of_range}/{tri_count} soup triangles index past "
                f"vertCount ({vert_count:,}) and were dropped — the index scheme "
                f"may not suit this game"
            )

    if not any(g["indices"] for g in groups.values()):
        sys.exit("nothing to write: no blocking brushes and no triangle soup")

    # Weld coincident vertices (every face was emitted separately), then drop
    # any triangle the weld collapsed, rebuilding the per-brush ranges alongside.
    grid = 1e-4  # 0.1 mm
    lookup, welded, welded_surfaces, remap = {}, [], [], []
    # One integer key per vertex rather than a 3-tuple: a 400k-triangle mesh has
    # 1.2M vertices, and a tuple of three ints is ~100 bytes of objects each.
    # Injective while every rounded coordinate stays inside +/- _WELD_BIAS,
    # which at 0.1 mm is +/- 200,000 km.
    for v in range(len(positions) // 3):
        x, y, z = positions[v * 3 : v * 3 + 3]
        key = ((round(x / grid) + _WELD_BIAS) << 64) | ((round(y / grid) + _WELD_BIAS) << 32) | (round(z / grid) + _WELD_BIAS)
        # The surface joins the key: a floor meeting a wall shares a corner, and
        # welding the two would leave that vertex one surface for both faces.
        # Within a triangle it is constant, so which triangles the weld collapses
        # is unchanged -- only how many vertices survive.
        key = (key << 8) | surfaces[v]
        hit = lookup.get(key)
        if hit is None:
            hit = lookup[key] = len(welded) // 3
            welded.extend(positions[v * 3 : v * 3 + 3])
            welded_surfaces.append(surfaces[v])
        remap.append(hit)
    before = len(positions) // 3
    positions = welded
    surfaces = welded_surfaces
    collapsed = 0
    for g in groups.values():
        src = g["indices"]
        kept_indices = []
        starts = g.get("brush_starts") or []
        next_start = 0
        new_starts = []
        for t in range(len(src) // 3):
            while next_start < len(starts) and starts[next_start] == t:
                new_starts.append(len(kept_indices) // 3)
                next_start += 1
            i0, i1, i2 = (remap[src[t * 3 + k]] for k in range(3))
            if i0 == i1 or i1 == i2 or i0 == i2:
                collapsed += 1
                continue
            kept_indices.extend((i0, i1, i2))
        while next_start < len(starts):
            new_starts.append(len(kept_indices) // 3)
            next_start += 1
        g["indices"] = kept_indices
        if starts:
            g["brush_starts"] = new_starts
    print(
        f"welded vertices: {before:,} -> {len(positions) // 3:,}"
        f"{f', dropped {collapsed:,} collapsed triangle(s)' if collapsed else ''}"
    )

    # The base, then each part by brush-model number; within each, solid and soup
    # first, then clip groups largest first.
    ordered = {}
    for part in (None, *sorted(parts, key=lambda p: int(p[1:]))):
        mine = {k: g for k, g in groups.items() if g.get("part") == part}
        for kind in ("solid", "soup"):
            key = kind if part is None else f"part:{part}/{kind}"
            if key in mine:
                ordered[key] = mine[key]
        for key, g in sorted(((k, g) for k, g in mine.items() if k not in ordered), key=lambda kv: -len(kv[1]["indices"])):
            ordered[key] = g
    for g in ordered.values():
        g["extras"]["triangles"] = len(g["indices"]) // 3
        if g["brushes"]:
            g["extras"]["brushes"] = g["brushes"]
        if g["materials"]:
            g["extras"]["materials"] = sorted(g["materials"])
        if g["brush_starts"]:
            # First triangle of each brush, ascending; engine/picking.ts bisects it.
            g["extras"]["brushStarts"] = g["brush_starts"]
            g["extras"]["brushMaterials"] = g["brush_materials"]

    # Every removable brush model is listed, even one with no triangle that blocks
    # a player or AI, so each `solid` gameplay.world writes names a part the file has.
    part_triangles = collections.Counter()
    for g in ordered.values():
        if g.get("part"):
            part_triangles[g["part"]] += len(g["indices"]) // 3
    part_list = [{"part": p, "triangles": part_triangles[p]} for p in sorted(parts, key=lambda p: int(p[1:]))]
    base_total = sum(len(g["indices"]) for g in ordered.values() if not g.get("part")) // 3
    # Splitting parts out moves triangles between meshes and must never lose one.
    if base_total + sum(part_triangles.values()) != emitted - collapsed:
        sys.exit(
            f"collision: {base_total:,} base + {sum(part_triangles.values()):,} part triangles "
            f"!= {emitted - collapsed:,} emitted and kept"
        )

    size = write_collision_glb(out_path, positions, surfaces, ordered, {"parts": part_list} if part_list else None)

    degenerate_out = sum(
        1
        for g in ordered.values()
        for t in range(len(g["indices"]) // 3)
        if len({g["indices"][t * 3], g["indices"][t * 3 + 1], g["indices"][t * 3 + 2]}) < 3
    )
    if degenerate_out:
        sys.exit(f"{degenerate_out} degenerate triangle(s) survived into the output")

    total = sum(len(g["indices"]) for g in ordered.values()) // 3

    # The one number that says the surface pass worked. A mesh that is all
    # `default` means no face's material was read; one that is all of any single
    # type means the field was read from the wrong place. Both look like success
    # everywhere else, so this is printed rather than merely available.
    hist = collections.Counter()
    for g in ordered.values():
        idx = g["indices"]
        for t in range(len(idx) // 3):
            hist[ENGINE_SURFACES[surfaces[idx[t * 3]]]] += 1
    print(f"surfaces: {len(hist)} type(s) over {total:,} triangles")
    for name, n in hist.most_common():
        print(f"  {name:<14} {n:8,}  {n / total * 100:5.1f}%")

    print(
        f"brushes: {kept:,} kept ({ai_only:,} stop only AI), {dropped:,} dropped (block neither player nor AI), "
        f"{degenerate:,} degenerate"
    )
    print(f"  worst vertex OUTSIDE its brush bounds: {drift_worst:.4f} units ({drift_worst / UNITS_PER_M * 1000:.2f} mm)")
    print(
        f"triangle soup: {soup:,} triangles"
        f"{f' ({segmented:,} past the 16-bit index range, rebased from their partitions)' if segmented else ''}"
    )
    if submodel:
        print("brush models: " + ", ".join(f"{n:,} {what}" for what, n in sorted(submodel.items())))
    if part_list:
        print(
            f"removable brush models: {len(part_list)} part(s), {sum(part_triangles.values()):,} triangles "
            f"beside {base_total:,} in the base"
        )
        for p in part_list:
            where = parts[p["part"]]
            why = " ".join(where["modes"]) if where.get("modes") else "DYNAMICPATH"
            print(f"  {p['part']:<6} {p['triangles']:6,} tris  {why}")
    print(f"groups: {len(ordered)}")
    width = max(20, *(len(name) for name in ordered))
    for name, g in ordered.items():
        extras = g["extras"]
        detail = ""
        if "blocks" in extras:
            detail = f"  blocks {'+'.join(extras['blocks'])}"
        mats = extras.get("materials")
        if mats:
            detail += f"  [{', '.join(mats[:3])}{', ...' if len(mats) > 3 else ''}]"
        count = f"{g['brushes']:,} brushes" if g["brushes"] else "soup"
        print(f"  {name:<{width}} {len(g['indices']) // 3:8,} tris  {count:>14}{detail}")
    print(f"-> {out_path}: {total:,} triangles, {len(positions) // 3:,} vertices, {size / 1e6:.1f} MB")
