"""The game's `.iwd` archives: what is loose beside the fastfiles rather than in one.

A search path is the `;`-joined list of a game's `main` directories (installs.py).
Pictures (the compass, the loading screen) and streamed sounds both live here,
which is why this is its own module rather than half of `textures.py`.

Entry names are matched **case-insensitively and asked for by their own
spelling**: the archives do not agree with each other, and `iw_11.iwd` holds
`sound/...` where `iw_34.iwd` holds `Sound/...`. Matched exactly, every streamed
clip in one of the two resolves to nothing and the alias plays silently.
"""

import functools
import glob
import os
import zipfile


@functools.cache
def entries(root):
    """((archive, its entry names), …) for one search root.

    Read once per root: a game directory holds dozens of .iwd archives, every
    caller walks the same ones, and an `--all` batch asks once per map.
    """
    out = []
    for iwd in sorted(glob.glob(os.path.join(root, "*.iwd"))):
        try:
            with zipfile.ZipFile(iwd) as z:
                out.append((iwd, frozenset(z.namelist())))
        except zipfile.BadZipFile:
            continue
    return tuple(out)


@functools.cache
def index(search, newest=False):
    """{lower-case entry name: (archive, its own spelling)} across the whole search path.

    Roots are searched in the order the search path lists them. Within a root the
    lowest-named archive wins, or with `newest` the highest-named, which is the
    game's own order (a later `iw_NN.iwd` patches an earlier one). The two differ
    for a handful of files: docs/cod/pitfalls.md#extraction.
    """
    found = {}
    for root in search.split(";"):
        for iwd, names in reversed(entries(root)) if newest else entries(root):
            for name in names:
                found.setdefault(name.lower(), (iwd, name))
    return found


def read(search, path, newest=False):
    """The bytes of `path` (case-insensitive) out of the search path, or None."""
    hit = index(search, newest).get(path.lower())
    if not hit:
        return None
    iwd, name = hit
    with zipfile.ZipFile(iwd) as z:
        return z.read(name)
