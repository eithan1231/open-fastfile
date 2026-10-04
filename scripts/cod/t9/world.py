"""A T9 map's world assets, found by content: render surfaces, collision, placements, entities.

Nothing here is at a fixed offset: each asset is found by a signature read off
mp_kgb, mp_cartel, mp_nuketown6 and mp_miami (reverse/t9-zone/world_find.py and
the world_* scripts beside it, which this ports).

**GfxWorld.** The header opens with the map's name hash (FNV-1a 64 of
`maps/mp/<map>.d3dbsp`, bit 63 cleared), 8 zero bytes and -1 at +0x10, and the
map's base-name string follows it by 0x1ef8..0x1f30 bytes:

  +0x18  u32 surfaceCount             +0xc8  u32 sun-volume plane count
  +0xe8  u32 vertexCount              +0x130 u32 indexCount
  +0x180 u32 brush-model count        +0x190 vec3 mins, vec3 maxs

After the name and the sun volume's planes (vec4 each) come, packed: positions
(float3 per vertex), a second stream of 20 bytes per vertex (u32 colour -- RGB
always white, alpha a blend weight -- f32 u, f32 v, u32 normal, u32 tangent,
both 10:10:10 unsigned), u16 indices, then the brush models (32 bytes: bounds,
u32 surfaceCount, u32 startSurface; model 0 is the world). The surfaces (96
bytes) come later, found by their own chaining: +0 mins, +12 firstVertex, +16
maxs, +0x24 u16 vertexCount, +0x26 u16 triCount, +0x28 baseIndex, +0x48 the
material (an alias to a type-10 entry). Triangles are wound clockwise.

**Collision.** A symmetric world box (vec3 -B, vec3 +B, B > 30000) then eight
u32: planes, brush vertices, brushes, (open), soup vertices, soup indices,
partitions, (open), and at +0x48 the byte size of a blob. In stream order:
planes (vec4), brush vertices (vec3), a u32 per brush, a u32 per brush
`numVerts << 24 | firstVert`, then (after data not read here) the brushes (28
bytes: vec3 mins, vec3 maxs, u32 contents), the blob, soup vertices (vec3), u8
soup indices, and partitions (32 bytes: bounds, then a u64 packing the vertex
base in bits 0-22, first triangle 23-48, triangle count 49-53, material 54-63).

**Placements.** 80-byte records flagged 0xf00fd00f at +56: origin, a
reciprocal scale, a unit quaternion (x, y, z, w), world bounds; the model's
name hash is the u64 12 bytes *before* the origin.

**Entities.** Assets under the map's name hash: a count, 48-byte records (u32
key/value count, u64 key/value pointer, i32, u32 id, vec3 origin, vec3 angles),
then per record its key/values (32 bytes: key, value, 0, type) and the strings
that were inline. Most strings are aliases to strings loaded earlier, resolved
statistically (`read_ents`): some come out wrong, and they are left out.
"""

import bisect
import math
import re
import struct
from collections import Counter

NULL = 0xFFFFFFFFFFFFFFFF

SURFACE = 96
SURFACE_MATERIAL = 0x48
BRUSH_MODEL = 32
WORLD_VERTEX_2 = 20
PLACEMENT = 80
PLACEMENT_FLAG = bytes.fromhex("0fd00ff0")  # 0xf00fd00f
ENTITY = 48
KEY_VALUE = 32

SOLID, PLAYERCLIP = 0x1, 0x10000


def u32(d, o):
    return struct.unpack_from("<I", d, o)[0]


def fnv63(text):
    h = 0xCBF29CE484222325
    for c in text.encode():
        h = ((h ^ c) * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
    return h & 0x7FFFFFFFFFFFFFFF


def bsp_name(map_name):
    return f"maps/mp/{map_name}.d3dbsp"


# -- GfxWorld -------------------------------------------------------------------


def find_gfx(d, name):
    """The GfxWorld header: before the map's base-name string, with the shape above."""
    for m in re.finditer(b"\0" + name.encode() + b"\0", d):
        p = m.start() + 1
        for h in range(max(0, p - 0x3000), p - 0x1D00):
            if d[h + 8 : h + 0x10] != b"\0" * 8 or d[h + 0x10 : h + 0x18] != b"\xff" * 8:
                continue
            if d[h + 0xF0 : h + 0xF8] != b"\xff" * 8 or d[h + 0x188 : h + 0x190] != b"\xff" * 8:
                continue
            mins = struct.unpack_from("<3f", d, h + 0x190)
            maxs = struct.unpack_from("<3f", d, h + 0x19C)
            if 0 < u32(d, h + 0xE8) < 10**8 and all(a < b for a, b in zip(mins, maxs, strict=True)):
                return h
    raise SystemExit(f"no GfxWorld header before a {name!r} string")


def _find_surfaces(d, start, count):
    """The surface array: the first offset where two surfaces chain firstVertex and baseIndex."""
    p, end = start, len(d) - SURFACE * count
    while p < end:
        if u32(d, p + 12) == 0 and u32(d, p + 40) == 0:
            vc = struct.unpack_from("<H", d, p + 36)[0]
            if vc and u32(d, p + SURFACE + 12) == vc:
                tc = struct.unpack_from("<H", d, p + 38)[0]
                if u32(d, p + SURFACE + 40) == 3 * tc:
                    return p
        p += 1
    raise SystemExit("no GfxWorld surface array found")


class GfxWorld:
    def __init__(self, d, name):
        h = self.header = find_gfx(d, name)
        self.name_hash = struct.unpack_from("<Q", d, h)[0]
        self.vertex_count = u32(d, h + 0xE8)
        self.index_count = u32(d, h + 0x130)
        self.model_count = u32(d, h + 0x180)
        self.surface_count = u32(d, h + 0x18)
        planes = u32(d, h + 0xC8)
        self.bounds = struct.unpack_from("<6f", d, h + 0x190)
        p = d.index(b"\0" + name.encode() + b"\0", h) + 1
        q = d.index(b"\0", p)
        self.base_name = d[p:q].decode("latin-1")
        while u32(d, q) != planes:
            q += 1
        self.positions = q + 4 + 16 * planes
        self.stream2 = self.positions + 12 * self.vertex_count
        self.indices = self.stream2 + WORLD_VERTEX_2 * self.vertex_count
        self.models_at = self.indices + 2 * self.index_count
        self.models = [struct.unpack_from("<6f2I", d, self.models_at + BRUSH_MODEL * i) for i in range(self.model_count)]
        self.surfaces_at = _find_surfaces(d, self.models_at + BRUSH_MODEL * self.model_count, self.surface_count)

    def surface(self, d, i):
        o = self.surfaces_at + SURFACE * i
        return {
            "firstVertex": u32(d, o + 12),
            "vertexCount": struct.unpack_from("<H", d, o + 36)[0],
            "triCount": struct.unpack_from("<H", d, o + 38)[0],
            "baseIndex": u32(d, o + 40),
            "material": struct.unpack_from("<Q", d, o + SURFACE_MATERIAL)[0],
        }


# -- collision ------------------------------------------------------------------

# three floats with a negative top byte, then three positive ones: a candidate world box
_BOX = re.compile(rb"(?s)(?=.{3}[\xc7\xc8].{3}[\xc7\xc8].{3}[\xc7\xc8].{3}[\x47\x48].{3}[\x47\x48].{3}[\x47\x48])")


def _unit_planes(d, p, n):
    for k in range(n):
        a, b, c = struct.unpack_from("<3f", d, p + 16 * k)
        if not abs(a * a + b * b + c * c - 1) <= 1e-3:  # also rejects NaN
            return False
    return True


def find_clip_counts(d):
    """The eight collision counts, found after the symmetric world box."""
    for m in _BOX.finditer(d):
        o = m.start()
        b = struct.unpack_from("<6f", d, o)
        if not all(b[k] == -b[k + 3] and b[k + 3] > 30000 for k in range(3)):
            continue
        c = struct.unpack_from("<3I", d, o + 24)
        if not all(0 < x < 10**7 for x in c):
            continue
        for p in range(o + 56, o + 0x100000):
            if _unit_planes(d, p, 16) and _unit_planes(d, p + 16 * (c[0] - 16), 16) and _unit_planes(d, p, 256):
                return o + 24
    raise SystemExit("no collision counts found")


class Clip:
    def __init__(self, d):
        c = find_clip_counts(d)
        self.counts = struct.unpack_from("<8I", d, c)
        nplanes, nverts, nbrushes = self.counts[:3]
        p = c + 32
        while not (_unit_planes(d, p, 64) and _unit_planes(d, p + 16 * (nplanes - 64), 64)):
            p += 1
            if p > c + 0x400000:
                raise SystemExit("collision planes not found")
        self.planes = p
        self.verts = p + 16 * nplanes
        self.ranges = self.verts + 12 * nverts + 4 * nbrushes
        # the brushes: the first offset after the ranges where brush 0's bounds are its own vertices'
        r0 = u32(d, self.ranges)
        n0, f0 = r0 >> 24, r0 & 0xFFFFFF
        v0 = [struct.unpack_from("<3f", d, self.verts + 12 * j) for j in range(f0, f0 + n0)]
        q = self.ranges + 4 * nbrushes
        while True:
            b = struct.unpack_from("<6f", d, q)
            if all(b[k] <= b[k + 3] for k in range(3)) and all(
                all(b[k] - 0.01 <= v[k] <= b[k + 3] + 0.01 for k in range(3)) for v in v0
            ):
                if min(v[0] for v in v0) == b[0] and max(v[0] for v in v0) == b[3]:
                    break
            q += 1
            if q > self.ranges + 0x400000:
                raise SystemExit("collision brushes not found")
        self.brushes = q
        self.soup = q + 28 * nbrushes + u32(d, c + 0x48)
        self.soup_indices = self.soup + 12 * self.counts[4]
        self.partitions = self.soup_indices + self.counts[5]

    def brush(self, d, i):
        """(mins, maxs, contents, [vertices])."""
        b = struct.unpack_from("<6fI", d, self.brushes + 28 * i)
        r = u32(d, self.ranges + 4 * i)
        n, f = r >> 24, r & 0xFFFFFF
        pts = []
        for j in range(f, f + n):
            v = struct.unpack_from("<3f", d, self.verts + 12 * j)
            if v not in pts:
                pts.append(v)
        return b[:3], b[3:6], b[6], pts

    def partition(self, d, k):
        """(vertex base, first triangle, triangle count, material)."""
        q = struct.unpack_from("<Q", d, self.partitions + 32 * k + 24)[0]
        return q & 0x7FFFFF, (q >> 23) & 0x3FFFFFF, (q >> 49) & 0x1F, q >> 54


def hull_planes(pts, eps=0.05):
    """The outward (normal, dist) of every face of the convex hull of a small point set."""
    n = len(pts)
    faces = {}
    for i in range(n):
        for j in range(i + 1, n):
            for k in range(j + 1, n):
                a, b, c = pts[i], pts[j], pts[k]
                u = (b[0] - a[0], b[1] - a[1], b[2] - a[2])
                v = (c[0] - a[0], c[1] - a[1], c[2] - a[2])
                nx, ny, nz = u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]
                ln = math.sqrt(nx * nx + ny * ny + nz * nz)
                if ln < 1e-6:
                    continue
                nx, ny, nz = nx / ln, ny / ln, nz / ln
                dist = nx * a[0] + ny * a[1] + nz * a[2]
                side = [nx * p[0] + ny * p[1] + nz * p[2] - dist for p in pts]
                if all(s <= eps for s in side):
                    pass
                elif all(s >= -eps for s in side):
                    nx, ny, nz, dist = -nx, -ny, -nz, -dist
                else:
                    continue
                key = (round(nx, 4), round(ny, 4), round(nz, 4), round(dist, 2))
                faces.setdefault(key, ((nx, ny, nz), dist))
    return list(faces.values())


# -- placements -----------------------------------------------------------------


def _placement_ok(d, p):
    s, qx, qy, qz, qw = struct.unpack_from("<5f", d, p + 12)
    return abs(qx * qx + qy * qy + qz * qz + qw * qw - 1) < 1e-2 and 0 < s < 1000


def placements(d):
    """[(model name hash, origin, quaternion, scale)] and the table's (start, end), or ([], None)."""
    hits = {m.start() for m in re.finditer(re.escape(PLACEMENT_FLAG), d)}
    best = (0, 0)
    for h in sorted(hits):
        if h - PLACEMENT in hits:
            continue
        n = 1
        while h + PLACEMENT * n in hits:
            n += 1
        if n > best[1]:
            best = (h - 56, n)
    if not best[1]:
        return [], None
    p = best[0]
    while _placement_ok(d, p - PLACEMENT):
        p -= PLACEMENT
    start = end = p
    while _placement_ok(d, end):
        end += PLACEMENT
    out = []
    for o in range(start, end, PLACEMENT):
        x, y, z, inv_scale, qx, qy, qz, qw = struct.unpack_from("<8f", d, o)
        name = struct.unpack_from("<Q", d, o - 12)[0]
        out.append((name, (x, y, z), (qx, qy, qz, qw), 1.0 / inv_scale))
    return out, (start - 12, end)


def quat_axis(q):
    """The rows of the rotation v' = q v q* (q = x, y, z, w): axis[i] is where local axis i goes."""
    x, y, z, w = q
    n = math.sqrt(x * x + y * y + z * z + w * w) or 1.0
    x, y, z, w = x / n, y / n, z / n, w / n
    return [
        [1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w)],
        [2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w)],
        [2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y)],
    ]


# -- entities -------------------------------------------------------------------


def find_ents(d, name):
    """Every asset shaped like an entity list under the map's name hash."""
    h = struct.pack("<Q", fnv63(bsp_name(name)))
    found = []
    p = d.find(h)
    while p >= 0:
        n = u32(d, p + 16)
        if d[p + 8 : p + 16] == b"\0" * 8 and d[p + 24 : p + 32] == b"\xff" * 8 and 100 < n < 100000:
            r0 = struct.unpack_from("<IIQ", d, p + 32)
            if r0[1] == 0 and r0[2] == NULL and r0[0] < 1000:
                found.append(p)
        p = d.find(h, p + 1)
    return found


def _fit_deltas(targets, starts, keep=12, min_ok=3):
    """File-minus-virtual deltas that land several aliases on string starts (world_ents.fit_deltas)."""
    ts = sorted(set(targets))
    pairs = [(ts[i], ts[i + 1] - ts[i]) for i in range(len(ts) - 1) if 4 <= ts[i + 1] - ts[i] < 64]
    score = Counter()
    for t0, gap in pairs:
        for st in starts:
            if st + gap in starts:
                score[st - t0] += 1
    out = {}
    for delta, _ in score.most_common(keep * 8):
        ok = [t for t in ts if t + delta in starts]
        if len(ok) >= min_ok and delta not in out:
            out[delta] = ok
        if len(out) >= keep:
            break
    return out


def _resolver(deltas, lookup):
    def res(t):
        best = None
        for delta, ok in deltas.items():
            k = bisect.bisect_left(ok, t)
            near = min(abs(ok[j] - t) for j in (k - 1, k) if 0 <= j < len(ok))
            s = lookup(t + delta)
            if s is not None and (best is None or near < best[0]):
                best = (near, s)
        return best[1] if best else None

    return res


def read_ents(d, h):
    """[{id, origin, angles, kv: [(key, value)]}] of one entity asset; unresolved strings are None."""
    n = u32(d, h + 16)
    a = h + 32
    recs = [struct.unpack_from("<IIQiI3f3f", d, a + ENTITY * i) for i in range(n)]
    p = a + ENTITY * n
    v = 0
    strings, raw = {}, []
    for r in recs:
        cnt, ptr = r[0], r[2]
        kv = []
        if ptr == NULL:
            v = (v + 7) & ~7
            pairs = [struct.unpack_from("<QQQQ", d, p + KEY_VALUE * k) for k in range(cnt)]
            p += KEY_VALUE * cnt
            v += KEY_VALUE * cnt
            for key, val, _, _typ in pairs:
                pair = []
                for x in (key, val):
                    if x == NULL:
                        e = d.index(b"\0", p)
                        s = d[p:e].decode("latin-1")
                        strings[v] = s
                        pair.append(s)
                        v += e + 1 - p
                        p = e + 1
                    else:
                        pair.append(x)
                kv.append(tuple(pair))
        raw.append(kv)
    targets = [
        x - 0x4000000000000001
        for kv in raw
        for pair in kv
        for x in pair
        if isinstance(x, int) and x >> 60 == 4 and x & 0x0FFFFFFF00000000 == 0
    ]
    own = _resolver(_fit_deltas(targets, set(strings), keep=6, min_ok=5), strings.get)
    rest = [t for t in targets if own(t) is None]
    file_starts = {m.start() + 1 for m in re.finditer(rb"\0(?=[\x20-\x7e]{1,200}\0)", d[:h])}

    def at(o):
        return d[o : d.index(b"\0", o)].decode("latin-1") if o in file_starts else None

    ext = _resolver(_fit_deltas(rest, file_starts), at)

    def res(x):
        if isinstance(x, str):
            return x
        if x >> 60 == 4:
            t = x - 0x4000000000000001
            return own(t) or ext(t)
        return None

    out = []
    for r, kv in zip(recs, raw, strict=True):
        out.append({"id": r[4], "origin": r[5:8], "angles": r[8:11], "kv": [(res(k), res(val)) for k, val in kv]})
    return out
