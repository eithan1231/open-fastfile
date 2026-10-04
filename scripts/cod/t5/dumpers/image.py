"""`image`: every image the zone names, once, as `images/<name>.iwi` (IWI v13) or `.dds`.

IW5's writer (iw5/dumpers/image.py) with T5's containers: the load definition's
flags are a byte of IWI v13's bits (`NOMIPMAPS` 2, `CUBEMAP` 4, `VOLMAP` 8) rather
than a word of v8's, and both the archive's IWIs and the ones written here are
version 13 (`IWi`, 13, format, flags, three dimensions, gamma, eight picmip sizes).
IWI v13 numbers its formats as v8 does and holds the same ones, so what goes to DDS
is what does on IW5: 24-bit colour (padded to 32, as OAT pads it) and colour
wavelets. A dozen of Black Ops' archive images are wavelets, decoded with the code
tables read out of BlackOpsMP.exe, which holds IW5's (scripts/cod/wavelet.py).
"""

import struct
from collections import Counter

from ... import iwd
from ...iw5.dumpers import image as iw
from ...iw6.dumpers.common import asset_path

NOMIPMAPS, CUBEMAP, VOLMAP = 0x2, 0x4, 0x8
LOADDEF = struct.Struct("<Bb2xii")  # levelCount, flags, format, resourceSize, then the data
IWI13_HEADER = struct.Struct("<3sBbbHHHf8I")  # tag, version, format, flags, dims, gamma, file size per picmip


def maptype(flags):
    """IWI v13's flag bits as the maptype IW5's writer carries (a cube wins, as in OAT's loader)."""
    return iw.CUBE if flags & CUBEMAP else iw.VOLUME if flags & VOLMAP else 0


def from_loaddef(record, raw):
    """A Texture from pixels the zone carries, or a reason it has none."""
    _levels, flags, d3d, size = LOADDEF.unpack_from(raw, 0)
    fmt = iw.D3D.get(d3d & 0xFFFFFFFF)
    if fmt is None:
        return f"D3D format {d3d:#x}"
    kind = maptype(flags & 0xFF)
    width, height, depth = record["width"], record["height"], record["depth"]
    if kind == iw.CUBE:
        height = width
    if kind != iw.VOLUME:
        depth = 1
    mips = not flags & NOMIPMAPS
    levels = iw.split_levels(fmt, kind, width, height, depth, mips, raw[LOADDEF.size : LOADDEF.size + size], True)
    return iw.Texture(fmt, kind, width, height, depth, mips, levels)


def from_iwi(data, tables):
    """A Texture from an IWI v13 file, or a reason it cannot be read (OAT's LoadIwi13)."""
    if data[:4] != b"IWi\x0d":
        return "not an IWI v13"
    if len(data) < IWI13_HEADER.size:
        return "a truncated file"
    _tag, _version, fmtid, flags, width, height, depth, _gamma, *picmip = IWI13_HEADER.unpack_from(data, 0)
    kind = maptype(flags & 0xFF)
    mips = not flags & NOMIPMAPS
    payload = data[IWI13_HEADER.size :]
    if fmtid in iw.WAVELET:
        fmt, channels = iw.WAVELET[fmtid]
        if tables is None:
            return "a wavelet, and no executable to read its code tables from"
        if kind == iw.VOLUME or (not mips and width > 1 and height > 1):
            return "a wavelet volume, or one without mips"
        levels = iw.wavelet.decode(payload, width, height, iw.faces(kind), channels, tables)
        return iw.Texture(fmt, kind, width, height, 1, mips, levels)
    fmt = iw.IWI.get(fmtid)
    if fmt is None:
        return f"IWI format {fmtid}"
    if kind != iw.VOLUME:
        depth = 1
    count = iw.level_count(width, height, depth, mips)
    total = IWI13_HEADER.size
    for level in range(count - 1, -1, -1):
        total += iw.level_size(fmt, width, height, depth, level) * iw.faces(kind)
        if level < 8 and picmip[level] != total:
            return "sizes that do not match its header"  # OAT refuses these too
    if len(data) < total:
        return "a truncated file"
    return iw.Texture(
        fmt, kind, width, height, depth, mips, iw.split_levels(fmt, kind, width, height, depth, mips, payload, False)
    )


def iwi_bytes(t):
    """IWI v13 as OAT's IwiWriter13 writes one: only the mip, cube and volume flags, gamma 0."""
    flags = (0 if t.mips else NOMIPMAPS) | (CUBEMAP if t.maptype == iw.CUBE else 0) | (VOLMAP if t.maptype == iw.VOLUME else 0)
    picmip, total = [0] * 8, IWI13_HEADER.size
    for level in range(len(t.levels) - 1, -1, -1):
        total += len(t.levels[level])
        if level < 8:
            picmip[level] = total
    depth = t.depth if t.maptype == iw.VOLUME else 1
    header = IWI13_HEADER.pack(b"IWi", 13, iw.FORMATS[t.fmt].iwi, flags, t.width, t.height, depth, 0.0, *picmip)
    return header + b"".join(reversed(t.levels))


def encode(texture):
    """(extension, bytes): IWI v13 where it holds the format, else DDS."""
    texture = iw.padded(texture)
    if iw.FORMATS[texture.fmt].iwi is not None:
        return ".iwi", iwi_bytes(texture)
    return ".dds", iw.dds_bytes(texture)


def write(walk, out, ctx=None):
    search = ctx.search if ctx else None
    found = walk.by_type("image")
    stats, skipped, tables = Counter(), Counter(), iw.Tables(ctx.exe if ctx else None)
    for asset in found:
        if asset.name.startswith(","):
            stats["stubs"] += 1
            continue
        raw = asset.record.captured("LoadImageData")
        if raw is not None and LOADDEF.unpack_from(raw, 0)[3] > 0:
            texture, source = from_loaddef(asset.record, raw), "zone"
        else:
            data = iwd.read(search, iw.file_name(asset.name, ".iwi"), newest=True) if search else None
            if data is None:
                skipped["no .iwi in the search path"] += 1
                continue
            fmtid = data[4] if len(data) > 4 else None
            texture = from_iwi(data, tables.get() if fmtid in iw.WAVELET else None)
            source = "wavelet" if fmtid in iw.WAVELET else "archive"
        if isinstance(texture, str):
            skipped[texture] += 1
            continue
        ext, payload = encode(texture)
        with open(asset_path(out, iw.file_name(asset.name, ext)), "wb") as fh:
            fh.write(payload)
        stats[f"{source} {ext[1:]}"] += 1
    written = sum(v for k, v in stats.items() if k != "stubs")
    detail = ", ".join(f"{n} {k}" for k, n in sorted(stats.items()) if k != "stubs")
    line = f"      {written} of {len(found)} images written ({detail})"
    if skipped:
        line += "; skipped: " + "; ".join(f"{n} {why}" for why, n in skipped.most_common())
    print(line)
