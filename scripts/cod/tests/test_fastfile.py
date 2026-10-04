"""IW4, IW5 and T5 containers, built here: which game each is, and the zone it inflates to."""

import hashlib
import random
import struct
import zlib

import pytest

from scripts.cod import fastfile
from scripts.cod.fastfile import CHUNK, SIGNED, UNSIGNED
from scripts.cod.zone import IW4, IW5, T5

VERSION = {IW4: 0x114, IW5: 1, T5: 0x1D9}


def zone_bytes(spec, payload):
    """An inflated zone: XFile (size, externalSize, block sizes), then `payload`."""
    return struct.pack(spec.header_format, len(payload), 99, *range(len(spec.blocks))) + payload


def unsigned(spec, zone):
    head = UNSIGNED + struct.pack("<I", VERSION[spec])
    if spec is not T5:
        head += b"\0" + bytes(8)  # an ignored byte and a timestamp
    return head + zlib.compress(zone)


def signed(spec, zone, name=b"mp_test"):
    """IWff0100: header, auth header padded to a chunk, then [master chunk, <=256 data chunks]..."""
    stream = zlib.compress(zone)
    chunks = [stream[i : i + CHUNK] for i in range(0, len(stream), CHUNK)]
    groups = [chunks[i : i + 256] for i in range(0, len(chunks), 256)]
    masters = [b"".join(hashlib.sha256(c).digest() for c in group).ljust(CHUNK, b"\0") for group in groups]
    subheader = name.ljust(32, b"\0") + bytes(4) + b"".join(hashlib.sha256(m).digest() for m in masters).ljust(244 * 32, b"\0")
    auth = b"IWffs100" + bytes(4) + hashlib.sha256(subheader).digest() + bytes(256) + subheader
    body = b"".join(m + b"".join(group) for m, group in zip(masters, groups, strict=True))
    return SIGNED + struct.pack("<I", VERSION[spec]) + b"\0" + bytes(8) + auth.ljust(CHUNK, b"\0") + body


def payload(size, seed=1):
    # Incompressible, so the stream spans many chunks.
    return random.Random(seed).randbytes(size)


@pytest.mark.parametrize(("spec", "start"), [(IW5, 21), (IW4, 21), (T5, 12)])
def test_an_unsigned_zone_inflates_from_just_after_its_header(tmp_path, spec, start):
    zone = zone_bytes(spec, payload(50_000))
    path = tmp_path / "a.ff"
    path.write_bytes(unsigned(spec, zone))
    assert fastfile.claim(path) == (spec, False, start)
    got_spec, got = fastfile.read_zone(path)
    assert got_spec is spec and got == zone and isinstance(got, bytearray)
    assert spec.header(got)[0] == len(got) - spec.header_size


@pytest.mark.parametrize("spec", [IW4, IW5])
def test_a_signed_zone_spanning_two_master_chunks_inflates(tmp_path, spec):
    zone = zone_bytes(spec, payload(257 * CHUNK + 1234))  # more than one group, a short last chunk
    path = tmp_path / "mp_test.ff"
    path.write_bytes(signed(spec, zone))
    assert fastfile.claim(path) == (spec, True, 21)
    assert fastfile.read_zone(path) == (spec, zone)


@pytest.mark.parametrize(
    ("where", "message"),
    [
        (lambda n: 21 + 0x2000 + 0x2000 + 5, "chunk 0 of group 0 fails its hash"),  # the first data chunk
        (lambda n: n - 3, "chunk 1 of group 1 fails its hash"),  # the short last one
        (lambda n: 21 + 0x2000 + 7, "master chunk 0 fails its hash"),
        (lambda n: 21 + 300 + 40, "auth subheader fails its hash"),
    ],
)
def test_a_signed_zone_with_a_wrong_hash_is_refused(tmp_path, where, message):
    data = bytearray(signed(IW5, zone_bytes(IW5, payload(257 * CHUNK))))
    data[where(len(data))] ^= 0x40
    path = tmp_path / "mp_test.ff"
    path.write_bytes(bytes(data))
    with pytest.raises(ValueError, match=message):
        fastfile.read_zone(path)


def test_a_zone_longer_or_shorter_than_its_header_states_is_refused(tmp_path):
    zone = bytearray(zone_bytes(T5, payload(1000)))
    for size in (999, 1001):
        struct.pack_into("<I", zone, 0, size)
        path = tmp_path / f"{size}.ff"
        path.write_bytes(unsigned(T5, bytes(zone)))
        with pytest.raises(ValueError, match="its header states"):
            fastfile.read_zone(path)


def test_a_truncated_stream_is_refused(tmp_path):
    path = tmp_path / "a.ff"
    path.write_bytes(unsigned(IW5, zone_bytes(IW5, payload(20_000)))[:-100])
    with pytest.raises(ValueError, match="truncated"):
        fastfile.read_zone(path)


def test_only_iw4_iw5_and_t5_headers_are_claimed(tmp_path):
    cases = {
        "iw6": SIGNED + struct.pack("<I", 0x235),  # Ghosts shares the magic, not the version
        "s1": b"S1ff0100" + struct.pack("<I", 0x72E),
        "t5-signed": SIGNED + struct.pack("<I", 0x1D9),  # no Black Ops zone is signed
        "short": b"IWff",
    }
    for name, head in cases.items():
        path = tmp_path / f"{name}.ff"
        path.write_bytes(head + bytes(64))
        assert fastfile.claim(path) is None, name
        with pytest.raises(ValueError):
            fastfile.read_zone(path)


def test_is_t5_tells_a_black_ops_zone_by_its_header(tmp_path):
    t5, iw5 = tmp_path / "a.ff", tmp_path / "b.ff"
    t5.write_bytes(unsigned(T5, zone_bytes(T5, b"")))
    iw5.write_bytes(unsigned(IW5, zone_bytes(IW5, b"")))
    assert fastfile.is_t5(t5) and not fastfile.is_t5(iw5)
