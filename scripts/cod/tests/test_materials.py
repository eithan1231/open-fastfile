import json

from scripts.cod.materials import (
    check_state_flags,
    classify_materials,
    colour_map,
    drawn_state_and_technique,
    material_blend_mode,
    material_file_stem,
    material_layers,
    material_render_state,
    surface_images,
)


def material(entries, table, **extra):
    return {"stateBitsEntry": entries, "stateBits": table, **extra}


def test_lit_technique_differs_per_game():
    # 0x9 is LIT on IW4/IW5 and EMISSIVE_REFLECTED on T5, where LIT is 0xA.
    entries = [-1] * 16
    entries[0x9], entries[0xA] = 0, 1
    table = [{"cullFace": "back"}, {"cullFace": "none"}]
    data = material(entries, table)
    assert drawn_state_and_technique(data, "iw5") == ({"cullFace": "back"}, 0x9)
    assert drawn_state_and_technique(data, "t5") == ({"cullFace": "none"}, 0xA)


def test_iw6_draws_technique_7_then_unlit_2():
    entries = [-1] * 412
    entries[0x2], entries[0x7] = 0, 1
    table = [{"cullFace": "none"}, {"cullFace": "back"}]
    assert drawn_state_and_technique(material(entries, table), "iw6") == ({"cullFace": "back"}, 0x7)
    entries[0x7] = -1
    assert drawn_state_and_technique(material(entries, table), "iw6") == ({"cullFace": "none"}, 0x2)


def test_falls_back_to_unlit_then_emissive():
    entries = [-1] * 16
    entries[0x5] = 0
    assert drawn_state_and_technique(material(entries, [{"x": 1}]), "iw5") == ({"x": 1}, 0x5)
    assert drawn_state_and_technique(material([], []), "iw5") == ({}, None)


def test_blend_modes():
    assert material_blend_mode({}) is None
    assert material_blend_mode({"blendOpRgb": "disabled"}) is None
    assert material_blend_mode({"blendOpRgb": "add", "srcBlendRgb": "one", "dstBlendRgb": "zero"}) is None
    assert material_blend_mode({"blendOpRgb": "add", "srcBlendRgb": "zero", "dstBlendRgb": "srccolor"}) == "multiply"
    assert material_blend_mode({"blendOpRgb": "add", "srcBlendRgb": "one", "dstBlendRgb": "one"}) == "add"
    assert material_blend_mode({"blendOpRgb": "add", "srcBlendRgb": "weird", "dstBlendRgb": "weird"}) == "alpha"


def test_iw6_blend_equations():
    def mode(src, dst):
        return material_blend_mode({"blendOpRgb": "add", "srcBlendRgb": src, "dstBlendRgb": dst})

    # D3D11 dual-source alpha, on every blended IW6 world material that is not a decal.
    assert mode("one", "invsrcalpha1") == "alpha"
    assert mode("srcalpha1", "invsrcalpha1") == "alpha"
    # The base pass of a two-pass layer blend (`*r`) replaces what is under it.
    assert mode("srcalpha", "zero") is None
    assert mode("srcalpha", "one") == "add"


def test_render_state():
    entries = [-1] * 16
    entries[0x9] = 0
    state = {"blendOpRgb": "disabled", "alphaTest": "ge128", "cullFace": "none"}
    data = material(entries, [state], techniqueSet="wc_l_sm_a0c0", sortKey=1, gameFlags=["80"])
    assert material_render_state(data, "iw5") == {
        "techniqueSet": "wc_l_sm_a0c0",
        "sortKey": 1,
        "blend": None,
        "alphaTest": "ge128",
        "doubleSided": True,
        "flag": None,
        "castsShadow": True,
        "layers": [],
        "drop": False,
    }


def test_state_flags_check_counts_only_lit_disagreements():
    entries = [-1] * 16
    entries[0x9] = 0
    agrees = material(entries, [{"cullFace": "back", "depthWrite": True}], stateFlags=0x9)
    disagrees = material(entries, [{"cullFace": "none", "depthWrite": True}], stateFlags=0x9)
    unlit_only = material([-1, -1, -1, -1, 0], [{"cullFace": "none"}], stateFlags=0x1)
    assert check_state_flags({"a": agrees, "u": unlit_only}, "iw5") == 0
    assert check_state_flags({"a": agrees, "d": disagrees}, "iw5") == 1


def test_depth_write_is_the_lit_pass_or_the_prepass(capsys):
    # IW6's lit pass tests against the depth its prepass (technique 0) wrote.
    entries = [-1] * 412
    entries[0x0], entries[0x7] = 0, 1
    table = [{"cullFace": "back", "depthWrite": True}, {"cullFace": "back", "depthWrite": False}]
    assert check_state_flags({"m": material(entries, table, stateFlags=0x9)}, "iw6") == 0
    assert "depthWrite" not in capsys.readouterr().out


def test_colour_map_prefers_the_named_slot_where_the_game_says_so():
    textures = [
        {"name": "revealMap", "semantic": "colorMap", "image": "mask"},
        {"name": "colorMap", "semantic": "colorMap", "image": "colour"},
        {"name": "colorMap", "semantic": "2D", "image": "ui"},
    ]
    assert colour_map({"textures": textures}, "iw6") == "colour"
    assert colour_map({"textures": textures}, "iw5") == "mask"  # unchanged: the first colorMap semantic
    assert colour_map({"textures": textures[2:]}, "iw6") is None


def write_material(root, name, techset, state):
    path = root / f"{material_file_stem(name)}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    entries = [-1] * 412
    entries[0x7] = 0
    textures = [{"name": "colorMap", "semantic": "colorMap", "image": name.replace("/", "_")}]
    path.write_text(json.dumps({"techniqueSet": techset, "stateBitsEntry": entries, "stateBits": [state], "textures": textures}))


def test_iw6_surface_rules(tmp_path, capsys):
    opaque = {"blendOpRgb": "disabled", "cullFace": "back"}
    multiply = {"blendOpRgb": "add", "srcBlendRgb": "zero", "dstBlendRgb": "srccolor", "cullFace": "back"}
    cutout = {**opaque, "alphaTest": "ge128"}
    for name, techset, state in (
        ("wc/stain", "wc_unlit_multiply_lin_ndw_bl_nfwpf", multiply),
        ("wc/vista", "wc_unlit_atest_lin_bl_nfwpf", cutout),
        ("wc/canopy", "wc_unlit_atest_lin_flagext_wv0wv1wv2_onlycast_bl_nfwpf", cutout),
        ("wc/stream_dist", "wc_distortion_scale_ua_zfeather", opaque),
        ("*a101dn_101y", "w_l_sm_r0c0z0n0s0l0_y1_nfwpf", opaque),
        ("*r101dn_101z", "w_l_sm_r0c0z0n0s0l0_z1_nfwpf", opaque),
    ):
        write_material(tmp_path, name, techset, state)
    used = {"wc/stain", "wc/vista", "wc/canopy", "wc/stream_dist", "*a101dn_101y", "*r101dn_101z"}

    colours, decals, drop, states = classify_materials(str(tmp_path), used, "iw6")
    assert decals == ["wc/stain"]
    assert drop == ["*a101dn_101y", "wc/canopy", "wc/stream_dist"]
    assert colours["*r101dn_101z"] == "*r101dn_101z"

    # The same dumps read as IW5 keep IW5's rules.
    _, decals, drop, _ = classify_materials(str(tmp_path), used, "iw5")
    assert decals == ["wc/canopy", "wc/stain", "wc/vista"]
    assert drop == []
    capsys.readouterr()


def test_material_file_stem():
    assert material_file_stem("wc/concrete") == "wc/concrete"
    assert material_file_stem("*342n_22(wc/a:wc/b)") == "generated/_342n_22"
    assert material_file_stem(",wc/decal_flag_nazi_theater") == "wc/decal_flag_nazi_theater"


def test_a_dropped_non_surface_asks_for_no_image(tmp_path):
    write_material(tmp_path, "wpc/shadowcaster", "wpc_shadowcaster_wj6w5j60", {"cullFace": "back"})
    write_material(tmp_path, "wpc/brick", "wpc_l_sm_r0c0_nfwpf", {"cullFace": "back"})
    colours, _, drop, _ = classify_materials(str(tmp_path), {"wpc/shadowcaster", "wpc/brick"}, "t6")
    assert drop == ["wpc/shadowcaster"]
    assert surface_images(colours, drop) == {"wpc_brick"}


def colour_slots(*images):
    return [
        {"name": "colorMap" + (str(k) if k else ""), "semantic": "colorMap", "image": image} for k, image in enumerate(images)
    ]


def test_a_black_ops_techset_spells_its_layers():
    data = {"techniqueSet": "l_sm_r0c0n0s0x0_b1c1n1s1x1_m2c2", "textures": colour_slots("mud", "snow", "grime")}
    assert material_layers(data, "t5") == [{"mode": "blend", "image": "snow"}, {"mode": "multiply", "image": "grime"}]
    assert material_render_state(data, "t5")["layers"] == material_layers(data, "t5")
    # Other games' layered techsets are not read yet.
    assert material_layers(data, "iw5") == []


def test_a_layer_that_cannot_be_drawn_ends_the_list():
    # The vertex data addresses layers by position, so layer 2 must not slide into layer 1's place.
    data = {"techniqueSet": "l_sm_r0c0_x1c1_b2c2", "textures": colour_slots("base", "one", "two")}
    assert material_layers(data, "t5") == []
    data = {"techniqueSet": "l_sm_r0c0_b1c1_a2c2", "textures": colour_slots("base", "one")}
    assert material_layers(data, "t5") == [{"mode": "blend", "image": "one"}]


def test_a_layered_shell_asks_for_its_layer_images():
    states = {"*1n_2n(a:b)": {"layers": [{"mode": "blend", "image": "b_c"}]}}
    assert surface_images({"*1n_2n(a:b)": "a_c"}, [], states) == {"a_c", "b_c"}
    assert surface_images({"*1n_2n(a:b)": "a_c"}, ["*1n_2n(a:b)"], states) == set()
