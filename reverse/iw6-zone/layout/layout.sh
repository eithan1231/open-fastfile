#!/usr/bin/env bash
# Build the importer's IW6 struct layout, scripts/cod/data/iw6/layout.json, from the
# IW6 PC structs of an x64-zt checkout at $X64ZT, with the host g++: gen.py writes a
# program that prints every member's offset and size, and g++ runs it. The program and
# the header copy stay in ../out/layout/.
# MSVC's `long` is 32-bit and g++'s is not, so the header is copied with `long` narrowed.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
x64zt=${X64ZT:?set X64ZT to an x64-zt checkout}
out="$here/../out/layout"
data="$here/../../../scripts/cod/data/iw6"
mkdir -p "$out"
cp "$here/d3d11.h" "$out/d3d11.h"
sed 's/\bunsigned long\b/unsigned int/g; s/\blong\b/int/g' "$x64zt/src/zonetool/zonetool/iw6/structs.hpp" > "$out/structs.hpp"
python3 "$here/gen.py" "$out/structs.hpp" > "$out/layout.cpp"
g++ -std=c++20 -w -fms-extensions -I"$out" "$out/layout.cpp" -o "$out/layout"
mkdir -p "$data"
"$out/layout" > "$data/layout.json"
echo "$(cd "$data" && pwd)/layout.json"
