"""`image`: every image the zone names, once, as `images/<name>.iwi` or `.dds`.

Pixels come from the zone when its load definition carries them, and otherwise
from `images/<name>.iwi` in the `.iwd` archives on the search path. Each image is
written in the format OpenAssetTools would hand its writer: IWI v8 where IWI can
hold it, and DDS for what it cannot -- 24-bit colour (padded to 32, as OAT pads
it) and colour wavelets. Wavelet IWIs are decoded (scripts/cod/wavelet.py, with
the tables read from the game's executable). An IWI from an archive keeps its
payload; only its header is rewritten, as OAT rewrites it.

Images named with a leading comma live in another zone and are skipped.
"""

import struct
from collections import Counter, namedtuple

from ... import iwd, wavelet
from ...iw6.dumpers.common import asset_path
from . import dumper

FOLDER = "images"
NOMIPMAPS, CUBE, VOLUME = 0x2, 0x10000, 0x20000
MAPTYPE = CUBE | VOLUME
IWI_HEADER = struct.Struct("<3sBIbx3H4I")  # tag, version, flags, format, dims, file size per picmip
LOADDEF = struct.Struct("<B3xiii")  # levelCount, flags, format, resourceSize, then the data

# name: (pixels per block edge, bytes per block, IWI format, DDS pixel format flags and masks or DX10 format)
Format = namedtuple("Format", "block bytes iwi dds")
DDPF_ALPHA, DDPF_ALPHAPIXELS, DDPF_FOURCC, DDPF_RGB, DDPF_LUMINANCE = 0x2, 0x1, 0x4, 0x40, 0x20000
FORMATS = {
    "BGRA8": Format(1, 4, 1, (DDPF_RGB | DDPF_ALPHAPIXELS, 32, 0xFF0000, 0xFF00, 0xFF, 0xFF000000)),
    "BGR8": Format(1, 3, 2, None),  # padded to BGRX8 before it is written, as OAT pads it
    "BGRX8": Format(1, 4, None, (DDPF_RGB, 32, 0xFF0000, 0xFF00, 0xFF, 0)),
    "RGBA8": Format(1, 4, None, (DDPF_RGB | DDPF_ALPHAPIXELS, 32, 0xFF, 0xFF00, 0xFF0000, 0xFF000000)),
    "A8": Format(1, 1, 5, (DDPF_ALPHA, 8, 0, 0, 0, 0xFF)),
    "L8": Format(1, 1, 4, (DDPF_LUMINANCE, 8, 0xFF, 0, 0, 0)),
    "LA8": Format(1, 2, 3, (DDPF_LUMINANCE | DDPF_ALPHAPIXELS, 16, 0xFF, 0, 0, 0xFF00)),
    "DXT1": Format(4, 8, 11, b"DXT1"),
    "DXT3": Format(4, 16, 12, b"DXT3"),
    "DXT5": Format(4, 16, 13, b"DXT5"),
    "DXN": Format(4, 16, 14, 83),  # DXGI_FORMAT_BC5_UNORM
    # Black Ops' lightmap pages (t5/lightmap.py): DDS only, read back by that module alone.
    "R5G6B5": Format(1, 2, None, (DDPF_RGB, 16, 0xF800, 0x07E0, 0x001F, 0)),
    "G16R16": Format(1, 4, None, (DDPF_RGB, 32, 0xFFFF, 0xFFFF0000, 0, 0)),
}


def fourcc(text):
    return int.from_bytes(text, "little")


D3D = {
    20: "BGR8",
    21: "BGRA8",
    22: "BGRX8",
    23: "R5G6B5",
    28: "A8",
    32: "RGBA8",
    34: "G16R16",
    50: "L8",
    51: "LA8",
    fourcc(b"DXT1"): "DXT1",
    fourcc(b"DXT3"): "DXT3",
    fourcc(b"DXT5"): "DXT5",
}
IWI = {f.iwi: name for name, f in FORMATS.items() if f.iwi is not None}
WAVELET = {6: ("BGRA8", 4), 7: ("BGRX8", 3), 8: ("LA8", 2), 9: ("L8", 1), 10: ("A8", 1)}

# levels: [bytes] largest first, each holding every face of that level
Texture = namedtuple("Texture", "fmt maptype width height depth mips levels")


def file_name(name, ext):
    return f"{FOLDER}/{name.replace('*', '_')}{ext}"


def faces(maptype):
    return 6 if maptype == CUBE else 1


def level_count(width, height, depth, mips):
    return max(width, height, depth).bit_length() if mips else 1


def level_size(fmt, width, height, depth, level):
    f = FORMATS[fmt]
    w, h, d = (max(1, n >> level) for n in (width, height, depth))
    return -(-w // f.block) * -(-h // f.block) * d * f.bytes


def split_levels(fmt, maptype, width, height, depth, mips, data, largest_first):
    """The data cut into levels as OAT reads it; short data is padded (OAT reads past its end)."""
    count = level_count(width, height, depth, mips)
    sizes = [level_size(fmt, width, height, depth, i) * faces(maptype) for i in range(count)]
    data = bytes(data).ljust(sum(sizes), b"\0")
    order = range(count) if largest_first else range(count - 1, -1, -1)
    levels, at = [None] * count, 0
    for i in order:
        levels[i] = data[at : at + sizes[i]]
        at += sizes[i]
    return levels


def from_loaddef(record, raw):
    """A Texture from pixels the zone carries, or a reason it has none."""
    _levels, flags, d3d, size = LOADDEF.unpack_from(raw, 0)
    fmt = D3D.get(d3d & 0xFFFFFFFF)
    if fmt is None:
        return f"D3D format {d3d:#x}"
    maptype = flags & MAPTYPE if flags & MAPTYPE in (CUBE, VOLUME) else 0
    width, height, depth = record["width"], record["height"], record["depth"]
    if maptype == CUBE:
        height = width
    if maptype != VOLUME:
        depth = 1
    mips = not flags & NOMIPMAPS
    levels = split_levels(fmt, maptype, width, height, depth, mips, raw[LOADDEF.size : LOADDEF.size + size], True)
    return Texture(fmt, maptype, width, height, depth, mips, levels)


def from_iwi(data, tables):
    """A Texture from an IWI v8 file, or a reason it cannot be read."""
    if data[:4] != b"IWi\x08":
        return "not an IWI v8"
    _tag, _version, flags, fmtid, width, height, depth, *picmip = IWI_HEADER.unpack_from(data, 0)
    maptype = flags & MAPTYPE
    if maptype not in (0, CUBE, VOLUME):
        return "a 1D map"
    mips = not flags & NOMIPMAPS
    payload = data[IWI_HEADER.size :]
    if fmtid in WAVELET:
        fmt, channels = WAVELET[fmtid]
        if tables is None:
            return "a wavelet, and no executable to read its code tables from"
        if maptype == VOLUME or (not mips and width > 1 and height > 1):
            return "a wavelet volume, or one without mips"
        levels = wavelet.decode(payload, width, height, faces(maptype), channels, tables)
        return Texture(fmt, maptype, width, height, 1, mips, levels)
    fmt = IWI.get(fmtid)
    if fmt is None:
        return f"IWI format {fmtid}"
    if maptype != VOLUME:
        depth = 1
    count = level_count(width, height, depth, mips)
    total = IWI_HEADER.size
    for level in range(count - 1, -1, -1):
        total += level_size(fmt, width, height, depth, level) * faces(maptype)
        if level < 4 and picmip[level] != total:
            return "sizes that do not match its header"  # OAT refuses these too
    if len(data) < total:
        return "a truncated file"
    return Texture(
        fmt, maptype, width, height, depth, mips, split_levels(fmt, maptype, width, height, depth, mips, payload, False)
    )


def padded(texture):
    """24-bit colour as 32 (X = 0xFF), which is what OAT writes for it."""
    if texture.fmt != "BGR8":
        return texture
    levels = []
    for level in texture.levels:
        out = bytearray(len(level) // 3 * 4)
        out[0::4], out[1::4], out[2::4], out[3::4] = level[0::3], level[1::3], level[2::3], b"\xff" * (len(level) // 3)
        levels.append(bytes(out))
    return texture._replace(fmt="BGRX8", levels=levels)


def iwi_bytes(t):
    flags = (0 if t.mips else NOMIPMAPS) | t.maptype
    picmip, total = [0, 0, 0, 0], IWI_HEADER.size
    for level in range(len(t.levels) - 1, -1, -1):
        total += len(t.levels[level])
        if level < 4:
            picmip[level] = total
    header = IWI_HEADER.pack(b"IWi", 8, flags, FORMATS[t.fmt].iwi, t.width, t.height, t.depth, *picmip)
    return header + b"".join(reversed(t.levels))


def dds_bytes(t):
    f = FORMATS[t.fmt]
    flags = (
        0x1
        | 0x2
        | 0x4
        | 0x1000
        | (0x20000 if t.mips else 0)
        | (0x80000 if f.block > 1 else 0x8)
        | (0x800000 if t.depth > 1 else 0)
    )
    pitch = -(-t.width // f.block) * f.bytes
    if isinstance(f.dds, tuple):
        pf = struct.pack("<2I4s5I", 32, f.dds[0], b"\0" * 4, *f.dds[1:])
    else:
        code = f.dds if isinstance(f.dds, bytes) else b"DX10"
        pf = struct.pack("<2I4s5I", 32, DDPF_FOURCC, code, 0, 0, 0, 0, 0)
    caps = 0x1000 | (0x400008 if t.mips else 0) | (0x8 if t.maptype == CUBE else 0)
    caps2 = 0xFE00 if t.maptype == CUBE else 0
    header = struct.pack("<4s7I44x", b"DDS ", 124, flags, t.height, t.width, pitch, t.depth, len(t.levels))
    header += pf + struct.pack("<5I", caps, caps2, 0, 0, 0)
    if isinstance(f.dds, int):
        dimension = 4 if t.maptype == VOLUME else 3
        header += struct.pack("<5I", f.dds, dimension, 0x4 if t.maptype == CUBE else 0, 6 if t.maptype == CUBE else 1, 0)
    return header + b"".join(t.levels)


def encode(texture):
    """(extension, bytes): IWI where IWI holds the format, else DDS."""
    texture = padded(texture)
    if FORMATS[texture.fmt].iwi is not None:
        return ".iwi", iwi_bytes(texture)
    return ".dds", dds_bytes(texture)


class Tables:
    """The wavelet code tables, read from the executable the first time an image needs them."""

    def __init__(self, exe):
        self.exe, self.value, self.read = exe, None, False

    def get(self):
        if not self.read:
            self.read = True
            try:
                self.value = wavelet.tables_from_exe(self.exe) if self.exe else None
            except (OSError, ValueError) as e:
                print(f"      ! no wavelet code tables: {e}")
        return self.value


@dumper("image")
def write(walk, out, ctx=None):
    search = ctx.search if ctx else None
    found = walk.by_type("image")
    stats, skipped, tables = Counter(), Counter(), Tables(ctx.exe if ctx else None)
    for asset in found:
        if asset.name.startswith(","):
            stats["stubs"] += 1
            continue
        raw = asset.record.captured("LoadImageData")
        if raw is not None and LOADDEF.unpack_from(raw, 0)[3] > 0:
            texture = from_loaddef(asset.record, raw)
            source = "zone"
        else:
            data = iwd.read(search, file_name(asset.name, ".iwi"), newest=True) if search else None
            if data is None:
                skipped["no .iwi in the search path"] += 1
                continue
            fmtid = data[8] if len(data) > 8 else None
            texture = from_iwi(data, tables.get() if fmtid in WAVELET else None)
            source = "wavelet" if fmtid in WAVELET else "archive"
        if isinstance(texture, str):
            skipped[texture] += 1
            continue
        ext, payload = encode(texture)
        with open(asset_path(out, file_name(asset.name, ext)), "wb") as fh:
            fh.write(payload)
        stats[f"{source} {ext[1:]}"] += 1
    written = sum(v for k, v in stats.items() if k != "stubs")
    detail = ", ".join(f"{n} {k}" for k, n in sorted(stats.items()) if k != "stubs")
    line = f"      {written} of {len(found)} images written ({detail})"
    if skipped:
        line += "; skipped: " + "; ".join(f"{n} {why}" for why, n in skipped.most_common())
    print(line)
