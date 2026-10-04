"""A walked zone's images as DDS files: the finest level of each, from the zone or the paks.

    python3 -m scripts.cod.iw6.images <map.ff> <out dir> [name ...]

Streamed images keep their pixels in imagefile<N>.pak beside the fastfile, one
zlib span per GfxImage.streams entry (reverse/iw6-zone/README.md#streamed-images). Images whose
name starts with ',' are references to another zone and carry no pixels here.

BC1-3 are written with DXT1/3/5 FourCC headers, since Pillow (10.2, which
scripts/cod decodes with) only reads them that way; every other format gets a
DX10 header.
"""

import os
import struct
import sys
import zlib

from .ff import SELF_PAK
from .records import Image

# DXGI_FORMAT -> (bytes per block, block edge in pixels)
BLOCK_BYTES = {
    **{f: (8, 4) for f in (70, 71, 72, 79, 80, 81)},  # BC1, BC4
    **{f: (16, 4) for f in (73, 74, 75, 76, 77, 78, 82, 83, 84, 94, 95, 96, 97, 98, 99)},  # BC2, BC3, BC5-7
    **{f: (4, 1) for f in (24, 26, 27, 28, 29, 41, 87, 88, 91)},  # 32-bit colour and float
    10: (8, 1),  # R16G16B16A16_FLOAT
    54: (2, 1),  # R16_FLOAT
    61: (1, 1),  # R8_UNORM
    65: (1, 1),  # A8_UNORM
}
FOURCC = {**dict.fromkeys((70, 71, 72), b"DXT1"), **dict.fromkeys((73, 74, 75), b"DXT3"), **dict.fromkeys((76, 77, 78), b"DXT5")}
MAPTYPE_CUBE = 5
REFERENCE = ","  # an image name prefix: the asset lives in another zone


def level_size(fmt, width, height):
    size, edge = BLOCK_BYTES[fmt]
    return size * max(1, (width + edge - 1) // edge) * max(1, (height + edge - 1) // edge)


def chain_size(fmt, width, height, levels):
    return sum(level_size(fmt, max(1, width >> i), max(1, height >> i)) for i in range(levels))


class PakFiles:
    """The imagefile<N>.pak files an image's stream spans point into, opened on demand."""

    def __init__(self, fastfile):
        self.folder = os.path.dirname(os.path.abspath(fastfile))
        self.self_pak = os.path.splitext(os.path.abspath(fastfile))[0] + ".pak"
        self.handles = {}

    def path(self, stream_file):
        if stream_file.localized:
            raise NotImplementedError("localized image paks: none ship with the PC game")
        if stream_file.file_index == SELF_PAK:
            return self.self_pak
        return os.path.join(self.folder, f"imagefile{stream_file.file_index}.pak")

    def read(self, stream_file):
        path = self.path(stream_file)
        if path not in self.handles:
            self.handles[path] = open(path, "rb")
        fh = self.handles[path]
        fh.seek(stream_file.offset)
        return fh.read(stream_file.end - stream_file.offset)

    def close(self):
        for fh in self.handles.values():
            fh.close()
        self.handles.clear()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


def finest_level(image: Image, zone_data, paks):
    """(width, height, faces, bytes): the finest level of every face, faces concatenated.

    Levels are stored face by face, finest first within each face, both in the zone
    and within a stream span. Raises ValueError if the sizes do not add up."""
    faces = image.elements * (6 if image.map_type == MAPTYPE_CUBE else 1)
    if image.stream_files:
        present = [k for k, f in enumerate(image.stream_files) if f.offset]
        if not present:
            raise ValueError("streamed, but no stream span is present")
        k = present[-1]
        stream = image.streams[k]
        below = image.streams[k - 1] if k else None
        size = stream.pixel_size - (below.pixel_size if below else 0)
        levels = stream.level_count - (below.level_count if below else 0)
        data = zlib.decompress(paks.read(image.stream_files[k]))
        width, height = stream.width, stream.height
    else:
        if image.pixels is None:
            raise ValueError("no pixels in this zone")
        size, levels = image.pixel_size, image.level_count
        data = zone_data[image.pixels : image.pixels + size]
        width, height = image.width, image.height
    depth = max(1, image.depth)
    chain = chain_size(image.format, width, height, levels) * depth
    if len(data) != size or chain * faces != size:
        raise ValueError(f"{faces} faces of {levels} levels at {width}x{height} need {chain * faces} bytes, have {len(data)}")
    top = level_size(image.format, width, height) * depth
    return width, height, faces, b"".join(data[f * chain : f * chain + top] for f in range(faces))


def dds(fmt, width, height, faces, pixels):
    """A DDS file holding one level, as a cube map when there are six faces."""
    cube = faces == 6
    header = bytearray(128)
    header[0:4] = b"DDS "
    size = level_size(fmt, width, height)
    struct.pack_into("<7I", header, 4, 124, 0x81007, height, width, size, 0, 1)
    struct.pack_into("<2I", header, 76, 32, 0x4)  # DDS_PIXELFORMAT size, DDPF_FOURCC
    header[84:88] = FOURCC.get(fmt, b"DX10")
    struct.pack_into("<2I", header, 108, 0x1000 | (0x8 if cube else 0), 0xFE00 if cube else 0)
    if fmt not in FOURCC:
        # DDS_HEADER_DXT10: format, TEXTURE2D, cube flag, array size, alpha mode
        header += struct.pack("<5I", fmt, 3, 0x4 if cube else 0, 1 if cube else faces, 0)
    return bytes(header) + pixels


def extract(fastfile, images, zone_data, names=None):
    """Yield (name, (width, height, faces, pixels) or None, why not) for each wanted image."""
    with PakFiles(fastfile) as paks:
        for name, image in images.items():
            if names is not None and name not in names:
                continue
            if name.startswith(REFERENCE):
                yield name, None, "in another zone"
            elif image.format not in BLOCK_BYTES:
                yield name, None, f"DXGI format {image.format}"
            else:
                try:
                    yield name, finest_level(image, zone_data, paks), None
                except (ValueError, OSError, zlib.error, NotImplementedError) as error:
                    yield name, None, str(error)


def export(fastfile, images, zone_data, out_dir, names=None):
    """Write <out_dir>/<image name>.dds for each wanted image. Returns (written, {name: reason})."""
    os.makedirs(out_dir, exist_ok=True)
    written, skipped = 0, {}
    for name, level, reason in extract(fastfile, images, zone_data, names):
        if level is None:
            skipped[name] = reason
            continue
        with open(os.path.join(out_dir, name.replace("/", "_") + ".dds"), "wb") as fh:
            fh.write(dds(images[name].format, *level))
        written += 1
    return written, skipped


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    from .gfxworld import walk_map

    fastfile, out_dir, names = sys.argv[1], sys.argv[2], set(sys.argv[3:]) or None
    walk, _ = walk_map(fastfile)
    images = walk.z.found.get("IMAGE", {})
    written, skipped = export(fastfile, images, walk.z.data, out_dir, names)
    print(f"wrote {written} of {len(images)} images to {out_dir}")
    reasons = {}
    for name, reason in skipped.items():
        reasons.setdefault(reason, []).append(name)
    for reason, which in sorted(reasons.items(), key=lambda r: -len(r[1])):
        print(f"  skipped {len(which)}: {reason} (e.g. {which[0]})")


if __name__ == "__main__":
    main()
