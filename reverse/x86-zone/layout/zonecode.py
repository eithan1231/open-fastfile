#!/usr/bin/env python3
"""Turn OAT's ZoneCode for one game into scripts/cod/data/<g>/zonecode.json: the load program a
table-driven zone walker interprets.

    zonecode.py <iw4|iw5|t5|t6> [-o scripts/cod/data/<g>/zonecode.json]

oat.py reads the header and the command files the way ZoneCodeGenerator does. This
script then does what ZCG's ZoneLoadTemplate does with them -- decide, member by member,
how each struct is loaded -- but writes the decisions down as data instead of C++. The
schema is documented in ../README.md ("zonecode.json"); loaddb.py renders it back into
OAT's C++ and diffs that against OAT's generated *_load_db.cpp, which is the proof that
nothing was lost on the way.

Only the native path is modelled: the zones are 32-bit and so is the walker's view of
them, so none of ZCG's "fill" code for loading 32-bit data on a 64-bit host applies.
"""

import argparse
import json
import os
import re

import oat

# ---------------------------------------------------------------------------- expressions


def value_kind(t):
    """How to read a scalar of definition `t`: (size, signed, float)."""
    while t.kind == "typedef":
        if t.decl.mods:
            return None
        t = t.decl.type
    if t.kind == "enum":
        t = t.parent
    if t.kind != "base":
        return None
    name = t.name
    return {"size": t.size, "signed": not name.startswith("unsigned") and name != "bool", "float": name in ("float", "double")}


def decl_after(decl, consumed):
    """What a declaration is after `consumed` modifiers were indexed through."""
    rest = decl.mods[consumed:]
    if rest and rest[0].kind == "ptr":
        return {"is": "pointer", "elem": element_size(decl, consumed + 1)}
    if rest:
        return {"is": "array", "elem": element_size(decl, consumed + 1)}
    scalar = value_kind(decl.type)
    return {"is": "scalar", **scalar} if scalar else {"is": "struct", "size": decl.type.size}


def element_size(decl, level):
    """Size of the type left after the first `level` modifiers (BaseTemplate::SizeForDeclModifierLevel)."""
    size = decl.type.size
    for m in reversed(decl.mods[level:]):
        size = oat.POINTER_SIZE if m.kind == "ptr" else size * m.size
    return size


def expr(e):
    if e is None:
        return None
    if isinstance(e, oat.Static):
        return {"enum": e.enum, "value": e.value} if e.enum else {"int": e.value}
    if isinstance(e, oat.Operation):
        a, b = expr(e.a), expr(e.b)
        out = {"op": e.op, "a": a, "b": b}
        # `varX - varY->xs`: C pointer difference, in elements (GfxCellTree's count).
        if e.op == "-" and a.get("is") in ("address", "pointer") and b.get("is") in ("address", "pointer"):
            out["op"], out["elem"] = "ptrdiff", a.get("elem") or b.get("elem")
        return out
    info, chain = e.structure, e.chain
    path = [{"member": m.name, "deref": oat.has_pointer(m)} for m in chain]
    out = {"var": info.name, "struct": info.definition.full, "path": path, "index": [expr(i) for i in e.indices]}
    if not chain:
        out.update({"is": "address", "elem": info.definition.size})
    else:
        out.update(decl_after(chain[-1].var.decl, len(e.indices)))
    return out


def count(e):
    """A bare number stays a number; anything else keeps its form (OAT prints it as
    written), and a static one also carries its "value"."""
    if e is None:
        return None
    if isinstance(e, oat.Static) and not e.enum:
        return e.value
    out = expr(e)
    if e.static:
        out["value"] = oat.evaluate(e)
    return out


# ---------------------------------------------------------------------------- members


def mods_json(decl):
    out = []
    for m in decl.mods:
        if m.kind == "ptr":
            p = {"ptr": True}
            if m.count is not None:
                p["count"] = count(m.count)
            if m.count_by_index:
                p["count_by_index"] = [count(e) for e in m.count_by_index]
            out.append(p)
        else:
            a = {"array": m.size}
            if m.dyn_count is not None:
                a["dyn_count"] = count(m.dyn_count)
            if m.dyn_size is not None:
                a["dyn_size"] = count(m.dyn_size)
            out.append(a)
    return out


def member_json(m):
    decl = m.var.decl
    t = decl.type
    out = {
        "name": m.name,
        "offset": m.var.offset,
        "size": decl.size,
        "align": decl.align,
        "type": t.full,
        "type_kind": t.kind,
        "type_size": t.size,
        "type_align": t.align,
        "struct": m.struct.definition.full if m.struct else None,
        "const": decl.const,
        "mods": mods_json(decl),
    }
    if decl.bits is not None:
        out["bits"] = decl.bits
    scalar = value_kind(t) if not decl.mods else None
    if scalar:
        out["scalar"] = scalar
    elif decl.mods and value_kind(t):
        # Arrays of, or pointers to, scalars (`float origin[3]`, `scr_string_t* names`):
        # how to read one element.
        out["element"] = value_kind(t)
    for key, value in (
        ("string", m.string),
        ("scriptstring", m.script_string),
        ("reusable", m.reusable),
        ("leaf", m.leaf),
    ):
        out[key] = value
    if m.asset_ref:
        out["asset_ref"] = m.asset_ref
    if m.condition is not None:
        out["condition"] = count(m.condition)
    if m.block is not None:
        out["block"] = m.block.name
    if m.alloc_align is not None:
        out["alloc_align"] = count(m.alloc_align)
    if m.action is not None:
        out["action"] = m.action
    return out


# ---------------------------------------------------------------------------- ZoneLoadTemplate
# Generating/Templates/ZoneLoadTemplate.cpp and Domain/Computations/
# MemberDeclarationModifierComputations.cpp, native (matching word size) branches only.


class Mods:
    """DeclarationModifierComputations: one level of a member's modifiers."""

    def __init__(self, member, indices=()):
        self.m, self.indices = member, list(indices)
        mods = member.mods
        sizes = []
        for x in mods:
            if x.kind != "arr":
                break
            sizes.append(x.size)
        per_depth, current = [0] * len(sizes), 1
        for i in range(len(sizes), 0, -1):
            per_depth[i - 1] = current
            current *= sizes[i - 1]
        self.combined = sum(per_depth[d] * v for d, v in enumerate(self.indices))
        n = len(self.indices)
        self.mod = mods[n] if n < len(mods) else None
        self.next = mods[n + 1] if n + 1 < len(mods) else None
        self.following = mods[n + 1 :]

    @property
    def is_array(self):
        return self.mod is not None and self.mod.kind == "arr"

    @property
    def array_size(self):
        return self.mod.size if self.is_array else 0

    def entries(self):
        return [Mods(self.m, self.indices + [i]) for i in range(self.array_size)]

    def _no_pointer_follows(self):
        return not any(x.kind == "ptr" for x in self.following)

    @property
    def is_single_pointer(self):
        return (
            self.mod is not None
            and self.mod.kind == "ptr"
            and not self.mod.is_array(self.combined)
            and self._no_pointer_follows()
        )

    @property
    def is_array_pointer(self):
        return self.mod is not None and self.mod.kind == "ptr" and self.mod.is_array(self.combined) and self._no_pointer_follows()

    @property
    def is_pointer_array(self):
        if self.mod is None or self.next is None:
            return False
        this = (self.mod.kind == "ptr" and self.mod.is_array(self.combined)) or self.mod.kind == "arr"
        return this and self.next.kind == "ptr" and not self.next.is_array()

    @property
    def is_dynamic_array(self):
        return self.is_array and self.mod.dyn_size is not None

    def pointer_count(self):
        return self.mod.count_for(self.combined) if self.mod.kind == "ptr" else self.mod.dyn_count

    @property
    def alignment(self):
        """DeclarationModifierComputations::GetAlignment."""
        if not self._no_pointer_follows():
            return self.m.var.align
        return self.m.var.decl.type.align


EMBEDDED, EMBEDDED_ARRAY, DYNAMIC_ARRAY = "embedded", "embedded_array", "dynamic_array"
SINGLE_POINTER, ARRAY_POINTER, POINTER_ARRAY = "single_pointer", "array_pointer", "pointer_array"
POINTERISH = (SINGLE_POINTER, ARRAY_POINTER, POINTER_ARRAY)


def actions(m):
    out = []
    if m.struct is not None and m.struct.action:
        out.append(m.struct.action)
    if m.action:
        out.append(m.action)
    return out


def type_check(m, mc, kind):
    """LoadMember_TypeCheck and the per-kind LoadMember_* it calls."""
    struct = m.struct
    if m.string:
        if kind == SINGLE_POINTER:
            return {"string": True}
        if kind == POINTER_ARRAY:
            if mc.is_array:
                return {"strings": mc.array_size, "at_start": False}
            return {"strings": count(mc.pointer_count()), "at_start": True}
        raise ValueError(f"{m.parent.name}.{m.name}: string loaded as {kind}")
    if struct is not None and struct.is_asset and kind == SINGLE_POINTER:
        return {"asset": struct.definition.full}
    if kind == POINTER_ARRAY:
        # LoadMember_PointerArray -> LoadPtrArray_<T>
        n = mc.array_size if mc.is_array else count(mc.pointer_count())
        return {"ptr_array": m.var.decl.type.full, "count": n, "at_start": not mc.is_array}
    if struct is not None and struct.is_asset:
        raise ValueError(f"{m.parent.name}.{m.name}: asset loaded as {kind}")
    after_partial = oat.is_after_partial_load(m)
    if kind == ARRAY_POINTER:
        n = count(mc.pointer_count())
        if struct is not None and not struct.leaf and not oat.in_runtime_block(m):
            return {"load_array": struct.definition.full, "count": n, "at_start": True, "actions": actions(m)}
        return {"raw": n}
    if kind == SINGLE_POINTER:
        if struct is not None and not struct.leaf and not oat.in_runtime_block(m):
            return {"load": struct.definition.full, "at_start": True, "actions": actions(m)}
        return {"raw": 1}
    if kind == EMBEDDED:
        if not m.leaf:
            return {"load": struct.definition.full, "at_start": after_partial, "actions": actions(m)}
        return {"raw": None} if after_partial else None
    if kind == EMBEDDED_ARRAY:
        n = count(mc.mod.dyn_count) if mc.mod.dyn_count is not None else mc.array_size
        if not m.leaf:
            return {"load_array": struct.definition.full, "count": n, "at_start": after_partial, "actions": actions(m)}
        return {"raw": n} if after_partial else None
    if kind == DYNAMIC_ARRAY:
        n = count(mc.mod.dyn_size)
        if struct is not None and not struct.leaf:
            return {"load_array": struct.definition.full, "count": n, "at_start": True}
        return {"raw": n}
    raise ValueError(kind)


def member_statement(m, mc, kind):
    """LoadMember_Block -> _PointerCheck -> _Reuse -> _Alloc -> _TypeCheck, flattened."""
    st = {"member": m.name, "index": mc.indices, "kind": kind}
    if oat.not_in_default_normal_block(m):
        st["push"] = m.block.name
    if kind in POINTERISH:
        if kind == POINTER_ARRAY:
            st["null_check"] = not mc.is_array
        else:
            st["null_check"] = not m.string
        reuse = not (kind == POINTER_ARRAY and mc.is_array) and m.reusable
        if reuse:
            st["reuse"] = {"temp": oat.in_temp_block(m)}
        alloc = (not mc.is_array) if kind == POINTER_ARRAY else not (m.string or (m.struct is not None and m.struct.is_asset))
        if alloc:
            st["alloc"] = count(m.alloc_align) if m.alloc_align is not None else mc.alignment
            if oat.in_temp_block(m):
                st["insert"] = True
    st["do"] = type_check(m, mc, kind)
    return st


def reference(m, mc):
    """LoadMember_Reference: pick the load kind for this modifier level."""
    if mc.is_dynamic_array:
        return [member_statement(m, mc, DYNAMIC_ARRAY)]
    if mc.is_single_pointer:
        return [member_statement(m, mc, SINGLE_POINTER)]
    if mc.is_array_pointer:
        return [member_statement(m, mc, ARRAY_POINTER)]
    if mc.is_pointer_array:
        return [member_statement(m, mc, POINTER_ARRAY)]
    if mc.is_array and mc.next is None:
        return [member_statement(m, mc, EMBEDDED_ARRAY)]
    if mc.mod is None:
        return [member_statement(m, mc, EMBEDDED)]
    if mc.is_array:
        out = []
        for entry in mc.entries():
            out.extend(reference(m, entry))
        return out
    raise ValueError(f"{m.parent.name}.{m.name}: no load kind")


def needs_treatment(m):
    """PrintLoadMemberIfNeedsTreatment."""
    if oat.should_ignore(m):
        return False
    return m.string or oat.has_pointer(m) or (m.struct is not None and not m.struct.leaf) or oat.is_after_partial_load(m)


def load_program(info, model):
    """PrintLoadMethod: Load_<S>(atStreamStart)."""
    dyn = oat.dynamic_member(info)
    if not (info.is_union and dyn is not None):
        header = "full" if dyn is None else {"partial": dyn.var.offset, "member": dyn.name}
    else:
        header = "none"
    push = None
    if info.is_asset:
        push = default_block(model, "normal").name
    elif info.block is not None:
        push = info.block.name
    body = []
    if info.is_union:
        cases = []
        for m in info.members:
            if needs_treatment(m):
                cases.append({"if": count(m.condition), "then": reference(m, Mods(m))})
        if cases:
            body.append({"select": cases})
    else:
        for m in info.members:
            if not needs_treatment(m):
                continue
            stmts = reference(m, Mods(m))
            if m.condition is not None:
                body.append({"if": count(m.condition), "then": stmts})
            else:
                body.extend(stmts)
    return {"header": header, "push": push, "body": body}


def default_block(model, type_):
    return next(b for b in model.blocks if b.default and b.type == type_)


# ---------------------------------------------------------------------------- per-asset context
# Generating/OncePerAssetRenderingContext.cpp: which types each asset's loader handles.


class Used:
    def __init__(self, type_, info):
        self.type, self.info = type_, info
        self.members_loaded = self.non_runtime = self.non_embedded = self.array_ref = False
        self.ptr_array_ref = self.ptr_array_reusable = self.context_asset = False


def asset_context(model, asset):
    used, order = {}, []

    def add(type_, info):
        u = Used(type_, info)
        used[type_.full + "#" + type_.kind] = u
        order.append(u)
        return u

    def key(t):
        return t.full + "#" + t.kind

    def base_type(u, m):
        if u.type.kind != "typedef":
            return None
        t = u.type
        while t.decl.type.kind == "typedef":
            t = t.decl.type
        final = t.decl.type
        if key(final) not in used:
            info = model.infos.get(id(final)) if final.kind in ("struct", "union") else None
            added = add(final, info)
            scan(m, u)
            return added
        return used[key(final)]

    def scan(m, u):
        if u.info is not None and not u.info.is_asset and not oat.in_runtime_block(m) and not u.members_loaded:
            u.members_loaded = True
            add_members(u.info)

    def add_members(info):
        for m in info.members:
            if oat.should_ignore(m):
                continue
            t = m.var.decl.type
            u = used.get(key(t)) or add(t, m.struct)
            b = base_type(u, m)
            if not oat.in_runtime_block(m):
                u.non_runtime = True
                if b is not None:
                    b.non_runtime = True
            if oat.has_pointer(m):
                u.non_embedded = True
            if oat.array_pointer_ref(m) or oat.array_ref(m):
                u.array_ref = True
            if oat.pointer_array_ref(m) and not m.string:
                u.ptr_array_ref = True
                if m.reusable:
                    u.ptr_array_reusable = True
            scan(m, u)

    root = add(asset.definition, asset)
    root.context_asset = True
    add_members(asset)
    return order


def name_accessors(g):
    """<G>.h's DEFINE_ASSET_NAME_ACCESSOR lines: the member path naming each asset
    (`info.name` for a material), or the fixed name of a singleton."""
    G = oat.game_dir(g)
    with open(oat.path("src", "Common", "Game", G, f"{G}.h")) as fh:
        text = fh.read()
    out = {}
    pattern = r"^\s*DEFINE_ASSET_NAME_ACCESSOR(_SINGLETON)?\(\s*(?:\w+::)?(\w+)\s*,\s*([^)]*?)\s*\)"
    for singleton, asset, arg in re.findall(pattern, text, re.M):
        out[asset] = {"singleton": arg.strip('"')} if singleton else {"member": arg}
    return out


def loader_json(model, asset, names):
    order = asset_context(model, asset)
    ptr_arrays, arrays, loads, referenced = [], [], [], []
    for u in order:
        if u.ptr_array_ref:
            # LoadPtrArray_<T>: each element is allocated at the struct's allocation
            # alignment when T is the struct itself, else at T's own (a typedef's alignas).
            is_struct = u.info is not None and u.info.definition is u.type
            align = u.type.align
            if is_struct and u.info.alloc_align is not None:
                align = count(u.info.alloc_align)
            ptr_arrays.append(
                {
                    "type": u.type.full,
                    "struct": u.info.definition.full if u.info else None,
                    "reusable": u.ptr_array_reusable,
                    "align": align,
                    "size": u.type.size,
                }
            )
        if u.array_ref and u.info is not None and not u.info.leaf and u.non_runtime:
            arrays.append({"type": u.type.full, "struct": u.info.definition.full})
        if u.info is not None and u.info.definition is u.type:
            if u.non_runtime and not u.info.leaf and not u.info.is_asset:
                loads.append(u.info.definition.full)
            if u.info.is_asset and u.info is not asset:
                referenced.append(u.info.definition.full)
    temp = asset.block is not None and asset.block.type == "temp"
    align = count(asset.alloc_align) if asset.alloc_align is not None else asset.definition.align
    return {
        "struct": asset.definition.full,
        "name": asset.asset_name,
        # AssetName<>: what OAT names one of these assets, in a listing and in every lookup.
        "asset_name": names[asset.asset_name],
        # LoadPtr_<asset>: the entry point every handle to this asset goes through.
        "entry": {"temp": temp, "align": align, "action": asset.action},
        "ptr_arrays": ptr_arrays,
        "arrays": arrays,
        "loads": loads,
        "referenced_assets": referenced,
    }


# ---------------------------------------------------------------------------- asset types


def asset_types(g, model):
    """<G>.h's XAssetType, and which loader ContentLoader<G>.cpp calls for each index."""
    G = oat.game_dir(g)
    with open(oat.path("src", "Common", "Game", G, f"{G}.h")) as fh:
        text = fh.read()
    m = re.search(r"enum\s+XAssetType\s*\{(.*?)\}", text, re.S)
    names, value = {}, 0
    for entry in re.sub(r"//[^\n]*", "", m.group(1)).split(","):
        entry = entry.strip()
        if not entry:
            continue
        name, _, given = (s.strip() for s in entry.partition("="))
        value = int(given, 0) if given else value
        names[name] = value
        value += 1
    with open(oat.path("src", "ZoneLoading", "Game", G, f"ContentLoader{G}.cpp")) as fh:
        loader = fh.read()
    with open(oat.path("src", "Common", "Game", G, f"Game{G}.cpp")) as fh:
        game = fh.read()
    # Game<G>.cpp's ASSET_TYPE_NAMES, indexed by XAssetType: a type's name in a .zone listing.
    listed = re.findall(r'"(\w+)"', re.search(r"ASSET_TYPE_NAMES\[\]\s*\{(.*?)\}", game, re.S).group(1))
    loads = {t: (s, h) for t, s, h in re.findall(r"^\s*LOAD_ASSET\((\w+),\s*(\w+),\s*(\w+)\)", loader, re.M)}
    skips = set(re.findall(r"^\s*SKIP_ASSET\((\w+)", loader, re.M))
    out = []
    for name, index in names.items():
        if name == "ASSET_TYPE_COUNT" or name.endswith("_COUNT"):
            continue
        entry = {"index": index, "enum": name, "listed": listed[index]}
        if name in loads:
            struct, header = loads[name]
            entry.update(struct=model.info_named(struct).definition.full, header_member=header)
        elif name in skips:
            entry["skip"] = True
        else:
            entry["unsupported"] = True
        out.append(entry)
    return out


# ---------------------------------------------------------------------------- output


def build(g):
    model = oat.Model(g)
    names = name_accessors(g)
    loaders = [loader_json(model, a, names) for a in model.assets]
    # Only what some asset's loader reaches gets a program, as only those get a Load_ in OAT.
    programs = {a.definition.full for a in model.assets}
    for loader in loaders:
        programs.update(loader["loads"])
    structs = {}
    for info in model.infos.values():
        d = info.definition
        s = {
            "kind": d.kind,
            "name": d.name,
            "anonymous": d.anonymous,
            "size": d.size,
            "align": d.align,
            "alloc_align": count(info.alloc_align) if info.alloc_align is not None else d.align,
            "asset": info.asset_name or None,
            "block": info.block.name if info.block else None,
            "action": info.action,
            "leaf": info.leaf,
            "reusable_ref": bool(model.type_reusable.get(d.full)),
            "dynamic_member": (oat.dynamic_member(info).name if oat.dynamic_member(info) else None),
            "members": [member_json(m) for m in info.members],
        }
        if d.full in programs:
            s["load"] = load_program(info, model)
        if d.full in structs:
            raise ValueError(f"two structs named {d.full}")
        structs[d.full] = s
    typedefs = {}
    for d in model.header.definitions:
        if d.kind == "typedef":
            typedefs[d.full] = {
                "type": d.decl.type.full,
                "type_kind": d.decl.type.kind,
                "const": d.decl.const,
                "mods": mods_json(d.decl),
                "size": d.size,
                "align": d.align,
            }
    return {
        "game": model.game,
        "wordsize": model.wordsize,
        "pointer_size": oat.POINTER_SIZE,
        "blocks": [{"name": b.name, "index": b.index, "type": b.type, "default": b.default} for b in model.blocks],
        "asset_types": asset_types(g, model),
        "assets": loaders,
        "enums": model.header.enum_values,
        "typedefs": typedefs,
        "structs": structs,
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("game", choices=sorted(oat.GAMES))
    ap.add_argument("-o", "--out")
    args = ap.parse_args()
    out = args.out or oat.data_path(args.game, "zonecode.json")
    data = build(args.game)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w") as fh:
        json.dump(data, fh, indent=1)
    loadable = sum(1 for s in data["structs"].values() if "load" in s)
    print(
        f"{os.path.normpath(out)}: {len(data['structs'])} structs ({loadable} with a load program), {len(data['assets'])} assets"
    )


if __name__ == "__main__":
    main()
