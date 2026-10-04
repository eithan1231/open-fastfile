"""Effective identity between two exports: everything the golden one holds, the candidate must hold too.

`python3 -m scripts.cod equiv worlds <golden> <candidate>` compares exported
world folders (one, a folder of them, or a catalogue); `equiv dump` compares two
dump trees (an export's `--keep-work` scratch). Both walk the golden tree, pair
files by path and canonicalise each by type before comparing its records, so
order, formatting, float noise under tolerance, buffer layout and generator
stamps do not count. A record the candidate lacks is MISSING and one it holds
differently DIFFERS, both failures; one only the candidate has is EXTRA, which is
reported and allowed. What each type compares, and the tolerances:
docs/cod/pipeline.md#proving-an-export-equivalent.
"""

import bisect
import fnmatch
import hashlib
import io
import json
import math
import os
import re
import struct
import subprocess
import sys
import zlib
from array import array
from collections import Counter, defaultdict

from . import xanim
from .files import read_bytes

MISSING, DIFFERS, EXTRA = "MISSING", "DIFFERS", "EXTRA"
FAILURES = (MISSING, DIFFERS)

TOL_M = 1e-4  # metres: world-file distances, GLB positions, matrices
TOL_DEG = 1e-3  # degrees: world-file angles
TOL_REL = 1e-6  # JSON numbers: |a - b| <= max(TOL_M, TOL_REL * |a|), so game units of 1e5 keep float32 noise out
TOL_UNIT = 1e-3  # unit vectors, normalised colours, weights, quaternions
TOL_UV = 1e-4
# A lossy image (JPEG on either side) passes when its pixels differ by at most
# this much, out of 255: a re-encode of identical pixels is bit-identical, so any
# difference means the source moved, and these bounds admit only rounding.
LOSSY_MEAN, LOSSY_MAX = 1.0, 32
# Opus clips that are not byte-identical are decoded and compared as PCM.
AUDIO_SNR_DB = 40.0

# How many records a file's report names before it summarises the rest by key.
DEFAULT_LIMIT = 12


# -- Findings --------------------------------------------------------------------------


class Report:
    """Findings per file: (status, record key, detail)."""

    def __init__(self):
        self.files = {}
        self.compared = 0
        self.identical = 0
        self.equivalent = []  # files whose bytes differ and whose records do not

    def add(self, rel, status, key, detail=""):
        self.files.setdefault(rel, []).append((status, key, detail))

    def emitter(self, rel):
        return lambda status, key, detail="": self.add(rel, status, key, detail)

    def count(self, *statuses):
        return sum(1 for items in self.files.values() for s, _, _ in items if s in statuses)

    @property
    def failed(self):
        return self.count(*FAILURES) > 0

    def to_json(self):
        return {
            "compared": self.compared,
            "identical": self.identical,
            "equivalent": self.equivalent,
            "files": {rel: [list(f) for f in items] for rel, items in sorted(self.files.items())},
        }

    def print(self, out=sys.stdout, limit=DEFAULT_LIMIT):
        for rel, items in sorted(self.files.items()):
            by = defaultdict(list)
            for s, k, d in items:
                by[s].append((k, d))
            head = ", ".join(f"{len(by[s])} {s.lower()}" for s in (MISSING, DIFFERS, EXTRA) if by[s])
            print(f"{rel}: {head}", file=out)
            for status in (MISSING, DIFFERS, EXTRA):
                rows = by[status]
                for key, detail in rows[:limit]:
                    print(f"  {status:7} {key}" + (f": {detail}" if detail else ""), file=out)
                if len(rows) > limit:
                    rest = ", ".join(k for k, _ in rows[limit : limit + 8])
                    print(f"  {status:7} ... {len(rows) - limit} more: {rest}{' ...' if len(rows) > limit + 8 else ''}", file=out)
        print(
            f"{self.compared} file(s) compared, {self.identical} byte-identical, {len(self.equivalent)} equivalent; "
            f"{self.count(MISSING)} missing, {self.count(DIFFERS)} differing, {self.count(EXTRA)} extra record(s)",
            file=out,
        )


def short(value, width=100):
    text = value if isinstance(value, str) else json.dumps(value, default=repr, sort_keys=True)
    return text if len(text) <= width else text[: width - 3] + "..."


# -- Numbers -----------------------------------------------------------------------------


def is_num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def close(a, b, tol=TOL_M, rel=TOL_REL):
    if a == b:
        return True
    if isinstance(a, float) and isinstance(b, float) and math.isnan(a) and math.isnan(b):
        return True
    return abs(a - b) <= max(tol, rel * max(abs(a), abs(b)))


def nums_equal(a, b, tol=TOL_M, rel=TOL_REL):
    """Ints must match exactly (flags, counts, indices); anything with a float in it within tolerance."""
    if isinstance(a, int) and isinstance(b, int):
        return a == b
    return close(float(a), float(b), tol, rel)


# -- The generic structured diff ---------------------------------------------------------


class Rules:
    """Per-kind rules for the structured diff, as fnmatch patterns over a schema path (`a.b[].c`).

    - `ordered`: lists whose order means something (an index space something else
      points into, keyframes). Lists of numbers and of lists are ordered anyway;
      lists of dicts and strings are collections unless named here.
    - `keys`: a collection's identity fields, for pairing records that differ; a
      collection without them is matched by whole content.
    - `ignore`: dict keys that carry no meaning (a generator stamp).
    - `angles`: numbers compared as degrees.
    - `scaled`: number lists whose float noise is the whole list's (a matrix), so each
      value is also allowed TOL_REL of the list's largest magnitude.
    """

    def __init__(self, ordered=(), keys=None, ignore=(), angles=(), scaled=()):
        self.ordered_pats = tuple(ordered)
        self.key_pats = dict(keys or {})
        self.ignore_pats = tuple(ignore)
        self.angle_pats = tuple(angles)
        self.scaled_pats = tuple(scaled)
        self._cache = {}

    def _match(self, kind, spath, pats):
        key = (kind, spath)
        if key not in self._cache:
            self._cache[key] = next((p for p in pats if fnmatch.fnmatchcase(spath, p)), None)
        return self._cache[key]

    def ordered(self, spath):
        return self._match("o", spath, self.ordered_pats) is not None

    def ignored(self, spath):
        return self._match("i", spath, self.ignore_pats) is not None

    def angle(self, spath):
        return self._match("a", spath, self.angle_pats) is not None

    def scaled(self, spath):
        return self._match("s", spath, self.scaled_pats) is not None

    def key_fields(self, spath):
        pat = self._match("k", spath, tuple(self.key_pats))
        return self.key_pats[pat] if pat else None


DEFAULT_RULES = Rules()


class Special:
    """A value compared by its own rules (a triangle set, an image, a curve) inside the structured diff."""

    def canon(self):
        raise NotImplementedError

    def diff(self, other, where, emit):
        raise NotImplementedError


def child(spath, key):
    return f"{spath}.{key}" if spath else str(key)


def canon(v, spath="", rules=DEFAULT_RULES):
    """A hashable form of `v` that is equal for equal records: dict order dropped, collections sorted, floats rounded."""
    if isinstance(v, Special):
        return v.canon()
    if isinstance(v, dict):
        return tuple(sorted((k, canon(x, child(spath, k), rules)) for k, x in v.items() if not rules.ignored(child(spath, k))))
    if isinstance(v, list | tuple):
        items = [canon(x, spath + "[]", rules) for x in v]
        if not is_ordered(v, spath, rules):
            items.sort(key=repr)
        return ("L", tuple(items))
    if isinstance(v, float):
        return round(v, 4) + 0.0
    return v


def is_ordered(v, spath, rules):
    if rules.ordered(spath):
        return True
    return not any(isinstance(x, dict | str) or (isinstance(x, Special) and not isinstance(x, Num)) for x in v)


def diff(g, c, where, spath, rules, emit):
    """Emit what `c` lacks or holds differently from `g`, and what only `c` holds."""
    if isinstance(g, Special) and type(g) is type(c):
        g.diff(c, where, emit)
    elif isinstance(g, dict) and isinstance(c, dict):
        for k, gv in g.items():
            sp = child(spath, k)
            if rules.ignored(sp):
                continue
            if k not in c:
                emit(MISSING, f"{where}.{k}" if where else str(k), short(gv))
            else:
                diff(gv, c[k], f"{where}.{k}" if where else str(k), sp, rules, emit)
        for k, cv in c.items():
            if k not in g and not rules.ignored(child(spath, k)):
                emit(EXTRA, f"{where}.{k}" if where else str(k), short(cv))
    elif isinstance(g, list | tuple) and isinstance(c, list | tuple):
        if is_ordered(g, spath, rules) and is_ordered(c, spath, rules):
            diff_ordered(g, c, where, spath, rules, emit)
        else:
            diff_collection(g, c, where, spath, rules, emit)
    elif is_num(g) and is_num(c):
        tol = TOL_DEG if rules.angle(spath) else TOL_M
        if not nums_equal(g, c, tol):
            emit(DIFFERS, where, f"{g!r} -> {c!r}")
    elif g != c:
        emit(DIFFERS, where, f"{short(g, 60)} -> {short(c, 60)}")


def diff_ordered(g, c, where, spath, rules, emit):
    item = spath + "[]"
    if len(g) == len(c) and all(is_num(x) for x in g) and all(is_num(x) for x in c):
        tol = TOL_DEG if rules.angle(item) else TOL_M
        if rules.scaled(spath):
            tol = max(tol, TOL_REL * max(abs(x) for x in (*g, *c)))
        bad = [i for i, (a, b) in enumerate(zip(g, c, strict=True)) if not nums_equal(a, b, tol)]
        if bad:
            shown = ", ".join(f"[{i}] {g[i]!r} -> {c[i]!r}" for i in bad[:4])
            emit(DIFFERS, where, f"{len(bad)} of {len(g)} value(s): {shown}")
        return
    for i, (a, b) in enumerate(zip(g, c, strict=False)):
        diff(a, b, f"{where}[{i}]", item, rules, emit)
    for i in range(len(c), len(g)):
        emit(MISSING, f"{where}[{i}]", short(g[i]))
    for i in range(len(g), len(c)):
        emit(EXTRA, f"{where}[{i}]", short(c[i]))


def equal(g, c, spath, rules):
    """Whether `diff` would find nothing (stops at the first finding)."""

    class Found(Exception):
        pass

    def stop(*_):
        raise Found

    try:
        diff(g, c, "", spath, rules, stop)
    except Found:
        return False
    return True


def identity(item, fields):
    """The label a collection record is paired and named by."""
    if fields and isinstance(item, dict):
        parts = []
        for f in fields:
            v = item.get(f)
            if isinstance(v, float):
                v = round(v, 1) + 0.0
            elif isinstance(v, dict) and v and all(is_num(x) for x in v.values()):
                v = tuple(round(float(v[k]), 1) + 0.0 for k in sorted(v))
            if isinstance(v, list | tuple) and all(is_num(x) for x in v):
                v = tuple(round(float(x), 1) + 0.0 for x in v)
            parts.append(f"{f}={v}" if v is not None else f"{f}=-")
        return " ".join(parts)
    return None


def default_fields(items):
    dicts = [x for x in items if isinstance(x, dict)]
    if not dicts or len(dicts) != len(items):
        return None
    for fields in (("name",), ("classname", "origin", "targetname"), ("aliasName",), ("model", "origin")):
        if all(fields[0] in d for d in dicts):
            return fields
    return None


# Leftovers paired by tolerance inside one identity group, at most this many comparisons.
MAX_PAIRING = 4_000_000


def diff_collection(g, c, where, spath, rules, emit):
    """Match records by content, then pair what is left by identity, then name the rest."""
    item = spath + "[]"
    gk = [canon(x, item, rules) for x in g]
    ck = [canon(x, item, rules) for x in c]
    pool = defaultdict(list)
    for i, k in enumerate(ck):
        pool[k].append(i)
    left_g = []
    for i, k in enumerate(gk):
        if pool.get(k):
            pool[k].pop()
        else:
            left_g.append(i)
    left_c = sorted(i for idx in pool.values() for i in idx)
    if not left_g and not left_c:
        return

    fields = rules.key_fields(item) or default_fields(list(g) + list(c))
    groups = defaultdict(lambda: ([], []))
    for i in left_g:
        groups[identity(g[i], fields)][0].append(i)
    for i in left_c:
        groups[identity(c[i], fields)][1].append(i)

    def label(key, value):
        return f"{where}[{key}]" if key is not None else f"{where}[{short(value, 80)}]"

    for key, (gs, cs) in groups.items():
        # Records equal within tolerance that rounding put in different buckets.
        if gs and cs and len(gs) * len(cs) <= MAX_PAIRING:
            rest = []
            for i in gs:
                j = next((j for j in cs if equal(g[i], c[j], item, rules)), None)
                if j is None:
                    rest.append(i)
                else:
                    cs.remove(j)
            gs = rest
        if key is not None:
            gs.sort(key=lambda i: repr(gk[i]))
            cs.sort(key=lambda j: repr(ck[j]))
            for i, j in zip(gs, cs, strict=False):
                diff(g[i], c[j], label(key, None), item, rules, emit)
            gs, cs = gs[len(cs) :], cs[len(gs) :]
        for i in gs:
            emit(MISSING, label(key, g[i]), "" if key is None else short(g[i]))
        for j in cs:
            emit(EXTRA, label(key, c[j]), "" if key is None else short(c[j]))


# -- Triangles ------------------------------------------------------------------------------
#
# Memory is bounded by design: vertices stay in the file's own compact arrays (or its raw
# blob) and become a tuple only to be hashed, one at a time; a triangle is one 64-bit digest
# in a sorted array('q'). Only triangles whose digest has no partner are ever materialised,
# and at most LEFTOVER_CAP of those a side. Measured on dome-mw3's world.glb (23 MB, 383k
# vertices): see docs/cod/pipeline.md#proving-an-export-equivalent.

LEFTOVER_CAP = 20_000


class VertexStore:
    """Vertices read on demand: `vertex(i)` builds one tuple of `names`, `hashes()` one int each, cached as array('q')."""

    def __init__(self, names, tols, count, vertex):
        self.names, self.tols, self.count, self.vertex = tuple(names), tuple(tols), count, vertex
        self._inv = [0 if t == 0 else 1.0 / t for t in self.tols]
        self._hashes = None

    def quantise(self, v):
        return tuple([x if s == 0 else round(x * s) for x, s in zip(v, self._inv, strict=True)])

    def hashes(self):
        if self._hashes is None:
            q, vertex = self.quantise, self.vertex
            self._hashes = array("q", (hash(q(vertex(i))) for i in range(self.count)))
        return self._hashes

    def project(self, names):
        idx = [self.names.index(n) for n in names]
        vertex = self.vertex
        return VertexStore(names, [self.tols[i] for i in idx], self.count, lambda i: tuple(vertex(i)[k] for k in idx))


def _rotated(a, b, c):
    """Three vertex hashes starting at the smallest, winding kept."""
    if a <= b and a <= c:
        return a, b, c
    if b <= a and b <= c:
        return b, c, a
    return c, a, b


class TriangleSet(Special):
    """Triangles as a multiset of digests: each a triangle's three vertices within tolerance, from any vertex, in any order.

    A set is built from parts over vertex stores: `tris` is a flat array of vertex
    indices, three a triangle, and `labels` an optional exact value per triangle
    (the brush a collision triangle belongs to). The first three components of every
    vertex are its position; a component with tolerance 0 is compared exactly.
    """

    def __init__(self, store, tris, labels=None, label="triangles"):
        self.names, self.tols, self.label = store.names, store.tols, label
        self.labelled = labels is not None
        self.parts = [(store, tris, labels)]
        self._digests = None

    def add(self, store, tris, labels=None):
        self.parts.append((store, tris, labels))
        self.labelled = self.labelled or labels is not None
        self._digests = None

    def _walk(self):
        """(digest, part, triangle index) of every triangle."""
        for p, (store, tris, labels) in enumerate(self.parts):
            h = store.hashes()
            for t in range(len(tris) // 3):
                key = _rotated(h[tris[3 * t]], h[tris[3 * t + 1]], h[tris[3 * t + 2]])
                yield hash((*key, labels[t] if labels is not None else 0)), p, t

    def digests(self):
        if self._digests is None:
            self._digests = array("q", sorted(d for d, _, _ in self._walk()))
        return self._digests

    def canon(self):
        return ("tris", self.names, hashlib.blake2b(self.digests().tobytes(), digest_size=16).hexdigest())

    def raw(self, p, t):
        """One triangle as three vertex tuples, its label appended to each where the set is labelled."""
        store, tris, labels = self.parts[p]
        verts = [store.vertex(tris[3 * t + k]) for k in range(3)]
        if self.labelled:
            lab = labels[t] if labels is not None else 0
            verts = [v + (lab,) for v in verts]
        return tuple(verts)

    def collect(self, wanted):
        """The raw triangles whose digests `wanted` (a Counter) names, at most LEFTOVER_CAP; and how many more there were."""
        out, over = [], 0
        wanted = Counter(wanted)
        for d, p, t in self._walk():
            if wanted.get(d):
                wanted[d] -= 1
                if len(out) < LEFTOVER_CAP:
                    out.append(self.raw(p, t))
                else:
                    over += 1
        return out, over

    def project(self, names):
        names = tuple(n for n in names if n != "brushMaterial")
        out = None
        for store, tris, labels in self.parts:
            if out is None:
                out = TriangleSet(store.project(names), tris, labels, self.label)
            else:
                out.add(store.project(names), tris, labels)
        return out

    def all_names(self):
        return self.names + (("brushMaterial",) if self.labelled else ())

    def _close_tri(self, a, b, tols):
        for rot in (b, (b[1], b[2], b[0]), (b[2], b[0], b[1])):
            if all(
                abs(x - y) <= t * 1.0001 if t else x == y
                for va, vb in zip(a, rot, strict=True)
                for x, y, t in zip(va, vb, tols, strict=True)
            ):
                return True
        return False

    def diff(self, other, where, emit):
        a, b = self, other
        if a.all_names() != b.all_names():
            for n in a.all_names():
                if n not in b.all_names():
                    emit(MISSING, f"{where} attribute {n}")
            for n in b.all_names():
                if n not in a.all_names():
                    emit(EXTRA, f"{where} attribute {n}")
            common = tuple(n for n in a.names if n in b.names)
            if len(common) < 3:
                return
            a, b = a.project(common), b.project(common)
        missing, extra = _multiset_difference(a.digests(), b.digests())
        if not missing and not extra:
            return
        lost, lost_over = a.collect(missing)
        found, found_over = b.collect(extra)
        tols = a.tols + ((0,) if a.labelled else ())
        # Near misses across a rounding boundary: bucket the candidate's leftovers by centroid, look in the 27 cells around.
        cell = max(tols[0], 1e-9) * 16

        def centroid_cell(tri):
            return tuple(math.floor(sum(v[i] for v in tri) / 3 / cell) for i in range(3))

        grid = defaultdict(list)
        for tri in found:
            grid[centroid_cell(tri)].append(tri)
        still = []
        for tri in lost:
            cx, cy, cz = centroid_cell(tri)
            hit = None
            for key in ((cx + dx, cy + dy, cz + dz) for dx in (-1, 0, 1) for dy in (-1, 0, 1) for dz in (-1, 0, 1)):
                bucket = grid.get(key)
                if bucket:
                    hit = next((t for t in bucket if a._close_tri(tri, t, tols)), None)
                    if hit is not None:
                        bucket.remove(hit)
                        break
            if hit is None:
                still.append(tri)
        found = [t for bucket in grid.values() for t in bucket]
        names = a.all_names()
        _name_tris(emit, MISSING, where, a.label, still, names, lost_over)
        _name_tris(emit, EXTRA, where, b.label, found, names, found_over)


def _multiset_difference(a, b):
    """(in a and not b, in b and not a) of two sorted arrays, as Counters of the unmatched values."""
    missing, extra = Counter(), Counter()
    i = j = 0
    while i < len(a) and j < len(b):
        if a[i] == b[j]:
            i += 1
            j += 1
        elif a[i] < b[j]:
            missing[a[i]] += 1
            i += 1
        else:
            extra[b[j]] += 1
            j += 1
    for k in range(i, len(a)):
        missing[a[k]] += 1
    for k in range(j, len(b)):
        extra[b[k]] += 1
    return missing, extra


def _name_tris(emit, status, where, label, tris, names, over=0, limit=6):
    """Name each triangle by its first vertex; past `limit`, one line with the rest's bounds."""
    tris = sorted(tris)
    for tri in tris[:limit]:
        v = tri[0]
        detail = ", ".join(f"{n}={v[i]:.5g}" if isinstance(v[i], float) else f"{n}={v[i]}" for i, n in enumerate(names))
        emit(status, f"{where} {label[:-1] if label.endswith('s') else label} at ({v[0]:.4f}, {v[1]:.4f}, {v[2]:.4f})", detail)
    if len(tris) > limit or over:
        rest = tris[limit:]
        bounds = ""
        if rest:
            lo = [min(t[0][i] for t in rest) for i in range(3)]
            hi = [max(t[0][i] for t in rest) for i in range(3)]
            bounds = f"within ({lo[0]:.3f}, {lo[1]:.3f}, {lo[2]:.3f})..({hi[0]:.3f}, {hi[1]:.3f}, {hi[2]:.3f})"
        if over:
            bounds += f"{'; ' if bounds else ''}{over} more past the {LEFTOVER_CAP} named here"
        emit(status, f"{where} {len(rest) + over} more {label}", bounds)


def name_hash(name):
    """A string as an exactly-compared triangle component."""
    return zlib.crc32(name.encode("utf-8", "replace")) if name else 0


# -- Images ------------------------------------------------------------------------------------

IMAGE_EXTS = (".iwi", ".dds", ".png", ".jpg", ".jpeg", ".tga", ".bmp")


def decode_image(data, name=""):
    """A PIL image of the largest level, or None when no decoder here reads it."""
    from PIL import Image

    try:
        if data[:3] == b"IWi":
            from .textures import decode_iwi_bytes

            return decode_iwi_bytes(data)[0]
        img = Image.open(io.BytesIO(data))
        img.load()
        return img
    except Exception:
        return _decode_dxgi(data)


def _decode_dxgi(data):
    """The two DX10 formats Pillow cannot read (dxgi.py), else None."""
    import tempfile

    from . import dxgi

    if data[:4] != b"DDS ":
        return None
    with tempfile.NamedTemporaryFile(suffix=".dds") as fh:
        fh.write(data)
        fh.flush()
        try:
            fmt, w, h, payload = dxgi.read_dds(fh.name)
        except ValueError:
            return None
    from PIL import Image

    if fmt != dxgi.BC4_UNORM:
        return None  # half floats have no 8-bit image; dds_payload compares them exactly
    try:
        return Image.frombytes("L", (w, h), bytes(dxgi.bc4(payload, w, h)))
    except Exception:
        return None


def dds_payload(data):
    """(format, width, height, top-level texels) of a DDS, whatever its header's other flags say; else None."""
    if data[:4] != b"DDS " or len(data) < 128:
        return None
    height, width = struct.unpack_from("<2I", data, 12)
    fourcc = data[84:88]
    if fourcc == b"DX10":
        return struct.unpack_from("<I", data, 128)[0], width, height, data[148:]
    return fourcc, width, height, data[128:]


def is_lossy(data):
    return data[:2] == b"\xff\xd8"


class ImageRef(Special):
    """An image compared by its pixels: exactly when lossless, within LOSSY_MEAN/LOSSY_MAX when JPEG."""

    def __init__(self, data, name=""):
        self.data, self.name = data, name
        self.digest = hashlib.sha1(data).hexdigest()

    def canon(self):
        return ("img", self.digest)

    def diff(self, other, where, emit):
        if self.digest == other.digest:
            return
        problem = compare_pixels(self.data, other.data)
        if problem:
            emit(DIFFERS, where or self.name or "image", problem)


def compare_pixels(a_bytes, b_bytes):
    """None when two images hold the same pixels (within the lossy bound where either is JPEG), else why not."""
    from PIL import ImageChops, ImageStat

    pa, pb = dds_payload(a_bytes), dds_payload(b_bytes)
    if pa is not None and pa == pb:
        return None
    a, b = decode_image(a_bytes), decode_image(b_bytes)
    if a is None or b is None:
        return "no decoder for this image here, and its bytes differ"
    if a.size != b.size:
        return f"size {a.size[0]}x{a.size[1]} -> {b.size[0]}x{b.size[1]}"
    if a.mode != b.mode:
        a, b = a.convert("RGBA"), b.convert("RGBA")
    if a.mode not in ("RGB", "RGBA", "L", "LA"):
        a, b = a.convert("RGBA"), b.convert("RGBA")
    delta = ImageChops.difference(a, b)
    # Not `getbbox()`: on RGBA it looks at alpha alone, and a colour change keeps alpha.
    stat = ImageStat.Stat(delta)
    mean, worst = max(stat.mean), max(hi for _, hi in stat.extrema)
    if worst == 0:
        return None
    if not (is_lossy(a_bytes) or is_lossy(b_bytes)):
        return f"pixels differ within {delta.getbbox(alpha_only=False)}"
    if mean <= LOSSY_MEAN and worst <= LOSSY_MAX:
        return None
    return f"lossy pixels differ: mean {mean:.2f}, max {worst} (bound {LOSSY_MEAN}, {LOSSY_MAX})"


# -- Audio --------------------------------------------------------------------------------------


def riff_chunks(data):
    """{chunk id: payload} of a RIFF file, or None."""
    if data[:4] != b"RIFF" or len(data) < 12:
        return None
    chunks, pos = {}, 12
    while pos + 8 <= len(data):
        cid, size = struct.unpack_from("<4sI", data, pos)
        chunks.setdefault(cid.decode("latin-1"), data[pos + 8 : pos + 8 + size])
        pos += 8 + size + (size & 1)
    return chunks


def compare_riff(a, b):
    """None when two RIFF clips hold the same audio: PCM by its format and samples, else the fmt and
    data chunks (xWMA's seek table too).

    Chunks are read to the end of the file, whatever the RIFF header's own size says:
    OpenAssetTools' WavWriter writes a constant 36 there, and a reader that believes it
    (`wave`) sees 12 bytes of every clip."""
    ca, cb = riff_chunks(a), riff_chunks(b)
    if ca is None or cb is None:
        return "not RIFF, and the bytes differ"
    fa, fb = ca.get("fmt ", b""), cb.get("fmt ", b"")
    if len(fa) >= 16 and len(fb) >= 16 and struct.unpack_from("<H", fa)[0] == struct.unpack_from("<H", fb)[0] == 1:
        pa, pb = struct.unpack_from("<HHIIHH", fa), struct.unpack_from("<HHIIHH", fb)
        if (pa[1], pa[2], pa[5]) != (pb[1], pb[2], pb[5]):  # channels, rate, bits
            return f"format {pa} -> {pb}"
        da, db = ca.get("data", b""), cb.get("data", b"")
        return None if da == db else f"PCM differs ({len(da)} -> {len(db)} bytes)"
    for cid in ("fmt ", "data", "dpds"):
        if ca.get(cid) != cb.get(cid):
            return f"{cid.strip()} chunk differs"
    return None


def decode_pcm(data):
    """Mono float PCM at 48 kHz through ffmpeg, or None where ffmpeg is not there."""
    try:
        out = subprocess.run(
            ["ffmpeg", "-loglevel", "error", "-i", "pipe:0", "-f", "f32le", "-ac", "1", "-ar", "48000", "pipe:1"],
            input=data,
            capture_output=True,
            check=True,
        ).stdout
    except (OSError, subprocess.CalledProcessError):
        return None
    import array

    samples = array.array("f")
    samples.frombytes(out[: len(out) // 4 * 4])
    return samples


def compare_encoded_audio(a, b):
    """None when two lossy clips decode to the same sound: the same length and an SNR of AUDIO_SNR_DB or better."""
    pa, pb = decode_pcm(a), decode_pcm(b)
    if pa is None or pb is None:
        return "ffmpeg could not decode them, and the bytes differ"
    if abs(len(pa) - len(pb)) > 960:  # 20 ms
        return f"length {len(pa) / 48000:.3f}s -> {len(pb) / 48000:.3f}s"
    signal = sum(x * x for x in pa) or 1e-12
    noise = sum((x - y) * (x - y) for x, y in zip(pa, pb, strict=False))
    if noise == 0:
        return None
    snr = 10 * math.log10(signal / noise)
    return None if snr >= AUDIO_SNR_DB else f"decoded PCM differs: SNR {snr:.1f} dB (bound {AUDIO_SNR_DB})"


# -- GLB ------------------------------------------------------------------------------------------

COMPONENTS = {
    5120: ("b", 1, 127.0),
    5121: ("B", 1, 255.0),
    5122: ("h", 2, 32767.0),
    5123: ("H", 2, 65535.0),
    5125: ("I", 4, None),
}
COMPONENTS[5126] = ("f", 4, None)
WIDTHS = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT2": 4, "MAT3": 9, "MAT4": 16}


def read_glb_bytes(data, path=""):
    """(gltf, binary chunk, directory for external URIs) of a .glb, or of a .gltf."""
    if data[:4] != b"glTF":
        return json.loads(data), b"", os.path.dirname(path)
    json_len = struct.unpack_from("<I", data, 12)[0]
    gltf = json.loads(data[20 : 20 + json_len])
    rest = data[20 + json_len :]
    binary = b""
    if len(rest) >= 8 and rest[4:8] == b"BIN\0":
        binary = rest[8 : 8 + struct.unpack_from("<I", rest, 0)[0]]
    return gltf, binary, os.path.dirname(path)


class Glb:
    def __init__(self, data, path=""):
        self.gltf, self.bin, self.dir = read_glb_bytes(data, path)
        self.buffers = {}
        # Primitives often share accessors (a shell's materials index one vertex buffer), so each is read once.
        self.accessors = {}
        self.arrays = {}
        self.stores = {}

    def buffer(self, i):
        if i not in self.buffers:
            b = self.gltf["buffers"][i]
            uri = b.get("uri")
            if uri is None:
                self.buffers[i] = self.bin
            elif uri.startswith("data:"):
                import base64

                self.buffers[i] = base64.b64decode(uri.split(",", 1)[1])
            else:
                self.buffers[i] = read_bytes(os.path.join(self.dir, uri))
        return self.buffers[i]

    def view(self, i):
        v = self.gltf["bufferViews"][i]
        off = v.get("byteOffset", 0)
        return memoryview(self.buffer(v.get("buffer", 0)))[off : off + v["byteLength"]], v.get("byteStride")

    def accessor(self, i):
        """The accessor's elements as tuples, normalised integers as floats."""
        if i not in self.accessors:
            self.accessors[i] = self._read_accessor(i)
        return self.accessors[i]

    def _read_accessor(self, i):
        a = self.gltf["accessors"][i]
        width = WIDTHS[a["type"]]
        code, size, norm = COMPONENTS[a["componentType"]]
        count = a["count"]
        if "bufferView" in a:
            data, stride = self.view(a["bufferView"])
            stride = stride or width * size
            layout = struct.Struct("<" + code * width + "x" * (stride - width * size))
            off = a.get("byteOffset", 0)
            chunk = bytes(data[off : off + stride * count])
            chunk += b"\0" * (stride * count - len(chunk))
            values = list(layout.iter_unpack(chunk))
        else:
            values = [(0,) * width] * count
        sparse = a.get("sparse")
        if sparse:
            idx = self._raw(sparse["indices"], 1, sparse["count"])
            val = self._raw(sparse["values"], width, sparse["count"], code, size)
            for (k,), v in zip(idx, val, strict=True):
                values[k] = v
        if a.get("normalized") and norm:
            values = [tuple(max(x / norm, -1.0) for x in v) for v in values]
        return values

    def array(self, i):
        """(flat array of the accessor's components, width, normalisation divisor or None), read once per accessor."""
        if i not in self.arrays:
            a = self.gltf["accessors"][i]
            width = WIDTHS[a["type"]]
            code, size, norm = COMPONENTS[a["componentType"]]
            count = a["count"]
            out = array(code)
            if "bufferView" in a:
                data, stride = self.view(a["bufferView"])
                off = a.get("byteOffset", 0)
                if not stride or stride == width * size:
                    chunk = bytes(data[off : off + width * size * count])
                    out.frombytes(chunk + b"\0" * (width * size * count - len(chunk)))
                    if sys.byteorder != "little":
                        out.byteswap()
                else:
                    layout = struct.Struct("<" + code * width + "x" * (stride - width * size))
                    chunk = bytes(data[off : off + stride * count])
                    chunk += b"\0" * (stride * count - len(chunk))
                    for v in layout.iter_unpack(chunk):
                        out.extend(v)
            else:
                out.extend([0] * (width * count))
            sparse = a.get("sparse")
            if sparse:
                idx = self._raw(sparse["indices"], 1, sparse["count"])
                val = self._raw(sparse["values"], width, sparse["count"], code, size)
                for (k,), v in zip(idx, val, strict=True):
                    out[k * width : (k + 1) * width] = array(code, v)
            self.arrays[i] = (out, width, norm if a.get("normalized") and norm else None)
        return self.arrays[i]

    def _raw(self, ref, width, count, code=None, size=None):
        if code is None:
            code, size, _ = COMPONENTS[ref["componentType"]]
        data, _ = self.view(ref["bufferView"])
        off = ref.get("byteOffset", 0)
        return list(struct.iter_unpack("<" + code * width, bytes(data[off : off + width * size * count])))

    def image(self, i):
        img = self.gltf["images"][i]
        if "bufferView" in img:
            data = bytes(self.view(img["bufferView"])[0])
        elif img.get("uri", "").startswith("data:"):
            import base64

            data = base64.b64decode(img["uri"].split(",", 1)[1])
        elif img.get("uri"):
            path = os.path.join(self.dir, img["uri"])
            data = read_bytes(path) if os.path.exists(path) else img["uri"].encode()
        else:
            data = b""
        return ImageRef(data, img.get("name") or img.get("uri") or f"image{i}")


def _mat_mul(a, b):
    """Column-major 4x4."""
    return [sum(a[k * 4 + r] * b[c * 4 + k] for k in range(4)) for c in range(4) for r in range(4)]


def _local_matrix(node):
    if "matrix" in node:
        return [float(x) for x in node["matrix"]]
    tx, ty, tz = node.get("translation", (0.0, 0.0, 0.0))
    x, y, z, w = node.get("rotation", (0.0, 0.0, 0.0, 1.0))
    sx, sy, sz = node.get("scale", (1.0, 1.0, 1.0))
    r = [
        1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w),
        2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w),
        2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y),
    ]  # fmt: skip
    return [r[0] * sx, r[1] * sx, r[2] * sx, 0.0, r[3] * sy, r[4] * sy, r[5] * sy, 0.0, r[6] * sz, r[7] * sz, r[8] * sz, 0.0,
            tx, ty, tz, 1.0]  # fmt: skip


IDENTITY = [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0]


def _normal_matrix(m):
    """The inverse transpose of the upper 3x3, row-major, for normals."""
    a, b, c = m[0], m[4], m[8]
    d, e, f = m[1], m[5], m[9]
    g, h, i = m[2], m[6], m[10]
    det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)
    if abs(det) < 1e-12:
        return None
    inv = [(e * i - f * h), -(d * i - f * g), (d * h - e * g),
           -(b * i - c * h), (a * i - c * g), -(a * h - b * g),
           (b * f - c * e), -(a * f - c * d), (a * e - b * d)]  # fmt: skip
    return [x / det for x in inv]


# Per attribute: its tolerance, and whether it is a direction to carry into world space.
ATTRIBUTE_TOLS = {"POSITION": TOL_M, "NORMAL": TOL_UNIT, "TANGENT": TOL_UNIT, "COLOR": TOL_UNIT, "TEXCOORD": TOL_UV}
SKIN_SLOTS = 8


def _attribute_tol(name, component_type):
    base = name.split("_")[0] if not name.startswith("_") else name
    if base in ATTRIBUTE_TOLS:
        return ATTRIBUTE_TOLS[base]
    return 0 if component_type != 5126 else TOL_UV


def flatten_glb(data, path=""):
    """A GLB as records: materials, primitives as world-space triangle sets, nodes, skins, animations."""
    glb = Glb(data, path)
    gltf = glb.gltf
    nodes = gltf.get("nodes") or []
    meshes = gltf.get("meshes") or []
    materials = gltf.get("materials") or []
    names = [n.get("name") or "" for n in nodes]
    parent = {}
    for i, n in enumerate(nodes):
        for ch in n.get("children") or []:
            parent[ch] = i
    world = {}

    def world_of(i):
        if i not in world:
            local = _local_matrix(nodes[i])
            world[i] = _mat_mul(world_of(parent[i]), local) if i in parent else local
        return world[i]

    images = {}

    def texture(info):
        rec = {k: v for k, v in info.items() if k != "index"}
        tex = (gltf.get("textures") or [])[info["index"]]
        src = tex.get("source")
        if src is not None:
            if src not in images:
                images[src] = glb.image(src)
            rec["image"] = images[src]
            rec["imageName"] = images[src].name
        if tex.get("sampler") is not None:
            rec["sampler"] = (gltf.get("samplers") or [])[tex["sampler"]]
        for k, v in tex.items():
            if k not in ("source", "sampler"):
                rec[f"texture.{k}"] = v
        return rec

    def material_record(m):
        def walk(v, key=""):
            if isinstance(v, dict):
                if key.endswith("Texture") and "index" in v:
                    return texture(v)
                return {k: walk(x, k) for k, x in v.items()}
            if isinstance(v, list):
                return [walk(x) for x in v]
            return v

        return walk(m)

    records = {"materials": [material_record(m) for m in materials]}

    def group_of(i):
        """A mode-only part's node counts as the group it was split from (docs/cod/reference.md#game-mode-objects)."""
        extras = nodes[i].get("extras")
        if isinstance(extras, dict) and "part" in extras:
            return extras.get("group") or names[i]
        return names[i]

    # One triangle set per (node, material, mode): whatever primitives and buffers carry them.
    prims = {}
    for i, n in enumerate(nodes):
        if n.get("mesh") is None:
            continue
        mesh = meshes[n["mesh"]]
        matrix = world_of(i)
        skin = (gltf.get("skins") or [])[n["skin"]] if n.get("skin") is not None else None
        brushes = _brush_ranges(n)
        for p in mesh.get("primitives") or []:
            mat = p.get("material")
            mat_name = (materials[mat].get("name") or f"material{mat}") if mat is not None else "<none>"
            key = f"{group_of(i) or mesh.get('name') or '<unnamed>'} | {mat_name} | mode {p.get('mode', 4)}"
            store, tris, labels = _primitive_triangles(glb, p, matrix, skin, names, brushes)
            have = prims.get(key)
            if have is None:
                prims[key] = TriangleSet(store, tris, labels)
            elif have.names == store.names:
                have.add(store, tris, labels)
            else:
                prims[key + f" | {'+'.join(store.names)}"] = TriangleSet(store, tris, labels)
    records["primitives"] = prims

    node_records = []
    for i, n in enumerate(nodes):
        rec = {"name": names[i], "parent": names[parent[i]] if i in parent else None, "world": world_of(i)}
        if n.get("mesh") is not None:
            rec["mesh"] = meshes[n["mesh"]].get("name") or True
            rec["meshExtras"] = meshes[n["mesh"]].get("extras")
        if n.get("skin") is not None:
            rec["skin"] = (gltf["skins"][n["skin"]].get("name")) or True
        for k in ("extras", "extensions", "camera"):
            if k in n:
                rec[k] = dict(n[k]) if isinstance(n[k], dict) else n[k]
        if isinstance(rec.get("extras"), dict):
            rec["extras"].pop("brushStarts", None)  # dereferenced into each triangle (_brush_ranges)
        node_records.append(rec)
    records["nodes"] = _fold_parts(node_records, [group_of(i) for i in range(len(nodes))])

    skins = []
    for s in gltf.get("skins") or []:
        ibm = glb.accessor(s["inverseBindMatrices"]) if s.get("inverseBindMatrices") is not None else None
        joints = {names[j]: (list(ibm[k]) if ibm and k < len(ibm) else None) for k, j in enumerate(s["joints"])}
        skins.append({"name": s.get("name"), "skeleton": names[s["skeleton"]] if s.get("skeleton") is not None else None,
                      "joints": joints})  # fmt: skip
    records["skins"] = skins

    anims = []
    for a in gltf.get("animations") or []:
        channels = {}
        for ch in a.get("channels") or []:
            target = ch.get("target") or {}
            sampler = a["samplers"][ch["sampler"]]
            label = f"{names[target['node']] if target.get('node') is not None else '?'}:{target.get('path')}"
            times = [t[0] for t in glb.accessor(sampler["input"])]
            values = glb.accessor(sampler["output"])
            channels[label] = Curve(times, values, sampler.get("interpolation", "LINEAR"), target.get("path"))
        anims.append({"name": a.get("name"), "channels": channels, "extras": a.get("extras")})
    records["animations"] = anims

    records["scenes"] = []
    for s in gltf.get("scenes") or []:
        extras = dict(s["extras"]) if isinstance(s.get("extras"), dict) else s.get("extras")
        if isinstance(extras, dict) and "parts" in extras:
            records.setdefault("parts", []).extend(extras.pop("parts"))
        roots = sorted({group_of(r) for r in s.get("nodes") or []})
        records["scenes"].append({"name": s.get("name"), "roots": roots, "extras": extras or None})
    records["asset"] = {k: v for k, v in (gltf.get("asset") or {}).items() if k != "generator"}
    for k in ("extras", "extensionsUsed", "extensionsRequired"):
        if k in gltf:
            records[k] = gltf[k]
    used = set(images)
    records["unreferencedImages"] = [glb.image(i) for i in range(len(gltf.get("images") or [])) if i not in used]
    return records


# What a part's node says about itself (and the group it folds into) rather than about its triangles.
PART_ONLY_EXTRAS = ("part", "entity", "group")


def _fold_parts(records, groups):
    """Node records with each mode-only part's folded into the group it was split from.

    Counts add, per-brush lists join, a `materials` list stays a sorted set, and
    the rest is the group's own. So a triangle moved into a part is not a loss,
    and what only a part says (`part`, `entity`) is not compared at all.
    """
    out, by_name, parts = [], {}, []
    for rec, group in zip(records, groups, strict=True):
        extras = rec.get("extras")
        if isinstance(extras, dict) and "part" in extras:
            parts.append((rec, group))
        else:
            out.append(rec)
            by_name[rec["name"]] = rec
    for rec, group in parts:
        base = by_name.get(group)
        if base is None:
            # A collision group all of whose triangles are parts: its own node says `group` too.
            extras = {k: v for k, v in rec["extras"].items() if k not in ("part", "entity")}
            base = by_name[group] = {**rec, "name": group, "mesh": group, "extras": extras}
            out.append(base)
            continue
        extras = {k: v for k, v in rec["extras"].items() if k not in PART_ONLY_EXTRAS}
        if not extras:
            continue
        merged = base["extras"] = dict(base.get("extras") or {})
        for k, v in extras.items():
            have = merged.get(k)
            if k not in merged:
                merged[k] = v
            elif isinstance(v, (int, float)) and not isinstance(v, bool):
                merged[k] = have + v
            elif k == "materials":
                merged[k] = sorted(set(have) | set(v))
            elif k == "brushMaterials":
                merged[k] = have + v
    return out


def _brush_ranges(node):
    """(starts, materials) where a collision group's extras split its triangles into brushes, else None."""
    extras = node.get("extras") or {}
    starts, mats = extras.get("brushStarts"), extras.get("brushMaterials")
    if isinstance(starts, list) and isinstance(mats, list) and len(starts) == len(mats):
        return starts, mats
    return None


def _vertex_store(glb, attrs, matrix, skin, node_names):
    """A VertexStore over one set of attribute accessors, positions and directions carried into world space."""
    acc = glb.gltf["accessors"]
    names, tols, columns = ["x", "y", "z"], [TOL_M] * 3, []
    identity = matrix == IDENTITY
    m, nmat, upper = matrix, (None if identity else _normal_matrix(matrix)), _upper(matrix)
    count = acc[attrs["POSITION"]]["count"] if "POSITION" in attrs else 0

    def position(v):
        x, y, z = v
        return (
            m[0] * x + m[4] * y + m[8] * z + m[12],
            m[1] * x + m[5] * y + m[9] * z + m[13],
            m[2] * x + m[6] * y + m[10] * z + m[14],
        )

    if "POSITION" in attrs:
        arr, width, norm = glb.array(attrs["POSITION"])
        columns.append((arr, width, norm, None if identity else position))
    for name in sorted(attrs):
        if name == "POSITION" or name.startswith(("JOINTS_", "WEIGHTS_")):
            continue
        arr, width, norm = glb.array(attrs[name])
        op = None
        if not identity and name == "NORMAL" and nmat is not None:
            op = lambda v, r=nmat: _transform_dir(r, v)  # noqa: E731
        elif not identity and name == "TANGENT":
            op = lambda v, r=upper: _transform_dir(r, v)  # noqa: E731
        columns.append((arr, width, norm, op))
        names += [f"{name}.{k}" for k in range(width)]
        tols += [_attribute_tol(name, acc[attrs[name]]["componentType"])] * width
    skin_sets = []
    if skin is not None and "JOINTS_0" in attrs:
        joint_hashes = [name_hash(node_names[j]) for j in skin["joints"]]
        for s in range(4):
            if f"JOINTS_{s}" not in attrs:
                break
            skin_sets.append((glb.array(attrs[f"JOINTS_{s}"]), glb.array(attrs[f"WEIGHTS_{s}"])))
        for k in range(SKIN_SLOTS):
            names += [f"joint{k}", f"weight{k}"]
            tols += [0, TOL_UNIT]

    def vertex(i):
        out = []
        for arr, width, norm, op in columns:
            v = arr[i * width : (i + 1) * width]
            if norm:
                v = [max(x / norm, -1.0) for x in v]
            out.extend(op(v) if op else v)
        if skin_sets:
            pairs = []
            for (js, jw, _), (ws, ww, wn) in skin_sets:
                for j, w in zip(js[i * jw : (i + 1) * jw], ws[i * ww : (i + 1) * ww], strict=True):
                    w = max(w / wn, 0.0) if wn else w
                    if w > 0:
                        pairs.append((joint_hashes[j] if j < len(joint_hashes) else -1, w))
            pairs = sorted(pairs)[:SKIN_SLOTS]
            pairs += [(0, 0.0)] * (SKIN_SLOTS - len(pairs))
            out.extend(x for pair in pairs for x in pair)
        return tuple(out)

    return VertexStore(names, tols, count, vertex)


def _primitive_triangles(glb, prim, matrix, skin, node_names, brushes):
    """(vertex store, flat vertex indices three a triangle, per-triangle labels or None) of one primitive."""
    attrs = prim.get("attributes") or {}
    key = (tuple(sorted(attrs.items())), tuple(matrix), id(skin))
    if key not in glb.stores:
        glb.stores[key] = _vertex_store(glb, attrs, matrix, skin, node_names)
    store = glb.stores[key]
    if prim.get("indices") is not None:
        index = glb.array(prim["indices"])[0]
    else:
        index = array("I", range(store.count))
    mode = prim.get("mode", 4)
    if mode == 4:
        tris = index if len(index) % 3 == 0 else index[: len(index) - len(index) % 3]
    elif mode == 5:
        tris = array("I")
        for k in range(len(index) - 2):
            tris.extend((index[k], index[k + 1], index[k + 2]) if k % 2 == 0 else (index[k + 1], index[k], index[k + 2]))
    elif mode == 6:
        tris = array("I")
        for k in range(1, len(index) - 1):
            tris.extend((index[0], index[k], index[k + 1]))
    else:  # points and lines: each element as a degenerate triangle, so they are still compared
        tris = array("I")
        for k in range(0, len(index), 1 if mode == 0 else 2):
            tris.extend((index[k], index[min(k + 1, len(index) - 1)], index[k]))
    labels = None
    if brushes:
        # Each triangle carries its brush's materials, so the brush ranges need no triangle order.
        starts, mats = brushes
        hashes = [name_hash(m) for m in mats]
        labels = array("q")
        for t in range(len(tris) // 3):
            k = bisect.bisect_right(starts, t) - 1
            labels.append(hashes[k] if k >= 0 else 0)
    return store, tris, labels


def _upper(m):
    return [m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]]


def _transform_dir(r, v):
    x, y, z = v[0], v[1], v[2]
    out = [r[0] * x + r[1] * y + r[2] * z, r[3] * x + r[4] * y + r[5] * z, r[6] * x + r[7] * y + r[8] * z]
    length = math.sqrt(sum(c * c for c in out)) or 1.0
    return tuple([c / length for c in out] + list(v[3:]))


class Curve(Special):
    """One animation channel: equal when both sample to the same values at every key time either has."""

    def __init__(self, times, values, interpolation, path):
        self.times, self.interp, self.path = list(times), interpolation, path
        self.values = [self._norm(v) for v in values]

    def _norm(self, v):
        v = tuple(float(x) for x in v)
        if self.path == "rotation" and len(v) == 4 and (v[3] < 0 or (v[3] == 0 and v[:3] < (0.0, 0.0, 0.0))):
            v = tuple(-x for x in v)
        return v

    def canon(self):
        return (
            "curve",
            self.interp,
            tuple(round(t, 4) for t in self.times),
            tuple(tuple(round(x, 4) for x in v) for v in self.values),
        )

    def sample(self, t):
        times, values = self.times, self.values
        if not times:
            return ()
        if self.interp == "CUBICSPLINE":
            values = values[1::3]
        k = bisect.bisect_right(times, t)
        if k == 0:
            return values[0]
        if k >= len(times):
            return values[-1]
        t0, t1 = times[k - 1], times[k]
        if self.interp == "STEP" or t1 <= t0:
            return values[k - 1]
        f = (t - t0) / (t1 - t0)
        a, b = values[k - 1], values[k]
        if self.path == "rotation" and sum(x * y for x, y in zip(a, b, strict=True)) < 0:
            b = tuple(-x for x in b)
        return tuple(x + (y - x) * f for x, y in zip(a, b, strict=True))

    def diff(self, other, where, emit):
        if self.canon() == other.canon():
            return
        tol = TOL_UNIT if self.path in ("rotation", "weights") else TOL_M
        for t in sorted(set(self.times) | set(other.times)):
            a, b = self.sample(t), other.sample(t)
            if self.path == "rotation" and len(a) == 4 and len(b) == 4:
                dot = abs(sum(x * y for x, y in zip(a, b, strict=True)))
                ok = dot >= 1 - tol
            else:
                ok = len(a) == len(b) and all(abs(x - y) <= tol for x, y in zip(a, b, strict=True))
            if not ok:
                emit(DIFFERS, where, f"at t={t:.4f}: {tuple(round(x, 5) for x in a)} -> {tuple(round(x, 5) for x in b)}")
                return


GLB_RULES = Rules(
    ordered=("*.world", "skins[].joints.*"),
    # A bone 6000 units out is float32 to about 5e-4, so its children's world
    # translations are too, whichever component carries the small value; and so is
    # an inverse bind matrix's translation, -R^T t cancelling to a small component.
    scaled=("nodes[].world", "skins[].joints.*"),
    keys={"materials[]": ("name",), "nodes[]": ("name",), "skins[]": ("name", "skeleton"), "animations[]": ("name",)},
    ignore=("asset.generator",),
)


# -- The .world DSL -----------------------------------------------------------------------------------

UNIT_TO_BASE = {"mm": 0.001, "cm": 0.01, "m": 1.0, "ft": 0.3048, "in": 0.0254, "deg": 1.0, "rad": 180.0 / math.pi}
_TOKEN = re.compile(
    r"""(?P<ws>[ \t\r\n]+)
      | (?P<comment>//[^\n]*)
      | (?P<str>"(?:[^"\\\n]|\\.)*"?)
      | (?P<color>\#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?=[\s,}]|$))
      | (?P<hash>\#[^\n]*)
      | (?P<num>-?\d+(?:\.\d+)?)(?P<unit>(?:mm|cm|ft|in|deg|rad|m)(?![A-Za-z0-9_-]))?
      | (?P<ident>[A-Za-z_][A-Za-z0-9_-]*)
      | (?P<punct>[{}:,.])
      | (?P<bad>.)""",
    re.X,
)
BOOL_WORDS = {"true": True, "on": True, "false": False, "off": False}
# Nodes whose names are positions in a list rather than names (`mantle m12`,
# `trigger t<entity index>`, `sound <alias>_3`); what they are is in their properties.
POSITIONAL_NAMES = ("mantle", "ladder", "trigger", "effect", "sound")
# Properties that are angles, compared to TOL_DEG.
ANGLE_PROPS = ("rotate", "yaw", "pitch", "roll", "angle", "fov", "cone", "inner", "outer")
# What a record of each type is paired by when it differs.
DISCRIMINATORS = ("asset", "source", "alias", "fx", "tag", "mode", "team", "kind", "type", "catalog")


class Num(Special):
    """A world-file number: its value in base units and how many decimals it was printed with."""

    def __init__(self, value, decimals, angle):
        self.value, self.decimals, self.angle = value, decimals, angle

    def canon(self):
        return round(self.value, 3) + 0.0

    def tol(self, other):
        tol = TOL_DEG if self.angle else TOL_M
        if self.decimals == other.decimals and self.decimals > 0:
            tol = max(tol, 10.0**-self.decimals * 1.0001)  # one unit in the last printed place
        return tol

    def diff(self, other, where, emit):
        if abs(self.value - other.value) > self.tol(other):
            emit(DIFFERS, where, f"{self.value:g} -> {other.value:g}")

    def __repr__(self):
        return f"{self.value:g}"


def tokenize_world(text):
    """[(kind, value, line)]; kinds: str, num, color, ident, and the punctuation itself."""
    out, line = [], 1
    for m in _TOKEN.finditer(text):
        kind = m.lastgroup if m.lastgroup != "unit" else "num"
        s = m.group(0)
        if kind == "num":
            num = m.group("num")
            unit = m.group("unit")
            decimals = len(num.split(".")[1]) if "." in num else 0
            out.append(
                ("num", (float(num) * UNIT_TO_BASE.get(unit, 1.0), decimals if not unit or unit in ("m", "deg") else 6), line)
            )
        elif kind == "str":
            body = s[1:-1] if s.endswith('"') and len(s) > 1 else s[1:]
            out.append(("str", re.sub(r"\\(.)", lambda e: {"n": "\n", "t": "\t"}.get(e.group(1), e.group(1)), body), line))
        elif kind == "color":
            out.append(("color", s.lower(), line))
        elif kind == "ident":
            out.append(("ident", s, line))
        elif kind == "punct":
            out.append((s, s, line))
        elif kind == "bad":
            out.append(("bad", s, line))
        line += s.count("\n")
    return out


def parse_world(text):
    """A .world file as flat records: {type, name, ctx, props} per node, one per include and top-level property."""
    toks = tokenize_world(text)
    pos = 0
    records = []

    def peek(k=0):
        return toks[pos + k] if pos + k < len(toks) else ("eof", None, -1)

    def value(prop):
        nonlocal pos
        kind, v, _ = toks[pos]
        pos += 1
        if kind == "num":
            return Num(v[0], v[1], prop in ANGLE_PROPS)
        if kind == "ident":
            if v in BOOL_WORDS:
                return BOOL_WORDS[v]
            path = [v]
            while peek()[0] == "." and peek(1)[0] == "ident":
                path.append(peek(1)[1])
                pos += 2
            return "ref:" + ".".join(path)
        return v

    def statements(ctx, into):
        nonlocal pos
        while pos < len(toks):
            kind, v, line = peek()
            if kind == ",":
                pos += 1
                continue
            if kind == "}":
                return
            if kind != "ident":
                pos += 1
                continue
            if v == "include" and peek(1)[0] == "str":
                records.append({"type": "include", "ctx": ctx, "path": peek(1)[1]})
                pos += 2
            elif peek(1)[0] == ":":
                pos += 2
                vals = []
                if peek()[0] in ("num", "str", "color", "ident"):
                    first_line = peek()[2]
                    vals.append(value(v))
                    while peek()[0] in ("num", "str", "color", "ident") and peek()[2] == first_line:
                        vals.append(value(v))
                into.setdefault(v, []).append(vals)
            else:
                pos += 1
                name = None
                if peek()[0] == "ident" and peek()[2] == line:
                    name = peek()[1]
                    pos += 1
                props = {}
                rec = {"type": v, "name": None if v in POSITIONAL_NAMES else name, "ctx": ctx, "props": props}
                records.append(rec)
                if peek()[0] == "{":
                    pos += 1
                    statements(ctx + (f"{v} {name}" if name else v,), props)
                    if peek()[0] == "}":
                        pos += 1

    top = {}
    statements((), top)
    for key, vals in top.items():
        records.append({"type": "property", "name": key, "ctx": (), "props": {key: vals}})
    for r in records:
        if "props" in r:
            r["props"] = {k: (v[0] if len(v) == 1 else v) for k, v in r["props"].items()}
            r["ctx"] = " / ".join(r["ctx"])
    return records


def world_label(rec):
    props = rec.get("props") or {}
    parts = [rec["type"]]
    if rec.get("name"):
        parts.append(rec["name"])
    else:
        for d in DISCRIMINATORS:
            if d in props:
                parts.append(f"{d}={short(repr(props[d]), 60)}")
                break
    if rec.get("path"):
        parts.append(repr(rec["path"]))
    if rec.get("ctx"):
        parts.append(f"in {rec['ctx']}")
    return " ".join(parts)


# A property's values are a sequence (`at: x y z`), never a set.
WORLD_RULES = Rules(ordered=("*",))


class WorldRecords(Special):
    """A .world file's records as a multiset; pairs leftovers by type, name and discriminator, nearest first."""

    def __init__(self, records):
        self.records = records

    def canon(self):
        return ("world", len(self.records))

    def diff(self, other, where, emit):
        rules = WORLD_RULES
        gk = Counter()
        by_key = defaultdict(list)
        for r in self.records:
            k = canon(r, "", rules)
            gk[k] += 1
            by_key[k].append(r)
        ck = Counter(canon(r, "", rules) for r in other.records)
        cby = defaultdict(list)
        for r in other.records:
            cby[canon(r, "", rules)].append(r)
        left_g = [r for k, n in (gk - ck).items() for r in by_key[k][:n]]
        left_c = [r for k, n in (ck - gk).items() for r in cby[k][:n]]
        groups = defaultdict(lambda: ([], []))
        for r in left_g:
            groups[world_label(r)][0].append(r)
        for r in left_c:
            groups[world_label(r)][1].append(r)
        for label, (gs, cs) in sorted(groups.items()):
            if gs and cs and len(gs) * len(cs) <= MAX_PAIRING:
                rest = []
                for r in gs:
                    j = next((j for j, s in enumerate(cs) if equal(r, s, "", rules)), None)
                    if j is None:
                        rest.append(r)
                    else:
                        cs.pop(j)
                gs = rest
            pairs = _nearest_pairs(gs, cs) if gs and cs and len(gs) * len(cs) <= MAX_PAIRING else []
            paired_g = {id(a) for a, _ in pairs}
            paired_c = {id(b) for _, b in pairs}
            for a, b in pairs:
                diff(a.get("props"), b.get("props"), f"{where}{label}{_at(a)}", "", rules, emit)
            for r in gs:
                if id(r) not in paired_g:
                    emit(MISSING, f"{where}{label}", _props_text(r))
            for r in cs:
                if id(r) not in paired_c:
                    emit(EXTRA, f"{where}{label}", _props_text(r))


def _at(rec):
    at = (rec.get("props") or {}).get("at")
    return " at " + " ".join(repr(x) for x in at) if isinstance(at, list) else ""


def _position(rec):
    at = (rec.get("props") or {}).get("at")
    if isinstance(at, list) and all(isinstance(x, Num) for x in at):
        return [x.value for x in at]
    return None


def _nearest_pairs(gs, cs):
    """Pair each golden record with the nearest unpaired candidate by `at`, in order."""
    pairs, free = [], list(cs)
    for r in gs:
        if not free:
            break
        p = _position(r)

        def dist(s, p=p):
            q = _position(s)
            return sum((x - y) ** 2 for x, y in zip(p, q, strict=False)) if p and q else 0.0

        best = min(free, key=dist)
        free.remove(best)
        pairs.append((r, best))
    return pairs


def _props_text(rec):
    if rec.get("type") == "include":
        return rec["path"]
    return short(", ".join(f"{k}: {v!r}" for k, v in (rec.get("props") or {}).items()), 140)


# -- export_metadata.json and other JSON ------------------------------------------------------------


def deref_ids(data):
    """export_metadata.json with every entity index replaced by the entity's own label.

    An entity's `id` is its position in the lump; the same entity at another index
    is the same entity, so each `id` (on spawns, game objects, influencers) and each
    list under `targetnames` is rewritten to `classname@origin`, disambiguated by
    the rest of its content where two share one.
    """
    entities = data.get("entities")
    if not isinstance(entities, list):
        return data
    labels, seen = {}, Counter()
    for e in entities:
        base = f"{e.get('classname', '?')}@{e.get('origin', '-')}"
        if e.get("targetname"):
            base += f"#{e['targetname']}"
        seen[base] += 1
    for e in entities:
        base = f"{e.get('classname', '?')}@{e.get('origin', '-')}" + (f"#{e['targetname']}" if e.get("targetname") else "")
        if seen[base] > 1:
            body = {k: v for k, v in e.items() if k != "id"}
            base += "~" + hashlib.sha1(json.dumps(body, sort_keys=True).encode()).hexdigest()[:8]
        if "id" in e:
            labels[e["id"]] = base

    def walk(v, key=""):
        if isinstance(v, dict):
            return {k: (labels.get(x, x) if k == "id" else walk(x, k)) for k, x in v.items()}
        if isinstance(v, list):
            return [walk(x, key) for x in v]
        return v

    out = walk(data)
    if isinstance(out.get("targetnames"), dict):
        out["targetnames"] = {
            k: [labels.get(i, i) for i in v] if isinstance(v, list) else v for k, v in out["targetnames"].items()
        }
    return out


# What each kind of JSON file orders and keys by. A kind is its `_type`, or its file name.
INDEX_SPACES = ("surfaces", "models", "lightmaps", "sortedSurfIndex", "brushes", "materials", "partitions", "aabbTrees",
                "cmodels", "leafs", "nodes", "planes", "brushes[].sides", "lods", "surfs")  # fmt: skip
SEQUENCES = ("*elemDefs", "*elems", "*amples", "*curve*", "*Curve*", "*keys", "*frames", "*points", "*knots")
JSON_RULES = {
    "metadata": Rules(
        keys={
            "entities[]": ("classname", "origin", "targetname"),
            "spawns[]": ("mode", "team", "origin"),
            "fx.placements[]": ("create", "fxid", "soundalias", "origin"),
            "game_objects.*[]": ("classname", "origin"),
            "intermission[]": ("classname", "origin"),
            "spawn_influencers[]": ("classname", "origin"),
        },
        angles=("*angles*", "*yaw*"),
    ),
    "gfxworld": Rules(ordered=INDEX_SPACES, keys={"staticModels[]": ("model", "origin")}),
    "clipmap": Rules(ordered=INDEX_SPACES, keys={"staticModels[]": ("model", "origin"), "dynEnts[][]": ("model", "origin")}),
    "xmodel": Rules(ordered=INDEX_SPACES),
    "material": Rules(
        ordered=("stateBitsEntry", "stateBits"), keys={"textures[]": ("name", "semantic"), "constants[]": ("name",)}
    ),
    "fx": Rules(ordered=SEQUENCES),
    "effects": Rules(ordered=SEQUENCES),
    "sound_alias": Rules(keys={"entries[]": ("aliasName", "sequence", "soundFile")}),
    "sounds": Rules(),
}


def json_kind(data, rel):
    base = os.path.basename(rel)
    if base == "export_metadata.json":
        return "metadata"
    if base == "effects.json":
        return "effects"
    if base == "sounds.json":
        return "sounds"
    if isinstance(data, dict) and isinstance(data.get("_type"), str):
        return data["_type"]
    return None


# -- Dump files --------------------------------------------------------------------------------------

GFX_VERTEX = struct.Struct("<3fI4B2f2fII")


def gfxworld_records(manifest, base):
    """A GfxWorld manifest with each surface's offsets into the two blobs replaced by its triangles.

    Surfaces stay in order (brush models and the draw lists name them by index);
    within a surface the triangles are a multiset of decoded vertices, so a blob
    laid out differently holds the same world.
    """
    data = dict(manifest)
    verts = _sibling(base, manifest.get("vertexFile"))
    idx = _sibling(base, manifest.get("indexFile"))
    if verts is None or idx is None:
        return data
    stride = manifest.get("vertexStride", 44)
    if stride != GFX_VERTEX.size:
        return data
    names = ("x", "y", "z", "unknown0", "r", "g", "b", "a", "u", "v", "lu", "lv", "normal", "unknown1")
    tols = (1e-3, 1e-3, 1e-3, 0, 0, 0, 0, 0, TOL_UV, TOL_UV, TOL_UV, TOL_UV, 0, 0)
    store = VertexStore(names, tols, len(verts) // stride, lambda i: GFX_VERTEX.unpack_from(verts, i * stride))
    indices = array("H")
    indices.frombytes(idx[: len(idx) // 2 * 2])
    if sys.byteorder != "little":
        indices.byteswap()
    surfaces = []
    for s in manifest.get("surfaces") or []:
        rec = {k: v for k, v in s.items() if k not in ("baseIndex", "firstVertex")}
        base_index, first = s.get("baseIndex", 0), s.get("firstVertex", 0)
        tris = array("I", (i + first for i in indices[base_index : base_index + s.get("triCount", 0) * 3]))
        if len(tris) % 3 or (tris and max(tris) >= store.count):
            rec["outOfRange"] = True
            tris = array("I")
        rec["triangles"] = TriangleSet(store, tris)
        surfaces.append(rec)
    data["surfaces"] = surfaces
    for k in ("vertexFile", "indexFile"):
        data.pop(k, None)
    return data


def edge_walkable_size(tri_count):
    """Bytes of `triEdgeIsWalkable`: a bit per triangle edge, in whole 4-byte words.

    OAT's IW4, IW5 and T5 writers take `triCount` bytes instead, so their blob runs on into
    whatever follows it in memory; only these bytes mean anything."""
    return (3 * tri_count + 31) // 32 * 4


def clipmap_records(manifest, base):
    """A clipmap manifest with its soup blobs decoded: triangles as vertex positions, in order, and the index lists."""
    data = dict(manifest)
    verts = _sibling(base, manifest.get("vertFile"))
    tris = _sibling(base, manifest.get("triFile"))
    if verts is not None and tris is not None:
        data["soupTriangles"] = Soup(verts, tris, manifest.get("partitions") or [])
        data.pop("vertFile", None)
        data.pop("triFile", None)
    for key in ("edgeWalkableFile", "uindFile", "uindsFile"):
        blob = _sibling(base, manifest.get(key))
        if blob is not None:
            if key == "edgeWalkableFile" and isinstance(manifest.get("triCount"), int):
                blob = blob[: edge_walkable_size(manifest["triCount"])]
            data[key] = Blob(blob)
    for key, value in manifest.items():
        if key.endswith("File") and isinstance(value, str) and isinstance(data.get(key), str):
            blob = _sibling(base, value)
            if blob is not None:
                data[key] = Blob(blob)
    return data


class Soup(Special):
    """A clipmap's triangle soup, in order (partitions and AABB leaves name triangles by index), as vertex positions.

    Read straight from the two blobs: a triangle's vertex base comes from its
    partition's `firstVertSegment`, as collision.py resolves it.
    """

    def __init__(self, verts, tris, partitions):
        self.verts, self.count = verts, len(tris) // 6
        self.index = array("H")
        self.index.frombytes(tris[: self.count * 6])
        if sys.byteorder != "little":
            self.index.byteswap()
        self.bases = {}
        for part in partitions:
            seg = part.get("firstVertSegment", 0) * 0x10000
            if seg:
                first = part.get("firstTri", 0)
                for t in range(first, min(first + part.get("triCount", 0), self.count)):
                    self.bases[t] = seg

    def triangle(self, t):
        base = self.bases.get(t, 0)
        out = []
        for k in range(3):
            v = self.index[3 * t + k] + base
            out.append(struct.unpack_from("<3f", self.verts, v * 12) if (v + 1) * 12 <= len(self.verts) else None)
        return out

    def canon(self):
        h = hashlib.blake2b(digest_size=16)
        for t in range(self.count):
            h.update(repr([None if v is None else tuple(round(x, 2) for x in v) for v in self.triangle(t)]).encode())
        return ("soup", h.hexdigest())

    def diff(self, other, where, emit, limit=6):
        bad = 0
        for t in range(min(self.count, other.count)):
            a, b = self.triangle(t), other.triangle(t)
            same = all(
                (va is None) == (vb is None) and (va is None or all(abs(x - y) <= 1e-3 for x, y in zip(va, vb, strict=True)))
                for va, vb in zip(a, b, strict=True)
            )
            if not same:
                bad += 1
                if bad <= limit:
                    emit(DIFFERS, f"{where}[{t}]", f"{a} -> {b}")
        if bad > limit:
            emit(DIFFERS, f"{where} {bad - limit} more triangles", "")
        for t in range(other.count, self.count):
            emit(MISSING, f"{where}[{t}]", str(self.triangle(t)))
        for t in range(self.count, other.count):
            emit(EXTRA, f"{where}[{t}]", str(other.triangle(t)))


def _sibling(base, rel):
    if not rel:
        return None
    for path in (os.path.join(base, rel), os.path.join(base, os.path.basename(rel))):
        if os.path.exists(path):
            return read_bytes(path)
    return None


class Blob(Special):
    """Bytes compared exactly: an index list or a bit array whose layout is its meaning."""

    def __init__(self, data):
        self.data = data

    def canon(self):
        return ("blob", hashlib.sha1(self.data).hexdigest())

    def diff(self, other, where, emit):
        if self.data != other.data:
            first = next(
                (i for i, (a, b) in enumerate(zip(self.data, other.data, strict=False)) if a != b),
                min(len(self.data), len(other.data)),
            )
            emit(DIFFERS, where, f"{len(self.data)} -> {len(other.data)} bytes, first difference at byte {first}")


def xanim_record(data, name):
    """A compiled xanim as its decoded clip: header, bone tracks by name, notetracks, and the delta track's bytes."""
    clip = xanim.decode(data, name)
    # `decode` reads the root-motion (delta) track only to step over it; its bytes are compared as they are.
    r = xanim._Reader(data)
    version = r.one("H")
    frames, _, flags, _, _ = r.take("HHBBH")
    looped, delta, delta3d, streamable = xanim._flags(version, flags)
    loop_frames = frames + 1 if looped else frames
    if streamable:
        r.one("f")
    start = r.pos
    if delta or delta3d:
        xanim._skip_delta(r, delta3d, loop_frames, (loop_frames - 1) < 256)
    return {
        "delta": Blob(data[start : r.pos]),
        "frames": clip.frames,
        "fps": clip.fps,
        "looped": clip.looped,
        "assetType": clip.asset_type,
        "rootMotion": clip.has_root_motion,
        "bones": {
            b.name: {
                "rotation": _track(b.rotation),
                "translation": _track(b.translation),
            }
            for b in clip.bones
        },
        "notetracks": [f"{n}@{f}" for n, f in clip.notetracks],
    }


def _track(track):
    if track is None:
        return None
    return {"indices": list(track.indices), "values": [list(v) for v in track.values]}


def parse_ents(text):
    """An entity lump as a list of {key: value} dicts."""
    out, cur = [], None
    for m in re.finditer(r'\{|\}|"((?:[^"\\]|\\.)*)"', text):
        tok = m.group(0)
        if tok == "{":
            cur, key = {}, None
        elif tok == "}":
            if cur is not None:
                out.append(cur)
            cur = None
        elif cur is not None:
            if key is None:
                key = m.group(1)
            else:
                cur.setdefault(key, m.group(1))
                key = None
    return out


INFOSTRING = re.compile(rb"^[A-Z0-9_]+FILE\\")


def parse_infostring(data):
    text = data.decode("latin-1")
    parts = text.split("\\")
    out = {"_type": parts[0]}
    for k in range(1, len(parts) - 1, 2):
        v = parts[k + 1]
        try:
            v = float(v) if re.fullmatch(r"-?\d+\.\d*|-?\d*\.\d+", v) else int(v) if re.fullmatch(r"-?\d+", v) else v
        except ValueError:
            pass
        out[parts[k]] = v
    return out


def text_lines(data):
    return [line.rstrip() for line in data.decode("latin-1").replace("\r\n", "\n").split("\n")]


# -- Files ----------------------------------------------------------------------------------------------

TEXT_EXTS = (".gsc", ".csc", ".vision", ".sun", ".shock", ".accu", ".txt", ".csv", ".cfg", ".str", ".menu", ".xpo", ".atr")


def compare_file(rel, g_path, c_path, emit):
    """Compare one pair of files by type. Returns False when they were not byte-identical."""
    a, b = read_bytes(g_path), read_bytes(c_path)
    if a == b and not (MANIFESTS.search(rel) and not _blobs_identical(a, g_path, c_path)):
        return True
    ext = os.path.splitext(rel)[1].lower()
    try:
        _compare_by_type(rel, ext, a, b, g_path, c_path, emit)
    except Exception as exc:  # a comparator that cannot read a file must say so, not pass it
        emit(DIFFERS, "(file)", f"could not compare ({type(exc).__name__}: {exc}); the bytes differ")
    return False


MANIFESTS = re.compile(r"\.(gfxworld|clipmap)\.json$")


def _blobs_identical(manifest, g_path, c_path):
    """Whether every blob a GfxWorld or clipmap manifest names is byte-identical on both sides."""
    for key, value in json.loads(manifest).items():
        if key.endswith("File") and isinstance(value, str):
            if _sibling(os.path.dirname(g_path), value) != _sibling(os.path.dirname(c_path), value):
                return False
    return True


def _compare_by_type(rel, ext, a, b, g_path, c_path, emit):
    base = os.path.basename(rel)
    if ext == ".world":
        diff(
            WorldRecords(parse_world(a.decode("utf-8"))),
            WorldRecords(parse_world(b.decode("utf-8"))),
            "",
            "",
            DEFAULT_RULES,
            emit,
        )
    elif ext in (".glb", ".gltf"):
        diff(flatten_glb(a, g_path), flatten_glb(b, c_path), "", "", GLB_RULES, emit)
    elif ext == ".json":
        ga, cb = json.loads(a), json.loads(b)
        kind = json_kind(ga, rel)
        if kind == "metadata":
            ga, cb = deref_ids(ga), deref_ids(cb)
        elif kind == "gfxworld":
            ga, cb = gfxworld_records(ga, os.path.dirname(g_path)), gfxworld_records(cb, os.path.dirname(c_path))
        elif kind == "clipmap":
            ga, cb = clipmap_records(ga, os.path.dirname(g_path)), clipmap_records(cb, os.path.dirname(c_path))
        diff(ga, cb, "", "", JSON_RULES.get(kind, DEFAULT_RULES), emit)
    elif ext in IMAGE_EXTS:
        problem = compare_pixels(a, b)
        if problem:
            emit(DIFFERS, "pixels", problem)
    elif ext in (".wav", ".xwma", ".adpcm") or a[:4] == b"RIFF":
        problem = compare_riff(a, b)
        if problem:
            emit(DIFFERS, "audio", problem)
    elif ext in (".webm", ".opus", ".ogg", ".mp3", ".flac"):
        problem = compare_encoded_audio(a, b)
        if problem:
            emit(DIFFERS, "audio", problem)
    elif ext == ".ents":
        diff(
            parse_ents(a.decode("latin-1")), parse_ents(b.decode("latin-1")), "entities", "entities", JSON_RULES["metadata"], emit
        )
    elif ext == ".zone":
        diff([x for x in text_lines(a) if x], [x for x in text_lines(b) if x], "lines", "", DEFAULT_RULES, emit)
    elif ext == "" and INFOSTRING.match(a) and INFOSTRING.match(b):
        diff(parse_infostring(a), parse_infostring(b), "", "", DEFAULT_RULES, emit)
    elif ext == "" and a[:2] in (b"\x11\x00", b"\x12\x00", b"\x13\x00"):
        diff(xanim_record(a, base), xanim_record(b, base), "", "", DEFAULT_RULES, emit)
    elif ext in TEXT_EXTS or _is_text(a):
        la, lb = text_lines(a), text_lines(b)
        if la != lb:
            first = next((i for i, (x, y) in enumerate(zip(la, lb, strict=False)) if x != y), min(len(la), len(lb)))
            emit(DIFFERS, f"line {first + 1}", f"{short(la[first] if first < len(la) else '<end>', 60)} -> "
                 f"{short(lb[first] if first < len(lb) else '<end>', 60)}")  # fmt: skip
    else:
        emit(DIFFERS, "bytes", f"{len(a)} -> {len(b)} bytes, and no decoder for {ext or 'this file'}")


def _is_text(data):
    head = data[:4096]
    return b"\0" not in head and all(c in b"\t\n\r" or 32 <= c < 127 or c >= 128 for c in head)


def file_key(rel):
    """The path a file is paired by: an image by its name without extension, so an .iwi pairs with a .dds."""
    stem, ext = os.path.splitext(rel)
    return stem + ".<image>" if ext.lower() in IMAGE_EXTS else rel


# Blobs a manifest decodes; compared through their manifest, not alone.
MANIFEST_BLOBS = re.compile(
    r"\.(gfxworld_vertices|gfxworld_indices|clipmap_verts|clipmap_tris|clipmap_edgewalkable|clipmap_uinds)\.bin$"
)


def list_tree(root, only=None):
    out = {}
    for dirpath, _, files in os.walk(root):
        for f in files:
            path = os.path.join(dirpath, f)
            rel = os.path.relpath(path, root)
            if only and not any(fnmatch.fnmatch(rel, pat) for pat in only):
                continue
            out.setdefault(file_key(rel), []).append(rel)
    return {k: sorted(v) for k, v in out.items()}


def compare_trees(golden, candidate, report=None, only=None, progress=None):
    """Compare every file under `golden` with its partner under `candidate`."""
    report = report or Report()
    g_files, c_files = list_tree(golden, only), list_tree(candidate, only)
    for key in sorted(g_files):
        rels = g_files[key]
        rel = rels[0]
        if MANIFEST_BLOBS.search(rel) and _has_manifest(golden, rel):
            continue
        if key not in c_files:
            report.add(rel, MISSING, "(file)", "")
            continue
        report.compared += 1
        if progress:
            progress(rel)
        c_rel = c_files[key][0]
        name = rel if rel == c_rel else f"{rel} ~ {c_rel}"
        emit = report.emitter(name)
        if compare_file(rel, os.path.join(golden, rel), os.path.join(candidate, c_rel), emit):
            report.identical += 1
        elif name not in report.files:
            report.equivalent.append(name)
    for key in sorted(set(c_files) - set(g_files)):
        rel = c_files[key][0]
        if MANIFEST_BLOBS.search(rel) and _has_manifest(candidate, rel):
            continue
        report.add(rel, EXTRA, "(file)", "")
    return report


def _has_manifest(root, rel):
    stem = MANIFEST_BLOBS.sub("", rel)
    kind = "gfxworld" if "gfxworld" in rel else "clipmap"
    return os.path.exists(os.path.join(root, f"{stem}.{kind}.json"))


def main(args):
    """`python3 -m scripts.cod equiv worlds|dump <golden> <candidate>`. Returns whether nothing is missing or different."""
    for path in (args.golden, args.candidate):
        if not os.path.isdir(path):
            print(f"  ! {path} is not a directory")
            return False
    progress = (lambda rel: print(f"  .. {rel}", file=sys.stderr)) if args.verbose else None
    report = compare_trees(args.golden, args.candidate, only=args.only, progress=progress)
    report.print(limit=args.limit)
    if args.json:
        with open(args.json, "w", encoding="utf-8", newline="\n") as fh:
            json.dump(report.to_json(), fh, indent=1)
    return not report.failed


def add_arguments(ap):
    ap.add_argument("what", choices=("worlds", "dump"), help="world folders (or a catalogue), or dump trees")
    ap.add_argument("golden", help="the reference tree")
    ap.add_argument("candidate", help="the tree that must hold everything the reference does")
    ap.add_argument("--only", action="append", metavar="GLOB", help="compare only paths matching this glob (repeatable)")
    ap.add_argument("--limit", type=int, default=DEFAULT_LIMIT, help="records named per file and status before summarising")
    ap.add_argument("--json", help="also write every finding to this file")
    ap.add_argument("--verbose", action="store_true", help="name each file as it is compared")
