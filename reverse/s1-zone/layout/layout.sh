#!/usr/bin/env bash
# Build the importer's S1 struct layout, scripts/cod/data/s1/layout_pc.json, from the
# S1 PC structs of an x64-zt checkout at $X64ZT with the host g++, exactly as
# reverse/iw6-zone/layout/layout.sh does for IW6 -- the generator and the d3d11 stub
# are that effort's, since neither is game-specific. Intermediates stay in ../out/layout/.
#
# This is the authoritative layout, and the one scripts/cod/s1/walkers.py reads.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
iw6=$here/../../iw6-zone/layout
x64zt=${X64ZT:?set X64ZT to an x64-zt checkout}
out="$here/../out/layout"
data="$here/../../../scripts/cod/data/s1"
mkdir -p "$out"
cp "$iw6/d3d11.h" "$out/d3d11.h"
# MSVC's `long` is 32-bit and g++'s is not, so the header is copied with `long` narrowed,
# and S1 declares alignment the MSVC way, which g++ takes only as alignas.
sed -E 's/\bunsigned long\b/unsigned int/g; s/\blong\b/int/g; s/__declspec\(align\(([0-9]+)\)\)/alignas(\1)/g' "$x64zt/src/zonetool/zonetool/s1/structs.hpp" > "$out/structs.hpp"
python3 "$iw6/gen.py" "$out/structs.hpp" zonetool::s1 > "$out/layout.cpp"

# gen.py mis-flattens the anonymous unions in S1's menu structs, which no walk needs.
# Rather than special-case them in a parser that is right about everything else, drop
# whatever members the compiler rejects and build again; each struct keeps its size row.
for attempt in 1 2 3 4 5 6; do
    if g++ -std=c++20 -w -fms-extensions -I"$out" "$out/layout.cpp" -o "$out/layout" 2> "$out/errors.txt"; then
        break
    fi
    bad=$(grep -oE 'M\([A-Za-z_0-9]+, [A-Za-z_0-9]+' "$out/errors.txt" | sort -u || true)
    if [ -z "$bad" ]; then cat "$out/errors.txt"; exit 1; fi
    echo "$bad" | while read -r line; do
        printf '    dropping %s\n' "$line" >&2
        grep -vF "$line," "$out/layout.cpp" > "$out/layout.next" && mv "$out/layout.next" "$out/layout.cpp"
    done
done
test -x "$out/layout" || { echo "layout did not build"; exit 1; }
mkdir -p "$data"
"$out/layout" > "$data/layout_pc.json"
echo "$(cd "$data" && pwd)/layout_pc.json"
