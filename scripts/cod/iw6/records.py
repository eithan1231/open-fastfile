"""What the walkers keep from a zone, beyond walking it: plain data, by asset type and name.

Offsets are into the decompressed zone (`Zone.data`); nothing here holds a zone.
A walker files a record with `Zone.record(type, name, value)`, and a reader looks
it up in `Zone.found[type][name]`.
"""

from dataclasses import dataclass, field


@dataclass
class Surface:
    """One XSurface: packed vertices and 16-bit triangle indices, local to the surface.

    Offsets are None where the data did not follow (aliased or absent). How the
    skinning arrays read: scripts/cod/iw6/skeleton.py."""

    vertices: int  # file offset of GfxPackedVertex (or GfxPackedMotionVertex) data
    vertex_count: int
    motion: bool  # GfxPackedMotionVertex; the position is laid out the same way
    triangles: int  # file offset of u16[3] per triangle
    triangle_count: int
    flags: int = 0  # XSurface.flags
    rigid_lists: int | None = None  # file offset of XRigidVertList[rigid_list_count]
    rigid_list_count: int = 0
    blend_counts: tuple[int, ...] = ()  # XSurface.blendVertCounts: vertices with 1..8 bones
    blend_verts: int | None = None  # file offset of the XBlendInfo (u16) stream
    blend_table: int | None = None  # file offset of BlendVertsUnknown[vertex_count], 32 bytes each
    subdivided: bool = False  # has XSurfaceSubdivInfo, which nothing decodes


@dataclass
class ModelSurfs:
    name: str
    surfaces: list[Surface]


@dataclass
class ModelLod:
    surfs: str | None  # XModelSurfs name
    surface_index: int  # where this LOD's surfaces start in XModel.materials
    surface_count: int
    distance: float = 0.0  # XModelLodInfo.dist: where the next LOD takes over


@dataclass
class Model:
    """An XModel. Array fields are file offsets (None where they did not follow)."""

    name: str
    materials: list[str | None]
    lods: list[ModelLod] = field(default_factory=list)
    at: int | None = None  # the XModel header
    bone_count: int = 0
    root_bone_count: int = 0
    bone_names: int | None = None  # scr_string_t (u32) per bone, indexing Zone.script_strings
    parents: int | None = None  # u8 per non-root bone: how many bones back its parent is
    tag_angles: int | None = None  # XModelAngle per non-root bone
    tag_positions: int | None = None  # XModelTagPos per non-root bone
    base_mat: int | None = None  # DObjAnimMat per bone
    bone_info: int | None = None  # XBoneInfo per bone
    phys_preset: str | None = None
    phys_collmap: str | None = None


@dataclass
class ImageStream:
    """GfxImageStreamData. Stream 0 holds the coarse mip chain and each later one adds
    finer levels; level_count and pixel_size count every stream up to this one."""

    width: int
    height: int
    level_count: int
    pixel_size: int


@dataclass
class Image:
    """A GfxImage header, and where its pixels are: in the zone or in pak files."""

    name: str
    format: int  # DXGI_FORMAT
    map_type: int  # MapType: 3 2D, 4 3D, 5 cube, 6 array
    semantic: int
    width: int
    height: int
    depth: int
    elements: int
    level_count: int
    pixels: int | None  # zone offset of the loaded levels, if any
    pixel_size: int
    streams: list[ImageStream] = field(default_factory=list)
    stream_files: list = field(default_factory=list)  # ff.StreamFile per stream, when streamed


@dataclass
class TextureDef:
    """One MaterialTextureDef: which slot (by name hash) and what image fills it."""

    name_hash: int
    name_start: str  # the slot name's first and last characters
    name_end: str
    sampler: int
    semantic: int  # IMG_TS
    image: str | None


@dataclass
class Material:
    name: str
    at: int  # zone offset of the Material header, for the fields not copied here
    technique_set: str | None
    textures: list[TextureDef]
    state_bits: int | None = None  # zone offset of GfxStateBits[stateBitsCount]
    constants: int | None = None  # zone offset of MaterialConstantDef[constantCount]


@dataclass
class TechniqueSet:
    name: str
    techniques: dict[int, str]  # MaterialTechniqueType -> the technique's own name, for the slots present


@dataclass
class GfxGlobals:
    """Where a zone's shared render-state tables are (XGfxGlobals). A material's
    GfxStateBits indexes these rather than holding its depth and blend state."""

    depth_stencil: int | None  # zone offset of u64[depthStencilStateCount]
    depth_stencil_count: int
    blend: int | None  # zone offset of u32[blendStateCount]
    blend_count: int


@dataclass
class Loaded:
    """An asset the Durango loader walked (emulated.py): its header, copied into the
    emulator's memory as the game registers it. `memory.Struct` reads it."""

    struct: str  # the loader's struct name, e.g. clipMap_t
    address: int


@dataclass
class Placement:
    """A static model in the world (GfxStaticModelDrawInst.placement)."""

    model: str | None
    origin: tuple[float, float, float]
    axis: tuple[tuple[float, float, float], ...]  # rows: the model's x, y and z in world space
    scale: float

    def rotate(self, vector):
        x, y, z = vector
        return tuple(x * self.axis[0][i] + y * self.axis[1][i] + z * self.axis[2][i] for i in range(3))

    def transform(self, point):
        x, y, z = point
        return tuple(
            self.origin[i] + self.scale * (x * self.axis[0][i] + y * self.axis[1][i] + z * self.axis[2][i]) for i in range(3)
        )


@dataclass
class DeltaTrack:
    """One track of an XAnimDeltaPart (root motion). `size` keys + 1 when non-zero; with size 0
    `values` holds the one constant frame."""

    size: int
    small: bool = False  # translation keys are bytes, not u16
    frames: int | None = None  # translation only: mins and size (3 floats each)
    indices: int | None = None  # u8 or u16 per key, by the clip's frame count
    values: int | None = None


@dataclass
class Anim:
    """An XAnimParts: its header and where its arrays are (None where they did not follow).
    The flat arrays are decoded by dumpers/xanim.py."""

    name: str
    at: int
    names: int | None = None  # scr_string_t per bone
    notify: int | None = None  # XAnimNotifyInfo per notetrack
    data_byte: int | None = None
    data_short: int | None = None
    data_int: int | None = None
    random_short: int | None = None
    random_byte: int | None = None
    indices: int | None = None  # the u16 frame-index pool (clips of 256 frames and more)
    delta_trans: DeltaTrack | None = None
    delta_quat2: DeltaTrack | None = None
    delta_quat: DeltaTrack | None = None


@dataclass
class Script:
    """A compiled script (ScriptFile): its zlib string section and its bytecode."""

    name: str
    at: int
    buffer: int | None  # compressedLen bytes
    bytecode: int | None  # bytecodeLen bytes


@dataclass
class Raw:
    """A RawFile: a `.vision`, a `.sun` or a plain-text script, deflated when `compressed`."""

    name: str
    buffer: int | None  # `compressed` bytes, or `length` + 1 uncompressed
    compressed: int  # RawFile.compressedLen: 0 when the bytes are stored plain
    length: int  # RawFile.len: the text's length, without its terminator
