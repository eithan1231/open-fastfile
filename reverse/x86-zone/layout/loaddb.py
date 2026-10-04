#!/usr/bin/env python3
"""Prove zonecode.json against OAT's generated loaders: render every load program back
into the C++ ZoneCodeGenerator would have written and diff it with the real thing.

    loaddb.py <iw4|iw5|t5> [asset struct ...] [--show FUNCTION]

For each asset (all of them by default) this renders LoadPtr_<asset>, Load_<struct> for
every struct its loader handles, LoadArray_<T> and LoadPtrArray_<T>, from zonecode.json
alone, and compares them with build/src/ZoneCode/Game/<G>/XAssets/<a>/<a>_<g>_load_db.cpp
after both are normalised (whitespace, blank lines, comments and asserts dropped). The set
of function names must match too. Exit status is the number of assets that differ.

The rendering follows ZoneLoadTemplate.cpp's native branches line for line, so a match
means every decision the walker needs -- order, blocks, counts, alignments, conditions,
reuse, inserts, actions -- is in the JSON.
"""

import argparse
import json
import os
import re
import sys

import oat

PREC = oat.PRECEDENCE


def safe(name):
    """MakeSafeTypeName: a definition's own name (not its namespace), spaces as _."""
    return name.split("::")[-1].replace(" ", "_")


def evaluation(e):
    """BaseTemplate::MakeEvaluation."""
    if isinstance(e, int):
        return str(e)
    if "int" in e:
        return str(e["int"])
    if "enum" in e:
        return e["enum"]
    if "op" in e:
        op = "-" if e["op"] == "ptrdiff" else e["op"]

        def side(x, strict):
            text = evaluation(x)
            if isinstance(x, dict) and "op" in x:
                inner = PREC["-" if x["op"] == "ptrdiff" else x["op"]]
                if inner > PREC[op] or (not strict and inner == PREC[op]):
                    return f"({text})"
            return text

        return f"{side(e['a'], True)} {op} {side(e['b'], False)}"
    out = "var" + safe(e["var"])
    if e["path"]:
        out += "->"
        for step in e["path"][:-1]:
            out += step["member"] + ("->" if step["deref"] else ".")
        out += e["path"][-1]["member"]
    for i in e["index"]:
        out += f"[{evaluation(i)}]"
    return out


def following(mods):
    return "".join(f"[{m['array']}]" if "array" in m else "*" for m in mods)


class Renderer:
    def __init__(self, zc, loader):
        self.zc, self.loader = zc, loader
        self.structs = zc["structs"]
        self.cls = "Loader_" + safe(loader["struct"])
        self.default_temp = next(b["name"] for b in zc["blocks"] if b["default"] and b["type"] == "temp")

    def action(self, a):
        return "m_actions." + a["name"] + "(" + ", ".join("var" + safe(t) for t in a["args"]) + ");"

    # ---- one member statement: LoadMember_Block and everything under it
    def member(self, s, st):
        m = next(x for x in s["members"] if x["name"] == st["member"])
        access = "var" + safe(s["name"]) + "->" + m["name"] + "".join(f"[{i}]" for i in st["index"])
        typedecl = ("const " if m["const"] else "") + m["type"]
        follow = following(m["mods"][len(st["index"]) + 1 :])
        out = []
        if st.get("push"):
            out.append(f"m_stream.PushBlock({st['push']});")
        inner = self.reuse(s, m, st, access, typedecl, follow)
        if st.get("null_check"):
            out += [f"if ({access})", "{", *inner, "}"]
        else:
            out += inner
        if st.get("push"):
            out.append("m_stream.PopBlock();")
        return out

    def reuse(self, s, m, st, access, typedecl, follow):
        body = self.alloc(s, m, st, access, typedecl, follow)
        if "reuse" not in st:
            return body
        out = [f"const auto zonePtrType = GetZonePointerType({access});"]
        if st["reuse"]["temp"]:
            out += ["if (zonePtrType == ZonePointerType::FOLLOWING || zonePtrType == ZonePointerType::INSERT)", "{", *body, "}"]
            out += ["else", "{", f"{access} = m_stream.ConvertOffsetToAliasNative({access});", "}"]
        else:
            out += ["if (zonePtrType == ZonePointerType::FOLLOWING)", "{", *body, "}"]
            out += ["else", "{", f"{access} = m_stream.ConvertOffsetToPointerNative({access});", "}"]
        return out

    def alloc(self, s, m, st, access, typedecl, follow):
        body = self.do(s, m, st, access, typedecl, follow)
        if "alloc" not in st:
            return body
        out = [f"{access} = m_stream.Alloc<{typedecl}{follow}>({evaluation(st['alloc'])});"]
        if st.get("insert"):
            out += [
                f"{m['type']}** toInsert = nullptr;",
                "if (zonePtrType == ZonePointerType::INSERT)",
                f"toInsert = m_stream.InsertPointerNative<{m['type']}>();",
            ]
        out += body
        if st.get("insert"):
            out += ["if (zonePtrType == ZonePointerType::INSERT)", f"*toInsert = var{safe(s['name'])}->{m['name']};"]
        return out

    def do(self, s, m, st, access, typedecl, follow):
        do, kind = st["do"], st["kind"]
        if do is None:
            return []
        var = "var" + safe(m["type"])
        if "string" in do:
            if m["const"]:
                return [f"varXString = &{access};", "LoadXString(false);"]
            return [f"varXString = const_cast<const char**>(&{access});", "LoadXString(false);"]
        if "strings" in do:
            return [f"varXString = {access};", f"LoadXStringArray({str(do['at_start']).lower()}, {evaluation(do['strings'])});"]
        if "asset" in do:
            return [f"Loader_{safe(do['asset'])} loader(m_zone, m_stream);", f"loader.Load(&{access});"]
        if "ptr_array" in do:
            t = safe(do["ptr_array"])
            return [f"var{t}Ptr = {access};", f"LoadPtrArray_{t}({str(do['at_start']).lower()}, {evaluation(do['count'])});"]
        at_start = str(do.get("at_start", False)).lower()
        if "load_array" in do:
            out = [f"{var} = {access};", f"LoadArray_{safe(m['type'])}({at_start}, {evaluation(do['count'])});"]
            return out + [self.action(a) for a in do.get("actions", [])]
        if "load" in do:
            if kind == "embedded":
                out = [f"{var} = &{access};", f"Load_{safe(m['type'])}({at_start});"]
            else:
                out = [f"{var} = {access};", f"Load_{safe(do['load'])}({at_start});"]
            return out + [self.action(a) for a in do.get("actions", [])]
        # raw
        if kind == "single_pointer":
            return [f"m_stream.Load<{typedecl}{follow}>({access});"]
        if kind == "embedded":
            return [f"m_stream.Load<{typedecl}{follow}>(&{access});"]
        return [f"m_stream.Load<{typedecl}{follow}>({access}, {evaluation(do['raw'])});"]

    # ---- statements
    def body(self, s, stmts):
        out = []
        for st in stmts:
            if "select" in st:
                for i, case in enumerate(st["select"]):
                    lines = self.body(s, case["then"])
                    if i == 0:
                        out += [f"if ({evaluation(case['if'])})", "{", *lines, "}"] if case["if"] is not None else lines
                    elif case["if"] is not None:
                        out += [f"else if ({evaluation(case['if'])})", "{", *lines, "}"]
                    else:
                        out += ["else", "{", *lines, "}"]
            elif "if" in st:
                out += [f"if ({evaluation(st['if'])})", "{", *self.body(s, st["then"]), "}"]
            else:
                out += self.member(s, st)
        return out

    # ---- whole functions
    def load(self, full):
        s = self.structs[full]
        p = s["load"]
        out = []
        if p["header"] == "full":
            out += ["if (atStreamStart)", f"m_stream.Load<{full}>(var{safe(s['name'])});"]
        elif p["header"] != "none":
            out += [
                "if (atStreamStart)",
                f"m_stream.LoadPartial<{full}>(var{safe(s['name'])}, offsetof({full}, {p['header']['member']}));",
            ]
        if p["push"]:
            out.append(f"m_stream.PushBlock({p['push']});")
        out += self.body(s, p["body"])
        if p["push"]:
            out.append("m_stream.PopBlock();")
        return out

    def load_array(self, a):
        t, s = safe(a["type"]), self.structs[a["struct"]]
        return [
            "if (atStreamStart)",
            f"m_stream.Load<{a['struct']}>(var{t}, count);",
            f"auto* var = var{t};",
            "for (size_t index = 0; index < count; index++)",
            "{",
            f"var{safe(s['name'])} = var;",
            f"Load_{safe(s['name'])}(false);",
            "var++;",
            "}",
        ]

    def load_ptr_array(self, a):
        t, full = safe(a["type"]), a["type"]
        s = self.structs.get(a["struct"]) if a["struct"] else None
        loading = [f"*var{t}Ptr = m_stream.Alloc<{full}>({evaluation(a['align'])});"]
        if s is not None and not s["leaf"]:
            loading += [f"var{safe(s['name'])} = *var{t}Ptr;", f"Load_{t}(true);"]
        else:
            loading += [f"m_stream.Load<{full}>(*var{t}Ptr);"]
        if s is not None and s["asset"]:
            check = [f"Loader_{safe(s['name'])} loader(m_zone, m_stream);", f"loader.Load(var{t}Ptr);"]
        elif a["reusable"]:
            check = [
                f"const auto zonePtrType = GetZonePointerType(*var{t}Ptr);",
                "if (zonePtrType == ZonePointerType::FOLLOWING)",
            ]
            check += ["{", *loading, "}", "else", "{", f"*var{t}Ptr = m_stream.ConvertOffsetToPointerNative(*var{t}Ptr);", "}"]
        else:
            check = loading
        return [
            "if (atStreamStart)",
            f"m_stream.Load<{full}*>(var{t}Ptr, count);",
            f"{full}** var = var{t}Ptr;",
            "for (size_t index = 0; index < count; index++)",
            "{",
            f"var{t}Ptr = var;",
            f"if (*var{t}Ptr)",
            "{",
            *check,
            "}",
            "var++;",
            "}",
        ]

    def load_ptr(self):
        full, e = self.loader["struct"], self.loader["entry"]
        a = safe(full)
        s = self.structs[full]
        out = ["if (atStreamStart)", f"m_stream.Load<{full}*>(var{a}Ptr);"]
        if e["temp"]:
            out.append(f"m_stream.PushBlock({self.default_temp});")
        out += [f"if (*var{a}Ptr != nullptr)", "{", f"const auto zonePtrType = GetZonePointerType(*var{a}Ptr);"]
        if e["temp"]:
            out.append("if (zonePtrType == ZonePointerType::FOLLOWING || zonePtrType == ZonePointerType::INSERT)")
        else:
            out.append("if (zonePtrType == ZonePointerType::FOLLOWING)")
        out += ["{", f"*var{a}Ptr = m_stream.Alloc<{full}>({evaluation(e['align'])});"]
        if e["temp"]:
            out += [
                f"{full}** toInsert = nullptr;",
                "if (zonePtrType == ZonePointerType::INSERT)",
                f"toInsert = m_stream.InsertPointerNative<{full}>();",
            ]
        out += [f"var{a} = *var{a}Ptr;", f"Load_{a}(true);"]
        if e["action"]:
            out.append(self.action(e["action"]))
        out.append(f"LoadAsset_{a}(var{a}Ptr);")
        if e["temp"]:
            out += ["if (zonePtrType == ZonePointerType::INSERT)", f"*toInsert = *var{a}Ptr;"]
        convert = "ConvertOffsetToAliasNative" if e["temp"] else "ConvertOffsetToPointerNative"
        out += ["}", "else", "{", f"*var{a}Ptr = m_stream.{convert}(*var{a}Ptr);", "}", "}"]
        if e["temp"]:
            out.append("m_stream.PopBlock();")
        assert not s["leaf"]
        return out

    def functions(self):
        out = {}
        for a in self.loader["ptr_arrays"]:
            out["LoadPtrArray_" + safe(a["type"])] = self.load_ptr_array(a)
        for a in self.loader["arrays"]:
            out["LoadArray_" + safe(a["type"])] = self.load_array(a)
        for full in self.loader["loads"] + [self.loader["struct"]]:
            out["Load_" + safe(full)] = self.load(full)
        out["LoadPtr_" + safe(self.loader["struct"])] = self.load_ptr()
        return out


FUNC = re.compile(r"^(?:void|XAssetInfo<[\w:]+>\*) Loader_\w+::(\w+)\(")


def normalise(lines):
    out = []
    for line in lines:
        line = re.sub(r"//.*", "", line)
        line = re.sub(r"\s+", "", line)
        if line and not line.startswith("assert("):
            out.append(line)
    return out


def generated(g, asset):
    G = oat.game_dir(g)
    lower = asset.split("::")[-1].lower()
    file = oat.path("build", "src", "ZoneCode", "Game", G, "XAssets", lower, f"{lower}_{g}_load_db.cpp")
    funcs, current = {}, None
    with open(file) as fh:
        for line in fh:
            m = FUNC.match(line)
            if m:
                current = funcs.setdefault(m.group(1), [])
                continue
            if current is not None:
                if line.startswith("}"):
                    current = None
                elif not line.startswith("{"):
                    current.append(line)
    # LoadAsset_ (registration) and Load (the entry wrapper) carry no load order.
    return {k: normalise(v) for k, v in funcs.items() if k != "Load" and not k.startswith("LoadAsset_")}, file


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("game", choices=sorted(oat.GAMES))
    ap.add_argument("assets", nargs="*")
    ap.add_argument("--zonecode")
    ap.add_argument("--show", help="print one function as rendered and as OAT generated it")
    args = ap.parse_args()
    with open(args.zonecode or oat.data_path(args.game, "zonecode.json")) as fh:
        zc = json.load(fh)
    loaders = [a for a in zc["assets"] if not args.assets or a["struct"] in args.assets]
    bad = functions = 0
    for loader in loaders:
        want, file = generated(args.game, loader["struct"])
        have = {k: normalise(v) for k, v in Renderer(zc, loader).functions().items()}
        problems = []
        for name in sorted(set(want) | set(have)):
            if name not in have:
                problems.append(f"{name}: in OAT, not rendered")
            elif name not in want:
                problems.append(f"{name}: rendered, not in OAT")
            elif have[name] != want[name]:
                i = next(
                    (i for i, (a, b) in enumerate(zip(have[name], want[name], strict=False)) if a != b),
                    min(len(have[name]), len(want[name])),
                )
                problems.append(f"{name}: line {i}: rendered {have[name][i : i + 1]} OAT {want[name][i : i + 1]}")
            if args.show == name:
                print("rendered:\n  " + "\n  ".join(have.get(name, [])) + "\nOAT:\n  " + "\n  ".join(want.get(name, [])))
        functions += len(want)
        if problems:
            bad += 1
            print(f"{loader['struct']}: {len(problems)} of {len(want)} functions differ ({os.path.basename(file)})")
            for p in problems[:10]:
                print("  " + p)
    print(f"{args.game}: {len(loaders) - bad}/{len(loaders)} loaders identical to OAT's ({functions} functions)")
    sys.exit(min(bad, 255))


if __name__ == "__main__":
    main()
