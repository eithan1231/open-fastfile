"""How the game draws each material, read from OpenAssetTools' material JSON.

Everything downstream (shell, decals, props) takes its blend mode, alpha test,
culling, draw order and shadow casting from `material_render_state`. The field
meanings and how they were established are in docs/cod/reference.md#materials.
"""

import os
from collections import namedtuple

from .files import read_json

# CoD's blend equations, as (srcBlendRgb, dstBlendRgb), named the way the engine
# understands them. Only "alpha" is what glTF's BLEND means; most decals multiply.
BLEND_EQUATIONS = {
    ("zero", "srccolor"): "multiply",
    ("destcolor", "zero"): "multiply",
    ("one", "one"): "add",
    ("srcalpha", "one"): "add",
    ("invdestcolor", "one"): "screen",
    ("srcalpha", "invsrcalpha"): "alpha",
    ("one", "invsrcalpha"): "alpha",  # premultiplied
    # IW6's D3D11 dual-source factors: the pixel shader's second output carries the alpha.
    ("one", "invsrcalpha1"): "alpha",
    ("srcalpha1", "invsrcalpha1"): "alpha",
}

# Equations that replace what is under the surface. IW6 draws the base pass of a
# two-pass layer blend (a `*r` material) scaled by a weight its shader computes.
REPLACE_EQUATIONS = {("one", "zero"), ("srcalpha", "zero")}

# Indices into `stateBitsEntry`, per game. T5 has four extra emissive techniques,
# which pushes LIT to 0xA; IW6 has no BUILD_FLOAT_Z or BUILD_SHADOWMAP_COLOR, which
# moves everything after them down two (docs/cod/reference.md#materials). Reading
# the wrong row is silent; `check_state_flags` is the guard.
Techniques = namedtuple("Techniques", "depth_prepass unlit emissive lit")
TECHNIQUES_BY_GAME = {
    "iw4": Techniques(0x0, 0x4, 0x5, 0x9),
    "iw5": Techniques(0x0, 0x4, 0x5, 0x9),
    "t5": Techniques(0x0, 0x4, 0x5, 0xA),
    # T6's MaterialTechniqueType (OAT T6_Assets.h): no BUILD_FLOAT_Z, SHADOWMAP_COLOR
    # or the four extra emissives, so LIT is 4 of 36.
    "t6": Techniques(0x0, 0x2, 0x3, 0x4),
    "iw6": Techniques(0x0, 0x2, 0x3, 0x7),
    # S1 (x64-zt s1/structs.hpp: ZPREPASS 0, UNLIT 8, EMISSIVE 9, LIT 13 of 180).
    # Its 15 map zones agree: 8 is on all but 5 of 21,610 materials, 13 on 20,336,
    # and 9-12 on exactly the 1,116 the zone also marks `cameraRegion` 4.
    "s1": Techniques(0x0, 0x8, 0x9, 0xD),
    # Cold War's material dump carries no state bits yet (scripts/cod/t9/materials.py),
    # so no row is ever read; T5's, the nearest Treyarch table, stands in.
    "t9": Techniques(0x0, 0x4, 0x5, 0xA),
}

# gameFlags bits: casts a solid shadow / casts an alpha-tested shadow.
MTL_GAMEFLAG_CASTS_SHADOW = "40"
MTL_GAMEFLAG_CASTS_SHADOW_ALPHATEST = "80"

# MaterialStateFlags: a separate cache of two facts the lit technique also holds.
STATE_FLAG_CULL_BACK, STATE_FLAG_WRITES_DEPTH = 0x1, 0x8

# Technique-set substrings for materials the game never draws as a surface:
# volumetrics (`falloff`) and editor tool / shadow-proxy surfaces.
DROP_TECHSETS = ("falloff", "tools", "shadowcaster")

# What a material's names say about it, per game (docs/cod/games.md):
# - drop_techsets: technique-set substrings of non-surfaces;
# - drop_prefixes: material-name prefixes of non-surfaces;
# - not_decals: technique-set substrings that keep an `unlit` material out of the decals;
# - colour_map: the texture slot that holds the colour, or None for the first
#   `colorMap`-semantic texture (which on IW5 can be a thermal `heatmap`).
SurfaceRules = namedtuple("SurfaceRules", "drop_techsets drop_prefixes not_decals colour_map")
IW_SURFACES = SurfaceRules(DROP_TECHSETS, (), (), None)
SURFACES_BY_GAME = {
    "iw4": IW_SURFACES,
    "iw5": IW_SURFACES,
    "t5": IW_SURFACES,
    # A Black Ops II generated material names every layer's colour slot, `colorMap`
    # the first and `colorMap1`.. the rest, so the first one is asked for by name.
    "t6": SurfaceRules(DROP_TECHSETS, (), (), "colorMap"),
    # `onlycast` cards cast a shadow and are never seen; `distortion` samples a
    # normal map to refract the screen. `*a` is the second pass of a two-pass layer
    # blend, over triangles its `*r` base already covers, weighted by its shader.
    # Unlit alpha-tested techsets are distant vista cards, not overlays. A
    # `revealMap` shares the colour semantic.
    "iw6": SurfaceRules(DROP_TECHSETS + ("onlycast", "distortion"), ("*a",), ("atest",), "colorMap"),
    # S1 keeps IW6's `distortion` refraction cards and has no `onlycast` techset at
    # all across its 15 zones. It also has no two-pass layer blend to drop: a
    # generated material blends every layer in one techset (`b0c0..b1c1..b2c2..`)
    # and is always named `*<digit>`, never IW6's `*a`. `colorMap` again, because a
    # `revealMap` shares the colour semantic here too. `hilite_z_edges` is on two
    # materials in all 14 zones, both gametype overlays a script shows: the Horde
    # dome and the Hardpoint zone outlines (reverse/s1-zone/README.md#the-barrier-dome).
    "s1": SurfaceRules(DROP_TECHSETS + ("distortion", "hilite_z_edges"), (), ("atest",), "colorMap"),
    # Cold War names a technique set by hash, so no substring rule can match one yet.
    "t9": SurfaceRules((), (), (), "colorMap"),
}

# CoD alpha-test modes as glTF alphaCutoff. `ge255` is 0.5, not 1.0: after the
# 512 px resample almost no texel is exactly 255, and 1.0 strips foliage bare.
ALPHA_CUTOFFS = {
    "gt0": 1.0 / 255.0,
    "ge128": 0.5,
    "ge255": 0.5,
}


def draw_techniques(game_key):
    """The (lit, unlit, emissive) stateBitsEntry indices to try, in that order."""
    techniques = TECHNIQUES_BY_GAME[game_key]
    return (techniques.lit, techniques.unlit, techniques.emissive)


def state_of(data, technique):
    """The state bits `data` draws `technique` with, or None when it has no such technique."""
    entries = data.get("stateBitsEntry") or []
    table = data.get("stateBits") or []
    index = entries[technique] if technique < len(entries) else -1
    return table[index] if 0 <= index < len(table) else None


def drawn_state_and_technique(data, game_key):
    """The state bits of the technique the game draws this material with, and that technique's index.

    `stateBits` is a table indexed through `stateBitsEntry`, not a single value.
    """
    for technique in draw_techniques(game_key):
        state = state_of(data, technique)
        if state is not None:
            return state, technique
    return {}, None


def drawn_state(data, game_key):
    return drawn_state_and_technique(data, game_key)[0]


def material_blend_mode(state):
    """The blend equation `state` draws with, or None if it replaces the surface."""
    op = state.get("blendOpRgb")
    if not op or op == "disabled":
        return None
    src, dst = state.get("srcBlendRgb"), state.get("dstBlendRgb")
    if (src, dst) in REPLACE_EQUATIONS:
        return None
    return BLEND_EQUATIONS.get((src, dst), "alpha")


# The technique-set token of the `flag` vertex wind, per game (docs/cod/reference.md#flag-wind).
# IW6 keeps IW5's `flag` sets and constant, and adds `flagext_wv…` sets whose waves are
# material constants (`flagWave0Parms`…) rather than the three the ported shader fixes.
# Their amplitudes are mostly a fortieth of IW5's or less, so drawn with the fixed three
# they would move many times too far; they are not matched, and stay still.
# S1 spells both the same way Ghosts does (`mc_l_sm_flag_…` and `…_flagext_wv…`),
# so the same token picks the ported one and leaves the others still. No world
# surface in any of its 15 zones uses either, so this is exercised only by props.
# Cold War's technique sets are hashes: no token can name its flag wind, so none matches.
# Black Ops II has `mc_lit_sm_flag_…` sets, whose wind is its own shader's and not
# the ported one, so none is matched and its flags stay still.
FLAG_TECHSETS_BY_GAME = {"iw4": "flag", "iw5": "flag", "t5": "flag", "t6": "\0", "iw6": "_flag_", "s1": "_flag_", "t9": "\0"}


def is_flag_technique(techset, game_key):
    """Whether a technique set draws the ported `flag` vertex wind."""
    return FLAG_TECHSETS_BY_GAME[game_key] in (techset or "")


def flag_parms(data, game_key):
    """(speed, time offset) for a material drawn with the `flag` vertex-wind technique, else None.

    The shader and what it does with these: docs/cod/reference.md#flag-wind.
    """
    if not is_flag_technique(data.get("techniqueSet"), game_key):
        return None
    for const in data.get("constants") or []:
        if const.get("name") == "flagParms" and len(const.get("literal") or []) >= 2:
            return [float(const["literal"][0]), float(const["literal"][1])]
    return None


def colour_map(data, game_key):
    """The image a material's colour comes from, or None."""
    colours = [tex for tex in data.get("textures", []) if tex.get("semantic") == "colorMap"]
    slot = SURFACES_BY_GAME[game_key].colour_map
    named = [tex for tex in colours if tex.get("name") == slot] if slot else []
    return (named or colours or [{}])[0].get("image")


def colour_maps(mat_root, game_key):
    """{material: its colour map's image} over every dumped material.

    What a model's own writer could not read: a model whose zone names its
    material under a leading comma has no texture table to pick from, and the
    material's record is in another zone's dump (TranZit's gump models name the
    map zone's materials: reverse/t6-zombies)."""
    found = {}
    for dirpath, _, files in os.walk(mat_root):
        for f in files:
            if f.endswith(".json"):
                path = os.path.join(dirpath, f)
                image = colour_map(read_json(path), game_key)
                if image is not None:
                    found[os.path.relpath(path, mat_root)[:-5]] = image
    return found


def surface_images(colormap, drop):
    """The colour maps a shell needs: every used material's but the dropped non-surfaces'.

    A dropped material draws nothing, and asking for its image anyway reported a
    false MISSING on every BO2 map: `wpc/shadowcaster` names an image `shadow` no zone holds.
    """
    dropped = set(drop)
    return {image for name, image in colormap.items() if name not in dropped}


def material_images(mat_root, name):
    """Every image a dumped material names, in slot order; () when the dump has no such material.

    A 2D material's one texture is its `2D` semantic, not `colorMap`, so this
    takes all of them rather than `colour_map`'s pick.
    """
    path = os.path.join(mat_root, material_file_stem(name) + ".json")
    if not os.path.exists(path):
        return ()
    return tuple(tex["image"] for tex in read_json(path).get("textures", []) if tex.get("image"))


def material_render_state(data, game_key):
    """Everything the glTF needs about how the game draws one material.

    Blend and alpha test are both carried: glTF cannot express "blended and
    tested", so BLEND wins there, but "opaque and tested" is a cutout (MASK).
    `drop` says the technique set is not a surface; see also `classify_materials`.
    """
    state = drawn_state(data, game_key)
    alpha_test = state.get("alphaTest")
    flags = data.get("gameFlags") or []
    techset = data.get("techniqueSet") or ""
    return {
        "techniqueSet": techset,
        "sortKey": data.get("sortKey") if isinstance(data.get("sortKey"), int) else None,
        "blend": material_blend_mode(state),
        "alphaTest": alpha_test if alpha_test not in (None, "disabled") else None,
        "doubleSided": state.get("cullFace") == "none",
        "castsShadow": bool({MTL_GAMEFLAG_CASTS_SHADOW, MTL_GAMEFLAG_CASTS_SHADOW_ALPHATEST} & set(flags)),
        "flag": flag_parms(data, game_key),
        "drop": any(t in techset for t in SURFACES_BY_GAME[game_key].drop_techsets),
    }


def check_state_flags(materials, game_key):
    """Check the technique lookup against each material's independent `stateFlags` byte.

    Only lit-pass materials are comparable. A `cullFace` disagreement means the
    technique index for this game is wrong. `depthWrite` is reported for interest
    only: the byte says whether the lit pass or the depth prepass writes depth
    (IW6's lit pass mostly tests against the prepass's depth instead).
    Returns the number of cullFace disagreements.
    """
    techniques = TECHNIQUES_BY_GAME[game_key]
    lit_technique = techniques.lit
    cull, depth, checked, fallback = [], [], 0, 0
    for name, data in sorted(materials.items()):
        state, technique = drawn_state_and_technique(data, game_key)
        flags = data.get("stateFlags")
        if not state or not isinstance(flags, int):
            continue
        if technique != lit_technique:
            fallback += 1
            continue
        checked += 1
        if (state.get("cullFace") == "back") != bool(flags & STATE_FLAG_CULL_BACK):
            cull.append(name)
        prepass = state_of(data, techniques.depth_prepass) or {}
        if bool(state.get("depthWrite") or prepass.get("depthWrite")) != bool(flags & STATE_FLAG_WRITES_DEPTH):
            depth.append(name)
    if cull:
        print(
            f"      !! {len(cull)} of {checked} lit materials disagree with their own "
            f"stateFlags byte on cullFace: "
            f"{', '.join(cull[:5])}{' ...' if len(cull) > 5 else ''}"
        )
        print(
            f"         The lit technique index (0x{lit_technique:x} for this game) is "
            "probably wrong -- see TECHNIQUES_BY_GAME in scripts/cod/materials.py."
        )
    elif checked:
        print(
            f"      technique 0x{lit_technique:x} agrees with stateFlags on cullFace "
            f"{checked}/{checked}" + (f" ({fallback} unlit/emissive-only, not comparable)" if fallback else "")
        )
    if depth:
        print(f"      ({len(depth)} of {checked} disagree on depthWrite, which nothing downstream reads: {', '.join(depth[:3])})")
    return len(cull)


def material_file_stem(name):
    """Where OAT writes a material's JSON, as a path stem under `materials/`.

    Black Ops' generated layer materials (`*342n_22(a:b)`) are not legal paths,
    so OAT writes them as `generated/_342n_22`. The rule is lossy, hence a
    forward mapping from the name a surface asks for. A leading comma marks a
    material the map only references; its JSON is the companion zone's, unmarked.
    """
    name = name.removeprefix(",")
    if not name.startswith("*"):
        return name
    stem = name.replace("*", "_")
    cut = stem.find("(")
    if cut != -1:
        stem = stem[:cut]
    return f"generated/{stem}"


def classify_materials(mat_root, used, game_key):
    """(colour map per used material, decal names, dropped names, render state per dumped material).

    A decal is an `unlit` techset lying on a real surface; anything the game's
    SURFACES_BY_GAME rules drop is not a surface at all.
    """
    rules = SURFACES_BY_GAME[game_key]
    colormap, techset, states, sources = {}, {}, {}, {}
    for dirpath, _, files in os.walk(mat_root):
        for f in files:
            if not f.endswith(".json"):
                continue
            path = os.path.join(dirpath, f)
            name = os.path.relpath(path, mat_root)[:-5]
            data = read_json(path)
            techset[name] = data.get("techniqueSet") or ""
            sources[name] = data
            states[name] = material_render_state(data, game_key)
            image = colour_map(data, game_key)
            if image is not None:
                colormap[name] = image
    check_state_flags(sources, game_key)

    for name in used:
        stem = material_file_stem(name)
        if stem == name or name in techset:
            continue
        if stem in techset:
            techset[name] = techset[stem]
            states[name] = states[stem]
            if stem in colormap:
                colormap[name] = colormap[stem]

    drop = sorted(m for m in used if m.startswith(rules.drop_prefixes) or states.get(m, {}).get("drop"))
    decal = sorted(
        m for m in used if "unlit" in techset.get(m, "") and not any(t in techset[m] for t in ("falloff", *rules.not_decals))
    )
    return ({m: colormap[m] for m in used if m in colormap}, decal, drop, states)
