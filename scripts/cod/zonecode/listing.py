"""A walk's asset listing in the format of OpenAssetTools' `zone_source/<zone>.zone`.

The listing is what `scripts/cod/metadata.py` reads for the game a zone belongs to and
for what it holds. Each asset appears once, as `<type>,<name>`, with OAT's type names
(Game<G>.cpp's ASSET_TYPE_NAMES, carried in zonecode.json); a name with a leading comma
is another zone's asset, listed as it is found.
"""

import os

HEADERS = {
    "iw4": ("// Call Of Duty: Modern Warfare 2", "IW4"),
    "iw5": ("// Call Of Duty: Modern Warfare 3", "IW5"),
    "t5": ("// Call Of Duty: Black Ops", "T5"),
    "t6": ("// Call Of Duty: Black Ops II", "T6"),
}


LOCALIZE = "localize"


def value(name):
    """A name as OAT's ZoneDefinitionOutputStream writes it: quoted, with `"` and `\\` escaped,
    when it holds a quote or `//`; `""` when empty."""
    if '"' in name or "//" in name:
        return '"' + name.replace("\\", "\\\\").replace('"', '\\"') + '"'
    return name or '""'


def rows(walk):
    """(type, name) of each line, as OAT's ZoneDefWriter<G> writes them: every localize entry
    is folded into one line naming the zone, which comes first."""
    zone = os.path.splitext(os.path.basename(walk.path or "zone"))[0]
    out = [(LOCALIZE, zone)] if any(listed == LOCALIZE for listed, _ in walk.listing()) else []
    return out + [(listed, value(name)) for listed, name in walk.listing() if listed != LOCALIZE]


def lines(walk):
    title, game = HEADERS[walk.game]
    return [title, f">game,{game}", ""] + [f"{listed},{name}" for listed, name in rows(walk)]


def write_listing(walk, path):
    """Write the listing to `path` (a file, or a directory to hold `<zone>.zone`)."""
    if os.path.isdir(path) and walk.path:
        path = os.path.join(path, os.path.splitext(os.path.basename(walk.path))[0] + ".zone")
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w", encoding="latin-1", newline="\n") as fh:
        fh.write("\n".join(lines(walk)) + "\n")
    return path


def read_listing(path):
    """(type, name) of every asset line of a `.zone` listing."""
    out = []
    with open(path, encoding="latin-1") as fh:
        for line in fh.read().splitlines():
            if not line or line.startswith(("//", ">")):
                continue
            kind, _, name = line.partition(",")
            out.append((kind, name))
    return out


def compare(walked, golden):
    """(missing, extra): assets the golden listing has and the walk does not, and the reverse.
    Compared as multisets, so a duplicate on one side only is reported too."""
    have, want = {}, {}
    for row in walked:
        have[row] = have.get(row, 0) + 1
    for row in golden:
        want[row] = want.get(row, 0) + 1
    missing = sorted(row for row, n in want.items() if have.get(row, 0) < n)
    extra = sorted(row for row, n in have.items() if want.get(row, 0) < n)
    return missing, extra
