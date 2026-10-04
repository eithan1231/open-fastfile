"""T9 models: the XModel (type 6), its LOD meshes (type 9) and their streamed geometry.

A mesh record, offsets from K (its stream key; the record's XHash is at K-0x28):

  K+0x00  u64 stream key (0: the data is inline), u64 0, u64 0
  K+0x18  f32, u16 numSurfs, u16
  K+0x20  XSurfaceShared: u32 flags, vertCount, skinVertCount, indexCount, 4 x u32
  K+0x40  u64 -1
  K+0x48  u32 dataSize, posOffset, vertsOffset, indicesOffset, skinWeightsOffset
  K+0x1f0 the data itself when the key is 0 (dataSize bytes), then numSurfs
          XSurfaces of 0x30: u16 flags, vertCount, triCount, 0, u32 baseVert,
          u32 baseIndex (in indices), two pointers each followed by 8 zero bytes.
  The next mesh of a model's run starts 0x28 past its last XSurface.

The data: u16 indices (relative to the surface's baseVert), float3 positions,
then 16-byte vertices -- u32 colour, f16 u, f16 v, u32 normal and u32 tangent,
each 10:10:10 *unsigned* (`v / 1023 * 2 - 1`) -- every stream 16-aligned.
Triangles are wound clockwise.

A model's meshes follow its type-7 record (`B`, 0x68 bytes: name, two
pointers, bounds at +0x48), back to back; the XModel (`C`) is the next record
after the run with the same name:

  C+0x28  meshes[8]: aliases, COARSEST first, so LOD0 is meshes[numLods - 1]
  C+0x68  -1 (the per-LOD material records are inline)
  C+0x78  u16 numLods
  C+0x7c  f32[8] per-LOD distances (descending), C+0xbc bounds, C+0xe0 radius
  C+0xf0  numLods x 24: u64 numMaterials, materials (-1 inline, or a pointer to
          an identical earlier array), f32 array (the same); then each inline
          array in order, the pointer arrays 8-aligned. Record i goes with
          meshes[i], and material s is surface s's.

reverse/t9-zone/mesh_format.py, mesh_models.py, mesh_xmodel.py.
"""

import bisect
import re
import struct

NULL = 0xFFFFFFFFFFFFFFFF
MESH_NAME = 0x28
SURFACES = 0x1F0
SURFACE = 0x30
VERTEX = 16
MAX_B_GAP = 0x400
XMODEL_MESHES = 0x28
XMODEL_MATERIALS = 0x68
XMODEL_LODS = 0x78
XMODEL_LOD_RECORDS = 0xF0
B_BOUNDS = 0x48

_MESH_NULL = re.compile(rb"(?=\xff{8}[^\xff])")
_HALF = struct.Struct("<e")
_WORD = struct.Struct("<H")


def align16(n):
    return (n + 15) & ~15


def scan_meshes(data, start=0):
    """Every mesh record's K, found by shape: the -1 at K+0x40 and stream offsets that follow from the counts."""
    found = []
    for m in _MESH_NULL.finditer(data, start):
        k = m.start() - 0x40
        if k < 0 or k + 0x70 > len(data):
            continue
        _, vc, _, ic = struct.unpack_from("<4I", data, k + 0x20)
        ds, po, vo, io = struct.unpack_from("<4I", data, k + 0x48)
        if not (vc and ic and io == 0 and vc < 1 << 20):
            continue
        if po == align16(2 * ic) and vo == po + align16(12 * vc) and ds >= vo + VERTEX * vc:
            if struct.unpack_from("<QQ", data, k + 8) == (0, 0):
                found.append(k)
    return found


class Mesh:
    def __init__(self, data, k):
        self.k = k
        self.key = struct.unpack_from("<Q", data, k)[0]
        self.surface_count = struct.unpack_from("<H", data, k + 0x1C)[0]
        self.flags, self.vertex_count, self.skin_vertex_count, self.index_count = struct.unpack_from("<4I", data, k + 0x20)
        self.data_size, self.pos_offset, self.verts_offset, self.indices_offset = struct.unpack_from("<4I", data, k + 0x48)
        self.surfaces_at = k + SURFACES + (self.data_size if self.key == 0 else 0)
        self.surfaces = [
            struct.unpack_from("<4H2I", data, self.surfaces_at + SURFACE * i) for i in range(self.surface_count)
        ]  # flags, vertCount, triCount, 0, baseVert, baseIndex
        self.end = self.surfaces_at + SURFACE * self.surface_count

    def item(self, data, packages):
        """The geometry bytes: inline after the record, or the stream item (None when not installed)."""
        if self.key == 0:
            return data[self.k + SURFACES : self.k + SURFACES + self.data_size]
        item = packages.read(self.key)
        if item is not None and len(item) != self.data_size:
            raise SystemExit(f"mesh item {self.key:016x} is {len(item)} bytes, its record says {self.data_size}")
        return item


def unit10(packed):
    return (
        ((packed) & 0x3FF) / 1023.0 * 2.0 - 1.0,
        ((packed >> 10) & 0x3FF) / 1023.0 * 2.0 - 1.0,
        ((packed >> 20) & 0x3FF) / 1023.0 * 2.0 - 1.0,
    )


def half(word):
    return _HALF.unpack(_WORD.pack(word))[0]


def decode(item, mesh):
    """(positions, normals, uvs, colours, [(first vertex, triangles)] per surface), CoD frame.

    Triangles are local to their surface and wound as the zone stores them (clockwise)."""
    n = mesh.vertex_count
    flat = struct.unpack_from(f"<{3 * n}f", item, mesh.pos_offset)
    positions = [flat[3 * i : 3 * i + 3] for i in range(n)]
    normals, uvs, colours = [], [], []
    for colour, u, v, normal, _tangent in struct.iter_unpack("<IHHII", item[mesh.verts_offset : mesh.verts_offset + VERTEX * n]):
        normals.append(unit10(normal))
        uvs.append((half(u), half(v)))
        colours.append(tuple(((colour >> s) & 0xFF) / 255.0 for s in (0, 8, 16, 24)))
    surfaces = []
    for _flags, vcount, tcount, _, base_vert, base_index in mesh.surfaces:
        raw = struct.unpack_from(f"<{3 * tcount}H", item, mesh.indices_offset + 2 * base_index)
        tris = [raw[i : i + 3] for i in range(0, 3 * tcount, 3)]
        if any(max(t) >= vcount for t in tris):
            raise SystemExit(f"mesh {mesh.k:#x}: a triangle indexes past its surface's {vcount} vertices")
        surfaces.append((base_vert, tris))
    return positions, normals, uvs, colours, surfaces


class ZoneModels:
    """The zone's mesh runs, and each model's B record, mesh run and XModel, by name."""

    def __init__(self, zone):
        self.zone = zone
        data = zone.data
        self.meshes = {k: Mesh(data, k) for k in scan_meshes(data, zone.data_at)}
        succ = {}
        for k, mesh in self.meshes.items():
            nxt = mesh.end + MESH_NAME
            if nxt in self.meshes:
                succ[k] = nxt
        self.succ = succ
        self.heads = sorted(set(self.meshes) - set(succ.values()))
        self._occurrences = None

    def run(self, k):
        out = [k]
        while k in self.succ:
            k = self.succ[k]
            out.append(k)
        return out

    def occurrences(self, name, exclude):
        pat = re.escape(struct.pack("<Q", name))
        lo, hi = exclude
        return [m.start() for m in re.finditer(pat, self.zone.data) if not lo <= m.start() < hi]

    def resolve(self, name, exclude=(0, 0)):
        """{b, meshes (the run, file order), xmodel} for a model name hash, or None.

        B is the occurrence of the name closest before a run's head (within
        MAX_B_GAP, no other occurrence between); the XModel is the next occurrence
        after the run."""
        occ = self.occurrences(name, exclude)
        best = None
        for i, o in enumerate(occ):
            q = bisect.bisect(self.heads, o)
            if q == len(self.heads):
                continue
            head = self.heads[q]
            if i + 1 < len(occ) and occ[i + 1] < head:
                continue
            if head - o <= MAX_B_GAP and (best is None or head - o < best[0]):
                best = (head - o, o, head)
        if best is None:
            return None
        _, b, head = best
        run = self.run(head)
        after = [o for o in occ if o > run[-1]]
        return {"b": b, "meshes": run, "xmodel": after[0] if after else None}

    def xmodel(self, c, run):
        """The XModel at `c`: its LOD meshes (K offsets, LOD0 first) and each LOD's material entries."""
        zone, data = self.zone, self.zone.data
        num_lods = struct.unpack_from("<H", data, c + XMODEL_LODS)[0]
        if not 0 < num_lods <= 8:
            return None
        entries = [zone.alias(v) for v in struct.unpack_from(f"<{num_lods}Q", data, c + XMODEL_MESHES)]
        known = [j for j in entries if j is not None]
        if not known:
            return None
        first = min(known)
        # Mesh assets load in list order, so entry j is the (j - first)th mesh of the run.
        meshes = [run[j - first] if j is not None and 0 <= j - first < len(run) else None for j in entries]
        materials = [None] * num_lods
        if struct.unpack_from("<Q", data, c + XMODEL_MATERIALS)[0] == NULL:
            recs = [struct.unpack_from("<QQQ", data, c + XMODEL_LOD_RECORDS + 24 * i) for i in range(num_lods)]
            at = c + XMODEL_LOD_RECORDS + 24 * num_lods
            inline = []
            for i, (count, mats, floats) in enumerate(recs):
                count &= 0xFFFF
                if mats == NULL:
                    arr = [zone.alias(v) for v in struct.unpack_from(f"<{count}Q", data, at)]
                    at += 8 * count
                    materials[i] = arr
                    inline.append(arr)
                else:
                    # A pointer to an identical array loaded earlier; this model's own
                    # inline array of the same length is the one that can be checked.
                    same = [a for a in inline if len(a) == count]
                    materials[i] = same[0] if same else None
                if floats == NULL:
                    at += 4 * count
        lods = list(zip(meshes, materials, strict=True))[::-1]  # LOD0 first
        distances = struct.unpack_from(f"<{num_lods}f", data, c + 0x7C)[::-1]
        return {"lods": lods, "distances": distances, "bounds": struct.unpack_from("<6f", data, c + 0xBC)}
