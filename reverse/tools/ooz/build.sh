#!/usr/bin/env bash
# Build ooz (an open-source Oodle decoder, github.com/powzix/ooz) for Linux:
# a shared library exporting Kraken_Decompress for ctypes (reverse/tools/oodle.py),
# and the ooz command-line tool.
#
#   reverse/tools/ooz/build.sh
#
# ooz is GPL-3, so it is cloned into src/ (gitignored) at a pinned commit rather
# than committed; OOZ_SRC points at another checkout instead. The checkout is
# only read, never patched. Output goes to out/ (gitignored).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
src="${OOZ_SRC:-$here/src}"
commit=05038060aa68f9187ae9923b2388ca8db40e58d1
out="$here/out"

if [[ ! -d "$src" ]]; then
  git clone https://github.com/powzix/ooz.git "$src"
  git -C "$src" checkout --quiet "$commit"
fi
mkdir -p "$out/src"

cp "$src"/kraken.cpp "$src"/bitknit.cpp "$src"/lzna.cpp "$out/src/"
cp "$here/stdafx.h" "$out/src/"

flags=(-O2 -std=c++17 -fPIC -w -fpermissive)
# kraken.cpp holds the decoder and the CLI's main(); the library renames main
# out of the way and exports the decoder with C linkage.
g++ "${flags[@]}" -shared -Dmain=ooz_cli_main \
  -include "$here/export.h" \
  -o "$out/libooz.so" "$out/src/kraken.cpp" "$out/src/bitknit.cpp" "$out/src/lzna.cpp"
g++ "${flags[@]}" -o "$out/ooz" "$out/src/kraken.cpp" "$out/src/bitknit.cpp" "$out/src/lzna.cpp"
echo "built $out/libooz.so and $out/ooz"
