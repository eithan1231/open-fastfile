"""Oodle decompression through ooz, by ctypes.

ooz (an open-source Oodle decoder, GPL-3) is built by `reverse/tools/ooz/build.sh`
into `reverse/tools/ooz/out/libooz.so`; `$OOZ_LIB` or cod.config.json's `ooz` names
another build. It is not
hardened against bad input, so it is only ever handed a stream whose framing
has been checked (ff.py's block headers, xpak.py's chunk commands).
"""

import ctypes
import os

from .. import config
from ..config import REPO_ROOT

DEFAULT = os.path.join(REPO_ROOT, "reverse", "tools", "ooz", "out", "libooz.so")
BUILD = "reverse/tools/ooz/build.sh"
# ooz writes up to this many bytes past the end of its output while decoding.
SAFE_SPACE = 64

_lib = None


def library_path():
    return config.data_path("ooz")[0] or DEFAULT


def available():
    return os.path.exists(library_path())


def _load():
    global _lib
    if _lib is None:
        path = library_path()
        if not os.path.exists(path):
            raise SystemExit(
                f"Black Ops Cold War needs an Oodle decoder, and there is none at {path}: build it with {BUILD}, "
                "or set cod.config.json's `ooz` (or $OOZ_LIB) to a build"
            )
        _lib = ctypes.CDLL(path)
        _lib.Kraken_Decompress.argtypes = [ctypes.c_char_p, ctypes.c_size_t, ctypes.c_void_p, ctypes.c_size_t]
        _lib.Kraken_Decompress.restype = ctypes.c_int
    return _lib


def decompress(src, size):
    """Decode one Oodle stream to exactly `size` bytes, or raise ValueError."""
    buf = ctypes.create_string_buffer(size + SAFE_SPACE)
    n = _load().Kraken_Decompress(bytes(src), len(src), buf, size)
    if n != size:
        raise ValueError(f"oodle: decoded {n} bytes, expected {size}")
    return buf.raw[:size]
