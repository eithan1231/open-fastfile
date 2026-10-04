"""One walker per IW6 asset type, and the walk over a whole zone.

Each walker is entered with the zone positioned at the asset's header, in the
block its loader allocates it in, and returns the asset's name. The order of
reads, pushes and alignments follows the game's Load_* functions (the Durango
build's, via reverse/iw6-zone/loadorder.py) and x64-zt's <asset>::write. Where the two disagree
the loader wins; the disagreements are noted where they are handled.
"""

import struct

from .records import (
    Anim,
    DeltaTrack,
    GfxGlobals,
    Image,
    ImageStream,
    Material,
    Model,
    ModelLod,
    ModelSurfs,
    Raw,
    Script,
    Surface,
    TechniqueSet,
    TextureDef,
)
from .zone import CALLBACK, RUNTIME, SCRIPT, TEMP, VIRTUAL, Zone, follows

# XAssetType, by number, without the ASSET_TYPE_ prefix (x64-zt structs.hpp; the zones' asset
# lists use no other value). reverse/iw6-zone/assets.py checks it against the header.
ASSET_TYPES = dict(
    enumerate(
        (
            "PHYSPRESET",
            "PHYSCOLLMAP",
            "XANIMPARTS",
            "XMODEL_SURFS",
            "XMODEL",
            "MATERIAL",
            "COMPUTESHADER",
            "VERTEXSHADER",
            "HULLSHADER",
            "DOMAINSHADER",
            "PIXELSHADER",
            "VERTEXDECL",
            "TECHNIQUE_SET",
            "IMAGE",
            "SOUND",
            "SOUND_CURVE",
            "LPF_CURVE",
            "REVERB_CURVE",
            "LOADED_SOUND",
            "CLIPMAP",
            "COMWORLD",
            "GLASSWORLD",
            "PATHDATA",
            "VEHICLE_TRACK",
            "MAP_ENTS",
            "FXWORLD",
            "GFXWORLD",
            "LIGHT_DEF",
            "UI_MAP",
            "FONT",
            "MENULIST",
            "MENU",
            "ANIMCLASS",
            "LOCALIZE_ENTRY",
            "ATTACHMENT",
            "WEAPON",
            "SNDDRIVER_GLOBALS",
            "FX",
            "IMPACT_FX",
            "SURFACE_FX",
            "AITYPE",
            "MPTYPE",
            "CHARACTER",
            "XMODELALIAS",
            "RAWFILE",
            "SCRIPTFILE",
            "STRINGTABLE",
            "LEADERBOARD",
            "STRUCTURED_DATA_DEF",
            "TRACER",
            "VEHICLE",
            "ADDON_MAP_ENTS",
            "NET_CONST_STRINGS",
            "REVERB_PRESET",
            "LUA_FILE",
            "SCRIPTABLE",
            "COLORIZATION",
            "COLORIZATIONSET",
            "TONEMAPPING",
            "EQUIPMENT_SND_TABLE",
            "VECTORFIELD",
            "DOPPLER_PRESET",
            "PARTICLE_SIM_ANIMATION",
            "STRING",
            "ASSETLIST",
        )
    )
)

WALKERS = {}


def walker(*types):
    def register(fn):
        for t in types:
            WALKERS[t] = fn
        return fn

    return register


def asset(z, typename, value, storage=None):
    """A handle to an asset of `typename` (XAssetType name without ASSET_TYPE_)."""
    return z.handle(value, WALKERS[typename], typename, storage)


def field_asset(z, record, path, typename):
    return asset(z, typename, record[path], record.address(path))


# --- zone ------------------------------------------------------------------


class ZoneWalk:
    def __init__(self, data, types, layout=None, stream_files=()):
        self.z = Zone(data, layout, stream_files)
        self.types = types  # XAssetType number -> name
        self.assets = []  # (type name, name, header file offset)
        self.failed = None

    def header(self):
        z = self.z
        z.take(72)  # XZoneMemory
        head = struct.unpack_from("<5Q", z.data, z.take(40))
        string_count, strings, asset_count, assets, globals_ = head
        z.push(VIRTUAL)
        z.push(VIRTUAL)
        if string_count and follows(strings):
            z.script_strings = z.strings_at(z.take(8 * string_count), string_count)
        z.pop()
        if follows(globals_):
            inner = z.u64(z.take(8))
            if follows(inner):
                gfx_globals(z)
        z.pop()
        z.push(VIRTUAL)
        z.align(3)
        self.asset_base = z.blocks[VIRTUAL]
        start = z.take(16 * asset_count)
        self.entries = [struct.unpack_from("<QQ", z.data, start + 16 * i) for i in range(asset_count)]
        for i, (kind, _) in enumerate(self.entries):
            # A reference to an asset is to its header pointer, the second half of its entry.
            self.z.slots[self.asset_base + 16 * i + 8] = (self.types.get(kind, kind), None)

    def walk(self, stop=None):
        """Walk every asset (or up to the first of type `stop`). Returns the index reached."""
        z = self.z
        for i, (kind, pointer) in enumerate(self.entries):
            typename = self.types.get(kind, f"type{kind}")
            if typename == stop:
                return i
            if typename not in WALKERS:
                self.failed = (i, typename, "no walker")
                return i
            at = z.pos
            try:
                # An entry can alias an asset already embedded in an earlier one; nothing follows then.
                result = asset(z, typename, pointer)
                name = result[1] if result else None
            except Exception as error:  # noqa: BLE001 - reported with its position
                self.failed = (i, typename, f"{type(error).__name__}: {error} (header at 0x{at:x})")
                return i
            slot = self.asset_base + 16 * i + 8
            self.z.slots[slot] = (typename, name)
            emulator = getattr(z, "emulator", None)
            if emulator is not None and getattr(emulator, "last_header", None):
                # What Load_XAssetHeader leaves in the list: the registered header, for later aliases.
                emulator.put64(emulator.block_address(VIRTUAL, slot), emulator.last_header)
                emulator.last_header = None
            self.assets.append((typename, name, at))
            z.check()
        return len(self.entries)


def gfx_globals(z):
    g = z.struct("XGfxGlobals")
    depth_stencil = z.elements(g, "depthStencilStateBits", g["depthStencilStateCount"], align=3)
    blend = z.elements(g, "blendStateBits", g["blendStateCount"], align=3)
    z.record("GFX_GLOBALS", None, GfxGlobals(depth_stencil, g["depthStencilStateCount"], blend, g["blendStateCount"]))
    z.push(RUNTIME)
    for path, count in (("depthStencilStates", "depthStencilStateCount"), ("blendStates", "blendStateCount")):
        if follows(g[path]):
            z.align(3)
            z.take(z.layout.size("GfxZoneTableEntry") * g[count])
    z.pop()
    z.elements(g, "perPrimConstantBufferSizes", g["perPrimConstantBufferCount"], align=3)
    z.elements(g, "perObjConstantBufferSizes", g["perObjConstantBufferCount"], align=3)
    z.elements(g, "stableConstantBufferSizes", g["stableConstantBufferCount"], align=3)
    z.push(RUNTIME)
    for path in ("perPrimConstantBuffers", "perObjConstantBuffers", "stableConstantBuffers"):
        if follows(g[path]):
            z.align(3)
            z.take(z.layout.size("GfxZoneTableEntry") * g[path.replace("Buffers", "BufferCount")])
    z.pop()


# --- images, materials, techsets ---------------------------------------------

WATER = 11  # MaterialTextureDef.semantic for a water_t rather than an image
IMAGE_STREAMS = 4  # GfxImage.streams, and the XStreamFile entries a streamed image takes
STREAM_DATA = struct.Struct("<HHI")  # GfxImageStreamData: width, height, pixelSize:26 | levelCount:6


@walker("IMAGE")
def image(z):
    img = z.struct("GfxImage")
    z.push(VIRTUAL)
    name = z.field_string(img, "name")
    pixels = z.aliased(img, "pixelData", 1 if img["semantic"] == WATER else img["dataLen1"], align=3)
    z.pop()
    record = Image(
        name,
        img["imageFormat"],
        img["mapType"],
        img["semantic"],
        img["width"],
        img["height"],
        img["depth"],
        img["numElements"],
        img["levelCount"],
        pixels,
        img["dataLen1"],
    )
    if img["streamed"]:
        at = img.at + z.layout.resolve("GfxImage", "streams")[0]
        for k in range(IMAGE_STREAMS):
            width, height, packed = STREAM_DATA.unpack_from(z.data, at + STREAM_DATA.size * k)
            record.streams.append(ImageStream(width, height, packed >> 26, packed & 0x3FFFFFF))
        record.stream_files = z.take_stream_files(IMAGE_STREAMS)
    z.record("IMAGE", name, record)
    return name


@walker("MATERIAL")
def material(z):
    mat = z.struct("Material")
    z.push(VIRTUAL)
    name = z.field_string(mat, "name")
    techset = field_asset(z, mat, "techniqueSet", "TECHNIQUE_SET")
    textures = []
    if follows(mat["textureTable"]):
        z.blocks[CALLBACK] += 4 * mat["textureCount"]
        z.align(3)
        for tex in z.array("MaterialTextureDef", mat["textureCount"]):
            image = None
            if tex["semantic"] == WATER:
                if follows(tex["u.image"]):
                    raise NotImplementedError(f"material {name}: water texture")
            else:
                image = field_asset(z, tex, "u.image", "IMAGE")
            ends = (chr(tex["nameStart"] & 0xFF), chr(tex["nameEnd"] & 0xFF))
            textures.append(TextureDef(tex["nameHash"], *ends, tex["samplerState"], tex["semantic"], image and image[1]))
    constants = z.elements(mat, "constantTable", mat["constantCount"], align=15)
    state_bits = z.elements(mat, "stateBitsTable", mat["stateBitsCount"], align=3)
    if follows(mat["constantBufferTable"]):
        z.align(3)
        for cb in z.array("MaterialConstantBufferDef", mat["constantBufferCount"]):
            for stage in ("vs", "hs", "ds", "ps"):
                z.elements(cb, f"{stage}Data", cb[f"{stage}DataSize"], align=15)
            for stage in ("vs", "hs", "ds", "ps"):
                z.elements(cb, f"{stage}OffsetData", cb[f"{stage}OffsetDataSize"], align=1)
            cb.touch("vsConstantBuffer", "hsConstantBuffer", "dsConstantBuffer", "psConstantBuffer")
    if follows(mat["subMaterials"]):
        start = z.elements(mat, "subMaterials", mat["layerCount"], align=7)
        z.strings_at(start, mat["layerCount"])
    z.pop()
    z.record("MATERIAL", name, Material(name, mat.at, techset and techset[1], textures, state_bits, constants))
    return name


TECHNIQUE_COUNT = 412


@walker("TECHNIQUE_SET")
def technique_set(z):
    ts = z.struct("MaterialTechniqueSet")
    z.push(VIRTUAL)
    name = z.field_string(ts, "name")
    techniques = {}
    for t in range(TECHNIQUE_COUNT):
        if not follows(ts[f"techniques[{t}]"]):
            continue
        z.align(3)
        hdr = z.struct("MaterialTechniqueHeader")
        for p in z.array("MaterialPass", hdr["passCount"]):
            field_asset(z, p, "vertexShader", "VERTEXSHADER")
            field_asset(z, p, "vertexDecl", "VERTEXDECL")
            field_asset(z, p, "hullShader", "HULLSHADER")
            field_asset(z, p, "domainShader", "DOMAINSHADER")
            field_asset(z, p, "pixelShader", "PIXELSHADER")
            count = p["perPrimArgCount"] + p["perObjArgCount"] + p["stableArgCount"]
            if follows(p["args"]):
                z.align(3)
                for arg in z.array("MaterialShaderArgument", count):
                    if arg["type"] == 4:
                        z.elements(arg, "u.literalConst", 4, align=3, size=4)
                    else:
                        arg.touch("u.literalConst")
        techniques[t] = z.field_string(hdr, "name")
    z.pop()
    z.record("TECHNIQUE_SET", name, TechniqueSet(name, techniques))
    return name


@walker("VERTEXDECL")
def vertex_decl(z):
    decl = z.struct("MaterialVertexDeclaration")
    z.push(VIRTUAL)
    name = z.field_string(decl, "name")
    z.pop()
    return name


def _shader(typename, temp_program):
    def walk(z):
        shader = z.struct(typename)
        z.push(VIRTUAL)
        name = z.field_string(shader, "name")
        if temp_program:
            z.push(TEMP)
        z.elements(shader, "prog.loadDef.program", shader["prog.loadDef.programSize"], align=3, size=1)
        if temp_program:
            z.pop()
        z.pop()
        return name

    return walk


walker("VERTEXSHADER")(_shader("MaterialVertexShader", False))
walker("PIXELSHADER")(_shader("MaterialPixelShader", False))
walker("HULLSHADER")(_shader("MaterialHullShader", True))
walker("DOMAINSHADER")(_shader("MaterialDomainShader", True))


# --- models ------------------------------------------------------------------


@walker("XMODEL")
def xmodel(z):
    model = z.struct("XModel")
    z.push(VIRTUAL)
    name = z.field_string(model, "name")
    bones, roots = model["numBones"], model["numRootBones"]
    children = bones - roots
    record = Model(name, [], at=model.at, bone_count=bones, root_bone_count=roots)

    def shared(taken, path):
        """A bone array's offset, whether it streamed here or an earlier model already carried it.

        Ghosts ships a camo variant as a whole XModel whose skeleton pointers
        address the first variant's bytes instead of following: four of the five
        `viewhands_us_rangers_*` do. Read as absent, such a model packs as a
        heap of unskinned meshes that no clip moves, which still renders.
        """
        return taken if taken is not None else z.located(model[path])

    record.bone_names = shared(z.elements(model, "boneNames", bones, align=3), "boneNames")
    record.parents = shared(z.elements(model, "parentList", children), "parentList")
    record.tag_angles = shared(z.elements(model, "tagAngles", children, align=1), "tagAngles")
    record.tag_positions = shared(z.elements(model, "tagPositions", children, align=3), "tagPositions")
    z.elements(model, "partClassification", bones)
    record.base_mat = shared(z.elements(model, "baseMat", bones, align=3), "baseMat")
    z.elements(model, "reactiveMotionParts", model["numReactiveMotionParts"], align=15)
    z.blocks[CALLBACK] += 4 * model["numsurfs"]
    materials = z.handles(model, "materialHandles", model["numsurfs"], material, "MATERIAL")
    record.materials = [m[1] if m else None for m in materials]
    for i in range(6):
        lod = f"lodInfo[{i}]."
        surfs = field_asset(z, model, lod + "modelSurfs", "XMODEL_SURFS")
        model.touch(lod + "surfs")
        if surfs or i < model["numLods"]:
            record.lods.append(
                ModelLod(surfs and surfs[1], model[lod + "surfIndex"], model[lod + "numsurfs"], model[lod + "dist"])
            )
    z.elements(model, "collSurfs", model["numCollSurfs"], align=3)
    record.bone_info = shared(z.elements(model, "boneInfo", bones, align=3), "boneInfo")
    z.elements(model, "invHighMipRadius", model["numsurfs"], align=1)
    preset = field_asset(z, model, "physPreset", "PHYSPRESET")
    collmap = field_asset(z, model, "physCollmap", "PHYSCOLLMAP")
    record.phys_preset, record.phys_collmap = preset and preset[1], collmap and collmap[1]
    z.pop()
    z.record("XMODEL", name, record)
    return name


@walker("XMODEL_SURFS")
def xmodel_surfs(z):
    surfs = z.struct("XModelSurfs")
    z.push(VIRTUAL)
    name = z.field_string(surfs, "name")
    surfaces = []
    if follows(surfs["surfs"]):
        z.align(3)
        surfaces = [xsurface(z, surface) for surface in z.array("XSurface", surfs["numsurfs"])]
    z.pop()
    z.record("XMODEL_SURFS", name, ModelSurfs(name, surfaces))
    return name


SURF_FLAG_MOTION = 0x8  # GfxPackedMotionVertex (x64-zt SURF_FLAG_REACTIVE_MOTION)
SUBDIV_ALIGN = [3, 3, 3]  # struct, levels, level arrays; x64-zt aligns the levels to 16, the block sizes say 4
BLEND_WEIGHTS = (1, 3, 5, 7, 9, 11, 13, 15)  # u16s per blended vertex, by bone count
XSURFACE_RUNTIME = (
    "vb0",
    "vb0View",
    "indexBuffer",
    "blendVertsBuffer",
    "blendVertsView",
    "vblmapBuffer",
    "vblmapView",
    "tensionAccumTableBuffer",
    "tensionAccumTableView",
    "tensionDataBuffer",
    "tensionDataView",
    "indexBufferView",
)


def xsurface(z, s):
    """Walk one XSurface's data; returns its geometry as a Surface.

    Surfaces identical to an earlier one alias its arrays, which are then read
    where they were first loaded."""
    verts = s["vertCount"]
    motion = bool(s["flags"] & SURF_FLAG_MOTION)
    vertices = None
    if follows(s["verts0.verts0"]):
        z.align(15)
        vertices = z.take(z.layout.size("GfxPackedMotionVertex" if motion else "GfxPackedVertex") * verts)
    s.touch("verts0.packedVerts0")
    triangles = z.elements(s, "triIndices", s["triCount"], align=15)
    rigid_lists = None
    if follows(s["rigidVertLists"]):
        z.align(3)
        lists = z.array("XRigidVertList", s["rigidVertListCount"])
        rigid_lists = lists[0].at if lists else None
        for rigid in lists:
            if follows(rigid["collisionTree"]):
                z.align(3)
                tree = z.struct("XSurfaceCollisionTree")
                z.elements(tree, "nodes", tree["nodeCount"], align=15)
                z.elements(tree, "leafs", tree["leafCount"], align=1)
    counts = struct.unpack("<8h", s.bytes("blendVertCounts"))
    blend_verts = z.elements(s, "blendVerts", sum(w * n for w, n in zip(BLEND_WEIGHTS, counts, strict=True)), align=1, size=2)
    blend_table = z.elements(s, "blendVertsTable", verts, align=0, size=32)
    z.elements(s, "lmapUnwrap", verts, align=3, size=8)
    subdivided = bool(s["subdiv"])
    if follows(s["subdiv"]):
        z.align(SUBDIV_ALIGN[0])
        info = z.struct("XSurfaceSubdivInfo")
        if follows(info["levels"]):
            z.align(SUBDIV_ALIGN[1])
            for level in z.array("XSurfaceSubdivLevel", s["subdivLevelCount"]):
                patches = level["regularPatchCount"]
                for path, count, size in (
                    ("rigidVertLists", s["rigidVertListCount"], 16),
                    ("faceIndices", level["faceCount"], 12),
                    ("regularPatchIndices", patches, 32),
                    ("regularPatchFlags", patches, 4),
                    ("facePoints", level["facePointBufferSize"] & ~3, 1),
                    ("edgePoints", level["edgePointCount"], 8),
                    ("vertexPoints", level["vertexPointBufferSize"] & ~3, 1),
                    ("normals", level["normalBufferSize"] & ~3, 1),
                    ("transitionPoints", level["transitionPointCount"], 4),
                    ("regularPatchCones", patches, 32),
                ):
                    z.elements(level, path, count, align=SUBDIV_ALIGN[2], size=size)
    z.elements(s, "tensionData", sum(counts), align=3, size=4)
    z.elements(s, "tensionAccumTable", verts, align=1, size=32)
    s.touch(*XSURFACE_RUNTIME)

    def where(taken, path):
        return taken if taken is not None else z.located(s[path])

    return Surface(
        where(vertices, "verts0.verts0"),
        verts,
        motion,
        where(triangles, "triIndices"),
        s["triCount"],
        s["flags"],
        where(rigid_lists, "rigidVertLists"),
        s["rigidVertListCount"],
        counts,
        where(blend_verts, "blendVerts"),
        where(blend_table, "blendVertsTable"),
        subdivided,
    )


@walker("PHYSPRESET")
def phys_preset(z):
    preset = z.struct("PhysPreset")
    z.push(VIRTUAL)
    name = z.field_string(preset, "name")
    z.field_string(preset, "sndAliasPrefix")
    z.pop()
    return name


@walker("PHYSCOLLMAP")
def phys_collmap(z):
    collmap = z.struct("PhysCollmap")
    z.push(VIRTUAL)
    name = z.field_string(collmap, "name")
    if follows(collmap["geoms"]):
        z.align(3)
        for geom in z.array("PhysGeomInfo", collmap["count"]):
            if follows(geom["brushWrapper"]):
                z.align(3)
                brush_wrapper(z)
    z.pop()
    return name


def brush_wrapper(z):
    wrapper = z.struct("BrushWrapper")
    sides = wrapper["brush.numsides"]
    if follows(wrapper["brush.sides"]):
        for side in z.array("cbrushside_t", sides):
            z.elements(side, "plane", 1, align=3)
    z.elements(wrapper, "brush.baseAdjacentSide", wrapper["totalEdgeCount"], align=0)
    z.elements(wrapper, "planes", sides, align=3)


# --- animation ---------------------------------------------------------------


@walker("XANIMPARTS")
def xanim_parts(z):
    parts = z.struct("XAnimParts")
    z.push(VIRTUAL)
    name = z.field_string(parts, "name")
    record = Anim(name, parts.at)
    record.names = z.elements(parts, "names", parts["boneCount[9]"], align=3)
    record.notify = z.elements(parts, "notify", parts["notifyCount"], align=3)
    wide = parts["numframes"] >= 256
    if follows(parts["deltaPart"]):
        z.align(3)
        delta = z.struct("XAnimDeltaPart")
        if follows(delta["trans"]):
            z.align(3)
            at = z.take(8)
            size, small = struct.unpack_from("<HB", z.data, at)
            track = DeltaTrack(size, small=bool(small))
            if size:
                track.frames = z.take(32)  # mins, size, then the frames pointer
                track.indices = z.take((size + 1) * (2 if wide else 1))
                if follows(z.u64(track.frames + 24)):
                    if small:
                        z.align(0)
                        track.values = z.take(3 * (size + 1))
                    else:
                        z.align(3)
                        track.values = z.take(6 * (size + 1))
                else:
                    track.values = z.located(z.u64(track.frames + 24))
            else:
                track.values = z.take(12)
            record.delta_trans = track
        for path, frame in (("quat2", 4), ("quat", 8)):
            if follows(delta[path]):
                z.align(3)
                size = struct.unpack_from("<H", z.data, z.take(8))[0]
                track = DeltaTrack(size)
                if size:
                    frames = z.take(8)
                    track.indices = z.take((size + 1) * (2 if wide else 1))
                    if follows(z.u64(frames)):
                        z.align(3)
                        track.values = z.take(frame * (size + 1))
                    else:
                        track.values = z.located(z.u64(frames))
                else:
                    track.values = z.take(frame)
                setattr(record, f"delta_{path}", track)
    record.data_byte = z.elements(parts, "dataByte", parts["dataByteCount"], align=0)
    record.data_short = z.elements(parts, "dataShort", parts["dataShortCount"], align=1)
    record.data_int = z.elements(parts, "dataInt", parts["dataIntCount"], align=3)
    record.random_short = z.elements(parts, "randomDataShort", parts["randomDataShortCount"], align=1)
    record.random_byte = z.elements(parts, "randomDataByte", parts["randomDataByteCount"], align=0)
    z.elements(parts, "randomDataInt", parts["randomDataIntCount"], align=3)
    if wide:
        record.indices = z.elements(parts, "indices.data", parts["indexCount"], align=1, size=2)
    else:
        z.elements(parts, "indices.data", parts["indexCount"], align=0, size=1)
    parts.touch("indices._1")
    z.pop()
    z.record("XANIMPARTS", name, record)
    return name


# --- sound -------------------------------------------------------------------

SAT_LOADED, SAT_STREAMED, SAT_PRIMED = 1, 2, 3


@walker("SOUND")
def sound(z):
    alias_list = z.struct("snd_alias_list_t")
    z.push(VIRTUAL)
    name = z.field_string(alias_list, "name")
    alias_list.touch("aliasName")
    if follows(alias_list["head"]):
        z.align(3)
        for alias in z.array("snd_alias_t", alias_list["count"]):
            alias.touch("name")
            for path in ("aliasName", "subtitle", "secondaryAliasName", "chainAliasName", "mixerGroup"):
                z.field_string(alias, path)
            if follows(alias["soundFile"]):
                z.align(3)
                sound_file(z)
            field_asset(z, alias, "volumeFalloffCurve", "SOUND_CURVE")
            field_asset(z, alias, "lpfCurve", "LPF_CURVE")
            field_asset(z, alias, "reverbSendCurve", "REVERB_CURVE")
            if follows(alias["speakerMap"]):
                z.align(3)
                speaker = z.struct("SpeakerMap")
                z.field_string(speaker, "name")
            # Not written by x64-zt; Load_snd_alias_tArray reads 0x20 bytes.
            z.elements(alias, "occlusionShape", 1, align=3, size=0x20)
            field_asset(z, alias, "dopplerPreset", "DOPPLER_PRESET")
    z.pop()
    return name


def sound_file(z):
    sf = z.struct("SoundFile")
    kind = sf["type"]
    sf.touch("u.loadSnd", "u.streamSnd.filename.info.raw.dir", "u.streamSnd.filename.info.raw.name", "u.primedSnd.loadedPart")
    if kind == SAT_LOADED:
        field_asset(z, sf, "u.loadSnd", "LOADED_SOUND")
    elif kind in (SAT_STREAMED, SAT_PRIMED):
        # Load_PrimedSound: the file name first, then the loaded part (x64-zt has them the other way).
        if sf["u.streamSnd.filename.fileIndex"] == 0:
            z.field_string(sf, "u.streamSnd.filename.info.raw.dir")
            z.field_string(sf, "u.streamSnd.filename.info.raw.name")
        if kind == SAT_PRIMED:
            field_asset(z, sf, "u.primedSnd.loadedPart", "LOADED_SOUND")


@walker("LOADED_SOUND")
def loaded_sound(z):
    snd = z.struct("LoadedSound")
    z.push(VIRTUAL)
    name = z.field_string(snd, "name")
    z.aliased(snd, "sound.data", snd["sound.loadedSize"])
    z.elements(snd, "sound.seekTable", snd["sound.seekTableSize"], size=1)
    z.pop()
    return name


@walker("SOUND_CURVE", "LPF_CURVE", "REVERB_CURVE")
def sound_curve(z):
    curve = z.struct("SndCurve")
    z.push(VIRTUAL)
    name = z.field_string(curve, "filename")
    curve.touch("name")
    z.pop()
    return name


@walker("DOPPLER_PRESET")
def doppler_preset(z):
    preset = z.struct("DopplerPreset")
    z.push(VIRTUAL)
    name = z.field_string(preset, "p_name")
    preset.touch("name")
    z.pop()
    return name


def sound_alias_name(z, record, path):
    """A snd_alias_list_t* stored by name (Load_SndAliasCustom -> Load_XStringPtr):
    8-aligned, a string pointer, then the string."""
    if not follows(record[path]):
        return None
    z.align(7)
    inner = z.u64(z.take(8))
    return z.string(inner)


# --- small assets --------------------------------------------------------------


@walker("RAWFILE")
def rawfile(z):
    raw = z.struct("RawFile")
    z.push(VIRTUAL)
    name = z.field_string(raw, "name")
    size = raw["compressedLen"] or raw["len"] + 1
    buffer = z.elements(raw, "buffer", size, size=1)
    z.pop()
    z.record("RAWFILE", name, Raw(name, buffer, raw["compressedLen"], raw["len"]))
    return name


@walker("SCRIPTFILE")
def scriptfile(z):
    script = z.struct("ScriptFile")
    z.push(VIRTUAL)
    name = z.field_string(script, "name")
    z.push(SCRIPT)
    buffer = z.elements(script, "buffer", script["compressedLen"], size=1)
    bytecode = z.elements(script, "bytecode", script["bytecodeLen"], size=1)
    z.pop()
    z.pop()
    z.record("SCRIPTFILE", name, Script(name, script.at, buffer, bytecode))
    return name


@walker("NET_CONST_STRINGS")
def net_const_strings(z):
    ncs = z.struct("NetConstStrings")
    z.push(VIRTUAL)
    name = z.field_string(ncs, "name")
    start = z.elements(ncs, "stringList", ncs["entryCount"], align=7)
    z.strings_at(start, ncs["entryCount"])
    z.pop()
    return name


@walker("COLORIZATION")
def colorization(z):
    c = z.struct("Colorization")
    z.push(VIRTUAL)
    name = z.field_string(c, "name")
    z.pop()
    return name


@walker("COLORIZATIONSET")
def colorization_set(z):
    s = z.struct("ColorizationSet")
    z.push(VIRTUAL)
    name = z.field_string(s, "name")
    # Load_ColorizationSet loads all five colorizations; x64-zt writes none of them.
    for path in ("colorization", "colorizationAlternate", "colorizationLow", "colorizationMid", "colorizationHigh"):
        field_asset(z, s, path, "COLORIZATION")
    field_asset(z, s, "alternateMaskMaterial", "MATERIAL")
    z.pop()
    return name


@walker("REVERB_PRESET")
def reverb_preset(z):
    r = z.struct("ReverbPreset")
    z.push(VIRTUAL)
    name = z.field_string(r, "p_name")
    z.pop()
    return name


@walker("TONEMAPPING")
def tonemapping(z):
    t = z.struct("ToneMapping")
    z.push(VIRTUAL)
    name = z.field_string(t, "name")
    z.pop()
    return name


@walker("COMWORLD")
def comworld(z):
    w = z.struct("ComWorld")
    z.push(VIRTUAL)
    name = z.field_string(w, "name")
    if follows(w["primaryLights"]):
        z.align(3)
        for light in z.array("ComPrimaryLight", w["primaryLightCount"]):
            z.field_string(light, "defName")
    z.elements(w, "primaryLightEnvs", w["primaryLightEnvCount"], align=3)
    z.pop()
    return name


@walker("LIGHT_DEF")
def light_def(z):
    d = z.struct("GfxLightDef")
    z.push(VIRTUAL)
    name = z.field_string(d, "name")
    field_asset(z, d, "attenuation.image", "IMAGE")
    field_asset(z, d, "cucoloris.image", "IMAGE")
    z.pop()
    return name


@walker("FXWORLD")
def fxworld(z):
    w = z.struct("FxWorld")
    z.push(VIRTUAL)
    name = z.field_string(w, "name")
    g = "glassSys."
    if follows(w[g + "defs"]):
        z.align(3)
        for d in z.array("FxGlassDef", w[g + "defCount"]):
            # Load_FxGlassDefArray: the preset before the materials (x64-zt writes it after).
            field_asset(z, d, "physPreset", "PHYSPRESET")
            field_asset(z, d, "material", "MATERIAL")
            field_asset(z, d, "materialShattered", "MATERIAL")
            for path in ("pieceBreakEffect", "shatterEffect", "shatterSmallEffect", "crackDecalEffect"):
                field_asset(z, d, path, "FX")
            for path in ("damagedSound", "destroyedSound", "destroyedQuietSound"):
                sound_alias_name(z, d, path)
    z.push(RUNTIME)
    limit, words = w[g + "pieceLimit"], w[g + "pieceWordCount"]
    for path, count, mask in (
        ("piecePlaces", limit, 3),
        ("pieceStates", limit, 3),
        ("pieceDynamics", limit, 3),
        ("geoData", w[g + "geoDataLimit"], 3),
        ("isInUse", words, 3),
        ("cellBits", words * w[g + "cellCount"], 3),
        ("visData", (limit + 15) & ~15, 15),
        ("linkOrg", limit, 3),
        ("halfThickness", (limit + 3) & ~3, 15),
    ):
        z.elements(w, g + path, count, align=mask)
    z.pop()
    z.elements(w, g + "lightingHandles", w[g + "initPieceCount"], align=1)
    z.elements(w, g + "initPieceStates", w[g + "initPieceCount"], align=3)
    z.elements(w, g + "initGeoData", w[g + "initGeoDataCount"], align=3)
    z.pop()
    return name


# --- effects -----------------------------------------------------------------

# FxElemType on PC. Durango has no APEX turbulence (6) or NVIDIA hair (7), so every
# type from 6 up is two higher here than in its loader.
FX_TRAIL, FX_FLARE, FX_PARTICLE_SIM = 3, 4, 5
FX_SPARK_FOUNTAIN, FX_MODEL, FX_OMNI_LIGHT, FX_SPOT_LIGHT = 10, 11, 12, 13
FX_SOUND, FX_DECAL, FX_RUNNER, FX_VECTORFIELD = 14, 15, 16, 17
FX_IMPACT_ENTRIES, FX_NONFLESH, FX_FLESH = 15, 31, 7  # FxImpactTable, from the Durango PDB


def fx_visual(z, elem_type, value, storage):
    """One FxElemVisuals, loaded by element type (Load_FxElemVisuals)."""
    if elem_type == FX_MODEL:
        asset(z, "XMODEL", value, storage)
    elif elem_type in (FX_RUNNER, FX_SOUND, FX_VECTORFIELD):
        z.string(value)
    elif elem_type == FX_PARTICLE_SIM:
        asset(z, "PARTICLE_SIM_ANIMATION", value, storage)
    elif elem_type == FX_SPOT_LIGHT:
        asset(z, "LIGHT_DEF", value, storage)
    elif elem_type != FX_OMNI_LIGHT:
        asset(z, "MATERIAL", value, storage)


def fx_elem_def(z, e):
    kind, count = e["elemType"], e["visualCount"]
    z.elements(e, "velSamples", e["velIntervalCount"] + 1, align=3)
    z.elements(e, "visSamples", e["visStateIntervalCount"] + 1, align=3)
    e.touch("visuals.instance.anonymous")
    if kind == FX_DECAL:
        if follows(e["visuals.markArray"]):
            z.align(3)
            for mark in z.array("FxElemMarkVisuals", count):
                for k in range(3):
                    field_asset(z, mark, f"materials[{k}]", "MATERIAL")
    elif count > 1:
        if follows(e["visuals.array"]):
            z.align(3)
            block, cursor = z.block, z.blocks[z.block]
            start = z.take(8 * count)
            for i in range(count):
                fx_visual(z, kind, z.u64(start + 8 * i), (block, cursor + 8 * i))
    else:
        fx_visual(z, kind, e["visuals.instance.anonymous"], e.address("visuals"))
    for path in ("effectOnImpact", "effectOnDeath", "effectEmitted"):
        z.field_string(e, path + ".name")
        e.touch(path + ".handle")
    extended = e["extended.trailDef"]
    e.touch("extended.sparkFountainDef", "extended.spotLightDef", "extended.flareDef", "extended.unknownDef")
    if kind == FX_TRAIL:
        if follows(extended):
            z.align(3)
            trail = z.struct("FxTrailDef")
            z.elements(trail, "verts", trail["vertCount"], align=3)
            z.elements(trail, "inds", trail["indCount"], align=1)
    elif kind in (FX_SPARK_FOUNTAIN, FX_SPOT_LIGHT):
        if follows(extended):
            z.align(3)
            z.take(z.layout.size("FxSparkFountainDef" if kind == FX_SPARK_FOUNTAIN else "FxSpotLightDef"))
    elif kind == FX_FLARE:
        if follows(extended):
            z.align(3)
            flare = z.struct("FxFlareDef")
            for path in ("intensityX", "intensityY", "srcCosIntensity", "srcCosScale"):
                z.elements(flare, path, flare[path + "IntervalCount"] + 1, align=3)
    elif extended:
        z.take(1)  # Load_FxElemExtendedDefPtr loads one byte for any other non-null pointer


@walker("FX")
def fx(z):
    d = z.struct("FxEffectDef")
    z.push(VIRTUAL)
    name = z.field_string(d, "name")
    count = d["elemDefCountLooping"] + d["elemDefCountOneShot"] + d["elemDefCountEmission"]
    if follows(d["elemDefs"]):
        z.align(3)
        for e in z.array("FxElemDef", count):
            fx_elem_def(z, e)
    z.pop()
    return name


@walker("PARTICLE_SIM_ANIMATION")
def particle_sim_animation(z):
    a = z.struct("FxParticleSimAnimation")
    z.push(VIRTUAL)
    name = z.field_string(a, "name")
    field_asset(z, a, "material", "MATERIAL")
    z.elements(a, "particleData", a["header.particleDataCount"], align=31)
    z.elements(a, "frames", a["header.frameCount"], align=3)
    z.elements(a, "colorTable", a["header.colorTableSize"], align=3)
    z.pop()
    return name


@walker("IMPACT_FX")
def impact_fx(z):
    table = z.struct("FxImpactTable")
    z.push(VIRTUAL)
    name = z.field_string(table, "name")
    if follows(table["table"]):
        z.align(3)
        for entry in z.array("FxImpactEntry", FX_IMPACT_ENTRIES):
            for k in range(FX_NONFLESH):
                field_asset(z, entry, f"nonflesh[{k}]", "FX")
            for k in range(FX_FLESH):
                field_asset(z, entry, f"flesh[{k}]", "FX")
    z.pop()
    return name


# The world, in gfxworld.py; registered there to keep this module importable on its own.
