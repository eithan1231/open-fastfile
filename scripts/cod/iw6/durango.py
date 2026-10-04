"""The Ghosts Xbox One server build, read from disk: its PE32+ image and its linker map.

$IW6_DURANGO, or cod.config.json's `iw6_durango`, names the folder holding
iw6mp64_dh_server_durango.{exe,map}. The user supplies it; nothing ships it.
The exe is never run; `emulate.py` interprets its loaders. Names come from the map,
so they are exact. Why this build: reverse/iw6-zone/README.md#sources-in-order-of-trust.
"""

import bisect
import os
import re

from .. import config
from ..pe import PE

STEM = "iw6mp64_dh_server_durango"
ENV = "IW6_DURANGO"
KEY = "iw6_durango"


def folder():
    """The folder $IW6_DURANGO or cod.config.json's `iw6_durango` names, or '' when neither does."""
    return config.data_path(KEY)[0] or ""


def demangle(name):
    return re.sub(r"^\?([^@]+)@.*", r"\1", name)


class Image:
    def __init__(self, path):
        self.exe = PE(os.path.join(path, STEM + ".exe"))
        self.symbols = {}
        with open(os.path.join(path, STEM + ".map"), errors="replace") as fh:
            for line in fh:
                parts = line.split()
                if len(parts) >= 3 and re.fullmatch(r"[0-9a-f]{16}", parts[2]) and not parts[1].startswith(("$", "__imp")):
                    self.symbols.setdefault(int(parts[2], 16), parts[1])
        self.addresses = sorted(self.symbols)

    def name(self, va):
        i = bisect.bisect_right(self.addresses, va) - 1
        if i < 0:
            return hex(va)
        base = self.addresses[i]
        name = demangle(self.symbols[base])
        return name if base == va else f"{name}+0x{va - base:x}"

    def find(self, wanted):
        if wanted.startswith("0x"):
            return int(wanted, 16)
        return next(va for va, n in self.symbols.items() if demangle(n) == wanted)

    def end(self, va):
        """Where the function at `va` ends: the next symbol's address."""
        return self.addresses[self.addresses.index(va) + 1]
