"""The interpreter: walk a whole 32-bit zone the way OAT's generated loaders do, from zonecode.json.

    walk = walk_zone(data, program)      # or walk_fastfile("mp_dome.ff")
    for asset in walk.assets: ...        # every asset loaded, nested ones included, in load order

Each struct's load program is compiled once per walk into closures, one per statement,
following ZoneLoadTemplate's native branches exactly as reverse/x86-zone/layout/loaddb.py
renders them (that renderer is proven identical to OAT's C++, so it is this module's
specification). What the C++ does to memory becomes what a Record's `kids` hold.

- **The current instance** of each struct (OAT's `var<Struct>`) is per asset loader, as in
  OAT: a nested asset is a new loader with its own. Expressions read the most recent one.
- **Allocation alignment** comes from zonecode.json, never from layout.json.
- **Asset handles are not followed into other zones**: a handle is an alias or it follows.
- **Errors carry the path** of structs and members they happened under (`WalkError`).
"""

import struct
import time

from ..zone.spec import FOLLOWS, INSERT
from . import program as programs
from .actions import ACTIONS
from .stream import Stream, WalkError
from .values import Array, Asset, Pointer, Record, mods_size, scalar_format

U32 = struct.Struct("<I")


def _c_div(a, b):
    q = abs(a) // abs(b)
    return q if (a < 0) == (b < 0) else -q


OPS = {
    "+": lambda a, b: a + b,
    "-": lambda a, b: a - b,
    "*": lambda a, b: a * b,
    "/": lambda a, b: _c_div(a, b) if isinstance(a, int) and isinstance(b, int) else a / b,
    "%": lambda a, b: a - b * _c_div(a, b),
    "<<": lambda a, b: a << b,
    ">>": lambda a, b: a >> b,
    "&": lambda a, b: a & b,
    "|": lambda a, b: a | b,
    "^": lambda a, b: a ^ b,
    "==": lambda a, b: int(a == b),
    "!=": lambda a, b: int(a != b),
    "<": lambda a, b: int(a < b),
    "<=": lambda a, b: int(a <= b),
    ">": lambda a, b: int(a > b),
    ">=": lambda a, b: int(a >= b),
    "&&": lambda a, b: int(bool(a) and bool(b)),
    "||": lambda a, b: int(bool(a) or bool(b)),
}


def _note(error, where):
    """Add one level of struct/member path to an error on its way out."""
    if isinstance(error, WalkError):
        error.args = (f"{where}: {error.args[0]}" if error.args else where,)
    return error


class Walk:
    """What walking a zone produced. `data` is the zone (XFile header included)."""

    def __init__(self, data, program, path=None):
        self.data, self.program, self.path = data, program, path
        self.game = program.game
        self.assets = []  # every asset loaded, in load order (Asset)
        self.entries = []  # the XAsset list: (type index, Asset or whatever the entry aliased)
        self.script_strings = []
        self.depends = []
        self.stream = None
        self.failed = None  # (entry index, message) if the walk stopped
        self.loose = 0  # references that resolved to no allocation (values.Pointer)
        self.aliased = 0  # XAsset entries naming an asset loaded earlier
        self.seconds = 0.0

    def script_string(self, index):
        return self.script_strings[index] if 0 <= index < len(self.script_strings) else None

    def memory(self, block, offset, size):
        return self.stream.memory(block, offset, size)

    def by_type(self, kind):
        """Assets of a type, by enum (`ASSET_TYPE_XMODEL`) or listed name (`xmodel`)."""
        return [a for a in self.assets if kind in (a.type, a.listed)]

    def listing(self):
        """(listed type, name) of every asset, as OAT's `.zone` listing names them."""
        return [(a.listed, a.name) for a in self.assets]

    def span(self, obj, count):
        """`count` elements from `obj` on (a Record a single pointer gave, or an Array): the
        array holding it, from there. What a single pointer into an array (cbrush_t.sides,
        numsides long) means."""
        found = self.stream.allocation(obj.block, obj.cursor)
        if found is not None:
            start, holder = found
            if isinstance(holder, Array) and (obj.cursor - start) % holder.elem == 0:
                return holder.view((obj.cursor - start) // holder.elem, count)
        if isinstance(obj, Array):
            return obj.view(0, count)
        if count == 1:
            return Array(self, obj.info.name, obj.info.size, obj.at, obj.block, obj.cursor, 1, items=[obj], info=obj.info)
        raise IndexError(f"{obj!r} is not inside an array of {count}")

    def blocks(self):
        """(name, high-water mark, header size) per block."""
        spec, stream = self.program.spec, self.stream
        sizes = spec.header(self.data)[2]
        return [(name, max(stream.block_peak[i], stream.blocks[i]), sizes[i]) for i, name in enumerate(spec.blocks)]

    def check(self):
        """Problems with a finished walk: not at the end of the zone, or a block's high-water
        mark not the size the XFile header gives it. Empty when the walk is exact."""
        problems = []
        if self.failed:
            problems.append(f"stopped at XAsset {self.failed[0]}: {self.failed[1]}")
            return problems
        if self.stream.pos != len(self.data):
            problems.append(f"ended at 0x{self.stream.pos:x} of 0x{len(self.data):x}")
        for name, peak, size in self.blocks():
            if peak != size:
                problems.append(f"block {name}: high-water mark {peak}, header {size}")
        return problems


class Walker:
    def __init__(self, walk):
        self.walk = walk
        self.p = walk.program
        self.z = Stream(walk.data, self.p.spec)
        walk.stream = self.z
        self.data = walk.data
        self.vars = {}
        self.loader = None
        self.actions = ACTIONS[self.p.game]
        self._loads = {}
        self._loader_ptr_arrays = {}
        self.insert_block = self.z.insert
        self.temp = self.z.temp

    # --- expressions -------------------------------------------------------

    def expr(self, e):
        """A closure evaluating a zonecode expression against the current instances."""
        if e is None:
            return None
        if isinstance(e, int):
            return lambda: e
        if "int" in e:
            value = e["int"]
            return lambda: value
        if "enum" in e:
            value = e["value"]
            return lambda: value
        if "op" in e:
            if "value" in e:
                value = e["value"]
                return lambda: value
            a, b = self.expr(e["a"]), self.expr(e["b"])
            if e["op"] == "ptrdiff":
                elem = e["elem"]

                def ptrdiff():
                    x, y = a(), b()
                    if x is None or y is None or x.block != y.block:
                        raise WalkError(f"pointer difference between {x!r} and {y!r}")
                    return (x.cursor - y.cursor) // elem

                return ptrdiff
            op = OPS[e["op"]]
            return lambda: op(a(), b())
        return self.field(e)

    def field(self, e):
        key, path, is_ = e["struct"], e["path"], e["is"]
        walker = self
        if is_ == "address":
            return lambda: walker.vars[key]
        indices = [self.expr(i) for i in e["index"]]
        if is_ == "scalar" and not indices and len(path) >= 1 and not any(step["deref"] for step in path):
            # The common case: a scalar of the instance itself, or of a struct embedded in it.
            info, offset = self.p.struct(key), 0
            for step in path:
                member = info.members[step["member"]]
                offset += member["offset"]
                info = self.p.struct(member["struct"]) if member["struct"] else None
            fmt, data = scalar_format(e), self.data

            def scalar():
                at = walker.vars[key].at
                return 0 if at is None else struct.unpack_from(fmt, data, at + offset)[0]

            return scalar
        return lambda: self.navigate(key, path, [i() for i in indices], e)

    def navigate(self, key, path, indices, e):
        """The general field read: through embedded structs and dereferenced pointers."""
        obj = self.vars[key]
        info, offset = obj.info, 0
        for k, step in enumerate(path):
            member = info.members[step["member"]]
            last = k == len(path) - 1
            if step["deref"]:
                kid = (obj.kids or {}).get(step["member"]) if offset == 0 else None
                if kid is None:
                    raise WalkError(f"{info.name}.{step['member']} is not loaded, and an expression reads through it")
                if last:
                    if e["is"] == "pointer":
                        return kid
                    i = indices[0] if indices else 0
                    elem = mods_size(member["type_size"], member["mods"][1:])
                    if kid.at is None:
                        return 0
                    return struct.unpack_from(scalar_format(e), self.data, kid.at + i * elem)[0]
                obj = kid[0] if isinstance(kid, Array) else kid
                info, offset = obj.info, 0
                continue
            offset += member["offset"]
            if last:
                mods = member["mods"]
                for depth, i in enumerate(indices):
                    offset += i * mods_size(member["type_size"], mods[depth + 1 :])
                if obj.at is None:
                    return 0
                return struct.unpack_from(scalar_format(e), self.data, obj.at + offset)[0]
            sub = (obj.kids or {}).get(step["member"]) if offset == member["offset"] else None
            if isinstance(sub, Record):
                obj, offset = sub, 0
            info = self.p.struct(member["struct"])
        raise WalkError(f"cannot evaluate {e}")

    # --- statements --------------------------------------------------------

    def load_fn(self, name):
        """Load_<name>(rec, atStreamStart), compiled on first use."""
        fn = self._loads.get(name)
        if fn is not None:
            return fn
        info = self.p.struct(name)
        prog = info.load
        if prog is None:
            raise WalkError(f"{name} has no load program")
        header = prog["header"]
        size = info.size if header == "full" else 0 if header == "none" else header["partial"]
        push = self.p.block_index[prog["push"]] if prog["push"] else None
        z = self.z
        body = None

        def load(rec, at_start):
            if at_start:
                rec.at = z.take(size)
            if push is not None:
                z.push(push)
            body(rec)
            if push is not None:
                z.pop()

        # Registered before the body compiles: a struct may contain itself.
        self._loads[name] = load
        body = self.body(info, prog["body"])
        return load

    def body(self, info, statements):
        ops = [self.statement(info, st) for st in statements]
        if len(ops) == 1:
            return ops[0]

        def run(rec):
            for op in ops:
                op(rec)

        return run

    def statement(self, info, st):
        if "select" in st:
            cases = [(self.expr(case["if"]), self.body(info, case["then"])) for case in st["select"]]

            def select(rec):
                for cond, then in cases:
                    if cond is None or cond():
                        then(rec)
                        return

            return select
        if "if" in st:
            cond, then = self.expr(st["if"]), self.body(info, st["then"])

            def when(rec):
                if cond():
                    then(rec)

            return when
        op = self.member(info, st)
        where = f"{info.name}.{st['member']}" + "".join(f"[{i}]" for i in st["index"])

        def noted(rec):
            try:
                op(rec)
            except WalkError as error:
                raise _note(error, where) from None
            except (KeyError, IndexError, ValueError, TypeError, AttributeError, struct.error, EOFError) as error:
                raise WalkError(f"{where}: {type(error).__name__}: {error}") from None

        return noted

    def member(self, info, st):
        """One member statement: LoadMember_Block and everything under it (loaddb.Renderer.member)."""
        m = info.members[st["member"]]
        index = st["index"]
        mods = m["mods"]
        offset = m["offset"]
        for depth, i in enumerate(index):
            offset += i * mods_size(m["type_size"], mods[depth + 1 :])
        key = st["member"] + "".join(f"[{i}]" for i in index)
        is_pointer = len(mods) > len(index) and "ptr" in mods[len(index)]
        push = self.p.block_index[st["push"]] if st.get("push") else None
        null_check = st.get("null_check", False)
        reuse = st.get("reuse")
        temp_reuse = bool(reuse and reuse["temp"])
        alloc = st.get("alloc")
        if alloc is not None and not isinstance(alloc, int):
            alloc = alloc["value"]
        insert = st.get("insert", False)
        aliasable = temp_reuse or (st["do"] is not None and "asset" in st["do"])
        do = self.do(info, m, st, key, offset)
        resolve = self.reuse_target(info, m, st, key) if reuse else None
        z, data, walker = self.z, self.data, self

        def run(rec):
            if push is not None:
                z.push(push)
            value = None
            if is_pointer:
                value = 0 if rec.at is None else U32.unpack_from(data, rec.at + offset)[0]
            if null_check and not value:
                pass
            elif reuse is not None and not (value == FOLLOWS or (temp_reuse and value == INSERT)):
                result = walker.alias(value) if temp_reuse else resolve(value)
                rec.set(key, result)
                if aliasable:
                    z.file_slot(rec.block, rec.cursor + offset, result)
            else:
                if alloc is not None:
                    z.align_to(alloc)
                slot = z.insert_pointer() if insert and value == INSERT else None
                result = do(rec, value)
                if slot is not None:
                    # *toInsert = the member, after any action replaced it (ReallocClipInfo)
                    z.aliases[(walker.insert_block, slot)] = (rec.kids or {}).get(key, result)
                if aliasable:
                    z.file_slot(rec.block, rec.cursor + offset, (rec.kids or {}).get(key, result))
            if push is not None:
                z.pop()

        return run

    def count(self, expr, default=1):
        if expr is None:
            return lambda: default
        fn = self.expr(expr)

        def checked():
            n = fn()
            if not isinstance(n, int) or n < 0 or n > 1 << 28:
                raise WalkError(f"count {n!r} is not a plausible element count")
            return n

        return checked

    def do(self, info, m, st, key, offset):
        """The `do` of a member statement: a function (rec, pointer value) that loads it and
        sets the record's kid."""
        do, kind = st["do"], st["kind"]
        z, walker, walk = self.z, self, self.walk
        if do is None:
            return lambda rec, value: None
        if "string" in do:

            def string(rec, value):
                text = walker.xstring(value)
                rec.set(key, text)
                return text

            return string
        if "strings" in do:
            count, at_start = self.count(do["strings"]), do["at_start"]

            def strings(rec, value):
                n = count()
                block, cursor, at = walker.pointers_at(rec, offset, n, at_start)
                texts = [walker.xstring(p) for p in walker.words(at, n)]
                arr = Array(walk, "char*", 4, at, block, cursor, n, items=texts)
                rec.set(key, arr)
                if at_start:
                    z.register(block, cursor, arr)
                return arr

            return strings
        if "asset" in do:
            target = do["asset"]

            def handle(rec, value):
                result = walker.load_asset(target, value)
                rec.set(key, result)
                return result

            return handle
        if "ptr_array" in do:
            target, count, at_start = do["ptr_array"], self.count(do["count"]), do["at_start"]

            def ptr_array(rec, value):
                n = count()
                block, cursor, at = walker.pointers_at(rec, offset, n, at_start)
                items = []
                arr = Array(walk, target + "*", 4, at, block, cursor, n, items=items)
                rec.set(key, arr)
                if at_start:
                    z.register(block, cursor, arr)
                walker.load_ptr_array(target, walker.words(at, n), block, cursor, items)
                return arr

            return ptr_array
        actions = [(self.actions[a["name"]], a["args"], a["name"]) for a in do.get("actions", ())]
        if "load_array" in do:
            target = do["load_array"]
            sinfo = self.p.struct(target)
            count, at_start = self.count(do["count"]), do["at_start"]
            stride = sinfo.size
            embedded = kind in ("embedded_array", "dynamic_array") and not at_start

            def load_array(rec, value):
                n = count()
                if embedded:
                    block, cursor = rec.block, rec.cursor + offset
                    at = None if rec.at is None else rec.at + offset
                elif at_start:
                    block, cursor = z.block, z.blocks[z.block]
                    at = z.take(n * stride)
                else:
                    raise WalkError(f"{kind} loaded without its elements in the stream")
                items = [
                    Record(walk, sinfo, None if at is None else at + i * stride, block, cursor + i * stride) for i in range(n)
                ]
                arr = Array(walk, target, stride, at, block, cursor, n, items=items, info=sinfo)
                rec.set(key, arr)
                if not embedded and kind != "dynamic_array":
                    z.register(block, cursor, arr)
                load = walker.load_fn(target)
                vars_ = walker.vars
                for item in items:
                    vars_[target] = item
                    load(item, False)
                walker.act(actions)
                return arr

            return load_array
        if "load" in do:
            target = do["load"]
            sinfo = self.p.struct(target)
            at_start = do["at_start"]

            def load(rec, value):
                if kind == "embedded" and not at_start:
                    sub = Record(walk, sinfo, None if rec.at is None else rec.at + offset, rec.block, rec.cursor + offset)
                else:
                    sub = Record(walk, sinfo, None, z.block, z.blocks[z.block])
                    if kind != "embedded":
                        z.register(sub.block, sub.cursor, sub)
                rec.set(key, sub)
                walker.vars[target] = sub
                walker.load_fn(target)(sub, at_start)
                walker.act(actions)
                return sub

            return load
        # raw: m_stream.Load<T>(ptr, count) of the member's element type
        follow = m["mods"][len(st["index"]) + (0 if kind == "embedded" else 1) :]
        elem = mods_size(m["type_size"], follow)
        count = self.count(do["raw"])
        sinfo = self.p.struct(m["struct"]) if m["struct"] and not follow else None
        scalar = m.get("scalar") or m.get("element")
        fmt = scalar_format(scalar) if scalar and not follow else None

        def raw(rec, value):
            n = count()
            block, cursor = z.block, z.blocks[z.block]
            at = z.take(n * elem)
            if kind == "embedded":
                return None  # its bytes are the record's own
            if kind == "single_pointer" and sinfo is not None:
                result = Record(walk, sinfo, at, block, cursor)
            else:
                result = Array(walk, m["type"], elem, at, block, cursor, n, info=sinfo, scalar=fmt)
            rec.set(key, result)
            if kind != "dynamic_array":
                z.register(block, cursor, result)
            return result

        return raw

    def reuse_target(self, info, m, st, key):
        """ConvertOffsetToPointer for a reusable member: the object loaded at that address."""
        do, kind = st["do"], st["kind"]
        z, walk, walker = self.z, self.walk, self
        if do is not None and "raw" in do:
            follow = m["mods"][len(st["index"]) + 1 :]
            elem = mods_size(m["type_size"], follow)
            count = self.count(do["raw"])
            sinfo = self.p.struct(m["struct"]) if m["struct"] and not follow else None
            scalar = m.get("scalar") or m.get("element")
            fmt = scalar_format(scalar) if scalar and not follow else None

            single = kind == "single_pointer"

            def raw(value):
                block, offset = z.referenced(value)
                found = walker.loaded(block, offset, single)
                if found is not None:
                    return found
                # Inside plain data no allocation starts at: a view of the zone bytes there.
                n = count()
                at = z.file_offset(block, offset, max(n * elem, 1))
                if at is None and block not in z.runtime:
                    walk.loose += 1
                    return Pointer(walk, block, offset)
                if kind == "single_pointer" and sinfo is not None:
                    return Record(walk, sinfo, at, block, offset)
                return Array(walk, m["type"], elem, at, block, offset, n, info=sinfo, scalar=fmt)

            return raw
        if do is not None and "string" in do:
            return lambda value: z.cstring_at(*z.referenced(value))
        single = kind == "single_pointer"
        return lambda value: self.pointer(value, single)

    def pointer(self, value, single=False):
        """ConvertOffsetToPointerNative: what was loaded at the address a reference names.

        Into an array, a single pointer gives the element there (`Walk.span` gives the ones
        after it) and an array pointer a view of the array from there, sharing its elements."""
        block, offset = self.z.referenced(value)
        found = self.loaded(block, offset, single)
        if found is not None:
            return found
        self.walk.loose += 1
        return Pointer(self.walk, block, offset)

    def loaded(self, block, offset, single):
        """The object an allocation put at `block`+`offset`: itself, an element of an array
        (`single`), or a view of that array from there. None when no allocation holds it."""
        found = self.z.allocation(block, offset)
        if found is None:
            return None
        start, obj = found
        if isinstance(obj, Array) and (offset - start) % obj.elem == 0 and offset - start < obj.elem * obj.count:
            first = (offset - start) // obj.elem
            return obj[first] if single else obj.view(first)
        return obj if start == offset else None

    def alias(self, value):
        """ConvertOffsetToAliasNative: what the pointer stored at the named address resolved to."""
        block, offset = self.z.referenced(value)
        try:
            return self.z.aliases[(block, offset)]
        except KeyError:
            raise WalkError(
                f"alias 0x{value:x} names block {block}+0x{offset:x}, where no aliasable pointer was loaded"
            ) from None

    # --- helpers the statements share -------------------------------------

    def act(self, actions):
        for fn, args, name in actions:
            try:
                fn(self.walk, *[self.vars.get(a) for a in args])
            except (KeyError, ValueError, TypeError, AttributeError) as error:
                raise WalkError(f"action {name}: {error}") from None

    def xstring(self, value):
        """LoadXString: null, following (read into the current block), or earlier memory."""
        if not value:
            return None
        if value == FOLLOWS:
            return self.z.take_cstring()[0]
        return self.z.cstring_at(*self.z.referenced(value))

    def pointers_at(self, rec, offset, n, at_start):
        """(block, cursor, zone offset) of `n` pointers: read now (at_start) or already in `rec`."""
        z = self.z
        if at_start:
            block, cursor = z.block, z.blocks[z.block]
            return block, cursor, z.take(4 * n)
        return rec.block, rec.cursor + offset, None if rec.at is None else rec.at + offset

    def words(self, at, n):
        if at is None:
            return [0] * n
        return list(struct.unpack_from(f"<{n}I", self.data, at))

    def load_ptr_array(self, target, pointers, block, cursor, items):
        """LoadPtrArray_<T>: each non-null element is an asset, a reused one, or loaded here."""
        z = self.z
        entry = self._loader_ptr_arrays.get((self.loader["struct"], target))
        if entry is None:
            entry = next((a for a in self.loader["ptr_arrays"] if a["type"] == target), None)
            if entry is None:
                raise WalkError(f"the {self.loader['struct']} loader has no pointer array of {target}")
            self._loader_ptr_arrays[(self.loader["struct"], target)] = entry
        sinfo = self.p.struct(entry["struct"]) if entry["struct"] else None
        is_asset = sinfo is not None and sinfo.defn["asset"]
        for i, value in enumerate(pointers):
            if not value:
                items.append(None)
                continue
            if is_asset:
                result = self.load_asset(entry["struct"], value)
                z.file_slot(block, cursor + 4 * i, result)
            elif entry["reusable"] and value != FOLLOWS:
                result = self.pointer(value, single=True)
            else:
                z.align_to(entry["align"])
                if sinfo is not None and not sinfo.leaf:
                    result = Record(self.walk, sinfo, None, z.block, z.blocks[z.block])
                    z.register(result.block, result.cursor, result)
                    self.vars[entry["struct"]] = result
                    self.load_fn(entry["struct"])(result, True)
                else:
                    b, c = z.block, z.blocks[z.block]
                    at = z.take(entry["size"])
                    result = (
                        Record(self.walk, sinfo, at, b, c)
                        if sinfo is not None
                        else Array(self.walk, target, entry["size"], at, b, c, 1)
                    )
                    z.register(b, c, result)
            items.append(result)

    def load_asset(self, name, value):
        """Loader_<name>.Load(ptr) -> LoadPtr_<name>(false), in a loader of its own."""
        if not value:
            return None
        loader = self.p.loaders.get(name)
        if loader is None:
            raise WalkError(f"no loader for asset struct {name}")
        entry = loader["entry"]
        temp = entry["temp"]
        z = self.z
        saved = self.vars, self.loader
        self.vars, self.loader = {}, loader
        if temp:
            z.push(self.temp)
        try:
            if value == FOLLOWS or (temp and value == INSERT):
                z.align_to(entry["align"])
                slot = z.insert_pointer() if temp and value == INSERT else None
                rec = Record(self.walk, self.p.struct(name), None, z.block, z.blocks[z.block])
                self.vars[name] = rec
                try:
                    self.load_fn(name)(rec, True)
                    if entry["action"]:
                        self.act([(self.actions[entry["action"]["name"]], entry["action"]["args"], entry["action"]["name"])])
                except WalkError as error:
                    raise _note(error, f"asset {name} at {rec.at if rec.at is None else hex(rec.at)}") from None
                result = self.register_asset(name, rec)
                if slot is not None:
                    z.aliases[(self.insert_block, slot)] = result
            else:
                result = self.alias(value) if temp else self.pointer(value, single=True)
        finally:
            if temp:
                z.pop()
            self.vars, self.loader = saved
        return result

    def register_asset(self, name, rec):
        """LoadAsset_<name>: the asset exists now, under the name AssetName<> gives it and the
        type its loader declares, not the XAsset entry's (`Program.type_of`)."""
        kind = self.p.type_of[name]
        accessor = self.p.loaders[name]["asset_name"]
        asset_name = accessor["singleton"] if "singleton" in accessor else rec[accessor["member"]]
        asset = Asset(kind["enum"], kind["listed"], asset_name, rec, len(self.walk.assets))
        self.walk.assets.append(asset)
        return asset

    # --- the zone ----------------------------------------------------------

    def run(self):
        """ContentLoader::Load: the XAssetList, its script strings, then every asset in it."""
        z, walk, data = self.z, self.walk, self.data
        # T6 adds {dependCount, depends} between the two (ContentLoaderT6.cpp).
        depends = self.p.spec.depends
        if depends:
            string_count, strings, depend_count, depend_list, asset_count, assets = struct.unpack_from("<6I", data, z.pos)
        else:
            string_count, strings, asset_count, assets = struct.unpack_from("<4I", data, z.pos)
            depend_count = depend_list = 0
        if strings not in (0, FOLLOWS) or assets not in (0, FOLLOWS) or 4 * (string_count + 2 * asset_count) > len(data):
            # MW3's 64-bit build shares IW5's header but stores 8-byte pointers (docs/cod/README.md#prerequisites).
            raise WalkError(
                f"the XAssetList ({string_count:#x}, {strings:#x}, {asset_count:#x}, {assets:#x}) is not a 32-bit zone's"
            )
        # OAT reads the XAssetList raw, into no block. The game loads it into TEMP, the stream's
        # first block, where it stays: every asset's TEMP use starts 16 bytes in, and only then
        # is TEMP's high-water mark the size the XFile header gives it (reverse/x86-zone/README.md).
        assert z.block == z.temp and not z.stack
        z.take(24 if depends else 16)
        z.push(z.virtual)
        if strings:
            if strings != FOLLOWS:
                raise WalkError(f"the script string list is 0x{strings:x}, not following")
            z.align_to(4)
            at = z.take(4 * string_count)
            walk.script_strings = [self.xstring(p) for p in self.words(at, string_count)]
        if depend_list:
            if depend_list != FOLLOWS:
                raise WalkError(f"the depends list is 0x{depend_list:x}, not following")
            z.align_to(4)
            at = z.take(4 * depend_count)
            walk.depends = [self.xstring(p) for p in self.words(at, depend_count)]
        if assets:
            if assets != FOLLOWS:
                raise WalkError(f"the asset list is 0x{assets:x}, not following")
            z.align_to(4)
            block, cursor = z.block, z.blocks[z.block]
            at = z.take(8 * asset_count)
            for i in range(asset_count):
                type_index, value = struct.unpack_from("<2I", data, at + 8 * i)
                kind = self.p.asset_types.get(type_index)
                if kind is None or kind.get("unsupported"):
                    raise WalkError(f"XAsset {i}: type {type_index} has no loader")
                if kind.get("skip"):
                    walk.entries.append((type_index, None))
                    continue
                try:
                    result = self.load_asset(kind["struct"], value)
                except WalkError as error:
                    walk.failed = (i, f"{kind['enum']}: {error}")
                    return walk
                z.file_slot(block, cursor + 8 * i + 4, result)
                walk.entries.append((type_index, result))
                if value not in (0, FOLLOWS, INSERT):
                    walk.aliased += 1
        z.pop()
        return walk


def walk_zone(data, program, path=None):
    """Walk a whole zone (the bytes `fastfile.read_zone` returns) with its game's Program.
    The Walk records a failure rather than raising, so a caller can report where a zone stopped."""
    started = time.perf_counter()
    walk = Walk(data, program, path)
    try:
        Walker(walk).run()
    except WalkError as error:
        walk.failed = (len(walk.entries), str(error))
    walk.seconds = time.perf_counter() - started
    return walk


def walk_fastfile(path):
    """Inflate an IW4, IW5 or T5 fastfile and walk its zone."""
    from ..fastfile import read_zone

    spec, data = read_zone(path)
    return walk_zone(data, programs.load(spec.game), path)
