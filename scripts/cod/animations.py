"""Animated props: which clip each entity plays, and writing clips into the packed prop GLBs.

A map animates the `script_model`s its script finds by `targetname
"animated_model"`. Each one's `precache_script` names a small script that sets
`level.anim_prop_models[model][key] = "<clip>"`: plain text in IW4 and T5
rawfiles, compiled `.gscbin` in IW5 and IW6. Clip names do not follow model names, and
one clip serves several models, so the scripts are the only source. The clips'
conventions are in docs/cod/reference.md#animations.
"""

import os
import re
import struct
import zlib
from collections import Counter, defaultdict

from .entities import named_keys
from .files import read_bytes, read_json, read_text
from .gltf import add_view, pack, read_glb, write_glb
from .pack import served_path
from .xanim import decode

ANIMATED_TARGETNAME = "animated_model"
ANIMTREE = "animated_props"  # the #using_animtree every animated-model script declares

# What a translation key means, by the xanim header's asset type: an offset added to
# the bind translation (2: every animated prop measured) or the local translation
# itself (1: every view clip). Type 0 is unverified; it keeps the offset reading and
# embed_clips says so. docs/cod/reference.md#animations.
TRANSLATION_BY_ASSET_TYPE = {1: "absolute", 2: "offset"}

# The one bone that does not follow its clip's asset type: the magazine tag, whose
# translation is an offset even in a view clip, where everything else is absolute.
#
# A judgement from the data rather than a rule of the format, so it is a list of
# one. In every reload clip of both games — and in no other clip, for no other
# bone — `tag_clip` is keyed at exactly the origin on its first and last frame
# while its bind pose is inches away; every other animated translation in the
# same clips starts within half an inch of its bind. A reload begins and ends at
# idle, which does not key the magazine at all and so leaves it at bind, so read
# as absolute those keys drop the magazine out of the magwell for the length of
# the reload and float it back afterwards. docs/cod/reference.md#animations.
OFFSET_BONES = ("tag_clip",)

# Advanced Warfare's rule, which is not the asset type's: a translation key adds to
# the model's own tagPositions, and the view arms store zeros there. So a key is
# absolute on those models' joints and an offset on every other, whatever the type;
# `clip_to_gltf`'s `absolute_bones` carries it. reverse/s1-zone/README.md#the-animations.
ZERO_TAG_POSITIONS = "zeroTagPositions"  # the xmodel-dump key the S1 dumper writes
S1_ADDITIVE_TYPE = 6  # the aim, lean and `*_additive` clips: rotations on top of a pose, not a pose


def absolute_joints(xmodel_dir, model, gltf):
    """The joint names of `model`'s GLB `gltf` if its xmodel dump says its tagPositions are zeros, else none."""
    path = os.path.join(xmodel_dir, f"{model}.json")
    if not (os.path.exists(path) and read_json(path).get(ZERO_TAG_POSITIONS)):
        return set()
    return {gltf["nodes"][j].get("name", "") for s in gltf.get("skins", []) for j in s["joints"]}


# Where each game keeps its animated-model scripts: text rawfiles found by path, or
# compiled scriptfiles named by number, which are all read (docs/cod/games.md).
SCRIPTS_BY_GAME = {
    "iw4": "text",
    "iw5": "compiled",
    "t5": "text",
    "t6": "compiled",
    "iw6": "compiled",
    "s1": "compiled",
    "t9": "compiled",
}

# IW4/T5 text: `level.anim_prop_models[ model ][ "sway" ] = "clip";`, the model
# either a literal or a variable assigned earlier in the file. The SP branch
# assigns `%clip` instead; either names the clip.
_ASSIGN = re.compile(r'anim_prop_models\s*\[\s*("[^"]+"|\w+)\s*\]\s*\[\s*"[^"]*"\s*\]\s*=\s*(?:"([^"]+)"|%(\w+))')
_VARIABLE = re.compile(r'(\w+)\s*=\s*"([^"]+)"\s*;')
_STRING = re.compile(rb"[\x20-\x7e]{2,}")
# A literal in a compiled string section can follow bytes of its reference that
# happen to be printable (IW6 puts `|` before the model); the name is what ends it.
_NAME = re.compile(r"[a-z0-9_]+$")


def load_clips(xanim_dir):
    """{name: XAnim} for every compiled clip OAT dumped. A clip that fails to decode is reported and skipped."""
    clips = {}
    if not os.path.isdir(xanim_dir):
        return clips
    for f in sorted(os.listdir(xanim_dir)):
        path = os.path.join(xanim_dir, f)
        if not os.path.isfile(path):
            continue
        try:
            clips[f] = decode(read_bytes(path), f)
        except ValueError as exc:
            print(f"      !! {exc}")
    return clips


def text_assignments(text):
    """[(model, clip)] set by one IW4/T5 script, in order."""
    out, seen = [], set()
    # Both matchers walk the text in order, so the variables are merged into
    # `latest` as the assignments that read them come up: the old version
    # re-scanned the whole prefix for every assignment.
    variables = _VARIABLE.finditer(text)
    pending = next(variables, None)
    latest = {}
    for m in _ASSIGN.finditer(text):
        while pending is not None and pending.start() < m.start():
            latest[pending.group(1)] = pending.group(2)
            pending = next(variables, None)
        target, clip = m.group(1), m.group(2) or m.group(3)
        if target.startswith('"'):
            model = target.strip('"')
        else:
            model = latest.get(target)
            if model is None:
                continue
        if (model, clip) not in seen:
            seen.add((model, clip))
            out.append((model, clip))
    return out


def gscbin_strings(data):
    """The inflated string section of an OAT `.gscbin`.

    Layout: name, NUL, int32 compressed / inflated / bytecode sizes, the zlib data, the bytecode.
    """
    try:
        start = data.index(0) + 1
        compressed, _inflated, _bytecode = struct.unpack_from("<iii", data, start)
        return zlib.decompress(data[start + 12 : start + 12 + compressed])
    except (ValueError, struct.error, zlib.error):
        return b""


def compiled_assignments(data, clip_names):
    """[(model, clip)] from one compiled `.gscbin` (IW5, IW6). Returns [] for any other script.

    The compiled script keeps its string literals in first-use order: the model
    name, then the animtree, then each clip and its key. A string is only taken
    as a clip if the zone has a clip by that name.
    """
    strings = [s.decode() for s in _STRING.findall(gscbin_strings(data))]
    if ANIMTREE not in strings:
        return []
    at = strings.index(ANIMTREE)
    names = (m.group(0) for m in map(_NAME.search, reversed(strings[:at])) if m)
    model = next((s for s in names if s not in ("mapname", "mp_")), None)
    if model is None:
        return []
    out = []
    for s in strings[at + 1 :]:
        if s in clip_names and (model, s) not in out:
            out.append((model, s))
    return out


def _compiled_scripts(root):
    """Every `.gscbin` OAT wrote under `root` (IW5 names them by number)."""
    for dirpath, _, files in os.walk(root):
        for f in files:
            if f.endswith(".gscbin"):
                yield os.path.join(dirpath, f)


class ClipAssignments:
    """Which clip each animated entity plays, from the map's precache scripts."""

    def __init__(self, game_key, by_script, clip_names):
        self.game_key = game_key
        self.by_script = by_script  # script path ("maps/animated_models/x") or None -> [(model, clip)]
        self.clip_names = set(clip_names)
        self.by_model = defaultdict(list)
        for pairs in by_script.values():
            for model, clip in pairs:
                if clip not in self.by_model[model]:
                    self.by_model[model].append(clip)
        self.missing = Counter()  # entities whose model the scripts name no available clip for

    @classmethod
    def from_dumps(cls, game_key, raw_dir, script_dir, clip_names):
        """Read the text scripts from the rawfile dump, or the compiled ones from the scriptfile dump."""
        by_script = {}
        if SCRIPTS_BY_GAME[game_key] == "compiled":
            for i, path in enumerate(sorted(_compiled_scripts(script_dir))):
                pairs = compiled_assignments(read_bytes(path), clip_names)
                if pairs:
                    by_script[f"#{i}"] = pairs
        else:
            base = os.path.join(raw_dir, "maps", "animated_models")
            if os.path.isdir(base):
                for f in sorted(os.listdir(base)):
                    if f.endswith(".gsc"):
                        text = read_text(os.path.join(base, f))
                        by_script[f"maps/animated_models/{f[:-4]}"] = text_assignments(text)
        return cls(game_key, by_script, clip_names)

    def clip_for(self, entity):
        """The clip an entity (raw key -> value dict) plays, or None if it does not animate."""
        e = named_keys([entity], self.game_key)[0]
        if e.get("targetname") != ANIMATED_TARGETNAME:
            return None
        model = (e.get("model") or "").removeprefix(",")
        script = " ".join((e.get("precache_script") or "").split())
        candidates = [c for c in self.by_model.get(model, []) if c in self.clip_names]

        # The entity's own script decides when two scripts give one model different clips.
        chosen = None
        if script:
            pairs = self.by_script.get(script.replace(" ", "/"), [])
            chosen = next((c for m, c in pairs if m == model and c in self.clip_names), None)
            if chosen is None and script.split()[-1] in candidates:  # IW5's scripts are named after their clip
                chosen = script.split()[-1]
        chosen = chosen or (candidates[0] if candidates else None)
        if chosen is None:
            self.missing[model] += 1
        return chosen


# -- Writing clips into prop GLBs ---------------------------------------------------


def _qmul(a, b):
    ax, ay, az, aw = a
    bx, by, bz, bw = b
    return [
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
        aw * bw - ax * bx - ay * by - az * bz,
    ]


def _rotate(q, v):
    """Rotate vector `v` by unit quaternion `q`."""
    x, y, z, w = _qmul(_qmul(q, [v[0], v[1], v[2], 0.0]), [-q[0], -q[1], -q[2], q[3]])
    return [x, y, z]


def _skeleton(gltf):
    """{joint name: (node index, is a root joint)}. A root joint carries OAT's Z-up -> Y-up rotation."""
    joints = {j for skin in gltf.get("skins", []) for j in skin["joints"]}
    parent = {c: i for i, n in enumerate(gltf.get("nodes", [])) for c in n.get("children", [])}
    return {gltf["nodes"][j].get("name", ""): (j, parent.get(j) not in joints) for j in joints}


def _floats(buf, gltf, rows, kind):
    """Append float rows as one accessor; return its index."""
    flat = [v for row in rows for v in (row if isinstance(row, list) else [row])]
    view = add_view(buf, gltf.setdefault("bufferViews", []), pack("f", flat))
    accessor = {"bufferView": view, "componentType": 5126, "count": len(rows), "type": kind}
    if kind == "SCALAR":
        accessor["min"], accessor["max"] = [min(rows)], [max(rows)]
    gltf.setdefault("accessors", []).append(accessor)
    return len(gltf["accessors"]) - 1


def clip_to_gltf(gltf, buf, clip, absolute_bones=None):
    """Append `clip` to `gltf` as one animation; return (bone tracks written, bone tracks with no joint).

    Rotation keys replace the joint's bind rotation; translation keys are offsets
    added to its bind translation, or the translation itself, by the clip's asset
    type -- or, where `absolute_bones` is given, by whether the joint is in it
    (S1's rule). On a root joint both are composed with the joint's bind rotation,
    which is OAT's axis change rather than the game's.
    """
    skeleton = _skeleton(gltf)
    if absolute_bones is not None and clip.asset_type == S1_ADDITIVE_TYPE:
        raise ValueError(f"{clip.name} is additive (asset type {clip.asset_type}), which a baked clip cannot be")
    by_type = TRANSLATION_BY_ASSET_TYPE.get(clip.asset_type) == "absolute"

    def absolute(name):
        if absolute_bones is not None:
            return name in absolute_bones
        return by_type and name not in OFFSET_BONES

    samplers, channels, written, unmatched = [], [], 0, 0

    def channel(node, path, track, values, kind):
        times = [i / clip.fps for i in track.indices]
        sampler = {"input": _floats(buf, gltf, times, "SCALAR"), "output": _floats(buf, gltf, values, kind)}
        samplers.append({**sampler, "interpolation": "LINEAR"})
        channels.append({"sampler": len(samplers) - 1, "target": {"node": node, "path": path}})

    for bone in clip.bones:
        if bone.name not in skeleton:
            unmatched += 1
            continue
        node, is_root = skeleton[bone.name]
        bind_r = gltf["nodes"][node].get("rotation", [0.0, 0.0, 0.0, 1.0])
        bind_t = gltf["nodes"][node].get("translation", [0.0, 0.0, 0.0])
        if bone.rotation:
            values = [_qmul(bind_r, q) for q in bone.rotation.values] if is_root else bone.rotation.values
            channel(node, "rotation", bone.rotation, values, "VEC4")
        if bone.translation:
            keys = [_rotate(bind_r, v) for v in bone.translation.values] if is_root else bone.translation.values
            base = [0.0, 0.0, 0.0] if absolute(bone.name) else bind_t
            values = [[b + d for b, d in zip(base, v, strict=True)] for v in keys]
            channel(node, "translation", bone.translation, values, "VEC3")
        if bone.rotation or bone.translation:
            written += 1

    if channels:
        gltf.setdefault("animations", []).append({"name": clip.name, "samplers": samplers, "channels": channels})
    return written, unmatched


def packed_file(props_dir, model):
    """The packed GLB for `model`, as props.write_props_world names it, or None."""
    for f in (served_path(f"{model}_lod0.glb"), served_path(f"{model}.glb")):
        if os.path.exists(os.path.join(props_dir, f)):
            return os.path.join(props_dir, f)
    return None


def embed_clips(props_dir, placements, clips):
    """Write every clip a placement plays into its model's packed GLB; return {model: {clips embedded}}."""
    wanted = defaultdict(set)
    for p in placements:
        if p.get("anim"):
            wanted[p["model"]].add(p["anim"])

    embedded, problems = {}, []
    for model, names in sorted(wanted.items()):
        path = packed_file(props_dir, model)
        if path is None:
            continue  # the model itself did not export; props.world skips it
        gltf, buf = read_glb(path)
        if not gltf.get("skins"):
            problems.append(f"{model} has no skeleton")
            continue
        done = set()
        for name in sorted(names):
            if clips[name].asset_type not in TRANSLATION_BY_ASSET_TYPE:
                problems.append(f"{name}: asset type {clips[name].asset_type}, translations read as offsets (unverified)")
            written, unmatched = clip_to_gltf(gltf, buf, clips[name])
            if written:
                done.add(name)
            if unmatched or not written:
                problems.append(f"{name} on {model}: {unmatched} of {len(clips[name].bones)} bones not in the skeleton")
        if done:
            gltf["buffers"] = [{"byteLength": len(buf)}]
            write_glb(path, gltf, buf)
            embedded[model] = done

    for p in problems:
        print(f"      !! {p}")
    return embedded
