#!/usr/bin/env python3
"""Emit C++ that prints the layout of every struct and union in x64-zt's IW6 structs.hpp.

    gen.py <structs.hpp> [namespace] > layout.cpp

`namespace` defaults to IW6's; S1's headers are laid out the same way, so the
same parser serves both (reverse/s1-zone/layout/layout.sh). `render()` is the
program writer on its own, for a caller that lists the members itself
(reverse/x86-zone/layout/layout.py, over OAT's 32-bit headers); it can add an
eleventh column, the member's or struct's `alignof`.

The header is regular enough for a line parser: one member per line, named
types opened by `struct Name` / `union Name` and a `{` line, anonymous unions
and structs flattened into their parent. The compiler, not this script, works
out every offset and size; a member this parser misreads fails to compile.
"""

import re
import sys

OPEN_NAMED = re.compile(r"^(struct|union)\s+(\w+)\s*(?::\s*(?:public\s+)?(\w+)\s*)?(\{)?\s*$")
OPEN_ANON = re.compile(r"^(struct|union)\s*(\{)?\s*$")
CLOSE = re.compile(r"^}\s*(\w+)?\s*;")
FUNC_PTR_ARRAY = re.compile(r"^(?P<type>.+?)\(\*(?P<name>\w+)\)(?P<dims>(\[[^\]]+\])+)$")
PLAIN = re.compile(r"^(?P<type>.+?[\s*&])(?P<name>\w+)(?P<dims>(\s*\[[^\]]+\])*)$")


def strip(line):
    # A block comment can sit inside a declaration -- S1 writes `struct
    # /*alignas(128)*/ clipMap_t` -- and a head this does not clear is a struct
    # silently missing from the layout rather than a parse error.
    line = re.sub(r"/\*.*?\*/", " ", line)
    line = re.sub(r"//.*", "", line)
    return line.strip()


NAMESPACE = "zonetool::iw6"


def parse(text):
    """Yield (struct name, [(path, base type or None)])."""
    structs = []
    known = {}  # parsed struct name -> members, for derived structs
    stack = []  # frames: {"name", "prefix", "members", "anon", "pending_member"}
    pending = None  # a struct/union head waiting for its `{`
    skip_depth = 0  # inside an enum
    for raw in text.splitlines():
        line = strip(raw)
        if not line or line.startswith("#"):
            continue
        if skip_depth:
            skip_depth += line.count("{") - line.count("}")
            continue
        if line.startswith("enum"):
            skip_depth = line.count("{") - line.count("}")
            if "{" not in line:
                skip_depth = 1 if not line.endswith(";") else 0
                # the `{` arrives on the next line; count it there
                if skip_depth:
                    skip_depth = 0
                    pending = "enum"
            continue
        if pending == "enum":
            if line == "{":
                skip_depth = 1
                pending = None
            continue
        if line in (f"namespace {NAMESPACE}", "{") and not stack and pending is None:
            continue
        if pending is not None:
            if line != "{":
                pending = None
            else:
                kind, name, *rest = pending
                pending = None
                if name:
                    stack.append({"name": name, "prefix": "", "members": rest[0] if rest else []})
                else:
                    parent = stack[-1]
                    stack.append({"name": None, "prefix": parent["prefix"], "members": parent["members"], "anon": True})
                continue
        m = OPEN_NAMED.match(line)
        if m and not line.endswith(";"):
            # A base class's members come first, as the compiler lays them out.
            inherited = list(known.get(m.group(3), [])) if m.group(3) else []
            pending = (m.group(1), m.group(2), inherited)
            if m.group(4):
                stack.append({"name": m.group(2), "prefix": "", "members": inherited})
                pending = None
            continue
        m = OPEN_ANON.match(line)
        if m:
            if stack:
                pending = (m.group(1), None)
                if m.group(2):
                    parent = stack[-1]
                    stack.append({"name": None, "prefix": parent["prefix"], "members": parent["members"], "anon": True})
                    pending = None
            continue
        m = CLOSE.match(line)
        if m:
            if not stack:
                continue
            frame = stack.pop()
            if frame.get("anon"):
                if m.group(1):
                    raise ValueError(f"anonymous member {m.group(1)} needs handling")
                continue
            if stack:
                # A type nested in another: only its member, if `} name;` declares one, is kept.
                if m.group(1):
                    stack[-1]["members"].append((stack[-1]["prefix"] + m.group(1), None))
                continue
            structs.append((frame["name"], frame["members"]))
            known[frame["name"]] = frame["members"]
            continue
        if not stack or not line.endswith(";"):
            continue
        decl = line[:-1].strip()
        if ":" in decl.replace("::", "") or decl.startswith(("static", "typedef", "using", "friend", "struct ", "union ")):
            continue
        if "(" in decl and not FUNC_PTR_ARRAY.match(decl):
            continue
        m = FUNC_PTR_ARRAY.match(decl) or PLAIN.match(decl)
        if not m:
            continue
        # Qualifiers are dropped as whole words: a type may contain the text (`pathnode_constant_t`).
        base = [word for word in m.group("type").replace("*", " ").split() if word not in ("const", "volatile")]
        base = base[-1] if base and base[-1] not in ("char", "short", "int", "long", "__int64", "float", "double") else None
        stack[-1]["members"].append((stack[-1]["prefix"] + m.group("name"), base))
    return structs


PRELUDE = r"""// Generated by gen.py from x64-zt's structs.hpp. Do not edit.
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <type_traits>
#define __int64 long long
#define assert_sizeof(x, y)
#define assert_offsetof(x, y, z)
#include "structs.hpp"
using namespace {NAMESPACE};

template <class X> struct pointee_of { static constexpr std::size_t value = 0; };
template <class T> requires std::is_object_v<T> && requires { sizeof(T); }
struct pointee_of<T*> { static constexpr std::size_t value = sizeof(T); };
template <class X> using leaf = std::remove_cv_t<std::remove_all_extents_t<X>>;
template <class X> constexpr std::size_t pointee() { return pointee_of<leaf<X>>::value; }
template <class L, bool = std::is_enum_v<L>> struct integer_of { using type = L; };
template <class L> struct integer_of<L, true> { using type = std::underlying_type_t<L>; };
template <class X> constexpr int kind()
{
    // 0 other, 1 unsigned integer, 2 signed integer, 3 float, 4 pointer
    using L = leaf<X>;
    using I = typename integer_of<L>::type;
    if (std::is_pointer_v<L>) return 4;
    if (std::is_floating_point_v<L>) return 3;
    if (std::is_integral_v<I>) return std::is_signed_v<I> ? 2 : 1;
    return 0;
}

#define M(T, path, base) do { \
    using X = decltype(((T*)nullptr)->path); \
    std::printf("[\"%s\",\"%s\",%zu,%zu,%zu,%zu,%d,%zu,%zu,\"%s\"],\n", #T, #path, offsetof(T, path), sizeof(X), \
                sizeof(leaf<X>), pointee<X>(), kind<X>(), std::extent_v<X, 0>, std::extent_v<X, 1>, base); \
} while (0);
#define S(T) std::printf("[\"%s\",\"\",0,%zu,0,0,0,0,0,\"\"],\n", #T, sizeof(T));

int main()
{
    std::printf("[\n");
"""


ALIGNED = r"""#define M(T, path, base) do { \
    using X = decltype(((T*)nullptr)->path); \
    std::printf("[\"%s\",\"%s\",%zu,%zu,%zu,%zu,%d,%zu,%zu,\"%s\",%zu],\n", #T, #path, offsetof(T, path), sizeof(X), \
                sizeof(leaf<X>), pointee<X>(), kind<X>(), std::extent_v<X, 0>, std::extent_v<X, 1>, base, alignof(X)); \
} while (0);
#define S(T) std::printf("[\"%s\",\"\",0,%zu,0,0,0,0,0,\"\",%zu],\n", #T, sizeof(T), alignof(T));
"""


def render(structs, namespace, include='#include "structs.hpp"', align=False):
    """The layout program for [(struct name, [(member path, base type or None)])].

    With `align`, every row gains an eleventh column: alignof the member's type, or of
    the struct on its size row."""
    prelude = PRELUDE.replace("{NAMESPACE}", namespace).replace('#include "structs.hpp"', include)
    if align:
        start = prelude.index("#define M(T, path, base)")
        prelude = prelude[:start] + ALIGNED + prelude[prelude.index("\nint main()") :]
    out = [prelude]
    for name, members in structs:
        out.append(f"    S({name})\n")
        for path, base in members:
            out.append(f'    M({name}, {path}, "{base or ""}")\n')
    tail = ",0" if align else ""
    out.append('    std::printf("[\\"\\",\\"\\",0,0,0,0,0,0,0,\\"\\"' + tail + ']\\n]\\n");\n}\n')
    return "".join(out)


def main():
    global NAMESPACE
    NAMESPACE = sys.argv[2] if len(sys.argv) > 2 else "zonetool::iw6"
    with open(sys.argv[1]) as fh:
        text = fh.read()
    sys.stdout.write(render(parse(text), NAMESPACE))


if __name__ == "__main__":
    main()
