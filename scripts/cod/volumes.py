"""Brushes as yaw-aligned boxes: the shape shared by `mantle` and `ladder` nodes.

Both are brushes the map marks (by contents or by surface flags) that the engine
tests with plain numbers rather than a BVH, so both come out as a box with a
centre, a size and a yaw. `fit_box` finds the smallest such box around a hull;
`tests/test_mantle.py` asserts that it never cuts the hull short.

A brush's faces are its six axial planes (implicit in its bounds) and then its
`sides`, which hold only the bevels. Each carries a material (IW4/IW5) or flags
(T5); the axial ones are in their own arrays, not in `sides`. What those flags
say is `collision.face_flags`, which the collision export reads as well. See
docs/cod/reference.md#collision.
"""

import collections
import math
import sys

from . import brushmodels
from .collision import FACE_FLAG_GAMES, blocks_player, brush_planes, face_polygon
from .units import to_engine, vec3

#: Yaw candidates are scanned this finely, in degrees, on top of the hull's own
#: face normals. A quarter degree is well under the 0.1 mm weld the rest of the
#: pipeline works to, at any volume's size.
YAW_STEP = 0.25

#: One face of a hull: its index into `brush_planes`, its outward normal (CoD
#: axes, placed) and its polygon (engine space, placed).
Face = collections.namedtuple("Face", "plane normal polygon")

_WRITER_GAP = "The backend's clipmap writer must write it (docs/cod/pipeline.md#the-dump-tree)."


def require_axial_faces(clip):
    """Refuse a clipmap dump that does not say what a brush's axial faces are.

    Run before any work: without them more than half of all ladder faces, and
    the kind of most all-axial mantles, silently go missing.
    """
    key = "axialSurfaceFlags" if clip.get("_game") in FACE_FLAG_GAMES else "axialMaterialNum"
    if any(key not in brush for brush in clip.get("brushes", ()) if brush.get("bounds")):
        sys.exit(f"the clipmap dump has brushes without `{key}`, so their axial faces are unknown. {_WRITER_GAP}")


def brush_owners(clip):
    """{brush index: N} for every brush a brush model N >= 1 owns."""
    out = {}
    for n, model in enumerate(clip.get("cmodels", [])):
        if n:
            out.update((b, n) for b in model.get("brushes", ()))
    return out


def hull_faces(brush, placement=None):
    """One brush's hull as [Face], or None if it has none.

    The faces come from `collision.face_polygon`, so this is the same hull the
    collision exporter builds. A brush-model brush is moved by its `placement`
    (brushmodels.load) as collision.py moves it. Computed once per brush and
    passed around, because clipping every plane against every other is the
    expensive part.
    """
    planes = brush_planes(brush)
    bounds = brush.get("bounds")
    if len(planes) < 4 or not bounds:
        return None
    centre = vec3(bounds["midPoint"])
    radius = 2.0 * sum(h * h for h in vec3(bounds["halfSize"])) ** 0.5
    faces = []
    for i in range(len(planes)):
        poly = face_polygon(planes, i, centre, radius)
        if not poly:
            continue
        normal = planes[i][:3]
        if placement:
            poly = [brushmodels.place(placement, p) for p in poly]
            normal = brushmodels.orient(placement, normal)
        faces.append(Face(i, normal, [to_engine(p) for p in poly]))
    return faces or None


def hull_points(faces):
    """Every vertex of a hull, engine space. Repeats across shared edges; the fit does not care."""
    return [p for face in faces for p in face.polygon]


def hull_volume(faces):
    """The hull's own volume in cubic metres, by the divergence theorem over its faces."""
    total = 0.0
    for face in faces:
        poly = face.polygon
        for k in range(1, len(poly) - 1):
            a, b, c = poly[0], poly[k], poly[k + 1]
            u = tuple(b[j] - a[j] for j in range(3))
            v = tuple(c[j] - a[j] for j in range(3))
            cross = (u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0])
            total += sum(a[j] * cross[j] for j in range(3)) / 6.0
    return abs(total)


def _yaw_candidates(faces):
    """Yaws worth trying, radians in [0, pi/2): the hull's own vertical faces, then a scan.

    A brush that *is* a box should come out with exactly its own yaw rather than
    the nearest step, so its own face normals are tried first and ties keep the
    earlier candidate. A normal here is still in CoD space, where up is z, so a
    vertical face is one whose normal has no z; in engine space its direction is
    (nx, -ny), whose angle in the box's frame is atan2(ny, nx).
    """
    quarter = math.pi / 2
    out = [math.atan2(f.normal[1], f.normal[0]) % quarter for f in faces if abs(f.normal[2]) <= 1e-3]
    steps = int(round(90.0 / YAW_STEP))
    out.extend(i * quarter / steps for i in range(steps))
    return out


def to_box_frame(v, yaw):
    """An engine-space offset (or direction) in a box's own frame: rotateY(v, -yaw)."""
    c, s = math.cos(yaw), math.sin(yaw)
    return (v[0] * c - v[2] * s, v[1], v[0] * s + v[2] * c)


def box_at(points, yaw):
    """The box hugging `points` when turned by `yaw`: (centre, full size), engine space.

    `resolveUtil.rotateY` is three.js' convention, so a world point maps into the
    box's own frame by turning it the other way.
    """
    c, s = math.cos(yaw), math.sin(yaw)
    # to_box_frame, inlined: this is the inner loop of every fit.
    us = [p[0] * c - p[2] * s for p in points]
    vs = [p[0] * s + p[2] * c for p in points]
    ys = [p[1] for p in points]
    umid, vmid = (min(us) + max(us)) / 2, (min(vs) + max(vs)) / 2
    # The centre back out of the box's frame (rotateY by +yaw).
    centre = (umid * c + vmid * s, (min(ys) + max(ys)) / 2, -umid * s + vmid * c)
    size = (max(us) - min(us), max(ys) - min(ys), max(vs) - min(vs))
    return centre, size


def fit_box(faces):
    """The smallest yaw-aligned box containing a hull: (centre, size, yaw_radians).

    Candidates are evaluated in a fixed order and a tie keeps the earlier one, so
    the same dump always exports the same box.
    """
    points = hull_points(faces)
    best_yaw, best_volume = 0.0, None
    for yaw in _yaw_candidates(faces):
        _, size = box_at(points, yaw)
        volume = size[0] * size[1] * size[2]
        if best_volume is None or volume < best_volume - 1e-9:
            best_yaw, best_volume = yaw, volume
    centre, size = box_at(points, best_yaw)
    return centre, size, best_yaw


def box_footprint(centre, size, yaw):
    """The axis-aligned bounds of a yaw-turned box's footprint: (min_x, max_x, min_z, max_z)."""
    c, s = abs(math.cos(yaw)), abs(math.sin(yaw))
    half_x = size[0] / 2 * c + size[2] / 2 * s
    half_z = size[0] / 2 * s + size[2] / 2 * c
    return (centre[0] - half_x, centre[0] + half_x, centre[2] - half_z, centre[2] + half_z)


def blocking_bounds(brushes):
    """[(brush index, (min_x, max_x, min_z, max_z, top))] for every blocking brush, engine space.

    Brush bounds only, and unplaced: a coarse broad phase for reports, never for
    what gets exported.
    """
    out = []
    for index, brush in enumerate(brushes):
        if not blocks_player(brush.get("contents", 0) & 0xFFFFFFFF):
            continue
        bounds = brush.get("bounds")
        if not bounds:
            continue
        mid, half = vec3(bounds["midPoint"]), vec3(bounds["halfSize"])
        lo = to_engine(tuple(mid[i] - half[i] for i in range(3)))
        hi = to_engine(tuple(mid[i] + half[i] for i in range(3)))
        box = (min(lo[0], hi[0]), max(lo[0], hi[0]), min(lo[2], hi[2]), max(lo[2], hi[2]), max(lo[1], hi[1]))
        out.append((index, box))
    return out


def solid_tops(brushes):
    """Every blocking brush as (min_x, max_x, min_z, max_z, top): `blocking_bounds` without the index."""
    return [box for _, box in blocking_bounds(brushes)]
