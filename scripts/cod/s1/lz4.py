"""LZ4 block format, decode only, in plain Python.

The payload of an Advanced Warfare fastfile is a run of these. No frame header,
no checksums: a block is a bare sequence of (token, literals, offset, match),
and it ends when the input does. `end` is therefore required and not a hint --
the last sequence is literals with no match, and only the input length says so.
"""


def decompress(src, start=0, end=None):
    """Decode one LZ4 block from src[start:end]. Returns the bytes."""
    if end is None:
        end = len(src)
    out = bytearray()
    i = start
    while i < end:
        token = src[i]
        i += 1

        length = token >> 4
        if length == 15:  # 0xf means "keep adding until a byte below 255"
            while True:
                if i >= end:
                    raise ValueError("end of input in a literal length")
                b = src[i]
                i += 1
                length += b
                if b != 255:
                    break
        if i + length > end:
            raise ValueError("end of input in literals")
        out += src[i : i + length]
        i += length

        if i == end:
            break  # the last sequence is literals only
        if i + 2 > end:
            raise ValueError("end of input in a match offset")
        offset = src[i] | (src[i + 1] << 8)
        i += 2
        if offset == 0 or offset > len(out):
            raise ValueError(f"match offset {offset} at input 0x{i:x}, output {len(out)}")

        length = token & 15
        if length == 15:
            while True:
                if i >= end:
                    raise ValueError("end of input in a match length")
                b = src[i]
                i += 1
                length += b
                if b != 255:
                    break
        length += 4  # a match is never shorter than this, so 0 encodes 4

        # Overlapping matches are the point of LZ4's run encoding: a match at
        # offset 1 fills; copying the slice wholesale would be wrong.
        p = len(out) - offset
        for _ in range(length):
            out.append(out[p])
            p += 1
    return bytes(out)
