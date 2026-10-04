#!/usr/bin/env python3
"""Check a game's struct layouts against OAT's own generated struct tests.

    check.py <iw4|iw5|t5|t6> [--layout out/<g>/layout.json] [--zonecode scripts/cod/data/<g>/zonecode.json]

ZoneCodeGenerator writes build/src/ZoneCode/Game/<G>/XAssets/*/*_struct_test.cpp: one
`REQUIRE(offsetof(S, m) == N)` per member it will load, and `sizeof`/`alignof` per
struct, all computed by ZCG itself. Every one is checked against

- layout.json, what the host g++ -m32 compiled (layout.sh), and
- zonecode.json, what zonecode.py computed by ZCG's own rules (oat.py),

so a mismatch names which side is wrong. Exit status is the number of mismatches.
"""

import argparse
import glob
import json
import os
import re
import sys

import oat

REQUIRES = [
    (re.compile(r"REQUIRE\(offsetof\(([\w:]+),\s*(\w+)\)\s*==\s*(\d+)\)"), "offsetof"),
    (re.compile(r"REQUIRE\((\d+)u\s*==\s*sizeof\(([\w:]+)\)\)"), "sizeof"),
    (re.compile(r"REQUIRE\((\d+)u\s*==\s*alignof\(([\w:]+)\)\)"), "alignof"),
]


def struct_tests(g):
    """{(kind, struct, member): value}, deduplicated across the per-asset test files."""
    G = oat.game_dir(g)
    files = sorted(glob.glob(oat.path("build", "src", "ZoneCode", "Game", G, "XAssets", "*", "*_struct_test.cpp")))
    if not files:
        raise SystemExit(f"no struct tests under {oat.path('build', 'src', 'ZoneCode', 'Game', G)}: build OAT's ZoneCode first")
    tests = {}
    for file in files:
        with open(file) as fh:
            for line in fh:
                for regex, kind in REQUIRES:
                    m = regex.search(line)
                    if not m:
                        continue
                    if kind == "offsetof":
                        key, value = (kind, m.group(1), m.group(2)), int(m.group(3))
                    else:
                        key, value = (kind, m.group(2), ""), int(m.group(1))
                    if tests.setdefault(key, value) != value:
                        raise SystemExit(f"{file}: {key} is both {tests[key]} and {value}")
    return tests


def from_layout(file):
    with open(file) as fh:
        rows = json.load(fh)
    got = {}
    for row in rows:
        typename, member, offset, size = row[:4]
        align = row[10] if len(row) > 10 else None
        if not typename:
            continue
        if member:
            got[("offsetof", typename, member)] = offset
        else:
            got[("sizeof", typename, "")] = size
            got[("alignof", typename, "")] = align
    return got


def from_zonecode(file):
    with open(file) as fh:
        zc = json.load(fh)
    got = {}
    for name, s in zc["structs"].items():
        got[("sizeof", name, "")] = s["size"]
        got[("alignof", name, "")] = s["align"]
        for m in s["members"]:
            got[("offsetof", name, m["name"])] = m["offset"]
    return got


def compare(tests, got, label):
    bad = 0
    for key, want in sorted(tests.items()):
        have = got.get(key)
        if have != want:
            bad += 1
            if bad <= 40:
                print(f"  {label}: {key[0]}({key[1]}{', ' + key[2] if key[2] else ''}) is {have}, OAT says {want}")
    print(f"{label}: {len(tests) - bad}/{len(tests)} struct-test checks agree")
    return bad


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("game", choices=sorted(oat.GAMES))
    here = os.path.dirname(os.path.abspath(__file__))
    ap.add_argument("--layout")
    ap.add_argument("--zonecode")
    args = ap.parse_args()
    out = os.path.join(here, "..", "out", args.game)
    tests = struct_tests(args.game)
    kinds = {k: sum(1 for key in tests if key[0] == k) for k in ("offsetof", "sizeof", "alignof")}
    print(
        f"{args.game}: {len(tests)} REQUIREs ({kinds['offsetof']} offsetof, {kinds['sizeof']} sizeof, {kinds['alignof']} alignof)"
    )
    bad, got = 0, {}
    for label, file, reader in (
        ("layout.json", args.layout or os.path.join(out, "layout.json"), from_layout),
        ("zonecode.json", args.zonecode or oat.data_path(args.game, "zonecode.json"), from_zonecode),
    ):
        if not os.path.exists(file):
            print(f"{label}: missing ({file})")
            bad += 1
            continue
        got[label] = reader(file)
        bad += compare(tests, got[label], label)
    if len(got) == 2:
        # Beyond the tests: every struct both sides lay out. Anonymous types and
        # bit-fields exist only on ZCG's side.
        a, b = got["layout.json"], got["zonecode.json"]
        common = [k for k in b if k in a]
        differ = [k for k in common if a[k] != b[k]]
        print(f"layout.json vs zonecode.json: {len(common) - len(differ)}/{len(common)} shared rows agree")
        for k in differ[:40]:
            print(f"  {k}: g++ {a[k]}, ZCG {b[k]}")
        bad += len(differ)
    sys.exit(min(bad, 255))


if __name__ == "__main__":
    main()
