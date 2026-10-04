"""Run the Durango build's Load_* functions, in a small x86-64 interpreter, over a PC zone.

The loaders are generated code: moves, arithmetic, compares, jumps and calls. So a
few dozen instructions cover them, and the interpreter can walk an asset exactly
as the game does without anyone transcribing it. The PC build differs from this
one only in its render structs (reverse/iw6-zone/README.md), so assets that are not render assets
load the same way on both.

Calls are where the interpreter meets the rest of the walker:
  - the stream helpers (Load_Stream, DB_PushStreamPos, DB_InsertPointer, the
    XString loaders) act on the `Zone`, so block cursors and the file position
    stay the same in both;
  - a handle or pointer to an asset type that has a Python walker is handed to it,
    which is how the render structs keep their PC layout;
  - anything else named in STUBS returns 0, and any other call is an error.

Nothing is executed natively: instructions are decoded with capstone and
interpreted here. Memory is sparse; the image's own sections are read from the
exe on first touch, and a block's memory lives at BLOCK_BASE(block) + offset.
"""

import re
import struct

import capstone
from capstone import x86

from .zone import VIRTUAL, follows, reference

PAGE = 0x1000
MASK64 = (1 << 64) - 1
STACK_TOP = 0x7FF0_0000_0000
RETURN_SENTINEL = 0x7FEE_DEAD_0000
FOREIGN = 0x6000_0000_0000  # fake addresses for assets loaded by the Python walkers
ARENA = 0x5000_0000_0000  # registered asset headers, copied out of TEMP as DB_AddXAsset does
HEADER_COPY = 0x2000  # bytes copied per header; more than any asset struct


def block_base(block):
    return (block + 1) << 44


def block_of(address):
    block = (address >> 44) - 1
    if 0 <= block < 7:
        return block, address - block_base(block)
    return None


# Calls the loaders make that need no effect here: bookkeeping, fixups.
STUBS = {
    "Load_ScriptStringCustom",
    "DB_FindXAssetHeader",
    "Load_FxEffectDefFromName",
    "DS_SHMEM_FixupAnimation",
    "Sys_TempPriorityAtLeastNormalBegin",
    "Sys_TempPriorityEnd",
    "sleep",
    "DB_LinkXAssetEntry1",
    "Load_XModelSurfsFixup",
    "DB_EnumXAssets",
    "Com_Error",
    "Com_PrintError",
}

REGS64 = {
    x86.X86_REG_RAX: 0,
    x86.X86_REG_RCX: 1,
    x86.X86_REG_RDX: 2,
    x86.X86_REG_RBX: 3,
    x86.X86_REG_RSP: 4,
    x86.X86_REG_RBP: 5,
    x86.X86_REG_RSI: 6,
    x86.X86_REG_RDI: 7,
}
for _n in range(8, 16):
    REGS64[getattr(x86, f"X86_REG_R{_n}")] = _n


def _subregs():
    table = {}
    names = ["A", "C", "D", "B", "SP", "BP", "SI", "DI"]
    for i, n in enumerate(names):
        wide = len(n) == 2
        table[getattr(x86, f"X86_REG_E{n}" if wide else f"X86_REG_E{n}X")] = (i, 4)
        table[getattr(x86, f"X86_REG_{n}" if wide else f"X86_REG_{n}X")] = (i, 2)
        low = {"A": "AL", "C": "CL", "D": "DL", "B": "BL", "SP": "SPL", "BP": "BPL", "SI": "SIL", "DI": "DIL"}[n]
        table[getattr(x86, f"X86_REG_{low}")] = (i, 1)
    for r in range(8, 16):
        table[getattr(x86, f"X86_REG_R{r}D")] = (r, 4)
        table[getattr(x86, f"X86_REG_R{r}W")] = (r, 2)
        table[getattr(x86, f"X86_REG_R{r}B")] = (r, 1)
    for reg, index in REGS64.items():
        table[reg] = (index, 8)
    return table


SUBREGS = _subregs()


class Emulator:
    def __init__(self, image, zone, python_handles):
        """`image`: durangodis.Image. `python_handles`: Durango struct name -> (asset type, walker)."""
        self.image = image
        self.exe = image.exe
        self.z = zone
        self.python_handles = python_handles
        self.md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_64)
        self.md.detail = True
        self.code = {}
        self.pages = {}
        self.names = {}
        self.by_name = {}
        for va, n in image.symbols.items():
            short = re.sub(r"^\?([^@]+)@.*", r"\1", n)
            self.names.setdefault(va, short)
            self.by_name.setdefault(short, va)
        self.stream_pos = self.by_name["g_streamPos"]
        self.stream_index = self.by_name["g_streamPosIndex"]
        self.foreign = {}
        self.foreign_results = {}
        self.arena = ARENA
        self.steps = 0
        self.zf = self.sf = self.cf = self.of = False

    # --- memory ------------------------------------------------------------

    def _page(self, address):
        base = address & ~(PAGE - 1)
        page = self.pages.get(base)
        if page is None:
            page = bytearray(PAGE)
            try:
                data = self.exe.read(base, PAGE)
                page[: len(data)] = data
            except ValueError:
                # Not the image, so a block page. An asset may alias data streamed
                # long before it (DB_GetPackedOffsetStreamPos): those bytes reached
                # the zone, not this memory, and left as zeros they read as a struct
                # full of nothing rather than as a missing one. The clipmap's planes
                # are the case, and every bevel side of every brush is one.
                where = block_of(base)
                if where and where[0] == VIRTUAL:
                    page[:] = self.z.virtual_slice(where[1], PAGE)
            self.pages[base] = page
        return page

    def read(self, address, size):
        if address == self.stream_pos and size == 8:
            return struct.pack("<Q", block_base(self.z.block) + self.z.blocks[self.z.block])
        if address == self.stream_index and size == 4:
            return struct.pack("<I", self.z.block)
        out = bytearray()
        while size:
            page = self._page(address)
            at = address & (PAGE - 1)
            n = min(size, PAGE - at)
            out += page[at : at + n]
            address += n
            size -= n
        return bytes(out)

    def write(self, address, data):
        if address == self.stream_pos and len(data) == 8:
            value = struct.unpack("<Q", data)[0]
            where = block_of(value)
            if where is None or where[0] != self.z.block:
                raise RuntimeError(f"g_streamPos set outside block {self.z.block}: {value:#x}")
            self.z.blocks[self.z.block] = where[1]
            return
        if address == self.stream_index:
            raise RuntimeError("g_streamPosIndex written directly")
        while data:
            page = self._page(address)
            at = address & (PAGE - 1)
            n = min(len(data), PAGE - at)
            page[at : at + n] = data[:n]
            address += n
            data = data[n:]

    def u64(self, address):
        return struct.unpack("<Q", self.read(address, 8))[0]

    def put64(self, address, value):
        self.write(address, struct.pack("<Q", value & MASK64))

    # --- registers ---------------------------------------------------------

    def get(self, reg):
        index, size = SUBREGS[reg]
        value = self.r[index]
        return value if size == 8 else value & ((1 << (8 * size)) - 1)

    def set(self, reg, value):
        index, size = SUBREGS[reg]
        if size == 8:
            self.r[index] = value & MASK64
        elif size == 4:
            self.r[index] = value & 0xFFFFFFFF  # a 32-bit write zero-extends
        else:
            bits = 8 * size
            self.r[index] = (self.r[index] & ~((1 << bits) - 1) & MASK64) | (value & ((1 << bits) - 1))

    def address(self, ins, op):
        mem = op.mem
        address = mem.disp
        if mem.base == x86.X86_REG_RIP:
            address += ins.address + ins.size
        elif mem.base:
            address += self.get(mem.base)
        if mem.index:
            address += self.get(mem.index) * mem.scale
        return address & MASK64

    def load(self, ins, op):
        if op.type == x86.X86_OP_REG:
            return self.get(op.reg)
        if op.type == x86.X86_OP_IMM:
            return op.imm & MASK64
        return int.from_bytes(self.read(self.address(ins, op), op.size), "little")

    def store(self, ins, op, value):
        if op.type == x86.X86_OP_REG:
            self.set(op.reg, value)
        else:
            self.write(self.address(ins, op), (value & ((1 << (8 * op.size)) - 1)).to_bytes(op.size, "little"))

    # --- flags -------------------------------------------------------------

    def flags_logic(self, value, bits):
        mask = (1 << bits) - 1
        value &= mask
        self.zf, self.sf, self.cf, self.of = value == 0, bool(value >> (bits - 1)), False, False

    def flags_sub(self, a, b, bits):
        mask = (1 << bits) - 1
        a, b = a & mask, b & mask
        result = (a - b) & mask
        sign = 1 << (bits - 1)
        self.zf, self.sf, self.cf = result == 0, bool(result & sign), a < b
        self.of = bool(((a ^ b) & (a ^ result)) & sign)
        return result

    def flags_add(self, a, b, bits):
        mask = (1 << bits) - 1
        a, b = a & mask, b & mask
        total = a + b
        result = total & mask
        sign = 1 << (bits - 1)
        self.zf, self.sf, self.cf = result == 0, bool(result & sign), total > mask
        self.of = bool((~(a ^ b) & (a ^ result)) & sign)
        return result

    def condition(self, cc):
        return {
            "e": self.zf,
            "z": self.zf,
            "ne": not self.zf,
            "nz": not self.zf,
            "b": self.cf,
            "c": self.cf,
            "nae": self.cf,
            "ae": not self.cf,
            "nb": not self.cf,
            "nc": not self.cf,
            "be": self.cf or self.zf,
            "na": self.cf or self.zf,
            "a": not (self.cf or self.zf),
            "nbe": not (self.cf or self.zf),
            "l": self.sf != self.of,
            "nge": self.sf != self.of,
            "ge": self.sf == self.of,
            "nl": self.sf == self.of,
            "le": self.zf or self.sf != self.of,
            "ng": self.zf or self.sf != self.of,
            "g": not self.zf and self.sf == self.of,
            "nle": not self.zf and self.sf == self.of,
            "s": self.sf,
            "ns": not self.sf,
            "o": self.of,
            "no": not self.of,
        }[cc]

    # --- running -----------------------------------------------------------

    def decode(self, address):
        ins = self.code.get(address)
        if ins is None:
            ins = next(self.md.disasm(self.exe.read(address, 16), address))
            self.code[address] = ins
        return ins

    def call(self, function, rcx=0, rdx=0, r8=0):
        """Run `function` (a name or an address) to its return. Calls may nest: a Python
        walker running inside an intercepted call can start another emulated load."""
        target = self.by_name[function] if isinstance(function, str) else function
        outer = getattr(self, "r", None)
        flags = (self.zf, self.sf, self.cf, self.of)
        top = (outer[4] - 0x10000) & ~0xF if outer is not None else STACK_TOP
        self.r = [0] * 16
        self.zf = self.sf = self.cf = self.of = False
        self.r[4] = top
        self.r[1], self.r[2], self.r[8] = rcx, rdx, r8
        self.push(RETURN_SENTINEL)
        rip = target
        while rip != RETURN_SENTINEL:
            rip = self.step(rip)
        result = self.r[0]
        if outer is not None:
            self.r = outer
            self.zf, self.sf, self.cf, self.of = flags
        else:
            del self.r
        return result

    def push(self, value):
        self.r[4] = (self.r[4] - 8) & MASK64
        self.put64(self.r[4], value)

    def pop(self):
        value = self.u64(self.r[4])
        self.r[4] = (self.r[4] + 8) & MASK64
        return value

    def step(self, rip):
        ins = self.decode(rip)
        self.steps += 1
        nxt = rip + ins.size
        m = ins.mnemonic
        ops = ins.operands
        if m in ("mov", "movabs"):
            self.store(ins, ops[0], self.load(ins, ops[1]))
        elif m == "movzx":
            self.store(ins, ops[0], self.load(ins, ops[1]))
        elif m in ("movsx", "movsxd"):
            value, bits = self.load(ins, ops[1]), 8 * ops[1].size
            if value >> (bits - 1):
                value -= 1 << bits
            self.store(ins, ops[0], value)
        elif m == "lea":
            self.store(ins, ops[0], self.address(ins, ops[1]))
        elif m in ("add", "sub", "cmp"):
            bits = 8 * ops[0].size
            a, b = self.load(ins, ops[0]), self.load(ins, ops[1])
            if m == "add":
                self.store(ins, ops[0], self.flags_add(a, b, bits))
            else:
                result = self.flags_sub(a, b, bits)
                if m == "sub":
                    self.store(ins, ops[0], result)
        elif m in ("and", "or", "xor", "test"):
            bits = 8 * ops[0].size
            a, b = self.load(ins, ops[0]), self.load(ins, ops[1])
            result = a & b if m in ("and", "test") else (a | b if m == "or" else a ^ b)
            self.flags_logic(result, bits)
            if m != "test":
                self.store(ins, ops[0], result)
        elif m in ("inc", "dec"):
            bits = 8 * ops[0].size
            cf = self.cf
            a = self.load(ins, ops[0])
            result = self.flags_add(a, 1, bits) if m == "inc" else self.flags_sub(a, 1, bits)
            self.cf = cf
            self.store(ins, ops[0], result)
        elif m == "neg":
            bits = 8 * ops[0].size
            self.store(ins, ops[0], self.flags_sub(0, self.load(ins, ops[0]), bits))
        elif m == "not":
            self.store(ins, ops[0], ~self.load(ins, ops[0]))
        elif m in ("shl", "shr", "sar", "sal"):
            bits = 8 * ops[0].size
            a = self.load(ins, ops[0])
            count = (self.load(ins, ops[1]) if len(ops) > 1 else 1) & (0x3F if bits == 64 else 0x1F)
            if m in ("shl", "sal"):
                result = a << count
            elif m == "shr":
                result = a >> count
            else:
                signed = a - (1 << bits) if a >> (bits - 1) else a
                result = signed >> count
            if count:
                self.flags_logic(result, bits)
            self.store(ins, ops[0], result)
        elif m == "imul":
            bits = 8 * ops[0].size
            if len(ops) == 3:
                a, b = self.load(ins, ops[1]), self.load(ins, ops[2])
            elif len(ops) == 2:
                a, b = self.load(ins, ops[0]), self.load(ins, ops[1])
            else:
                raise NotImplementedError(f"one-operand imul at {rip:#x}")
            self.store(ins, ops[0], (a * b) & ((1 << bits) - 1))
            self.cf = self.of = False
        elif m == "cdqe":
            eax = self.r[0] & 0xFFFFFFFF
            self.r[0] = (eax - (1 << 32) if eax >> 31 else eax) & MASK64
        elif m == "cdq":
            self.set(x86.X86_REG_EDX, 0xFFFFFFFF if self.r[0] & 0x80000000 else 0)
        elif m == "cqo":
            self.r[2] = MASK64 if self.r[0] >> 63 else 0
        elif m.startswith("cmov"):
            if self.condition(m[4:]):
                self.store(ins, ops[0], self.load(ins, ops[1]))
            elif ops[0].size == 4:
                self.store(ins, ops[0], self.load(ins, ops[0]))
        elif m.startswith("set"):
            self.store(ins, ops[0], int(self.condition(m[3:])))
        elif m == "jmp":
            target = self.load(ins, ops[0]) if ops[0].type != x86.X86_OP_IMM else ops[0].imm
            if target in self.names and self.intercept(self.names[target]):
                return self.pop()
            return target
        elif m.startswith("j"):
            return ops[0].imm if self.condition(m[1:]) else nxt
        elif m == "call":
            target = self.load(ins, ops[0]) if ops[0].type != x86.X86_OP_IMM else ops[0].imm
            self.push(nxt)
            if target in self.names and self.intercept(self.names[target]):
                return self.pop()
            return target
        elif m == "ret":
            return self.pop()
        elif m == "push":
            self.push(self.load(ins, ops[0]))
        elif m == "pop":
            self.store(ins, ops[0], self.pop())
        elif m in ("nop", "int3", "endbr64"):
            pass
        elif m in ("movaps", "movups", "movdqa", "movdqu"):
            self.vector_move(ins, ops)
        elif m in ("bt", "bts", "btr"):
            bits = 8 * ops[0].size
            value, bit = self.load(ins, ops[0]), self.load(ins, ops[1]) % bits
            self.cf = bool((value >> bit) & 1)
            if m == "bts":
                self.store(ins, ops[0], value | (1 << bit))
            elif m == "btr":
                self.store(ins, ops[0], value & ~(1 << bit))
        elif m == "xchg":
            a, b = self.load(ins, ops[0]), self.load(ins, ops[1])
            self.store(ins, ops[0], b)
            self.store(ins, ops[1], a)
        else:
            raise NotImplementedError(f"{m} {ins.op_str} at {rip:#x} ({self.image.name(rip)})")
        return nxt

    def vector_move(self, ins, ops):
        if not hasattr(self, "xmm"):
            self.xmm = {}
        src, dst = ops[1], ops[0]
        if src.type == x86.X86_OP_REG:
            data = self.xmm.get(src.reg, bytes(16))
        else:
            data = self.read(self.address(ins, src), 16)
        if dst.type == x86.X86_OP_REG:
            self.xmm[dst.reg] = data
        else:
            self.write(self.address(ins, dst), data)

    # --- the loader's helpers ------------------------------------------------

    def intercept(self, name):
        z = self.z
        rcx, rdx, r8 = self.r[1], self.r[2], self.r[8]
        if name == "Load_Stream":
            if rcx & 0xFF and r8:
                at = z.take(r8)
                if at is not None:
                    self.write(rdx, z.data[at : at + r8])
                else:
                    self.write(rdx, bytes(r8))
            self.r[0] = rdx
        elif name == "DB_PushStreamPos":
            z.push(rcx & 0xFFFFFFFF)
        elif name == "DB_PopStreamPos":
            z.pop()
        elif name == "DB_InsertPointer":
            self.r[0] = block_base(VIRTUAL) + z.insert_pointer()
        elif name == "Load_XStringCustom":
            target = self.u64(rcx)
            where = block_of(target)
            if where is None or where != (z.block, z.blocks[z.block]):
                raise RuntimeError(f"Load_XStringCustom at {target:#x}, stream at {z.block}:{z.blocks[z.block]:#x}")
            end = z.data.index(b"\0", z.pos)
            text = z.data[z.pos : end + 1]
            z.strings[where] = text[:-1].decode("latin-1")
            z.take(len(text))
            self.write(target, text)
        elif name in ("DB_ConvertOffsetToPointer", "DB_ConvertOffsetToAlias"):
            value = self.u64(rcx)
            block, offset = reference(value)
            if name == "DB_ConvertOffsetToPointer":
                self.put64(rcx, block_base(block) + offset)
            else:
                stored = self.u64(block_base(block) + offset)
                if not stored:
                    slot = z.slots.get(offset) if block == VIRTUAL else None
                    stored = self.fake(slot) if slot else 0
                self.put64(rcx, stored)
        elif name in ("memcpy", "memmove"):
            self.write(rcx, self.read(rdx, r8))
            self.r[0] = rcx
        elif name == "memset":
            self.write(rcx, bytes([rdx & 0xFF]) * r8)
            self.r[0] = rcx
        elif name == "R_Cinematic_EndLostDevice" or name.endswith("Asset") and name.startswith("Load_"):
            # Load_<T>Asset(XAssetHeader*), folded into one symbol in this build: the header is
            # registered, which copies it out of TEMP, and the handle then points at the copy.
            header = self.u64(rcx)
            where = block_of(header)
            if where is not None and where[0] == 0:
                self.put64(rcx, self.register(header))
            self.r[0] = 0
        elif name in STUBS:
            self.r[0] = 0
        elif self.python_handle(name):
            pass
        else:
            return False
        return True

    def block_address(self, block, offset):
        return block_base(block) + offset

    def register(self, header):
        """A stable copy of a header loaded in TEMP."""
        copy = self.arena
        self.arena += HEADER_COPY
        self.write(copy, self.read(header, HEADER_COPY))
        return copy

    def foreign_asset(self, address):
        """(type, name) of the Python-walked asset `fake` stood `address` in for, or None."""
        return self.foreign_results.get(address)

    def fake(self, result):
        """A stand-in address for an asset the Python walkers loaded."""
        if result not in self.foreign:
            self.foreign[result] = FOREIGN + 0x1000 * (len(self.foreign) + 1)
            self.foreign_results[self.foreign[result]] = result
        return self.foreign[result]

    def python_handle(self, name):
        """Load_<T>Handle/Ptr[Array] for a T the Python walkers own."""
        m = re.match(r"Load_(\w+?)(Handle|Ptr|_ptr)(Array)?$", name)
        if not m:
            return False
        struct_name = m.group(1)
        entry = self.python_handles.get(struct_name) or self.python_handles.get(struct_name + "_t")
        if entry is None:
            return False
        typename, walker = entry
        var = self.by_name.get("var" + name[len("Load_") :].removesuffix("Array"))
        if var is None:
            raise RuntimeError(f"{name}: no var global")
        z = self.z
        at_start = self.r[1] & 0xFF
        count = self.r[2] if m.group(3) else 1
        base = self.u64(var)
        if at_start:
            self.intercept_stream(base, 8 * count)
        for i in range(count):
            address = base + 8 * i
            value = self.u64(address)
            storage = block_of(address)
            if follows(value) or value:
                result = z.handle(value, walker, typename, storage)
                self.put64(address, self.fake(result) if result else 0)
        return True

    def intercept_stream(self, address, size):
        at = self.z.take(size)
        self.write(address, self.z.data[at : at + size] if at is not None else bytes(size))
