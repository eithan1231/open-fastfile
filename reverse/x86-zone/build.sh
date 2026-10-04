#!/usr/bin/env bash
# Rebuild the importer's load programs for IW4, IW5, T5 and T6 from an OpenAssetTools
# checkout at $OAT, and check them against OAT's own generated code. Written into the
# importer's tracked data, scripts/cod/data/<g>/: zonecode.json, weapon_fields.json (the
# weapon infostring's field table, T5's with its flame table's), for IW5
# attachment_enums.json (the attachment JSON's enum spellings), and for T5 and T6
# material_names.json (the material names OAT knows). The compiled layout,
# out/<g>/layout.json, is an intermediate that only the checks read.
#
#   build.sh [iw4|iw5|t5|t6 ...]
#
# Needs the checkout's build/src/ZoneCode/ (ZCG's generated struct tests and
# *_load_db.cpp, from an OAT build) and a g++ that can target -m32. Nothing in the
# checkout is run or written.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
games=("$@")
[ ${#games[@]} -gt 0 ] || games=(iw4 iw5 t5 t6)
: "${OAT:?set OAT to an OpenAssetTools checkout}"
for g in "${games[@]}"; do
    "$here/layout/layout.sh" "$g"
    python3 "$here/layout/zonecode.py" "$g"
    python3 "$here/layout/check.py" "$g"
    python3 "$here/layout/loaddb.py" "$g"
    python3 "$here/layout/infostring.py" "$g"
    if [ "$g" = t5 ] || [ "$g" = t6 ]; then
        python3 "$here/layout/materialnames.py" "$g"
    fi
done
