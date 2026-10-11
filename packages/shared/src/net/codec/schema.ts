// The field types a message is described with, and the combinators that build a
// message out of them.
//
// A codec is one `{ write, read }` pair, so a message is described exactly once
// and both directions are derived from that description. Encode and decode
// cannot disagree about field order, because there is only one order; adding a
// field to a schema adds it to both halves at once. `Infer<>` then reads the
// value type back out, so a schema that has drifted from the interface it is
// meant to carry is a typecheck failure rather than a wrong number on the wire.
//
// Several of these are lossy on purpose. See net/packet.ts for the rule that
// makes that safe in a predict-and-replay loop; the short version is that every
// lossy codec exposes `round`, and a sender simulates with the rounded value.

import type { BitReader, BitWriter } from "./bits.js";

export interface Codec<T> {
  write(w: BitWriter, value: T): void;
  read(r: BitReader): T;
  /**
   * The value this codec would decode back from `value`, without touching a
   * buffer. Present only on lossy codecs; a sender puts its own state through
   * this before simulating with it, so both ends step identical numbers.
   */
  round?(value: T): T;
}

/** The value type a codec carries. */
type Infer<C> = C extends Codec<infer T> ? T : never;

// -- Numbers -----------------------------------------------------------------------

/** An unsigned integer in `bits` bits. Out-of-range values are a caller bug, not a wire concern, so they throw. */
export function uint(bits: number): Codec<number> {
  const max = 2 ** bits - 1;
  return {
    write(w, value) {
      if (!Number.isInteger(value) || value < 0 || value > max) {
        throw new RangeError(`uint(${bits}) cannot carry ${value}`);
      }
      w.bits(value, bits);
    },
    read(r) {
      return r.bits(bits);
    },
  };
}

/** A signed integer in `bits` bits, two's complement. */
export function int(bits: number): Codec<number> {
  const min = -(2 ** (bits - 1));
  const max = 2 ** (bits - 1) - 1;
  return {
    write(w, value) {
      if (!Number.isInteger(value) || value < min || value > max) {
        throw new RangeError(`int(${bits}) cannot carry ${value}`);
      }
      w.bits(value < 0 ? value + 2 ** bits : value, bits);
    },
    read(r) {
      const raw = r.bits(bits);
      return raw > max ? raw - 2 ** bits : raw;
    },
  };
}

export const bool: Codec<boolean> = {
  write(w, value) {
    w.bool(value);
  },
  read(r) {
    return r.bool();
  },
};

/**
 * A full 32-bit float: no range to declare, ~7 significant digits. Lossy against
 * the f64 the simulation runs in, hence `round`.
 *
 * Non-finite values are refused. The simulation's state is documented as having
 * no Infinity in it (sim/movementState.ts), and a NaN position that survived onto the
 * wire would spread silently through every client that decoded it.
 */
export const f32: Codec<number> = {
  write(w, value) {
    if (!Number.isFinite(value)) {
      throw new RangeError(`f32 cannot carry ${value}`);
    }
    w.f32(value);
  },
  read(r) {
    return r.f32();
  },
  round(value) {
    return Math.fround(value);
  },
};

/**
 * A number known to live in [min, max], as `bits` evenly spaced steps. The step
 * is `(max - min) / (2**bits - 1)`, so both ends of the range are exactly
 * representable. Values outside the range clamp: the range is a claim about the
 * quantity, and a client's claim about its own state is not to be trusted.
 *
 * **Not for a range with a meaningful midpoint.** `2**bits - 1` is odd at every
 * width, so a symmetric range has no step on its centre and zero encodes to half
 * a step off — at *any* width, which makes it look like a precision problem it
 * is not. `signed` is that case.
 */
export function quant(min: number, max: number, bits: number): Codec<number> {
  const steps = 2 ** bits - 1;
  const scale = steps / (max - min);
  const encode = (value: number): number => {
    if (!Number.isFinite(value)) {
      throw new RangeError(`quant(${min}, ${max}) cannot carry ${value}`);
    }
    return Math.round((Math.min(max, Math.max(min, value)) - min) * scale);
  };
  const decode = (raw: number): number => min + raw / scale;
  return {
    write(w, value) {
      w.bits(encode(value), bits);
    },
    read(r) {
      return decode(r.bits(bits));
    },
    round(value) {
      return decode(encode(value));
    },
  };
}

/**
 * A fraction in [-1, 1], as `bits` bits counted out from an exact zero.
 *
 * The signed counterpart to `quant`, and the reason it exists: `quant(-1, 1, n)`
 * cannot represent zero, so a stick at rest encodes as a lean. This counts
 * `2**(bits-1) - 1` steps either side instead, which makes 0 and both ends exact
 * and spends the one code two's complement has left over — decoded as -1, since
 * a packet off the network may still carry it.
 */
export function signed(bits: number): Codec<number> {
  const steps = 2 ** (bits - 1) - 1;
  const raw = int(bits);
  const encode = (value: number): number => {
    if (!Number.isFinite(value)) {
      throw new RangeError(`signed(${bits}) cannot carry ${value}`);
    }
    const held = Math.min(1, Math.max(-1, value));
    // Rounded on the magnitude, so a tie breaks away from zero on both sides:
    // Math.round sends -0.5 up, which is the same one-sided lean in miniature.
    const count = Math.round(Math.abs(held) * steps);
    return held < 0 ? -count : count;
  };
  const decode = (code: number): number => Math.max(-1, code / steps);
  return {
    write(w, value) {
      raw.write(w, encode(value));
    },
    read(r) {
      return decode(raw.read(r));
    },
    round(value) {
      return decode(encode(value));
    },
  };
}

/**
 * A signed quantity in ±`limit`, built on `signed` rather than on
 * `quant(-limit, limit, bits)` for the reason `signed` exists: a symmetric
 * `quant` cannot represent zero, and "at rest" is the overwhelmingly common
 * value of anything that is signed.
 */
export function scaled(limit: number, bits: number): Codec<number> {
  const inner = signed(bits);
  return {
    write: (w, value) => inner.write(w, value / limit),
    read: (r) => inner.read(r) * limit,
    round: (value) => inner.round!(value / limit) * limit,
  };
}

const TAU = Math.PI * 2;

/** A rotation on the wire: four numbers, one of which is never sent. */
export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

/**
 * A unit quaternion in 32 bits, smallest-three.
 *
 * A rotation has three degrees of freedom and four components, and the fourth is
 * recoverable: drop the largest one, name which it was in two bits, and send the
 * other three. Negating a quaternion names the same rotation, so the dropped one
 * can always be taken as positive and reconstructed as `sqrt(1 - x² - y² - z²)` —
 * and `sqrt` is the one function IEEE-754 requires to be correctly rounded, which
 * is why this is safe to hand to a physics engine when `Math.sin` would not be.
 *
 * The three that are sent are each at most `1/sqrt(2)`, since no other component
 * can exceed the largest. So the range is that rather than 1, which buys half a
 * bit of precision for nothing: ten bits over ±0.7071 is a step of 0.0014, or
 * about 0.16° of rotation — a millimetre and a half at the end of a forearm.
 *
 * 2 + 10 + 10 + 10 = 32 bits.
 */
export const quat: Codec<Quat> = (() => {
  const BITS = 10;
  const LIMIT = Math.SQRT1_2;
  const steps = 2 ** BITS - 1;
  const scale = steps / (2 * LIMIT);
  const put = (value: number): number => Math.round((Math.min(LIMIT, Math.max(-LIMIT, value)) + LIMIT) * scale);
  const get = (raw: number): number => raw / scale - LIMIT;

  const encode = (q: Quat): { largest: number; rest: [number, number, number] } => {
    const parts = [q.x, q.y, q.z, q.w];
    let largest = 0;
    for (let i = 1; i < 4; i++) {
      if (Math.abs(parts[i]!) > Math.abs(parts[largest]!)) {
        largest = i;
      }
    }
    // The same rotation, with the dropped component positive, so its sign need
    // never be sent.
    const flip = parts[largest]! < 0 ? -1 : 1;
    const rest: number[] = [];
    for (let i = 0; i < 4; i++) {
      if (i !== largest) {
        rest.push(put(parts[i]! * flip));
      }
    }
    return { largest, rest: rest as [number, number, number] };
  };

  const decode = (largest: number, rest: readonly number[]): Quat => {
    const out = [0, 0, 0, 0];
    let sum = 0;
    let at = 0;
    for (let i = 0; i < 4; i++) {
      if (i !== largest) {
        const value = get(rest[at++]!);
        out[i] = value;
        sum += value * value;
      }
    }
    out[largest] = Math.sqrt(Math.max(0, 1 - sum));
    return { x: out[0]!, y: out[1]!, z: out[2]!, w: out[3]! };
  };

  return {
    write(w, value) {
      const { largest, rest } = encode(value);
      w.bits(largest, 2);
      for (const part of rest) {
        w.bits(part, BITS);
      }
    },
    read(r) {
      const largest = r.bits(2);
      return decode(largest, [r.bits(BITS), r.bits(BITS), r.bits(BITS)]);
    },
    round(value) {
      const { largest, rest } = encode(value);
      return decode(largest, rest);
    },
  };
})();

/**
 * An angle in radians, as `bits` steps around the whole circle, decoded into
 * [-π, π). Unlike `quant` this wraps rather than clamps, and it must: the
 * simulation never normalizes `yaw` (only `pitch` is clamped, by clampPitch), so
 * a player who keeps turning right arrives here with an ever-growing number.
 *
 * The circle is divided into 2**bits steps rather than 2**bits - 1, so that the
 * two ends meet: +π and -π encode to the same step instead of to neighbours.
 */
export function angle(bits: number): Codec<number> {
  const steps = 2 ** bits;
  const encode = (value: number): number => {
    if (!Number.isFinite(value)) {
      throw new RangeError(`angle cannot carry ${value}`);
    }
    const turns = value / TAU;
    return Math.round((turns - Math.floor(turns)) * steps) % steps;
  };
  const decode = (raw: number): number => {
    const a = (raw / steps) * TAU;
    return a >= Math.PI ? a - TAU : a;
  };
  return {
    write(w, value) {
      w.bits(encode(value), bits);
    },
    read(r) {
      return decode(r.bits(bits));
    },
    round(value) {
      return decode(encode(value));
    },
  };
}

// -- Enumerations ------------------------------------------------------------------

/** One of a fixed list of strings, as its index. An unknown value throws; an unknown index is a truncated or hostile packet and throws too. */
export function enumOf<const T extends readonly string[]>(values: T): Codec<T[number]> {
  const bits = Math.max(1, Math.ceil(Math.log2(values.length)));
  const index = new Map<string, number>(values.map((v, i) => [v, i]));
  return {
    write(w, value) {
      const i = index.get(value);
      if (i === undefined) {
        throw new RangeError(`not one of the ${values.length} known values: ${value}`);
      }
      w.bits(i, bits);
    },
    read(r) {
      const i = r.bits(bits);
      const value = values[i];
      if (value === undefined) {
        throw new RangeError(`enum index ${i} out of range`);
      }
      return value;
    },
  };
}

// -- Text --------------------------------------------------------------------------

const utf8Encode = new TextEncoder();
// `fatal` so invalid bytes throw rather than becoming U+FFFD: a decoded string
// that is quietly wrong is worse than a dropped packet.
const utf8Decode = new TextDecoder("utf-8", { fatal: true });

/** A UTF-8 string, prefixed with its length in *bytes* (not characters) in `lenBits`. */
export function str(lenBits = 16): Codec<string> {
  const max = 2 ** lenBits - 1;
  return {
    write(w, value) {
      const bytes = utf8Encode.encode(value);
      if (bytes.length > max) {
        throw new RangeError(`string of ${bytes.length} bytes exceeds the ${max}-byte field`);
      }
      w.bits(bytes.length, lenBits);
      w.bytes(bytes);
    },
    read(r) {
      const length = r.bits(lenBits);
      return length === 0 ? "" : utf8Decode.decode(r.bytes(length));
    },
  };
}

// -- Combinators -------------------------------------------------------------------

/** `null` in one bit, and the payload only when there is one. */
export function nullable<T>(inner: Codec<T>): Codec<T | null> {
  return {
    write(w, value) {
      w.bool(value !== null);
      if (value !== null) {
        inner.write(w, value);
      }
    },
    read(r) {
      return r.bool() ? inner.read(r) : null;
    },
    round(value) {
      return value === null ? null : (inner.round?.(value) ?? value);
    },
  };
}

/** A list, prefixed with its length in `lenBits`. */
export function array<T>(inner: Codec<T>, lenBits = 8): Codec<T[]> {
  const max = 2 ** lenBits - 1;
  return {
    write(w, value) {
      if (value.length > max) {
        throw new RangeError(`array of ${value.length} exceeds the ${max}-item field`);
      }
      w.bits(value.length, lenBits);
      for (const item of value) {
        inner.write(w, item);
      }
    },
    read(r) {
      const length = r.bits(lenBits);
      const out: T[] = [];
      for (let i = 0; i < length; i++) {
        out.push(inner.read(r));
      }
      return out;
    },
    round(value) {
      return inner.round ? value.map((item) => inner.round!(item)) : value;
    },
  };
}

// `Codec<unknown>` is a usable constraint only because `write` is declared with
// method shorthand, which TypeScript checks bivariantly; a `write: (…) => void`
// property would make Codec invariant and nothing would satisfy this.
type Fields = Record<string, Codec<unknown>>;
type Struct<S extends Fields> = { [K in keyof S]: Infer<S[K]> };

/**
 * An object, written field by field in declaration order. That order is the
 * whole format — there are no keys on the wire — so reordering the properties of
 * a schema is a breaking protocol change even though nothing about the type
 * changes. PROTOCOL_VERSION exists for exactly that.
 */
export function struct<S extends Fields>(fields: S): Codec<Struct<S>> {
  // Captured once: the object's key order is fixed at definition, and walking it
  // per packet would allocate on the hot path.
  const entries = Object.entries(fields) as [keyof S & string, Codec<unknown>][];
  return {
    write(w, value) {
      for (const [key, codec] of entries) {
        codec.write(w, value[key]);
      }
    },
    read(r) {
      const out = {} as Struct<S>;
      for (const [key, codec] of entries) {
        out[key] = codec.read(r) as Struct<S>[typeof key];
      }
      return out;
    },
    round(value) {
      const out = {} as Struct<S>;
      for (const [key, codec] of entries) {
        out[key] = (codec.round ? codec.round(value[key]) : value[key]) as Struct<S>[typeof key];
      }
      return out;
    },
  };
}

type Variants = Record<string, Fields>;
type Union<K extends string, V extends Variants> = { [N in keyof V]: { [T in K]: N } & Struct<V[N]> }[keyof V];

/**
 * One of several structs, told apart by the string in its `tag` field: the
 * variant's index in as few bits as hold them all, then that variant's fields.
 * The variants' declaration order is the format, as a struct's field order is.
 */
export function union<const K extends string, V extends Variants>(tag: K, variants: V): Codec<Union<K, V>> {
  const names = Object.keys(variants);
  const bits = Math.max(1, Math.ceil(Math.log2(names.length)));
  const index = new Map(names.map((name, i) => [name, i]));
  const bodies = names.map((name) => struct(variants[name]!) as Codec<Record<string, unknown>>);
  type Value = Union<K, V> & Record<string, unknown>;
  const which = (value: Value): number => {
    const i = index.get(value[tag] as string);
    if (i === undefined) {
      throw new RangeError(`not one of the ${names.length} known variants: ${String(value[tag])}`);
    }
    return i;
  };
  return {
    write(w, value) {
      const i = which(value as Value);
      w.bits(i, bits);
      bodies[i]!.write(w, value as Value);
    },
    read(r) {
      const i = r.bits(bits);
      const body = bodies[i];
      if (body === undefined) {
        throw new RangeError(`union index ${i} out of range`);
      }
      return { ...body.read(r), [tag]: names[i] } as Union<K, V>;
    },
    round(value) {
      const i = which(value as Value);
      return { ...bodies[i]!.round!(value as Value), [tag]: names[i] } as Union<K, V>;
    },
  };
}

/** Put a value through its codec's lossy rounding, if it has any. The identity for an exact codec. */
export function roundTrip<T>(codec: Codec<T>, value: T): T {
  return codec.round ? codec.round(value) : value;
}
