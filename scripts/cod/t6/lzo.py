"""LZO1X decompression in plain Python, for Black Ops II's `.ipak` image packs.

A port of `lzo1x_decompress_safe` (minilzo's lzo1x_d.ch, which OAT links): a stream
is literal runs and back-references, and ends with the M4 marker `0x11 0x00 0x00`.
Every read and copy is bounds-checked, and `decompress` refuses a stream that does
not end exactly at its marker, overruns `limit`, or reaches before its output.

Instructions, by the first byte `t` (after a literal run the meaning of t < 16 changes):

- t >= 64  M2: copy `(t >> 5) + 1` bytes from 1 + ((t >> 2) & 7) + (next << 3) back;
- t >= 32  M3: length `t & 31` (+ zero-run extension) + 2, 14-bit distance + 1 from the next two bytes;
- t >= 16  M4: length `t & 7` (+ extension) + 2, distance 0x4000 + (t & 8) << 11 + the next two bytes' 14 bits;
  a distance of exactly 0x4000 is the end marker;
- t < 16   after a match, M1: 2 bytes from 1 + (t >> 2) + (next << 2) back; straight after a
  literal run, 3 bytes from 0x801 + (t >> 2) + (next << 2) back; otherwise a literal run of
  t + 3 bytes (t = 0 extends by zero bytes, 255 each, then 15 + the next byte).

The two low bits of the byte before a match's last one say how many literals (0-3)
follow it before the next instruction.
"""


class LzoError(ValueError):
    pass


def _extend(src, ip, base):
    """A zero-run length extension at `ip`: base + 255 per zero byte + the next one; and the new ip."""
    n = 0
    while src[ip] == 0:
        n += 255
        ip += 1
    return n + base + src[ip], ip + 1


def decompress(data, limit=1 << 20):
    """The bytes an LZO1X stream decompresses to, at most `limit` of them.

    One flat loop over local variables: this runs once per 32 KB of every streamed
    texture. Reading past the input raises IndexError, which is reported as an overrun."""
    src = bytes(data)
    end = len(src)
    out = bytearray()
    try:
        return _run(src, end, out, limit)
    except IndexError:
        raise LzoError("input overrun") from None


def _copy(out, distance, n, limit):
    start = len(out) - distance
    if start < 0:
        raise LzoError("a match reaches before the output")
    if len(out) + n > limit:
        raise LzoError("output overrun")
    if distance >= n:
        out += out[start : start + n]
    else:  # overlapping: the pattern repeats
        pattern = out[start:]
        out += (pattern * (n // distance + 1))[:n]


def _run(src, end, out, limit):
    ip = 0
    # "start": read an instruction that may begin a literal run; "after": one straight after a run.
    state = "start"
    t = 0
    if src[0] > 17:
        t = src[0] - 17
        ip = 1
        if ip + t > end:
            raise IndexError
        out += src[ip : ip + t]
        ip += t
        if t < 4:
            t = src[ip]
            ip += 1
            state = "match"
        else:
            state = "after"
    while True:
        if state == "start":
            t = src[ip]
            ip += 1
            if t < 16:
                if t == 0:
                    t, ip = _extend(src, ip, 15)
                t += 3
                if ip + t > end:
                    raise IndexError
                if len(out) + t > limit:
                    raise LzoError("output overrun")
                out += src[ip : ip + t]
                ip += t
                state = "after"
        if state == "after":
            t = src[ip]
            ip += 1
            if t < 16:
                _copy(out, 1 + 0x800 + (t >> 2) + (src[ip] << 2), 3, limit)
                ip += 1
                trail = src[ip - 2] & 3
                if trail == 0:
                    state = "start"
                    continue
                if ip + trail > end:
                    raise IndexError
                out += src[ip : ip + trail]
                ip += trail
                t = src[ip]
                ip += 1
        # A match instruction `t`.
        if t >= 64:
            _copy(out, 1 + ((t >> 2) & 7) + (src[ip] << 3), (t >> 5) + 1, limit)
            ip += 1
        elif t >= 32:
            length = t & 31
            if length == 0:
                length, ip = _extend(src, ip, 31)
            _copy(out, 1 + ((src[ip] | src[ip + 1] << 8) >> 2), length + 2, limit)
            ip += 2
        elif t >= 16:
            length = t & 7
            if length == 0:
                length, ip = _extend(src, ip, 7)
            distance = ((t & 8) << 11) + ((src[ip] | src[ip + 1] << 8) >> 2)
            ip += 2
            if distance == 0:
                if ip != end:
                    raise LzoError(f"the end marker is {end - ip} bytes before the end of the input")
                return bytes(out)
            _copy(out, distance + 0x4000, length + 2, limit)
        else:
            _copy(out, 1 + (t >> 2) + (src[ip] << 2), 2, limit)
            ip += 1
        trail = src[ip - 2] & 3
        if trail == 0:
            state = "start"
            continue
        if ip + trail > end:
            raise IndexError
        out += src[ip : ip + trail]
        ip += trail
        t = src[ip]
        ip += 1
        state = "match"
