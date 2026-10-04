"""Black Ops II's sound asset banks: the audio a `soundbank` names, kept in `.sabl`/`.sabs` files beside the zones.

    banks = Banks(sound_dir)             # every *.sabl/*.sabs in `<game>/sound`, indexed by asset id
    found = banks.find(asset_id)         # (Bank, Entry), or None
    ext, blob = found[0].clip(found[1])  # a file a stock decoder plays: ".wav" or ".flac"

A zone's `SndAlias` names its recording twice: `assetFileName`, the source path
(`raw\\sound\\amb\\x.SL55.pc.snd`), and `assetId`, `snd_hash` of that path. The
recording itself is in a bank file, keyed by the id alone. `.sabl` is the loaded
half and `.sabs` the streamed half; both have one layout (OAT's SoundBank.cpp and
SoundBankTypes.h), checked here rather than trusted (reverse/t6-sound/):

- a 0x248-byte header: `2UX#`, version 14, the entry and checksum sizes (20, 16),
  a dependency size (64), the entry and dependency counts, then the file size, the
  entry table's offset and the checksum table's offset as 64-bit values, a 16-byte
  checksum and eight 64-byte dependency names;
- the audio, packed end to end from 0x800 with no gaps; then the entry table and
  the checksum table, each padded to 2048 bytes, and nothing after;
- an entry: id, size, offset, frame count, and four bytes -- a frame-rate index,
  the channel count, a looping flag and the format;
- each checksum is the MD5 of its entry's bytes.

On PC every loaded entry is 16-bit PCM (format 0) and every streamed one FLAC
(format 8), all at 48 kHz. `clip` refuses an entry whose bytes do not hash to
their checksum, whose PCM size is not its frame count, or whose FLAC STREAMINFO
disagrees with the entry on rate, channels or length.
"""

import functools
import glob
import hashlib
import os
import struct
from collections import namedtuple

from ..iw5.dumpers.sound import wav

MAGIC = b"2UX#"
VERSION = 14
HEADER = struct.Struct("<4sIIIIIII3q16s")  # + the dependency names
HEADER_SIZE = 0x248
ENTRY = struct.Struct("<IIIIBBBB")
CHECKSUM_SIZE = 16
DEPENDENCY_SIZE = 64
DATA_START = 0x800
SECTOR = 2048
# The frame-rate index an entry stores (OAT's FRAME_RATE_FOR_INDEX).
FRAME_RATES = (8000, 12000, 16000, 24000, 32000, 44100, 48000, 96000, 192000)
PCMS16, FLAC = 0, 8
FORMAT_NAMES = {0: "pcm16", 1: "pcm24", 2: "pcm32", 3: "ieee", 4: "xma4", 5: "mp3", 6: "msadpcm", 7: "wma", 8: "flac"}

Entry = namedtuple("Entry", "id size offset frames rate_index channels looping format")


def snd_hash(name):
    """T6's alias and asset hash: sdbm-like over the lower-cased bytes, from 0x1505, times 0x1003F; never 0 for a name.

    OAT's `Common::SND_HashName`. Checked against every alias list's `id` and every
    entry's `assetId` in the zones read (tests/test_t6_sound.py).
    """
    if not name:
        return 0
    value = 0x1505
    for c in name.lower().encode("latin-1"):
        value = (c + 0x1003F * value) & 0xFFFFFFFF
    return value or 1


def _align(n):
    return -(-n // SECTOR) * SECTOR


class Bank:
    """One `.sabl` or `.sabs` file's header and tables, checked for shape on open."""

    def __init__(self, path):
        self.path = path
        self.name = os.path.basename(path)
        size = os.path.getsize(path)
        with open(path, "rb") as fh:
            head = fh.read(HEADER_SIZE)
            (
                magic,
                version,
                entry_size,
                checksum_size,
                dep_size,
                count,
                dep_count,
                _pad,
                file_size,
                entry_offset,
                checksum_offset,
                self.checksum,
            ) = HEADER.unpack_from(head)
            if magic != MAGIC or version != VERSION:
                raise ValueError(f"{path}: not a version-{VERSION} sound bank ({magic!r}, {version})")
            if (entry_size, checksum_size, dep_size) != (ENTRY.size, CHECKSUM_SIZE, DEPENDENCY_SIZE):
                raise ValueError(f"{path}: entry/checksum/dependency sizes {entry_size}/{checksum_size}/{dep_size}")
            if file_size != size:
                raise ValueError(f"{path}: the header says {file_size} bytes, the file is {size}")
            self.dependencies = [
                name
                for i in range(dep_count)
                if (name := head[HEADER.size + i * dep_size : HEADER.size + (i + 1) * dep_size].split(b"\0")[0].decode())
            ]
            fh.seek(entry_offset)
            table = fh.read(count * ENTRY.size)
            fh.seek(checksum_offset)
            sums = fh.read(count * CHECKSUM_SIZE)
        self.entries = [Entry(*ENTRY.unpack_from(table, i * ENTRY.size)) for i in range(count)]
        self.checksums = [sums[i * CHECKSUM_SIZE : (i + 1) * CHECKSUM_SIZE] for i in range(count)]
        self._check_layout(entry_offset, checksum_offset, size)

    def _check_layout(self, entry_offset, checksum_offset, size):
        """The audio is packed from 0x800 to the entry table, and the two tables fill the file."""
        cursor = DATA_START
        for entry in sorted(self.entries, key=lambda e: e.offset):
            if entry.offset != cursor:
                raise ValueError(f"{self.path}: entry {entry.id:#x} at {entry.offset}, expected {cursor}")
            cursor += entry.size
        if _align(cursor) != entry_offset:
            raise ValueError(f"{self.path}: the audio ends at {cursor}, the entry table starts at {entry_offset}")
        if entry_offset + _align(len(self.entries) * ENTRY.size) != checksum_offset:
            raise ValueError(f"{self.path}: the checksum table is not where the entry table ends")
        if checksum_offset + _align(len(self.entries) * CHECKSUM_SIZE) != size:
            raise ValueError(f"{self.path}: {size - checksum_offset} bytes after the checksum table")

    def read(self, entry):
        """An entry's bytes, refused unless they hash to the checksum the bank stores for them."""
        with open(self.path, "rb") as fh:
            fh.seek(entry.offset)
            blob = fh.read(entry.size)
        index = self.entries.index(entry)
        if len(blob) != entry.size or hashlib.md5(blob).digest() != self.checksums[index]:
            raise ValueError(f"{self.path}: entry {entry.id:#x} does not match its checksum")
        return blob

    def clip(self, entry):
        """(extension, bytes) of one entry as a file a stock decoder plays, checked against the entry."""
        blob = self.read(entry)
        if entry.rate_index >= len(FRAME_RATES):
            raise ValueError(f"{self.path}: entry {entry.id:#x} has frame-rate index {entry.rate_index}")
        rate = FRAME_RATES[entry.rate_index]
        if entry.format == PCMS16:
            if entry.size != entry.frames * entry.channels * 2:
                raise ValueError(f"{self.path}: {entry.size} bytes of PCM is not {entry.frames} frames of {entry.channels}")
            return ".wav", wav(entry.channels, rate, 16, blob)
        if entry.format == FLAC:
            info = flac_streaminfo(blob)
            if (info["rate"], info["channels"], info["frames"]) != (rate, entry.channels, entry.frames):
                raise ValueError(f"{self.path}: entry {entry.id:#x} is {rate} Hz x{entry.channels} x{entry.frames}; FLAC {info}")
            return ".flac", blob
        raise ValueError(f"{self.path}: entry {entry.id:#x} is {FORMAT_NAMES.get(entry.format, entry.format)}, not read")


def flac_streaminfo(blob):
    """The rate, channel count, bit depth and total frames a FLAC stream's first metadata block gives."""
    if blob[:4] != b"fLaC" or blob[4] & 0x7F != 0:
        raise ValueError("not a FLAC stream beginning with STREAMINFO")
    info = blob[8:42]
    packed = int.from_bytes(info[10:18], "big")
    return {
        "rate": packed >> 44,
        "channels": ((packed >> 41) & 0x7) + 1,
        "bits": ((packed >> 36) & 0x1F) + 1,
        "frames": packed & 0xFFFFFFFFF,
    }


class Banks:
    """Every bank file in a game's `sound/` directory, by asset id.

    A zone's aliases name recordings in banks that are not its own: mp_la's loaded
    aliases are nearly all in `cmn_root.all.sabl`. So the index is over the whole
    directory rather than a zone's own two files and their dependencies. An id held
    by two files is kept once, and `conflicts` names those whose checksums differ.
    """

    def __init__(self, sound_dir):
        self.dir = sound_dir
        self.banks = []
        self.by_id = {}
        self.conflicts = []
        for path in sorted(glob.glob(os.path.join(sound_dir, "*.sab[ls]"))):
            bank = Bank(path)
            self.banks.append(bank)
            for entry, checksum in zip(bank.entries, bank.checksums, strict=True):
                held = self.by_id.get(entry.id)
                if held is None:
                    self.by_id[entry.id] = (bank, entry)
                elif held[0].checksums[held[0].entries.index(held[1])] != checksum:
                    self.conflicts.append((entry.id, held[0].name, bank.name))

    def find(self, asset_id):
        return self.by_id.get(asset_id)


@functools.lru_cache(maxsize=16)
def open_bank(path):
    return Bank(path)


def read_clip(bank_path, offset):
    """The playable file of the entry at `offset` in the bank at `bank_path`, as `Bank.clip` checks it."""
    bank = open_bank(bank_path)
    entry = next((e for e in bank.entries if e.offset == offset), None)
    if entry is None:
        raise ValueError(f"{bank_path}: no entry at {offset}")
    return bank.clip(entry)[1]


def sound_dir_for(fastfile_path):
    """`<game>/sound` for a fastfile at `<game>/zone/<language>/<name>.ff`."""
    return os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(fastfile_path)))), "sound")


def clip_path(asset_file_name):
    """The path a recording is kept at: `raw\\sound\\amb\\x.SL55.pc.snd` -> `amb/x.SL55`.

    The build's encoding stays in the name -- storage (`S`treamed, `L`oaded,
    `P`rimed), looping (`L`/`N`) and a quality number -- because one source is
    built more than once: mp_la names `fly/ladder/feet/ladder_feet_00` as two
    different entries of `cmn_root.all.sabl`, and without the code one of them
    would silently stand in for the other. The platform and `.snd` go, and
    `raw\\sound\\`, the tree every name is under.
    """
    path = asset_file_name.replace("\\", "/")
    if path.lower().startswith("raw/"):
        path = path[len("raw/") :]
    if path.lower().startswith("sound/"):
        path = path[len("sound/") :]
    if path.lower().endswith(".pc.snd"):
        path = path[: -len(".pc.snd")]
    return path
