"""File helpers shared by the writers: where OpenAssetTools puts an asset, and how it writes JSON."""

import json
import os


def asset_path(out, name):
    """Where an asset named `name` is written under `out`, creating its folder."""
    path = os.path.join(out, name)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    return path


def plain(name):
    """An asset name without the leading comma that marks it as another zone's."""
    return name.removeprefix(",") if name else name


def write_json(path, data):
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(data, fh, indent=4)
        fh.write("\n")


def bounds(mid, half):
    """A Bounds (midpoint, half size) as OpenAssetTools writes it: its corners."""
    return {
        "mins": [m - h for m, h in zip(mid, half, strict=True)],
        "maxs": [m + h for m, h in zip(mid, half, strict=True)],
    }
