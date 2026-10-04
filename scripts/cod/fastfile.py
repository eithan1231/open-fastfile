"""Which game an IW4, IW5, T5 or T6 fastfile is, and its zone, inflated and checked.

    python3 -m scripts.cod.fastfile <file.ff> ... [--out zone.bin]

Prints each file's game, container and zone size. The container is told from the
first 12 bytes, a magic and a version (reverse/x86-zone/README.md, "The container"):

- `IWff0100` is signed: IW4 at version 0x114, IW5 at 1. A byte and a timestamp follow,
  then at 21 the `IWffs100` auth header, padded to one 0x2000 chunk. After it come
  groups of one master chunk (256 SHA-256 hashes) and up to 256 data chunks, and
  the data chunks alone are one zlib stream. Every chunk is checked against its hash,
  and every master chunk against the auth header's, so a wrong layout fails loudly.
- `IWffu100` is unsigned, and zlib simply follows: at 21 for IW4 and IW5 (both
  games' `common.ff`, MW3's `so_*.ff`), at 12 for T5 (version 0x1D9), which has no
  byte or timestamp.

The zone starts with its XFile header, and its length is that header plus the `size`
the header states; `read_zone` refuses anything else. Black Ops II (`TAff0100`,
version 147) is encrypted; its container is `t6/ff.py`, and it is claimed here so that
the one zonecode walker reads it as it reads the other three. Ghosts and AW have
containers of their own (`iw6/ff.py`, `s1/ff.py`): IW6 shares `IWff0100` but not a version.
"""

import hashlib
import struct
import sys
import zlib
from collections import namedtuple

from .t6 import ff as t6_ff
from .zone.spec import IW4, IW5, T5, T6

SIGNED = b"IWff0100"
UNSIGNED = b"IWffu100"
AUTH_MAGIC = b"IWffs100"
VERSIONS = {0x114: IW4, 1: IW5, 0x1D9: T5}
CHUNK = 0x2000  # AUTHED_CHUNK_SIZE
CHUNKS_PER_MASTER = CHUNK // 32  # 256
# DB_AuthHeader: magic, reserved, subheader hash @12, RSA signature @44, subheader @300.
# DB_AuthSubHeader: fastfile name[32], reserved, masterBlockHashes[244].
AUTH_AT = 21
SUBHEADER_AT, SUBHEADER_SIZE, MASTER_HASHES = 300, 32 + 4 + 244 * 32, 244
READ = 1 << 16  # how much of an unsigned file is inflated at a time

# `start` is where the auth header (signed) or the zlib stream (unsigned) begins.
Container = namedtuple("Container", "spec signed start")

# A Black Ops fastfile: every zone the game ships, zombies' included, carries this header.
T5_HEADER = UNSIGNED + (0x1D9).to_bytes(4, "little")


def claim(path):
    """The Container of an IW4, IW5, T5 or T6 fastfile, or None for anything else."""
    with open(path, "rb") as fh:
        head = fh.read(12)
    if len(head) < 12:
        return None
    if t6_ff.is_fastfile(path):
        return Container(T6, t6_ff.MAGICS[head[:8]], 12)
    magic, version = head[:8], struct.unpack_from("<I", head, 8)[0]
    spec = VERSIONS.get(version)
    if spec is None:
        return None
    if magic == SIGNED and spec is not T5:
        return Container(spec, True, AUTH_AT)
    if magic == UNSIGNED:
        return Container(spec, False, 12 if spec is T5 else AUTH_AT)
    return None


def is_t5(path):
    with open(path, "rb") as fh:
        return fh.read(len(T5_HEADER)) == T5_HEADER


def _signed_chunks(fh, path):
    """The data chunks after the auth header, each checked against its master chunk's hash."""
    head = fh.read(CHUNK)
    if head[:8] != AUTH_MAGIC:
        raise ValueError(f"{path}: no {AUTH_MAGIC!r} at {AUTH_AT}")
    subheader = head[SUBHEADER_AT : SUBHEADER_AT + SUBHEADER_SIZE]
    if hashlib.sha256(subheader).digest() != head[12:44]:
        raise ValueError(f"{path}: the auth subheader fails its hash")
    masters = subheader[36:]
    group = 0
    while master := fh.read(CHUNK):
        if group >= MASTER_HASHES:
            raise ValueError(f"{path}: more than {MASTER_HASHES} master chunks")
        if hashlib.sha256(master).digest() != masters[32 * group : 32 * group + 32]:
            raise ValueError(f"{path}: master chunk {group} fails its hash")
        for k in range(CHUNKS_PER_MASTER):
            chunk = fh.read(CHUNK)
            if not chunk:
                return
            # A short last chunk is hashed as it is, not padded (ProcessorAuthedBlocks).
            if hashlib.sha256(chunk).digest() != master[32 * k : 32 * k + 32]:
                raise ValueError(f"{path}: chunk {k} of group {group} fails its hash")
            yield chunk
        group += 1


def _unsigned_chunks(fh):
    while chunk := fh.read(READ):
        yield chunk


def inflate(path, container):
    """The zone of a claimed fastfile, streamed into one bytearray of the size its header states."""
    spec = container.spec
    if spec is T6:
        return t6_ff.read_zone(path)
    inflater = zlib.decompressobj()
    zone, filled, total = bytearray(), 0, None
    with open(path, "rb") as fh:
        fh.seek(container.start)
        chunks = _signed_chunks(fh, path) if container.signed else _unsigned_chunks(fh)
        for chunk in chunks:
            if inflater.eof:
                continue  # padding after the stream: a signed file's chunks are still checked
            piece = inflater.decompress(chunk)
            if total is None:
                zone += piece
                if len(zone) < spec.header_size:
                    continue
                # The header says how long the zone is: allocate it once rather than grow it.
                total = spec.header_size + spec.header(zone)[0]
                filled = len(zone)
                if filled > total:
                    raise ValueError(f"{path}: the zone runs past the {total} bytes its header states")
                whole = bytearray(total)
                whole[:filled] = zone
                zone = whole
                continue
            end = filled + len(piece)
            if end > total:
                raise ValueError(f"{path}: the zone runs past the {total} bytes its header states")
            zone[filled:end] = piece
            filled = end
    if not inflater.eof:
        raise ValueError(f"{path}: the zlib stream is truncated after {filled or len(zone)} bytes")
    if total is None or filled != total:
        raise ValueError(f"{path}: {filled or len(zone)} bytes of zone, its header states {total}")
    return zone


def read_zone(path):
    """(ZoneSpec, zone bytes) of an IW4, IW5, T5 or T6 fastfile. The zone is a bytearray."""
    container = claim(path)
    if container is None:
        raise ValueError(f"{path} is not an IW4, IW5, T5 or T6 fastfile")
    return container.spec, inflate(path, container)


def main():
    args = sys.argv[1:]
    out = args.pop(args.index("--out") + 1) if "--out" in args else None
    args = [a for a in args if a != "--out"]
    if not args:
        sys.exit(__doc__)
    for path in args:
        container = claim(path)
        if container is None:
            print(f"{path}: not an IW4, IW5, T5 or T6 fastfile")
            continue
        spec, zone = container.spec, inflate(path, container)
        size, external, blocks = spec.header(zone)
        kind = "signed" if container.signed else "unsigned"
        print(f"{path}: {spec.game} {kind}, {len(zone)} bytes of zone = header {spec.header_size} + size {size}")
        print(f"    externalSize {external}")
        print("    " + "  ".join(f"{name}={value}" for name, value in zip(spec.blocks, blocks, strict=True)))
        if out:
            with open(out, "wb") as fh:
                fh.write(zone)


if __name__ == "__main__":
    main()
