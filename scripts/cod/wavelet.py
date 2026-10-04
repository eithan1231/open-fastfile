"""IWI wavelet images (formats 6-10): decoded to plain pixels, with the game's own code tables.

    tables = wavelet.tables_from_exe(path)   # read out of iw5mp.exe, never committed
    levels = wavelet.decode(payload, width, height, faces, channels, tables)

An image is stored smallest level first, each level's faces in turn. A level one
pixel wide or high is raw bytes; every other one is its half-size parent plus,
per 2x2 block, three Huffman-coded detail coefficients per channel. The decoded
layout is the one OpenAssetTools hands its writers: B, G, R, X/A bytes for colour,
L, A for luminance-alpha, one byte otherwise. docs/cod/reference.md#iwi-textures
has the format; reverse/iw5-wavelet/ how the tables were found.
"""

import functools
import re
import struct

LOOKUP_BITS = 12
ESCAPE = -32768
# Three lookups of 4096 (value, bit count) int16 pairs, back to back: the first
# channel's coefficients, the other two colour channels' (added to the first's),
# and alpha's, which also codes a parent level's corrections. Which is which is
# the length of its escape code, not its place: iw5mp.exe holds them in that
# order and iw4mp.exe in the reverse one.
TABLE_BYTES = 4 << LOOKUP_BITS
CANDIDATE = re.compile(rb"(?s)(?:..[\x01-\x0c]\x00){%d,}" % (3 << LOOKUP_BITS))  # at least three lookups' worth
ESCAPE_BITS = (6, 7, 4)  # first, colour, alpha

# channels -> bytes a decoded pixel takes
LAYOUT = {1: 1, 2: 2, 3: 4, 4: 4}


def _lookup(raw):
    """A 4096-entry lookup, or None unless every entry is the one its own code's low bits select."""
    entries = list(struct.iter_unpack("<hh", raw))
    for i, (_value, bits) in enumerate(entries):
        if entries[i & ((1 << bits) - 1)] != entries[i]:
            return None
    return entries


def _escape_bits(table):
    """The length of a lookup's escape code, or None when it has none."""
    return next((bits for value, bits in table if value == ESCAPE), None)


def find_tables(data):
    """(file offset, (first, colour, alpha)) of the first run of three lookups in `data`, or None."""
    for match in CANDIDATE.finditer(data):
        start = match.start()
        for offset in (o for base in range(start, start + 4) for o in range(base, match.end() - 3 * TABLE_BYTES + 1, 4)):
            found = [_lookup(data[offset + k * TABLE_BYTES : offset + (k + 1) * TABLE_BYTES]) for k in range(3)]
            if not all(found):
                continue
            by_escape = {_escape_bits(t): t for t in found}
            if set(by_escape) == set(ESCAPE_BITS):
                return offset, tuple(by_escape[bits] for bits in ESCAPE_BITS)
    return None


@functools.cache
def tables_from_exe(path):
    """(first, colour, alpha) lookups from an IW-engine executable, found by their shape.

    Raises ValueError when the file holds no such run of three."""
    with open(path, "rb") as fh:
        found = find_tables(fh.read())
    if found is None:
        raise ValueError(f"{path}: no wavelet code tables found")
    return found[1]


class Bits:
    """Raw bytes until the first bit is read, then least-significant-bit-first codes."""

    def __init__(self, data):
        self.data = bytes(data) + bytes(4)
        self.end = len(data) * 8
        self.pos = 0  # a byte offset while raw, a bit offset after
        self.bits = False

    def byte(self):
        if self.bits or self.pos >= self.end // 8:
            raise ValueError("wavelet data: a raw byte after the coded ones, or past the end")
        self.pos += 1
        return self.data[self.pos - 1]

    def _start(self):
        if not self.bits:
            self.pos *= 8
            self.bits = True

    def read(self, count):
        self._start()
        if self.pos + count > self.end:
            raise ValueError("wavelet data ends early")
        at = self.pos
        self.pos += count
        return (int.from_bytes(self.data[at >> 3 : (at >> 3) + 4], "little") >> (at & 7)) & ((1 << count) - 1)

    def code(self, table, escape_bits, bias):
        self._start()
        at = self.pos
        value, bits = table[(int.from_bytes(self.data[at >> 3 : (at >> 3) + 3], "little") >> (at & 7)) & 0xFFF]
        if at + bits > self.end:
            raise ValueError("wavelet data ends early")
        self.pos = at + bits
        return self.read(escape_bits) - bias if value == ESCAPE else value


def _block(src, dst, ch, bpp, stride, at, parity, h, v, d):
    """One channel of a 2x2 block from its parent's value and three detail coefficients."""
    base = 2 * src[ch]
    dst[at + ch] = (parity + ((base + h + v + d) >> 1)) & 0xFF
    dst[at + bpp + ch] = ((base + h - v - d) >> 1) & 0xFF
    dst[at + stride + ch] = ((base - h + v - d) >> 1) & 0xFF
    dst[at + stride + bpp + ch] = ((base - h - v + d) >> 1) & 0xFF


def _level(parent, width, height, channels, bits, tables):
    bpp = LAYOUT[channels]
    out = bytearray(width * height * bpp)
    if width <= 1 or height <= 1:
        for p in range(width * height):
            for c in range(channels):
                out[p * bpp + c] = bits.byte()
            for c in range(channels, bpp):
                out[p * bpp + c] = 0xFF
        return out
    first, colour, alpha = tables
    src = bytearray(parent)
    if bits.read(1):  # the parent level corrected before it is refined
        for p in range(len(src) // bpp):
            for c in range(channels):
                src[p * bpp + c] = (src[p * bpp + c] + bits.code(alpha, 9, 255)) & 0xFF
    stride = width * bpp
    half = width // 2
    for y in range(0, height, 2):
        for x in range(0, width, 2):
            s = ((y // 2) * half + x // 2) * bpp
            parent_px = src[s : s + bpp]
            at = (y * width + x) * bpp
            if channels != 1:
                parity = bits.read(1)
                h, v, d = (bits.code(first, 9, 255) for _ in range(3))
                _block(parent_px, out, 0, bpp, stride, at, parity, h, v, d)
                if channels >= 3:
                    for c in (1, 2):
                        parity = bits.read(1)
                        dh, dv, dd = (bits.code(colour, 10, 510) for _ in range(3))
                        _block(parent_px, out, c, bpp, stride, at, parity, h + dh, v + dv, d + dd)
            if channels == 3:
                for o in (at, at + bpp, at + stride, at + stride + bpp):
                    out[o + 3] = 0xFF
            else:
                parity = bits.read(1)
                h, v, d = (bits.code(alpha, 9, 255) for _ in range(3))
                _block(parent_px, out, channels - 1, bpp, stride, at, parity, h, v, d)
    return out


def level_count(width, height):
    return max(width, height).bit_length()


def decode(payload, width, height, faces, channels, tables):
    """[level bytes, all faces] largest level first, as OpenAssetTools' texture buffers hold them.

    Width and height must be powers of two, and the image must carry its mips."""
    if width & (width - 1) or height & (height - 1) or not width or not height:
        raise ValueError(f"wavelet image {width}x{height}: not powers of two")
    bits = Bits(payload)
    count = level_count(width, height)
    levels = [None] * count
    for level in range(count - 1, -1, -1):
        w, h = max(1, width >> level), max(1, height >> level)
        parents = levels[level + 1] if level + 1 < count else None
        size = w * h * LAYOUT[channels]
        psize = len(parents) // faces if parents is not None else 0
        faces_out = []
        for face in range(faces):
            parent = parents[face * psize : (face + 1) * psize] if parents is not None else b""
            faces_out.append(_level(parent, w, h, channels, bits, tables))
        levels[level] = b"".join(faces_out)
        assert len(levels[level]) == size * faces
    return levels
