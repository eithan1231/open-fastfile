"""Whole-file reads and writes.

Every one of these used to be a bare `open(...)` inside a larger expression,
which leaves the handle to the garbage collector. The pipeline walks tens of
thousands of small files per map, so that is worth closing deliberately.
"""

import json
import os


def find_file(root, suffix):
    """The first file under `root` ending in `suffix`, or None."""
    for dirpath, _, files in os.walk(root):
        for f in files:
            if f.endswith(suffix):
                return os.path.join(dirpath, f)
    return None


def read_bytes(path):
    with open(path, "rb") as fh:
        return fh.read()


def read_text(path, encoding="latin-1"):
    """CoD's own text assets (`.gsc`, `.ents`, `.zone`, infostrings) are latin-1; pass utf-8 for what this pipeline wrote."""
    with open(path, encoding=encoding) as fh:
        return fh.read()


def read_json(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def write_text(path, text, encoding="utf-8"):
    with open(path, "w", encoding=encoding, newline="\n") as fh:
        fh.write(text)


def write_json(path, data):
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(data, fh, separators=(",", ":"), sort_keys=True)
