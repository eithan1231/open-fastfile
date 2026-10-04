"""An Advanced Warfare zone's images as DDS files: the finest level of each, from the zone or the paks.

    python3 -m scripts.cod.s1.images <map.ff> <out dir> [name ...]

`GfxImage` and `GfxImageStreamData` are byte-for-byte IW6's, so what a DXGI
format costs per block, how a mip chain is sized and how a DDS is written are
taken from `scripts/cod/iw6/images.py` rather than spelled a second time: one
wrong block size is a silently wrong image in either game.

What is S1's own is the span. IW6 keeps one raw zlib stream per
`XAssetStreamFile` entry; S1 keeps the fastfile payload's own framing -- a
12-byte header then LZ4 chunks -- so a span must be looped, not inflated once
(reverse/s1-zone/README.md#the-fastfile).

Images whose name starts with ',' are references to another zone and carry no
pixels here.
"""

import os
import struct
import sys

from ..iw6.images import BLOCK_BYTES, MAPTYPE_CUBE, REFERENCE, chain_size, dds, level_size
from . import lz4

SPAN_FLAGS = 0x04010000  # the fastfile payload carries the same value
SPAN_HEADER = struct.Struct("<QI")  # uncompressed total, flags
CHUNK_HEADER = struct.Struct("<II")  # compressed, uncompressed


def decompress_span(span):
    """One pak span's pixels. Raises ValueError unless the span is consumed exactly.

    A chunk that decodes to its declared size proves nothing on its own: a span
    whose chunks stop short still decodes, so the totals and the span's own length
    are the checks that matter.
    """
    if len(span) < SPAN_HEADER.size:
        raise ValueError(f"span of {len(span)} bytes is shorter than its header")
    total, flags = SPAN_HEADER.unpack_from(span, 0)
    if flags != SPAN_FLAGS:
        raise ValueError(f"span flags 0x{flags:08x}, expected 0x{SPAN_FLAGS:08x}")
    out = bytearray()
    at = SPAN_HEADER.size
    while len(out) < total:
        if at + CHUNK_HEADER.size > len(span):
            raise ValueError(f"span ran out after {len(out)} of {total} bytes")
        compressed, uncompressed = CHUNK_HEADER.unpack_from(span, at)
        at += CHUNK_HEADER.size
        chunk = lz4.decompress(span, at, at + compressed)
        if len(chunk) != uncompressed:
            raise ValueError(f"a chunk gave {len(chunk)} bytes, its header said {uncompressed}")
        out += chunk
        at = (at + compressed + 3) & ~3  # chunks start on a 4-byte boundary
    if len(out) != total:
        raise ValueError(f"{len(out)} bytes of pixels, the span header said {total}")
    if at != len(span):
        raise ValueError(f"span decoded whole but {len(span) - at} of its {len(span)} bytes went unread")
    return bytes(out)


class PakFiles:
    """The imagefile<N>.pak files an image's stream spans point into, opened on demand.

    `offset`/`end` are raw byte offsets, and one pak reaches 4 GB, so a span is
    always seek-and-read: nothing here ever holds a pak in memory.
    """

    def __init__(self, fastfile):
        self.folder = os.path.dirname(os.path.abspath(fastfile))
        self.handles = {}

    def path(self, stream_file):
        if stream_file.localized:
            raise NotImplementedError("localized image paks: none ship with the PC game")
        return os.path.join(self.folder, f"imagefile{stream_file.file_index}.pak")

    def read(self, stream_file):
        path = self.path(stream_file)
        if path not in self.handles:
            self.handles[path] = open(path, "rb")
        fh = self.handles[path]
        fh.seek(stream_file.offset)
        span = fh.read(stream_file.end - stream_file.offset)
        if len(span) != stream_file.end - stream_file.offset:
            raise ValueError(f"{path}: span [{stream_file.offset}, {stream_file.end}) runs past the end of the file")
        return span

    def close(self):
        for fh in self.handles.values():
            fh.close()
        self.handles.clear()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


def finest_level(image, zone_data, paks):
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
        data = decompress_span(paks.read(image.stream_files[k]))
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
                except (ValueError, OSError, NotImplementedError) as error:
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
    from .walkers import walk_zone  # heavy: it pulls in every walker

    fastfile, out_dir, names = sys.argv[1], sys.argv[2], set(sys.argv[3:]) or None
    walk, _ = walk_zone(fastfile)
    if walk.failed:
        # Images past the failure were never reached, so a partial walk is a partial dump.
        print(f"WARNING: the walk stopped at asset {walk.failed[0]} ({walk.failed[1]}): {walk.failed[2]}", file=sys.stderr)
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
