#!/usr/bin/env bash
# Build out/<g>/layout.json from OAT's <G>_Assets.h with the host g++ in 32-bit mode.
#
#   layout.sh <iw4|iw5|t5|t6>       ($OAT names the OpenAssetTools checkout)
#
# layout.py writes a program (reverse/iw6-zone/layout/gen.py's) printing every member's
# offset, size and alignment; g++ compiles it with the flags OAT's own x86 build uses
# (build/src/*/Makefile: -m32 -std=c++23 -DARCH_x86), since those decide what the
# header's alignment macros expand to.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
g=${1:?usage: layout.sh <iw4|iw5|t5|t6>}
: "${OAT:?set OAT to an OpenAssetTools checkout}"
out="$here/../out/$g/layout"
mkdir -p "$out"
python3 "$here/layout.py" "$g" > "$out/layout.cpp"
g++ -m32 -std=c++23 -DARCH_x86 -w "$out/layout.cpp" -o "$out/layout"
"$out/layout" > "$out/../layout.json"
echo "$(cd "$out/.." && pwd)/layout.json"
