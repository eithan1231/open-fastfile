#!/usr/bin/env python3
"""Write the C++ program that prints a game's struct layouts as the host g++ -m32 lays
them out, from OAT's <G>_Assets.h.

    layout.py <iw4|iw5|t5> > layout.cpp      (layout.sh compiles and runs it)

The member list comes from oat.py's reading of the header -- ZCG's view of it -- and the
program itself comes from reverse/iw6-zone/layout/gen.py, with the alignment column on.
The header is compiled as OAT's own x86 build compiles it (`-m32 -DARCH_x86`, see
layout.sh), not as ZCG preprocesses it, so its `gcc_align32` annotations apply: those are
what make i386's 4-byte `double`/`int64` alignment agree with MSVC's 8.

Rows follow gen.py's schema. Anonymous structs and unions have no name to print a size
row under; their members are listed under the named struct holding them, dotted when the
anonymous member has a name (`u.image`). Bit-fields have no offset in C++ and are left out.
"""

import os
import sys

import oat

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "iw6-zone", "layout"))
import gen  # noqa: E402


def base_of(decl):
    t = decl.type
    while t.kind == "typedef" and not t.decl.mods:
        t = t.decl.type
    return t.full if t.kind in ("struct", "union") and not t.anonymous else None


def rows(record, prefix=""):
    out = []
    for var in record.members:
        t = var.decl.type
        if var.decl.bits is not None:
            continue
        if t.kind in ("struct", "union") and t.anonymous and not var.decl.mods:
            if var.name:
                out.append((prefix + var.name, None))
                out.extend(rows(t, prefix + var.name + "."))
            else:
                out.extend(rows(t, prefix))
            continue
        if not var.name:
            continue  # ZCG's member for a nested type declared without one; C++ has none
        out.append((prefix + var.name, base_of(var.decl)))
    return out


def main():
    g = sys.argv[1]
    G = oat.game_dir(g)
    header = oat.Header(oat.preprocess_header(g), f"{G}_ZoneCode.h")
    structs = [(d.full, rows(d)) for d in header.definitions if d.kind in ("struct", "union") and not d.anonymous]
    include = f'#include "{oat.path("src", "Common", "Game", G, f"{G}_Assets.h")}"'
    sys.stdout.write(gen.render(structs, G, include=include, align=True))


if __name__ == "__main__":
    main()
