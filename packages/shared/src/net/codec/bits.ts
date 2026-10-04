// A bit-level writer and reader, the floor the wire format is built on.
//
// Bit-level rather than byte-level because most fields are much smaller than a
// byte: a boolean is one bit, a WeaponState is four, a ClipRole is five. Packing
// them costs a shift and pays for itself immediately — one PlayerInput's five
// booleans share a single byte instead of taking five.
//
// Fields are written most-significant bit first, filling each byte from its high
// bit down. That is the convention that makes a byte-aligned 8- or 32-bit field
// come out identical to writing the plain byte, so a hex dump of a packet stays
// readable next to the schema that produced it.

/** No field is wider than this; 32 is what JavaScript's bitwise operators work in. */
const MAX_BITS = 32;

function mask(bits: number): number {
  // 1 << 32 is 1, not 0, so the full-width case cannot use the shift.
  return bits === 32 ? 0xffffffff : (1 << bits) - 1;
}

export class BitWriter {
  private buf: Uint8Array;
  /** Bits written so far, not bytes: the write cursor. */
  private bit = 0;
  /** 4 bytes of scratch for float conversion, so no allocation happens per field. */
  private readonly scratch = new DataView(new ArrayBuffer(4));

  constructor(initialBytes = 64) {
    this.buf = new Uint8Array(initialBytes);
  }

  /** Bytes the packet will occupy once finished. */
  get byteLength(): number {
    return (this.bit + 7) >> 3;
  }

  /** Write the low `bits` bits of `value`. The value is treated as unsigned; signedness is the caller's schema. */
  bits(value: number, bits: number): void {
    if (bits < 1 || bits > MAX_BITS) {
      throw new RangeError(`bit width ${bits} out of range 1..${MAX_BITS}`);
    }
    this.grow(bits);
    let left = bits;
    const v = (value >>> 0) & mask(bits);
    while (left > 0) {
      const byte = this.bit >> 3;
      const free = 8 - (this.bit & 7);
      const take = Math.min(free, left);
      // The top `take` bits of what is left, landed at the top of the free space.
      const chunk = (v >>> (left - take)) & mask(take);
      // The buffer is zero-filled and only ever grows, so OR never has to clear.
      this.buf[byte] = this.buf[byte]! | (chunk << (free - take));
      this.bit += take;
      left -= take;
    }
  }

  bool(value: boolean): void {
    this.bits(value ? 1 : 0, 1);
  }

  /** 32 bits of IEEE-754. Big-endian, to match the MSB-first field order. */
  f32(value: number): void {
    this.scratch.setFloat32(0, value, false);
    for (let i = 0; i < 4; i++) {
      this.bits(this.scratch.getUint8(i), 8);
    }
  }

  bytes(value: Uint8Array): void {
    for (const byte of value) {
      this.bits(byte, 8);
    }
  }

  /** The packet, byte-aligned. Any bits left over in the last byte are zero. */
  finish(): Uint8Array {
    // slice, not subarray: the caller owns the result, and this writer's buffer
    // is still growable behind it.
    return this.buf.slice(0, this.byteLength);
  }

  private grow(bits: number): void {
    const needed = (this.bit + bits + 7) >> 3;
    if (needed <= this.buf.length) {
      return;
    }
    let size = Math.max(this.buf.length * 2, 8);
    while (size < needed) {
      size *= 2;
    }
    const next = new Uint8Array(size);
    next.set(this.buf);
    this.buf = next;
  }
}

/**
 * Reads back what BitWriter wrote. Every read is bounds-checked and throws past
 * the end rather than returning zeroes: a packet off the network is attacker-
 * shaped input, and a truncated one must fail loudly at the codec instead of
 * decoding into a plausible-looking player state. Callers catch and drop.
 */
export class BitReader {
  private bit = 0;
  private readonly end: number;
  private readonly scratch = new DataView(new ArrayBuffer(4));

  constructor(private readonly buf: Uint8Array) {
    this.end = buf.length * 8;
  }

  /** Bits not yet consumed. A well-formed packet ends with fewer than 8 (the writer's padding). */
  get remaining(): number {
    return this.end - this.bit;
  }

  bits(bits: number): number {
    if (bits < 1 || bits > MAX_BITS) {
      throw new RangeError(`bit width ${bits} out of range 1..${MAX_BITS}`);
    }
    if (this.bit + bits > this.end) {
      throw new RangeError(`packet truncated: ${bits} bits wanted, ${this.remaining} left`);
    }
    let left = bits;
    let out = 0;
    while (left > 0) {
      const byte = this.bit >> 3;
      const free = 8 - (this.bit & 7);
      const take = Math.min(free, left);
      const chunk = (this.buf[byte]! >>> (free - take)) & mask(take);
      // Multiply rather than shift: `out << take` would overflow into the sign
      // bit for a 32-bit field, and these values are unsigned.
      out = out * 2 ** take + chunk;
      this.bit += take;
      left -= take;
    }
    return out;
  }

  bool(): boolean {
    return this.bits(1) === 1;
  }

  f32(): number {
    for (let i = 0; i < 4; i++) {
      this.scratch.setUint8(i, this.bits(8));
    }
    return this.scratch.getFloat32(0, false);
  }

  bytes(count: number): Uint8Array {
    const out = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
      out[i] = this.bits(8);
    }
    return out;
  }
}
