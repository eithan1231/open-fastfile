"""Per-bone hitboxes for the exported bodies, derived from their own skin weights.

A bullet is traced against a posed skeleton, so each bone a hit can land on needs a
volume attached to it. Call of Duty ships those volumes itself — `XModelCollSurf_s`
is an AABB per bone, with a `partClassification` byte saying what each bone counts
as — and reading them needs the zone, a dumper that does not exist yet, and one open
reverse-engineering question (`docs/cod/reference.md#collision`: which
classification byte is the head is not established).

This derives them from the GLBs that are already on disk instead, which needs no
game files at all and has one property the authored boxes do not: the volumes come
from **the mesh the client actually draws**, so a hitbox cannot disagree with the
body on screen. Dumping CoD's own is still worth doing, as a check against this
rather than as a replacement for it.

The method, per body:

  * for each vertex, the joint that influences it most;
  * fold that joint up to the nearest one that carries a box
    (`@3d/shared/sim/hitLocations.ts` decides which those are, and every skinned
    joint on every exported body resolves — see its test);
  * accumulate the vertex into that bone's box, **in the bone's own space**, so the
    box travels with the bone when the skeleton is posed.

`inverseBindMatrices` is what takes a vertex there: for joint j it maps the skin's
space to j's local space at bind time, which is exactly the frame a box has to be
expressed in to be transformed by that bone's world matrix later.
"""

import json
import os

from .files import write_text
from .gltf import parents_of, read_accessor, read_glb
from .units import UNITS_PER_M

# Bumped whenever the JSON below changes shape; the engine refuses one it does not read.
FORMAT_VERSION = 1

# Kept in step with HIT_BONES in packages/shared/src/sim/hitLocations.ts. Duplicated
# rather than shared because the two languages cannot import from each other, and
# `tests/test_hitboxes.py` reads the TypeScript to check the two have not drifted —
# a table that disagrees with itself across the pipeline is a hitbox in the wrong
# place with nothing to say so.
HIT_BONES = {
    "j_head": "head",
    "j_head_end": "head",
    "j_helmet": "helmet",
    "j_nvg": "helmet",
    "j_nvg_end": "helmet",
    "j_gasmask_front": "helmet",
    "j_gasmask_ri": "helmet",
    "j_neck": "neck",
    "j_neck_helper": "neck",
    "j_collar": "neck",
    "j_collar_front": "neck",
    "j_collar_rear": "neck",
    "j_spine4": "torsoUpper",
    "j_spineupper": "torsoUpper",
    "back_mid": "torsoUpper",
    "torso_stabilizer": "torsoUpper",
    "j_clavicle_le": "torsoUpper",
    "j_clavicle_ri": "torsoUpper",
    "j_pectoral_le": "torsoUpper",
    "j_pectoral_ri": "torsoUpper",
    "j_mainroot": "torsoLower",
    "pelvis": "torsoLower",
    "j_spinelower": "torsoLower",
    "back_low": "torsoLower",
    "j_shoulder_ri": "rightArmUpper",
    "j_shouldertwist_ri": "rightArmUpper",
    "j_elbow_ri": "rightArmLower",
    "j_wristtwist_ri": "rightArmLower",
    "j_wrist_ri": "rightHand",
    "j_shoulder_le": "leftArmUpper",
    "j_shouldertwist_le": "leftArmUpper",
    "j_elbow_le": "leftArmLower",
    "j_wristtwist_le": "leftArmLower",
    "j_wrist_le": "leftHand",
    "j_hip_ri": "rightLegUpper",
    "j_hiptwist_ri": "rightLegUpper",
    "j_knee_ri": "rightLegLower",
    "j_ankle_ri": "rightFoot",
    "j_hip_le": "leftLegUpper",
    "j_hiptwist_le": "leftLegUpper",
    "j_knee_le": "leftLegLower",
    "j_ankle_le": "leftFoot",
    "j_gun": "gun",
}

# Below this a weight is not an influence, it is a rounding artefact of the
# exporter's normalisation. Taking the argmax over every nonzero weight would let a
# 0.001 tie decide which box a vertex lands in.
MIN_WEIGHT = 0.05

# A box no thinner than this in any axis, **in the rig's own units**.
#
# A box is expressed in its bone's local space and stays there: the engine poses it
# by that bone's world matrix, which already carries the `unit-scale` root a body
# hangs from (0.0254 — a CoD rig is in inches). So the number here is inches, and
# writing metres would ask for half a millimetre. Stated as the world distance it
# means, times the conversion, so the intent survives the next person to read it.
MIN_THICKNESS = 0.02 * UNITS_PER_M


# What each location's longest axis should plausibly be, metres. Not a limit — the
# box is what the mesh says and is not clamped — but a box past this is *named*,
# because an implausible hit volume looks like ordinary data and plays like a bug.
#
# The case this exists for: a ghillie suit's veil is skinned to `j_head`, so the
# three `mp_body_ally_ghillie_*_sniper` bodies derive a 0.49 m "head" and would be
# headshot through a metre of foliage. CoD's own `XModelCollSurf_s` would not say
# that, and this is the concrete thing to compare against when it is dumped.
PLAUSIBLE_EXTENT = {
    # Calibrated against the 26 bodies on disk rather than guessed: each is a little
    # over the largest that location actually derives to, so an ordinary body is
    # silent. `head` is the deliberate exception — it is set *below* the three
    # ghillie bodies so they stay visible, and their 0.49 m is the only thing in the
    # whole corpus this flags.
    "helmet": 0.40,  # observed max 0.360
    "head": 0.40,  # observed max 0.489 (ghillie), next 0.367
    "neck": 0.25,  # 0.183
    "torsoUpper": 0.90,  # 0.820
    "torsoLower": 0.75,  # 0.658
    "rightArmUpper": 0.50,  # 0.407
    "rightArmLower": 0.50,  # 0.426
    "rightHand": 0.25,  # 0.177
    "leftArmUpper": 0.50,  # 0.408
    "leftArmLower": 0.50,  # 0.398
    "leftHand": 0.25,  # 0.177
    "rightLegUpper": 0.55,  # 0.493
    "rightLegLower": 0.60,  # 0.537
    "rightFoot": 0.45,  # 0.327
    "leftLegUpper": 0.55,  # 0.468
    "leftLegLower": 0.60,  # 0.529
    "leftFoot": 0.45,  # 0.401
    "gun": 1.20,  # no body skins a gun; a grafted weapon would
}


def implausible(bones):
    """[(bone, location, metres)] for every box bigger than its location should be."""
    out = []
    for box in bones:
        extent = max(box["max"][i] - box["min"][i] for i in range(3)) / UNITS_PER_M
        cap = PLAUSIBLE_EXTENT.get(box["location"])
        if cap is not None and extent > cap:
            out.append((box["bone"], box["location"], extent))
    return out


def hit_bone_of(name, parent_name):
    """The nearest joint above `name` (or itself) that carries a box, or None.

    `parent_name` walks upwards. Bounded by what it has already seen rather than by
    a depth it hopes is enough, so a malformed skeleton cannot spin.
    """
    seen = set()
    at = name
    while at is not None and at not in seen:
        if at in HIT_BONES:
            return at
        seen.add(at)
        at = parent_name(at)
    return None


def _mul_point(m, p):
    """A glTF (column-major) 4x4 times a point."""
    x, y, z = p
    return (
        m[0] * x + m[4] * y + m[8] * z + m[12],
        m[1] * x + m[5] * y + m[9] * z + m[13],
        m[2] * x + m[6] * y + m[10] * z + m[14],
    )


def derive(paths):
    """`{version, bones: [...]}` merged over every GLB in `paths`, or None with no skin.

    Several files, because a character is several: `characters.py` puts everything
    neck-down in the body and ships the head as a model of its own, rebound to the
    body's bones by name at run time. Read the body alone and there is **no head box
    at all** — the one volume that decides most fights.
    """
    boxes = {}
    found = False
    for path in paths:
        if _accumulate(path, boxes):
            found = True
    if not found:
        return None

    out = []
    for bone, (lo, hi) in sorted(boxes.items()):
        for axis in range(3):
            if hi[axis] - lo[axis] < MIN_THICKNESS:
                mid = (hi[axis] + lo[axis]) / 2
                lo[axis], hi[axis] = mid - MIN_THICKNESS / 2, mid + MIN_THICKNESS / 2
        out.append(
            {
                "bone": bone,
                "location": HIT_BONES[bone],
                "min": [round(v, 4) for v in lo],
                "max": [round(v, 4) for v in hi],
            }
        )
    return {"version": FORMAT_VERSION, "bones": out}


def _accumulate(path, boxes):
    """Fold one GLB's vertices into `boxes`. False when it carries no skin."""
    gltf, buf = read_glb(path)
    skins = gltf.get("skins") or []
    if not skins:
        return False
    skin = skins[0]
    joints = skin["joints"]
    nodes = gltf["nodes"]
    parent = parents_of(gltf)

    name_of = {i: nodes[i].get("name") for i in range(len(nodes))}
    index_of = {name_of[i]: i for i in range(len(nodes)) if name_of[i]}

    def parent_name(n):
        i = index_of.get(n)
        up = parent.get(i) if i is not None else None
        return name_of.get(up) if up is not None else None

    inverse = read_accessor(gltf, buf, skin["inverseBindMatrices"]) if "inverseBindMatrices" in skin else None
    if inverse is None:
        return False

    for node in nodes:
        mesh = node.get("mesh")
        if mesh is None or node.get("skin") is None:
            continue
        for prim in gltf["meshes"][mesh]["primitives"]:
            attrs = prim["attributes"]
            if "JOINTS_0" not in attrs or "WEIGHTS_0" not in attrs:
                continue
            positions = read_accessor(gltf, buf, attrs["POSITION"])
            joint_ids = read_accessor(gltf, buf, attrs["JOINTS_0"])
            weights = read_accessor(gltf, buf, attrs["WEIGHTS_0"])
            for v, point in enumerate(positions):
                # The joint that influences this vertex most. A vertex belongs to one
                # box: splitting it between two would put a sliver of every limb
                # inside its neighbour.
                best, best_w = None, MIN_WEIGHT
                for k in range(4):
                    w = weights[v][k]
                    if w > best_w:
                        best, best_w = joint_ids[v][k], w
                if best is None or best >= len(joints):
                    continue
                owner = hit_bone_of(name_of.get(joints[best]), parent_name)
                if owner is None:
                    continue
                # Into the owning bone's own space, so the box is posed by that
                # bone's world matrix at run time.
                local = _mul_point(inverse[joints.index(index_of[owner])], point)
                box = boxes.get(owner)
                if box is None:
                    boxes[owner] = [list(local), list(local)]
                else:
                    for axis in range(3):
                        box[0][axis] = min(box[0][axis], local[axis])
                        box[1][axis] = max(box[1][axis], local[axis])

    return True


# The catalogue kinds whose entries are bodies, and the sidecar keys naming their
# files: one body and one head for a player; lists of each for an actor (actors.py),
# whose boxes are the union over every variant, so any body wearing any head is covered.
BODY_KINDS = {"characters": ("body", "head"), "actors": ("bodies", "heads")}


def entry_files(meta, keys):
    """The GLBs an entry's sidecar names under `keys`, each key holding one name or a list."""
    out = []
    for key in keys:
        value = meta.get(key)
        out += value if isinstance(value, list) else [value] if value else []
    return out


def write_entry(entry_dir, ident, files, dry_run=False):
    """Derive and write `<ident>.hitboxes.json` for one entry.

    Returns how many boxes are larger than their location should be, or None when
    the files carry no skin (and nothing is written).
    """
    where = os.path.join(*entry_dir.split(os.sep)[-3:])
    data = derive([p for p in (os.path.join(entry_dir, f) for f in files) if os.path.isfile(p)])
    if data is None:
        print(f"  - {where}: no skin, no hitboxes")
        return None
    if dry_run:
        print(f"  ~ {where}: {len(data['bones'])} box(es) (dry run)")
    else:
        write_text(os.path.join(entry_dir, f"{ident}.hitboxes.json"), json.dumps(data, separators=(",", ":")))
        print(f"  + {where}: {len(data['bones'])} box(es)")
    loud = implausible(data["bones"])
    for bone, location, extent in loud:
        # Cloth and foliage skinned to a bone inflate its box: a ghillie
        # hood on `j_head` is the known case. Said out loud rather than
        # clamped, because the mesh is what it is and a silently shrunk box
        # is a worse lie than a large one.
        cap = PLAUSIBLE_EXTENT[location]
        print(f"    ! {bone} ({location}) is {extent:.2f}m across, past the {cap:.2f}m a {location} should be")
    return len(loud)


def main(args):
    """Write `<id>.hitboxes.json` beside every body under the catalogue: players' and actors'."""
    roots = {kind: os.path.join(args.worlds, "catalog", kind) for kind in BODY_KINDS}
    if not any(os.path.isdir(root) for root in roots.values()):
        print(f"no bodies under {os.path.join(args.worlds, 'catalog')}; build the catalogue first")
        return False

    written, skipped, loud = 0, 0, 0
    for kind, root in roots.items():
        for game in sorted(os.listdir(root)) if os.path.isdir(root) else []:
            game_dir = os.path.join(root, game)
            if not os.path.isdir(game_dir):
                continue
            for entry in sorted(os.listdir(game_dir)):
                entry_dir = os.path.join(game_dir, entry)
                # From the sidecar rather than by listing: an entry holds a body GLB and
                # a head GLB, and picking the first alphabetically picks the head.
                sidecar = os.path.join(entry_dir, f"{entry}.json")
                if not os.path.isfile(sidecar):
                    continue
                with open(sidecar, encoding="utf-8") as fh:
                    meta = json.load(fh)
                over = write_entry(entry_dir, entry, entry_files(meta, BODY_KINDS[kind]), args.dry_run)
                if over is None:
                    skipped += 1
                    continue
                written += 1
                loud += over
    print(f"{written} body/ies with hitboxes, {skipped} without, {loud} box(es) larger than their location should be")
    return skipped == 0
