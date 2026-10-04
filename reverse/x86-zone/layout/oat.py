"""OpenAssetTools' ZoneCodeGenerator front end, ported to Python: a game's struct header
and command files read into the model ZCG generates its zone loaders from.

Nothing here runs OAT. It reads three kinds of file from a checkout at $OAT, never
writes to it, and copies none of it into this repo:

- src/ZoneCode/Game/<G>/<G>_ZoneCode.h, which includes Common.h and <G>_Assets.h. It is
  preprocessed by the host g++ with `__zonecodegenerator` defined, exactly as ZCG
  preprocesses it, so the alignment macros expand the way ZCG saw them.
- src/ZoneCode/Game/<G>/<G>_Commands.txt and the XAssets/*.txt it includes.
- src/Common/Game/<G>/<G>.h for the XAssetType enum, and src/ZoneLoading/Game/<G>/
  ContentLoader<G>.cpp for which type index loads which struct.

Every rule below cites the ZCG source it mirrors (src/ZoneCodeGeneratorLib/...). Where
ZCG's behaviour is odd, the oddity is kept: the point is to reproduce its load order, and
check.py and loaddb.py prove that against ZCG's own generated output.
"""

import os
import re
import subprocess
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "tools"))
from paths import oat  # noqa: E402

OAT = oat()
# What the importer reads (zonecode.json and the field and name tables) is written into
# its tracked data, scripts/cod/data/<g>/; intermediates such as layout.json stay in ../out/.
DATA = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "scripts", "cod", "data"))
GAMES = {"iw4": "IW4", "iw5": "IW5", "t5": "T5", "t6": "T6"}
POINTER_SIZE = 4  # every game here is a 32-bit zone (`wordsize 32;`)
DEFAULT_PACK = 8  # Parser/Parsing/Impl/PackDefinitionStreamProxy.h


def data_path(g, name):
    """scripts/cod/data/<g>/<name>: where a generated file the importer reads goes."""
    return os.path.join(DATA, g.lower(), name)


def game_dir(g):
    return GAMES[g.lower()]


def path(*parts):
    return os.path.join(OAT, *parts)


# --------------------------------------------------------------------------- types
# Domain/Definition/*: a data definition is a base type, an enum, a typedef, a struct
# or a union; a member is a Variable holding a TypeDeclaration (type + modifiers).


class Base:
    kind = "base"

    def __init__(self, name, size):
        self.name, self.ns, self.size, self.align, self.force = name, "", size, size, False

    @property
    def full(self):
        return self.name


# BaseTypeDefinition.cpp: alignment is the size, so `double` and `long long` align to 8.
BASE_TYPES = {
    n: Base(n, s)
    for n, s in [
        ("float", 4),
        ("double", 8),
        ("bool", 1),
        ("char", 1),
        ("unsigned char", 1),
        ("short", 2),
        ("unsigned short", 2),
        ("int", 4),
        ("unsigned int", 4),
        ("long", 4),
        ("unsigned long", 4),
        ("long long", 8),
        ("unsigned long long", 8),
        ("void", 0),
    ]
}


class Named:
    def __init__(self, kind, ns, name):
        self.kind, self.ns, self.name = kind, ns, name

    @property
    def full(self):
        return f"{self.ns}::{self.name}" if self.ns else self.name


class Enum(Named):
    def __init__(self, ns, name, parent):
        super().__init__("enum", ns, name)
        self.parent, self.members = parent, []

    size = property(lambda self: self.parent.size)
    align = property(lambda self: self.parent.align)
    force = property(lambda self: self.parent.force)


class Typedef(Named):
    def __init__(self, ns, name, decl, align=None):
        super().__init__("typedef", ns, name)
        self.decl, self.align_override = decl, align

    size = property(lambda self: self.decl.size)
    align = property(lambda self: self.align_override if self.align_override is not None else self.decl.align)
    force = property(lambda self: self.align_override is not None or self.decl.force)


class Record(Named):
    """A struct or union (DefinitionWithMembers)."""

    def __init__(self, kind, ns, name, anonymous, pack):
        super().__init__(kind, ns, name)
        self.anonymous, self.pack, self.members = anonymous, pack, []
        self.custom_align, self.size, self.align, self.calculated = None, 0, 0, False

    force = property(lambda self: self.custom_align is not None)


class Forward(Named):
    def __init__(self, ns, name, kind):
        super().__init__("forward", ns, name)
        self.target_kind, self.definition = kind, None


class Ptr:
    kind = "ptr"

    def __init__(self):
        self.count = None  # IEvaluation; None means the default count of 1
        self.count_by_index = []  # set count <member>[i] ...; entries may stay None

    def count_for(self, index):
        """PointerDeclarationModifier::GetCountEvaluationForArrayIndex."""
        if 0 <= index < len(self.count_by_index) and self.count_by_index[index] is not None:
            return self.count_by_index[index]
        if 0 <= index < len(self.count_by_index):
            return None  # ZCG would dereference a null evaluation here; never happens in practice
        return self.count if self.count is not None else ONE

    def is_array(self, index=None):
        """CountEvaluationIsArray / AnyCountEvaluationIsArray."""
        if index is None:
            if self.count is not None and evaluation_is_array(self.count):
                return True
            if any(e is not None and evaluation_is_array(e) for e in self.count_by_index):
                return True
            return evaluation_is_array(ONE)
        if 0 <= index < len(self.count_by_index):
            e = self.count_by_index[index]
            return e is not None and evaluation_is_array(e)
        return evaluation_is_array(self.count if self.count is not None else ONE)

    @property
    def count_or_default(self):
        return self.count if self.count is not None else ONE


class Arr:
    kind = "arr"

    def __init__(self, size):
        self.size, self.dyn_count, self.dyn_size = size, None, None


class Decl:
    """TypeDeclaration: a type, `const`, modifiers outermost first, an optional bit size."""

    def __init__(self, type_, const=False, mods=None, bits=None):
        self.type, self.const, self.mods, self.bits = type_, const, mods or [], bits
        self.size = self.align = 0
        self.force = False
        self.calculated = False


class Var:
    def __init__(self, name, decl):
        self.name, self.decl, self.offset = name, decl, 0

    align = property(lambda self: self.decl.align)
    force = property(lambda self: self.decl.force)


# --------------------------------------------------------------------------- evaluations
# Domain/Evaluation/*: OperandStatic, OperandDynamic and Operation.


class Static:
    def __init__(self, value, enum=None):
        self.value, self.enum = value, enum

    static = True


class Dynamic:
    def __init__(self, structure, chain, indices):
        self.structure, self.chain, self.indices = structure, chain, indices

    static = False


class Operation:
    def __init__(self, op, a, b):
        self.op, self.a, self.b = op, a, b

    @property
    def static(self):
        return self.a.static and self.b.static


ONE = Static(1)

# OperationType.cpp: the lower the number, the tighter it binds.
PRECEDENCE = {
    "*": 1,
    "/": 1,
    "%": 1,
    "+": 2,
    "-": 2,
    "<<": 3,
    ">>": 3,
    ">": 4,
    ">=": 4,
    "<": 4,
    "<=": 4,
    "==": 5,
    "!=": 5,
    "&": 6,
    "^": 7,
    "|": 8,
    "&&": 9,
    "||": 10,
}


def _c_div(a, b):
    q = abs(a) // abs(b)
    return q if (a >= 0) == (b >= 0) else -q


FUNCS = {
    "+": lambda a, b: a + b,
    "-": lambda a, b: a - b,
    "*": lambda a, b: a * b,
    "/": _c_div,
    "%": lambda a, b: a - b * _c_div(a, b),
    "&": lambda a, b: a & b,
    "^": lambda a, b: a ^ b,
    "|": lambda a, b: a | b,
    "<<": lambda a, b: a << b,
    ">>": lambda a, b: a >> b,
    ">": lambda a, b: int(a > b),
    ">=": lambda a, b: int(a >= b),
    "<": lambda a, b: int(a < b),
    "<=": lambda a, b: int(a <= b),
    "==": lambda a, b: int(a == b),
    "!=": lambda a, b: int(a != b),
    "&&": lambda a, b: int(bool(a) and bool(b)),
    "||": lambda a, b: int(bool(a) or bool(b)),
}


def evaluate(e):
    if isinstance(e, Static):
        return e.value
    if isinstance(e, Operation):
        return FUNCS[e.op](evaluate(e.a), evaluate(e.b))
    raise ValueError("not a static evaluation")


def evaluation_is_array(e):
    """PointerDeclarationModifier::EvaluationIsArray."""
    return not e.static or evaluate(e) > 1


# --------------------------------------------------------------------------- tokens

TOKEN = re.compile(
    r"\s+|(?P<pragma>#pragma[^\n]*)|(?P<num>0[xX][0-9a-fA-F]+[uUlL]*|\d+[uUlL]*)|(?P<id>[A-Za-z_]\w*)"
    r"|(?P<op>::|\.\.\.|<<|>>|<=|>=|==|!=|&&|\|\||[-{}()\[\];:,*=&|^<>+/%!~.])"
)


def tokenize(text, where):
    out, pos = [], 0
    while pos < len(text):
        m = TOKEN.match(text, pos)
        if not m:
            raise ValueError(f"{where}: cannot tokenize at {text[pos : pos + 40]!r}")
        pos = m.end()
        if m.lastgroup == "num":
            out.append(("num", int(m.group().rstrip("uUlL"), 0)))
        elif m.lastgroup:
            out.append((m.lastgroup, m.group()))
    out.append(("eof", None))
    return out


class Cursor:
    def __init__(self, tokens, where):
        self.t, self.i, self.where = tokens, 0, where

    def peek(self, k=0):
        return self.t[min(self.i + k, len(self.t) - 1)]

    def next(self):
        tok = self.peek()
        self.i += 1
        return tok

    def at(self, value, k=0):
        return self.peek(k)[1] == value and self.peek(k)[0] in ("id", "op")

    def take(self, value):
        if self.at(value):
            self.i += 1
            return True
        return False

    def expect(self, value):
        if not self.take(value):
            self.fail(f"expected {value!r}")

    def ident(self):
        kind, value = self.next()
        if kind != "id":
            self.i -= 1
            self.fail("expected an identifier")
        return value

    def fail(self, message):
        context = " ".join(str(v) for _, v in self.t[max(0, self.i - 8) : self.i + 8])
        raise ValueError(f"{self.where}: {message} near: {context}")


# --------------------------------------------------------------------------- header

BUILTIN_WORDS = ("unsigned", "char", "short", "int", "long")
KEYWORDS = {"struct", "union", "enum", "typedef", "namespace", "const", "alignas", "__declspec"}


def preprocess_header(g):
    """<G>_ZoneCode.h through the host preprocessor, as ZCG's DefinesStreamProxy sees it."""
    G = game_dir(g)
    source = path("src", "ZoneCode", "Game", G, f"{G}_ZoneCode.h")
    cmd = ["g++", "-E", "-P", "-w", "-x", "c++", "-D__zonecodegenerator=1", source]
    return subprocess.run(cmd, check=True, capture_output=True, text=True).stdout


class Header:
    """HeaderParser + HeaderParserState + the header post-processors, for one game."""

    def __init__(self, text, where):
        self.c = Cursor(tokenize(text, where), where)
        self.ns = []
        self.pack = [DEFAULT_PACK]
        self.first_by_name = dict(BASE_TYPES)  # HeaderParserState::m_definitions: first wins
        self.forwards = {}  # full name -> Forward
        self.enum_members = {}  # first wins, like m_enum_members.insert
        self.definitions = []  # in declaration order
        self.anon = 0
        self._parse_scope(top=True)
        self._resolve_forwards()
        # InMemoryRepository: by short name, last wins; enum members likewise.
        self.by_name = dict(BASE_TYPES)
        self.enum_values = {}
        for d in self.definitions:
            self.by_name[d.name] = d
            if d.kind == "enum":
                for name, value in d.members:
                    self.enum_values[name] = value
        for d in self.definitions:
            if d.kind in ("struct", "union"):
                calculate_record(d)
            elif d.kind == "typedef":
                calculate_decl(d.decl)

    # -- naming
    def _ns(self):
        return "::".join(self.ns)

    def _add(self, definition):
        self.definitions.append(definition)
        self.first_by_name.setdefault(definition.name, definition)
        if definition.kind == "enum":
            for name, value in definition.members:
                self.enum_members.setdefault(name, value)

    def find_type(self, name):
        """HeaderParserState::FindType, then the namespace-qualified retry of SequenceVariable."""
        found = self.first_by_name.get(name) or self.forwards.get(name)
        if found is None and self.ns:
            qualified = f"{self._ns()}::{name}"
            found = self.first_by_name.get(qualified) or self.forwards.get(qualified)
        if found is None:
            self.c.fail(f"unknown type {name}")
        return found

    # -- grammar
    def _typename(self):
        """HeaderCommonMatchers::Typename: builtin words joined by spaces, or a::b::c."""
        c = self.c
        if c.peek()[1] in BUILTIN_WORDS:
            words = []
            if c.take("unsigned"):
                words.append("unsigned")
            word = c.ident()
            if word not in ("char", "short", "int", "long"):
                c.fail("bad builtin type")
            words.append(word)
            if word == "long" and c.take("long"):
                words.append("long")
            return " ".join(words)
        name = c.ident()
        while c.at("::"):
            c.next()
            name += "::" + c.ident()
        return name

    def _align(self):
        c = self.c
        if c.take("alignas"):
            c.expect("(")
            value = c.next()[1]
            c.expect(")")
            return value
        if c.take("__declspec"):
            c.expect("(")
            c.expect("align")
            c.expect("(")
            value = c.next()[1]
            c.expect(")")
            c.expect(")")
            return value
        return None

    def _array_dims(self):
        dims = []
        while self.c.take("["):
            kind, value = self.c.next()
            if kind == "id":
                if value not in self.enum_members:
                    self.c.fail(f"unknown enum member {value}")
                value = self.enum_members[value]
            dims.append(Arr(value))
            self.c.expect("]")
        return dims

    def _declarator(self, type_name, const):
        """SequenceVariable / SequenceTypedef: `T **name[a][b]` or `T (*name)[a]`."""
        c = self.c
        type_ = self.find_type(type_name)
        if c.at("("):
            c.next()
            pointers = 0
            while c.take("*"):
                pointers += 1
            name = c.ident()
            c.expect(")")
            mods = [Ptr() for _ in range(pointers)] + self._array_dims()
        else:
            pointers = 0
            while c.take("*"):
                pointers += 1
            name = c.ident()
            mods = self._array_dims() + [Ptr() for _ in range(pointers)]
        bits = None
        if c.take(":"):
            bits = c.next()[1]
        c.expect(";")
        return name, Decl(type_, const, mods, bits)

    def _parse_scope(self, top=False, record=None):
        c = self.c
        while True:
            kind, value = c.peek()
            if kind == "eof":
                if not top:
                    c.fail("unexpected end of header")
                return
            if kind == "pragma":
                c.next()
                self._pragma(value)
                continue
            if value == "}":
                return
            if value == "namespace":
                c.next()
                name = c.ident()
                c.expect("{")
                self.ns.append(name)
                self._parse_scope(top=True)
                c.expect("}")
                self.ns.pop()
                continue
            if value == ";":
                c.next()
                continue
            if value == "typedef" and c.peek(1)[1] not in ("struct", "union", "enum", "const"):
                self._typedef()
                continue
            if value == "typedef" and c.peek(1)[1] == "const" and c.peek(2)[1] not in ("struct", "union"):
                self._typedef()
                continue
            j = 1 if value in ("typedef",) else 0
            j += 1 if c.peek(j)[1] == "const" else 0
            head = c.peek(j)[1]
            if head in ("struct", "union", "enum"):
                # `struct X;` is a forward declaration (not allowed inside a record).
                if c.peek(j + 1)[0] == "id" and c.peek(j + 2)[1] == ";" and value != "typedef":
                    c.i += j + 1
                    name = c.ident()
                    c.expect(";")
                    fwd = Forward(self._ns(), name, head)
                    self.forwards.setdefault(fwd.full, fwd)
                    continue
                if head == "enum":
                    self._enum(record)
                else:
                    self._record(record)
                continue
            if record is None:
                c.fail("unexpected declaration outside a struct")
            const = c.take("const")
            type_name = self._typename()
            name, decl = self._declarator(type_name, const)
            record.members.append(Var(name, decl))

    def _pragma(self, text):
        m = re.match(r"#pragma\s+pack\s*\(\s*(push\s*,\s*(\d+)|pop|(\d+))?\s*\)", text)
        if not m:
            return
        if m.group(2):
            self.pack.append(int(m.group(2)))
        elif m.group(1) == "pop":
            self.pack.pop()
        elif m.group(3):
            self.pack[-1] = int(m.group(3))

    def _typedef(self):
        c = self.c
        c.expect("typedef")
        align = self._align()
        const = c.take("const")
        type_name = self._typename()
        name, decl = self._declarator(type_name, const)
        self._add(Typedef(self._ns(), name, decl, align))

    def _enum(self, record):
        c = self.c
        is_typedef = c.take("typedef")
        c.expect("enum")
        name = c.ident() if c.peek()[0] == "id" else ""
        parent = BASE_TYPES["int"]
        if c.take(":"):
            parent = self.find_type(self._typename())
            while parent.kind == "typedef":
                parent = parent.decl.type
        c.expect("{")
        ns = self._ns()
        if name:
            self.ns.append(name)
        enum = Enum(ns, name, parent)
        local, next_value = {}, 0
        while not c.at("}"):
            member = c.ident()
            if c.take("="):
                kind, value = c.next()
                if kind == "op" and value == "-":
                    value = -c.next()[1]
                elif kind == "id":
                    value = local[value] if value in local else self.enum_members[value]
            else:
                value = next_value
            enum.members.append((member, value))
            local[member] = value
            next_value = value + 1
            if not c.take(","):
                break
        c.expect("}")
        variable = c.ident() if c.peek()[0] == "id" else ""
        c.expect(";")
        if name:
            self.ns.pop()
        self._add(enum)
        if is_typedef:
            self._add(Typedef(ns, variable, Decl(enum)))
        elif variable and record is not None:
            record.members.append(Var(variable, Decl(enum)))

    def _record(self, parent):
        """SequenceStruct / SequenceUnion and HeaderBlockStruct / HeaderBlockUnion."""
        c = self.c
        is_typedef = c.take("typedef")
        c.take("const")
        kind = c.next()[1]
        align = self._align()
        name = c.ident() if c.peek()[0] == "id" else ""
        inherited = []
        if c.take(":"):
            base = self.find_type(self._typename())
            inherited = list(base.members)
        c.expect("{")
        ns = self._ns()
        anonymous = not name
        if anonymous:
            # ZCG names these at random; a stable name keeps our output diffable.
            self.anon += 1
            name = f"__anonymous{self.anon}"
        else:
            self.ns.append(name)
        fwd = Forward(ns, name, kind)
        self.forwards.setdefault(fwd.full, fwd)
        rec = Record(kind, ns, name, anonymous, self.pack[-1])
        rec.members.extend(inherited)
        rec.custom_align = align
        self._parse_scope(record=rec)
        c.expect("}")
        variable = c.ident() if c.peek()[0] == "id" else ""
        c.expect(";")
        if not anonymous:
            self.ns.pop()
        self._add(rec)
        if is_typedef:
            self._add(Typedef(ns, variable, Decl(rec)))
        # HeaderBlockStruct/Union::IsDefiningVariable is always true: a nested record
        # always adds a member, named or not.
        if parent is not None:
            parent.members.append(Var(variable, Decl(rec)))

    def _resolve_forwards(self):
        """HeaderParserState::SaveToRepository: forward declarations become their definitions."""

        def real(t):
            if t.kind != "forward":
                return t
            found = self.first_by_name.get(t.full)
            if found is None or found.kind == "forward":
                found = next((d for d in self.definitions if d.full == t.full and d.kind != "forward"), None)
            if found is None:
                raise ValueError(f"forward declaration {t.full} was never defined")
            return found

        for d in self.definitions:
            if d.kind in ("struct", "union"):
                for m in d.members:
                    m.decl.type = real(m.decl.type)
            elif d.kind == "typedef":
                d.decl.type = real(d.decl.type)


# --------------------------------------------------------------------------- sizes
# Parsing/PostProcessing/CalculateSizeAndAlignPostProcessor.cpp, for a 32-bit word.


def _align_up(value, alignment):
    return value if alignment <= 0 else (value + alignment - 1) // alignment * alignment


def calculate_type(t):
    if t.kind in ("struct", "union"):
        calculate_record(t)
    elif t.kind == "typedef":
        calculate_decl(t.decl)


def calculate_decl(d):
    if d.calculated:
        return
    if any(m.kind == "ptr" for m in d.mods):
        d.align, d.force = POINTER_SIZE, False
    else:
        calculate_type(d.type)
        d.align, d.force = d.type.align, d.type.force
    if not d.mods:
        calculate_type(d.type)
        d.size = d.type.size
    else:
        size = 0
        if d.mods[-1].kind != "ptr":
            calculate_type(d.type)
            size = d.type.size
        for m in reversed(d.mods):
            size = POINTER_SIZE if m.kind == "ptr" else size * m.size
        d.size = size
    d.calculated = True


def calculate_record(r):
    if r.calculated:
        return
    if r.calculated is None:
        raise ValueError(f"circular dependency in {r.full}")
    r.calculated = None
    for m in r.members:
        calculate_decl(m.decl)
    r.align = r.custom_align if r.custom_align is not None else max((m.align for m in r.members), default=0)
    if r.kind == "union":
        r.size = _align_up(max((m.decl.size for m in r.members), default=0), r.align)
        for m in r.members:
            m.offset = 0
    else:
        size, bits = 0, 0
        for m in r.members:
            if m.decl.bits is not None:
                m.offset = size + bits // 8
                bits += m.decl.bits
                continue
            if bits:
                size += _align_up(bits, 8) // 8
                bits = 0
            size = _align_up(size, m.align if m.force else min(m.align, r.pack))
            m.offset = size
            size += m.decl.size
        if bits:
            size += _align_up(bits, 8) // 8
        r.size = _align_up(size, r.align)
    r.calculated = True


# --------------------------------------------------------------------------- commands


class Block:
    def __init__(self, name, index, type_, default):
        self.name, self.index, self.type, self.default = name, index, type_, default


class MemberInfo:
    """Domain/Information/MemberInformation.h."""

    def __init__(self, parent, var, type_info, struct):
        self.parent, self.var, self.type_info, self.struct = parent, var, type_info, struct
        self.string = self.script_string = self.reusable = self.leaf = False
        self.condition = self.alloc_align = self.action = self.block = None
        self.asset_ref = ""

    name = property(lambda self: self.var.name)
    mods = property(lambda self: self.var.decl.mods)


class StructInfo:
    """Domain/Information/StructureInformation.h."""

    def __init__(self, definition):
        self.definition = definition
        self.asset_name = ""
        self.alloc_align = self.action = self.block = None
        self.usages, self.members = [], []
        self.leaf = self.requires_marking = False
        self.embedded_ref = self.non_embedded_ref = self.single_ptr_ref = False
        self.array_ptr_ref = self.array_ref = self.non_default_block_ref = False

    name = property(lambda self: self.definition.name)
    is_asset = property(lambda self: bool(self.asset_name))
    is_union = property(lambda self: self.definition.kind == "union")


class Model:
    """A header plus its commands: the IDataRepository ZCG renders templates from."""

    def __init__(self, g):
        self.g, self.G = g.lower(), game_dir(g)
        self.header = Header(preprocess_header(g), f"{self.G}_ZoneCode.h")
        self.infos = {}  # Record -> StructInfo
        self.type_reusable = {}  # definition full name -> TypeInformation::m_reusable_reference_exists
        for d in self.header.definitions:
            if d.kind in ("struct", "union"):
                self.infos[id(d)] = StructInfo(d)
        for info in self.infos.values():
            for var in info.definition.members:
                t = var.decl.type
                while t.kind == "typedef":
                    t = t.decl.type
                struct = self.infos.get(id(t)) if t.kind in ("struct", "union") else None
                info.members.append(MemberInfo(info, var, var.decl.type, struct))
        self.game = self.wordsize = None
        self.blocks, self.assets = [], []
        self.in_use = None
        commands = os.path.join(path("src", "ZoneCode", "Game", self.G), f"{self.G}_Commands.txt")
        self.c = Cursor(tokenize(read_commands(commands), commands), commands)
        while self.c.peek()[0] != "eof":
            self._command()
        post_process(self)

    # -- lookups
    def info_named(self, name):
        d = self.header.by_name.get(name)
        return self.infos.get(id(d)) if d is not None and d.kind in ("struct", "union") else None

    def block(self, name):
        found = next((b for b in self.blocks if b.name == name), None)
        if found is None:
            self.c.fail(f"unknown block {name}")
        return found

    @staticmethod
    def _members_from(name, info, offset=0):
        """ExtractMembersFromTypenameInternal: a::b::c as a member chain from `info`."""
        chain, parts = [], name.split("::")[offset:]
        for part in parts:
            if info is None:
                return None
            member = next((m for m in info.members if m.name == part), None)
            if member is None:
                return None
            chain.append(member)
            info = member.struct
        return chain

    def resolve(self, name):
        """CommandsParserState::GetTypenameAndMembersFromTypename -> (StructInfo, chain)."""
        if self.in_use is not None:
            chain = self._members_from(name, self.in_use)
            if chain is not None:
                return self.in_use, chain
        parts = name.split("::")
        for i in range(1, len(parts)):
            info = self.info_named("::".join(parts[:i]))
            d = self.header.by_name.get("::".join(parts[:i]))
            if d is not None:
                if info is None:
                    return None
                chain = self._members_from(name, info, i)
                return (info, chain) if chain is not None else None
        info = self.info_named(name)
        return (info, []) if info is not None else None

    def resolve_or_fail(self, name):
        found = self.resolve(name)
        if found is None:
            self.c.fail(f"unknown type {name}")
        return found

    # -- the grammar of CommandsParser's sequences
    def _typename(self):
        c = self.c
        if c.peek()[1] in BUILTIN_WORDS:
            words = []
            while c.peek()[1] in BUILTIN_WORDS:
                words.append(c.next()[1])
            return " ".join(words)
        name = c.ident()
        while c.at("::"):
            c.next()
            name += "::" + c.ident()
        return name

    def _command(self):
        c = self.c
        word = c.ident()
        if word == "game":
            self.game = c.ident()
        elif word == "wordsize":
            self.wordsize = c.next()[1]
        elif word == "asset":
            info = self.info_named(self._typename())
            info.asset_name = c.ident()
            self.assets.append(info)
        elif word == "block":
            type_ = c.ident()
            name = c.ident()
            default = c.take("default")
            self.blocks.append(Block(name, self.header.enum_values[name], type_, default))
        elif word == "use":
            self.in_use = self.info_named(self._typename())
            if self.in_use is None:
                c.fail("use of an unknown type")
        elif word == "reorder":
            self._reorder()
            return
        elif word == "set":
            self._set()
            return
        else:
            c.fail(f"unknown command {word}")
        c.expect(";")

    def _set(self):
        c = self.c
        what = c.ident()
        if what == "block":
            first = self._typename()
            if c.at(";"):
                self.in_use.block = self.block(first)
            else:
                info, chain = self.resolve_or_fail(first)
                block = self.block(c.ident())
                if chain:
                    chain[-1].block = block
                else:
                    info.block = block
        elif what in ("string", "scriptstring", "reusable"):
            _, chain = self.resolve_or_fail(self._typename())
            setattr(chain[-1], {"string": "string", "scriptstring": "script_string", "reusable": "reusable"}[what], True)
        elif what == "assetref":
            _, chain = self.resolve_or_fail(self._typename())
            chain[-1].asset_ref = c.ident()
        elif what == "condition":
            info, chain = self.resolve_or_fail(self._typename())
            if c.take("always"):
                chain[-1].condition = Static(1)
            elif c.take("never"):
                chain[-1].condition = Static(0)
            else:
                chain[-1].condition = self._evaluation(info)
        elif what in ("arraysize", "arraycount"):
            info, chain = self.resolve_or_fail(self._typename())
            arr = next(m for m in chain[-1].mods if m.kind == "arr")
            e = self._evaluation(info)
            if what == "arraysize":
                arr.dyn_size = e
            else:
                arr.dyn_count = e
        elif what == "allocalign":
            info, chain = self.resolve_or_fail(self._typename())
            e = self._evaluation(info)
            if chain:
                chain[-1].alloc_align = e
            else:
                info.alloc_align = e
        elif what == "count":
            self._count()
            return
        elif what == "action":
            self._action()
            return
        else:
            c.fail(f"unknown set {what}")
        c.expect(";")

    def _count(self):
        """SequenceCount: `set count [*...] member[idx]... evaluation;`."""
        c = self.c
        resolve = 0
        while c.take("*"):
            resolve += 1
        info, chain = self.resolve_or_fail(self._typename())
        indices = []
        while c.at("["):
            c.next()
            kind, value = c.next()
            indices.append(value if kind == "num" else self.header.enum_values[value])
            c.expect("]")
        member = chain[-1]
        pointers = [m for m in member.mods if m.kind == "ptr"]
        ptr = pointers[resolve]
        e = self._evaluation(info)
        c.expect(";")
        if not indices:
            ptr.count = e
            return
        sizes = [m.size for m in member.mods if m.kind == "arr"]
        depth = [1] * len(sizes)
        for i in range(len(sizes) - 2, -1, -1):
            depth[i] = depth[i + 1] * sizes[i + 1]
        if not ptr.count_by_index:
            total = 1
            for s in sizes:
                total *= s
            ptr.count_by_index = [None] * total
        index = sum(depth[k] * v for k, v in enumerate(indices[: len(depth)]))
        ptr.count_by_index[index] = e

    def _action(self):
        """SequenceAction: `set action [type[::member]] Name(ArgType, ...);`."""
        c = self.c
        names = [self._typename()]
        if not c.at("("):
            names.append(c.ident())
        c.expect("(")
        args = []
        while not c.at(")"):
            args.append(self._typename())
            c.take(",")
        c.expect(")")
        c.expect(";")
        action = {"name": names[-1], "args": args}
        if len(names) == 2:
            info, chain = self.resolve_or_fail(names[0])
            if chain:
                chain[-1].action = action
            else:
                info.action = action
        else:
            self.in_use.action = action

    def _reorder(self):
        c = self.c
        info = None
        if not c.at(":"):
            info, chain = self.resolve_or_fail(self._typename())
            if chain:
                info = chain[-1].struct
        info = info or self.in_use
        c.expect(":")
        find_first = False
        if c.take("..."):
            find_first = True
        entries = []
        while not c.at(";"):
            entries.append(c.ident())
        c.expect(";")
        first = entries.pop(0) if find_first else None
        old = list(info.members)
        new = []
        for name in entries:
            member = next(m for m in old if m.name == name)
            old.remove(member)
            new.append(member)
        ordered = []
        while find_first and old:
            if old[0].name == first:
                find_first = False
            ordered.append(old.pop(0))
        info.members = ordered + new + old

    # CommandsCommonMatchers::Evaluation / ProcessEvaluation
    def _evaluation(self, current):
        if current is self.in_use:
            current = None
        operands, operators = [self._operand(current)], []
        while self.c.peek()[0] == "op" and self.c.peek()[1] in PRECEDENCE:
            operators.append(self.c.next()[1])
            operands.append(self._operand(current))
        # ProcessEvaluation folds by precedence, left to right within one level.
        while operators:
            best = min(range(len(operators)), key=lambda i: (PRECEDENCE[operators[i]], i))
            operands[best : best + 2] = [Operation(operators.pop(best), operands[best], operands[best + 1])]
        return operands[0]

    def _operand(self, current):
        c = self.c
        negate = False
        if c.at("!") and c.at("(", 1):
            c.next()
            negate = True
        if c.take("("):
            e = self._evaluation(None)  # ProcessEvaluationInParenthesis drops the current type
            c.expect(")")
            return Operation("==", e, Static(0)) if negate else e
        kind, value = c.peek()
        if kind == "num":
            c.next()
            return Static(value)
        name = self._typename()
        indices = []
        while c.take("["):
            indices.append(self._evaluation(current))
            c.expect("]")
        if name in self.header.enum_values:
            return Static(self.header.enum_values[name], enum=name)
        found = self.resolve(name)
        if found is not None:
            return Dynamic(found[0], found[1], indices)
        # GetMembersFromTypename against the type the command named (resolve() already
        # tried the used type).
        chain = self._members_from(name, current) if current is not None else None
        if chain is not None:
            return Dynamic(current, chain, indices)
        c.fail(f"unknown operand {name}")


def read_commands(file):
    """The command file with its comments stripped and `#include`s inlined."""
    with open(file) as fh:
        text = fh.read()
    text = re.sub(r"/\*.*?\*/", " ", text, flags=re.S)
    text = re.sub(r"//[^\n]*", "", text)

    def include(m):
        return read_commands(os.path.join(os.path.dirname(file), m.group(1)))

    return re.sub(r'#include\s+"([^"]+)"', include, text)


# --------------------------------------------------------------------------- post-processing
# Parsing/Commands/CommandsFileReader.cpp runs these in this order after the commands.


def should_ignore(member):
    """MemberComputations::ShouldIgnore: a condition that is statically false."""
    return member.condition is not None and member.condition.static and evaluate(member.condition) == 0


def has_pointer(member):
    return any(m.kind == "ptr" for m in member.mods)


def is_array(member):
    return bool(member.mods) and member.mods[0].kind == "arr"


def pointer_depth(member):
    return sum(1 for m in member.mods if m.kind == "ptr")


def single_pointer_ref(member):
    return bool(member.mods) and member.mods[-1].kind == "ptr" and not member.mods[-1].is_array()


def array_pointer_ref(member):
    return bool(member.mods) and member.mods[-1].kind == "ptr" and member.mods[-1].is_array()


def array_ref(member):
    return bool(member.mods) and member.mods[-1].kind == "arr"


def pointer_array_ref(member):
    """MemberComputations::ContainsPointerArrayReference."""
    if not single_pointer_ref(member):
        return False
    return (is_array(member) and pointer_depth(member) == 1) or (not is_array(member) and pointer_depth(member) == 2)


def dynamic_array_size(member):
    return any(m.kind == "arr" and m.dyn_size is not None for m in member.mods)


def not_in_default_normal_block(member):
    return member.block is not None and not (member.block.type == "normal" and member.block.default)


def in_temp_block(member):
    return member.block is not None and member.block.type == "temp"


def in_runtime_block(member):
    return member.block is not None and member.block.type == "runtime"


def is_dynamic_member(member):
    if dynamic_array_size(member):
        return True
    return not has_pointer(member) and member.struct is not None and dynamic_member(member.struct) is not None


def is_after_partial_load(member):
    if is_dynamic_member(member):
        return True
    return member.parent.is_union and dynamic_member(member.parent) is not None


def dynamic_member(info):
    return next((m for m in info.members if is_dynamic_member(m)), None)


def used_members(info, include_leafs):
    """StructureComputations::GetUsedMembers."""
    if info.is_union and dynamic_member(info) is not None:
        return [m for m in info.members if not should_ignore(m)]
    return [m for m in info.members if (include_leafs or not m.leaf) and not should_ignore(m)]


def _pointer_counts_nonzero(member):
    for m in member.mods:
        if m.kind == "ptr":
            e = m.count_or_default
            if not e.static or evaluate(e) != 0:
                return True
    return False


def post_process(model):
    infos = list(model.infos.values())
    # UsagesPostProcessor: walk every asset's reachable structs.
    for asset in infos:
        if not asset.is_asset:
            continue
        seen, queue = set(), [asset]
        while queue:
            current = queue.pop(0)
            if id(current) in seen:
                continue
            seen.add(id(current))
            for member in current.members:
                if should_ignore(member):
                    continue
                if member.reusable:
                    model.type_reusable[member.type_info.full] = True
                    if member.struct is not None:
                        model.type_reusable[member.struct.definition.full] = True
                if member.struct is not None:
                    s = member.struct
                    if is_array(member) or not member.mods:
                        s.embedded_ref = True
                    if has_pointer(member):
                        s.non_embedded_ref = True
                    if single_pointer_ref(member):
                        s.single_ptr_ref = True
                    if array_pointer_ref(member):
                        s.array_ptr_ref = True
                    if array_ref(member):
                        s.array_ref = True
                    if not_in_default_normal_block(member):
                        s.non_default_block_ref = True
                    s.usages.append(current)
                    queue.append(s)

    # LeafsPostProcessor
    def is_leaf(info):
        for member in info.members:
            if should_ignore(member):
                continue
            if member.script_string or member.string:
                return False
            if _pointer_counts_nonzero(member):
                return False
            if dynamic_array_size(member):
                return False
            if member.struct is not None and member.struct is not info and not is_leaf(member.struct):
                return False
        return True

    for info in infos:
        info.leaf = is_leaf(info)

    # MarkingRequiredPostProcessor (kept for completeness; loading does not read it)
    visited = set()

    def requires_marking(info):
        if id(info) in visited:
            return info.requires_marking
        visited.add(id(info))
        if info.is_asset:
            info.requires_marking = True
            return True
        for member in info.members:
            if should_ignore(member):
                continue
            if any(m.kind == "ptr" and m.count_or_default.static and evaluate(m.count_or_default) == 0 for m in member.mods):
                continue
            if member.script_string or member.asset_ref or (member.struct is not None and member.struct.is_asset):
                info.requires_marking = True
                return True
            if member.struct is not None and member.struct is not info and requires_marking(member.struct):
                info.requires_marking = True
                return True
        info.requires_marking = False
        return False

    for info in infos:
        requires_marking(info)

    # MemberLeafsPostProcessor
    for info in infos:
        for member in info.members:
            member.leaf = not (
                member.string
                or member.script_string
                or (member.struct is not None and not member.struct.leaf)
                or _pointer_counts_nonzero(member)
                or dynamic_array_size(member)
            )

    # UnionsPostProcessor: the one member without a condition goes last.
    for info in infos:
        if not info.is_union:
            continue
        without = [i for i, m in enumerate(info.members) if m.condition is None and not m.leaf]
        if len(without) > 1 and info.usages and not info.leaf:
            raise ValueError(f"union {info.definition.full} has more than one entry without a condition")
        if len(without) == 1:
            info.members.append(info.members.pop(without[0]))
