"""The `nav.bin` conformance fixture: its JSON description, encoded.

    python3 -m scripts.cod.nav.conformance           # rewrite conformance.nav.bin
    python3 -m scripts.cod.nav.conformance --check   # exit 1 if it would change

The fixture lives with the TypeScript decoder that reads it
(`packages/shared/tests/fixtures/nav/`). Both files are committed: the bytes are
the contract, so a change to them is a format change and shows up in review.
"""

import argparse
import json
import os
import sys

from .format import Link, NavData, Node, RawSection, Traversal, encode
from .vocab import ABILITIES, HEADER_FLAGS, LINK_FLAGS, STANCES, mask

REPO = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".."))
FIXTURE_DIR = os.path.join(REPO, "packages", "shared", "tests", "fixtures", "nav")
JSON_PATH = os.path.join(FIXTURE_DIR, "conformance.json")
BIN_PATH = os.path.join(FIXTURE_DIR, "conformance.nav.bin")


def load(path=JSON_PATH):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def nav_data(fixture):
    """The fixture's JSON as the encoder's records."""
    nodes = [
        Node(
            position=tuple(n["position"]),
            type=n["type"],
            yaw=n["yaw"],
            floor_z=n["floorZ"],
            group=n["group"],
            abilities=mask(ABILITIES, n["abilities"]),
            stance=mask(STANCES, n["stance"]),
            source=n["source"],
            name=n["name"],
        )
        for n in fixture["nodes"]
    ]
    links = [
        Link(
            from_node=link["from"],
            to_node=link["to"],
            kind=link["kind"],
            game_cost=link["gameCost"],
            flags=mask(LINK_FLAGS, link["flags"]),
            traversal=link["traversal"],
        )
        for link in fixture["links"]
    ]
    travs = [Traversal(begin=t["begin"], end=t["end"], kind=t["kind"], animscript=t["animscript"]) for t in fixture["traversals"]]
    extra = [
        RawSection(tag=x["tag"], version=x["version"], payload=bytes.fromhex(x["hex"]), required=x["required"])
        for x in fixture["extra"]
    ]
    return NavData(
        nodes=nodes,
        links=links,
        traversals=travs,
        flags=mask(HEADER_FLAGS, fixture["flags"]),
        meta=fixture["meta"],
        skipped=fixture["skipped"],
        extra=extra,
    )


def build(path=JSON_PATH):
    return encode(nav_data(load(path)))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--check", action="store_true", help="compare with the committed bytes instead of writing them")
    args = ap.parse_args(argv)
    data = build()
    if args.check:
        with open(BIN_PATH, "rb") as fh:
            same = fh.read() == data
        print(f"{os.path.relpath(BIN_PATH, REPO)}: {'unchanged' if same else 'DIFFERS'}")
        return 0 if same else 1
    with open(BIN_PATH, "wb") as fh:
        fh.write(data)
    print(f"wrote {os.path.relpath(BIN_PATH, REPO)} ({len(data)} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
