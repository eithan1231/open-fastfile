"""Decrypt and inflate a Black Ops II (T6) PC fastfile into its zone.

    python3 -m scripts.cod.t6.ff <file.ff> [--out zone.bin]

The container, as OAT's ZoneLoaderFactoryT6 reads it (reverse/t6-zone/README.md,
"The container"):

-   0  `TAff0100` (signed) or `TAffu100`, then `u32` version 147 (PC).
-  12  signed only: `PHEEBs71`, `u32` flags, `char name[32]`, a 256-byte RSA signature.
-  then XChunks: a `u32` size (at most 0x8000), then that many bytes, dealt round-robin
   to 4 streams, to a size-0 chunk. A size word never straddles a 0x80000 boundary of
   the file, counted from where the chunks start: the tail before one is skipped.

Each chunk is Salsa20-decrypted with the first 8 bytes of its stream's current hash
block as IV, then raw-inflated on its own, to its end. The 200 hash blocks per stream
start as the zone name, each character four times, and after each chunk the stream
moves to its next block and xors the chunk's SHA-1 into it.

The inflated bytes are the XFile: `read_zone` refuses anything but `40 + size` of them.
The signature is not checked; the SHA-1 chain and the exact length are what would fail
on a wrong layout. A 36 MB map zone decrypts and inflates in about 3 s, so nothing is
cached (reverse/t6-zone's reader, a block at a time, took 50 s).
"""

import array
import hashlib
import mmap
import os
import struct
import sys
import zlib
from pathlib import Path

from ..zone.spec import T6

MAGICS = {b"TAff0100": True, b"TAffu100": False}  # -> signed
VERSION = 147  # PC
AUTH_MAGIC = b"PHEEBs71"
AUTH_SIZE = 8 + 4 + 32 + 256
STREAMS = 4
CHUNK_MAX = 0x8000
VANILLA_BUFFER = 0x80000  # a size word never straddles a multiple of this
HASH_BLOCKS = 200  # BLOCK_HASHES_COUNT (AbstractSalsa20Processor.h)
SIGMA = (0x61707865, 0x3320646E, 0x79622D32, 0x6B206574)  # "expand 32-byte k"


# The PC zone key: one value for every MP and SP zone. The game builds it on the stack in
# DB_AuthLoad_Init rather than storing it (reverse/t6-zone/README.md, "The Salsa20 key");
# reverse/t6-zone/key.py re-derives it from t6mp.exe and checks it against this.
SALSA20_KEY = bytes.fromhex("641d8a2fe31d3aa63622bbc9ce8587229d42b0f8ed9b924130bf88b65edc50be")


def salsa20_key():
    """The 32-byte Salsa20 key of a PC zone."""
    return SALSA20_KEY


def is_fastfile(path):
    """Whether `path` starts like a T6 PC fastfile (either magic, version 147)."""
    with open(path, "rb") as fh:
        head = fh.read(12)
    return len(head) == 12 and head[:8] in MAGICS and struct.unpack_from("<I", head, 8)[0] == VERSION


# -- Salsa20/20 over many blocks at once -------------------------------------------------------------
#
# Pure Python pays per operation, not per bit, so the keystream for a whole chunk is made
# in one pass: state word i of every block is one integer, a 32-bit lane per block in a
# 64-bit slot. Adding two lanes cannot carry into the next slot, and each operation is
# masked back to 32 bits per lane. About fifty times faster than a block at a time.


def keystream(key, iv, length):
    """`length` bytes of Salsa20/20 keystream (256-bit key, 64-bit IV, block counter from 0)."""
    blocks = (length + 63) // 64
    if blocks == 0:
        return b""
    ones = int.from_bytes(b"\1\0\0\0\0\0\0\0" * blocks, "little")
    mask = ones * 0xFFFFFFFF
    k = struct.unpack("<8I", key)
    v = struct.unpack("<2I", iv)
    counter = int.from_bytes(b"".join(struct.pack("<Q", b) for b in range(blocks)), "little")
    words = (SIGMA[0], k[0], k[1], k[2], k[3], SIGMA[1], v[0], v[1], None, 0, SIGMA[2], k[4], k[5], k[6], k[7], SIGMA[3])
    s = [counter if w is None else w * ones for w in words]
    x = list(s)

    def quarter(a, b, c, d):
        t = (x[a] + x[d]) & mask
        x[b] ^= ((t << 7) & mask) | (t >> 25 & mask)
        t = (x[b] + x[a]) & mask
        x[c] ^= ((t << 9) & mask) | (t >> 23 & mask)
        t = (x[c] + x[b]) & mask
        x[d] ^= ((t << 13) & mask) | (t >> 19 & mask)
        t = (x[d] + x[c]) & mask
        x[a] ^= ((t << 18) & mask) | (t >> 14 & mask)

    for _ in range(10):
        quarter(0, 4, 8, 12)
        quarter(5, 9, 13, 1)
        quarter(10, 14, 2, 6)
        quarter(15, 3, 7, 11)
        quarter(0, 1, 2, 3)
        quarter(5, 6, 7, 4)
        quarter(10, 11, 8, 9)
        quarter(15, 12, 13, 14)
    out = array.array("I", bytes(64 * blocks))
    for i in range(16):
        lanes = array.array("I", ((x[i] + s[i]) & mask).to_bytes(8 * blocks, "little"))
        out[i::16] = lanes[::2]
    if sys.byteorder != "little":
        out.byteswap()
    return out.tobytes()[:length]


def _xor(data, pad):
    return (int.from_bytes(data, "little") ^ int.from_bytes(pad[: len(data)], "little")).to_bytes(len(data), "little")


# -- The container -------------------------------------------------------------------------------


def chunks(raw, start, name, key):
    """Each XChunk from `start`, decrypted and inflated, in stream order."""
    hashes = bytearray(HASH_BLOCKS * STREAMS * 20)
    letters = name[:31].encode()
    for i in range(0, len(hashes), 4):
        hashes[i : i + 4] = letters[(i // 4) % len(letters) : (i // 4) % len(letters) + 1] * 4
    index = [0] * STREAMS
    pos, vanilla, stream, n = start, start, 0, 0
    while True:
        if vanilla + 4 > VANILLA_BUFFER:
            pos += VANILLA_BUFFER - vanilla
            vanilla = 0
        if pos + 4 > len(raw):
            raise ValueError(f"the chunks run off the end of the file after {n} of them")
        (size,) = struct.unpack_from("<I", raw, pos)
        pos += 4
        vanilla = (vanilla + 4) % VANILLA_BUFFER
        if size == 0:
            return
        if size > CHUNK_MAX or pos + size > len(raw):
            raise ValueError(f"chunk {n} at {pos - 4:#x} claims {size:#x} bytes")
        at = (index[stream] * STREAMS + stream) * 20
        plain = _xor(raw[pos : pos + size], keystream(key, bytes(hashes[at : at + 8]), size))
        pos += size
        vanilla = (vanilla + size) % VANILLA_BUFFER
        index[stream] = (index[stream] + 1) % HASH_BLOCKS
        at = (index[stream] * STREAMS + stream) * 20
        for i, byte in enumerate(hashlib.sha1(plain).digest()):
            hashes[at + i] ^= byte
        inflater = zlib.decompressobj(-15)
        try:
            piece = inflater.decompress(plain)
        except zlib.error as e:
            raise ValueError(f"chunk {n} (stream {stream}) does not inflate to its end ({e}): wrong key, IV or layout") from e
        if not inflater.eof:
            raise ValueError(f"chunk {n} (stream {stream}) does not inflate to its end: wrong key, IV or layout")
        yield piece
        stream = (stream + 1) % STREAMS
        n += 1


def read_zone(path, key=None):
    """The zone of a T6 fastfile, decrypted and inflated, checked to be `40 + size` bytes long."""
    with open(path, "rb") as fh:
        if os.fstat(fh.fileno()).st_size < 12:
            raise ValueError(f"{path}: not a Black Ops II PC fastfile (too short)")
        # Mapped, not read: the file is only ever sliced a chunk at a time.
        with mmap.mmap(fh.fileno(), 0, access=mmap.ACCESS_READ) as raw:
            return _read_zone(path, raw, key)


def _read_zone(path, raw, key):
    magic, version = raw[:8], struct.unpack_from("<I", raw, 8)[0]
    if magic not in MAGICS or version != VERSION:
        raise ValueError(f"{path}: not a Black Ops II PC fastfile ({magic!r}, version {version})")
    start, name = 12, Path(path).stem
    if MAGICS[magic]:
        if raw[12:20] != AUTH_MAGIC:
            raise ValueError(f"{path}: no {AUTH_MAGIC!r} auth header at 12")
        name = raw[24:56].split(b"\0")[0].decode() or name
        start += AUTH_SIZE
    # Grown until the XFile header is in, then allocated once at the size it states,
    # as fastfile.inflate does: joining the pieces held the zone twice at its peak.
    zone, filled, total = bytearray(), 0, None
    for piece in chunks(raw, start, name, key or salsa20_key()):
        if total is None:
            zone += piece
            if len(zone) < T6.header_size:
                continue
            total = T6.header_size + T6.header(zone)[0]
            filled = len(zone)
            if filled > total:
                raise ValueError(f"{path}: more than the {total} bytes of zone its header states")
            whole = bytearray(total)
            whole[:filled] = zone
            zone = whole
            continue
        end = filled + len(piece)
        if end > total:
            raise ValueError(f"{path}: more than the {total} bytes of zone its header states")
        zone[filled:end] = piece
        filled = end
    if total is None:
        raise ValueError(f"{path}: {len(zone)} bytes inflated, shorter than the XFile header")
    if filled != total:
        raise ValueError(f"{path}: {filled} bytes of zone, its header states {total}")
    return zone


def main():
    args = sys.argv[1:]
    out = args.pop(args.index("--out") + 1) if "--out" in args else None
    args = [a for a in args if a != "--out"]
    if not args:
        sys.exit(__doc__)
    for path in args:
        zone = read_zone(path)
        size, external, blocks = T6.header(zone)
        print(f"{path}: t6, {len(zone)} bytes of zone = header {T6.header_size} + size {size}")
        print(f"    externalSize {external}")
        print("    " + "  ".join(f"{name}={value}" for name, value in zip(T6.blocks, blocks, strict=True)))
        if out:
            Path(out).write_bytes(zone)


if __name__ == "__main__":
    main()
