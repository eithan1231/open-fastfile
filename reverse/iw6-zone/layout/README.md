# Struct layouts from x64-zt

The importer reads Ghosts' (IW6) and Advanced Warfare's (S1) zones by field path
(`"draw.vd.vertices"`), never by an offset typed by hand. The offsets come from a
generated layout file, built here from the PC structs of
[x64-zt](https://github.com/Joelrau/x64-zt) (checked at `021936c`), which is read
and compiled but never run.

| Script                           | Writes                               |
| -------------------------------- | ------------------------------------ |
| `layout.sh`                      | `scripts/cod/data/iw6/layout.json`   |
| `../../s1-zone/layout/layout.sh` | `scripts/cod/data/s1/layout_pc.json` |

```sh
X64ZT=<an x64-zt checkout> reverse/iw6-zone/layout/layout.sh
X64ZT=<an x64-zt checkout> reverse/s1-zone/layout/layout.sh
```

Each copies `src/zonetool/zonetool/<game>/structs.hpp` into its effort's `out/layout/`
(gitignored) with `long` narrowed to 32 bits, as MSVC has it. `gen.py` then writes a
C++ program that prints every struct and member, and the host `g++` (C++20,
`-fms-extensions`) compiles and runs it, so the compiler and not the parser works
out every offset and size. A member the parser misreads fails to compile. S1's
script also drops the few menu members that do not compile, since no walk reads
them; each struct keeps its size row. `d3d11.h` is a stub with just enough of the
D3D11 types for the headers to compile: every use is a pointer.

Every row of the JSON is `[struct, member path, offset, size, element size, pointee
size, kind, extent 0, extent 1, base type]`, where kind is 0 other, 1 unsigned, 2
signed, 3 float, 4 pointer. A struct's own row has an empty path and its size. With
`render(..., align=True)` a row gains an eleventh column, its `alignof`; the 32-bit
games' layouts use that (`reverse/x86-zone/`).

The outputs are tracked, so a rebuild against the same x64-zt shows no diff.
