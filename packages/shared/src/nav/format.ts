// `nav.bin` → plain typed arrays. The byte layout, and the reasons for it, are
// docs/engine/nav-format.md; this file is its reader and does nothing else — no
// snapping, no derived links, no costs. Those are computed at load against the
// collision the file deliberately knows nothing about.
//
// Every field is copied out through one DataView into a structure of arrays. A
// fetched Uint8Array can start at any byte offset of its buffer, so viewing the
// file's f32s in place would throw on a misaligned one; copying costs a few
// hundred kilobytes once per world and removes the question.
//
// The reader refuses rather than guesses: anything it cannot fully account for
// is a NavFormatError naming why, and a file it accepts has every index in range.

import { HEADER_FLAGS, SECTION_FLAGS } from "./vocab.js";

/** Why a file was refused. One reason per check, so a test can name the check it meant to trip. */
export type NavFormatReason =
  | "truncated" // shorter than its header, or than its header says
  | "magic"
  | "version" // a major version this reader does not know
  | "flags" // a must-understand header bit this reader does not know
  | "length" // bytes beyond the length the header states
  | "checksum"
  | "table" // the section table itself is out of bounds or malformed
  | "bounds" // a section lies outside the file, misaligned, or over another
  | "required" // a REQUIRED section this reader does not know, at this version
  | "missing" // no NODE section, or a string index with no STRS
  | "malformed"; // a known section whose contents do not add up

export class NavFormatError extends Error {
  constructor(
    readonly reason: NavFormatReason,
    message: string,
  ) {
    super(`nav.bin: ${message}`);
    this.name = "NavFormatError";
  }
}

export const NAV_MAGIC = "3DNV";
export const NAV_MAJOR = 1;

const HEADER_SIZE = 32;
const TABLE_ENTRY_SIZE = 16;
const ALIGN = 8;
/** The smallest record each v1 section may declare; a larger stride is a later minor's tail, skipped. */
const NODE_STRIDE = 32;
const LINK_STRIDE = 12;
const TRAV_STRIDE = 16;
/** The header bits this reader understands in the must-understand half. */
const KNOWN_MUST_UNDERSTAND = HEADER_FLAGS.DERIVE_WALK_LINKS;
const MUST_UNDERSTAND_MASK = 0xffff0000;
/** The sections this reader knows, at the one version of each it knows. */
const KNOWN_SECTIONS: Readonly<Record<string, number>> = { NODE: 1, LINK: 1, TRAV: 1, STRS: 1, META: 1 };

/** "None" in a u32 or u16 index field. */
export const NO_INDEX_32 = 0xffffffff;
export const NO_INDEX_16 = 0xffff;

/** One place per index. `position` is x, y, z per node, engine metres, Y up. */
export interface NavNodes {
  readonly count: number;
  readonly position: Float32Array;
  /** A fraction of a full turn, 65536 to the turn; see `yawRadians`. Meaningful only with HAS_YAW. */
  readonly yaw: Uint16Array;
  readonly type: Uint8Array;
  readonly flags: Uint8Array;
  readonly abilities: Uint32Array;
  /** The node's index in the data it came from, or NO_INDEX_32. */
  readonly source: Uint32Array;
  /** Index into `strings`; 0 is "". */
  readonly name: Uint32Array;
  /** Dynamic group, or NO_INDEX_16. */
  readonly group: Uint16Array;
  readonly stance: Uint8Array;
}

/** Directed links, grouped by node: node i's are `first[i]` up to `first[i + 1]`. */
export interface NavLinks {
  readonly count: number;
  readonly first: Uint32Array;
  readonly target: Uint32Array;
  /** The source's own number: a cost, never a distance. NaN = the source gave none. */
  readonly gameCost: Float32Array;
  readonly kind: Uint8Array;
  readonly flags: Uint8Array;
  /** Index into the traversals, or NO_INDEX_16. */
  readonly traversal: Uint16Array;
}

export interface NavTraversals {
  readonly count: number;
  readonly begin: Uint32Array;
  readonly end: Uint32Array;
  readonly kind: Uint8Array;
  /** Index into `strings`. */
  readonly animscript: Uint32Array;
}

export interface NavSection {
  readonly tag: string;
  readonly version: number;
  readonly flags: number;
  readonly offset: number;
  readonly length: number;
  /** False for a section this reader does not know and was allowed to skip. */
  readonly read: boolean;
}

export interface NavFile {
  readonly major: number;
  readonly minor: number;
  readonly flags: number;
  readonly nodes: NavNodes;
  /** Empty (every `first` 0) when the file has no LINK section. */
  readonly links: NavLinks;
  readonly traversals: NavTraversals;
  /** Index 0 is always "". */
  readonly strings: readonly string[];
  /** The META section's object: for a human reading a file, never for behaviour. */
  readonly meta: Readonly<Record<string, unknown>> | null;
  /** The section table in file order, the skipped ones included. */
  readonly sections: readonly NavSection[];
}

/** A stored yaw in radians, about +Y, facing (-sin yaw, 0, -cos yaw) as the player does. */
export function yawRadians(yaw16: number): number {
  return (yaw16 / 65536) * 2 * Math.PI;
}

/** Read a whole `nav.bin`. Throws NavFormatError for anything it cannot fully account for. */
export function decodeNav(bytes: Uint8Array): NavFile {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size = bytes.byteLength;

  if (size < HEADER_SIZE) {
    throw new NavFormatError("truncated", `${size} bytes is shorter than the ${HEADER_SIZE}-byte header`);
  }
  const magic = ascii(bytes, 0);
  if (magic !== NAV_MAGIC) {
    throw new NavFormatError("magic", `starts ${JSON.stringify(magic)}, not ${NAV_MAGIC}`);
  }
  const major = view.getUint16(4, true);
  const minor = view.getUint16(6, true);
  if (major !== NAV_MAJOR) {
    throw new NavFormatError("version", `major version ${major}; this reader knows ${NAV_MAJOR}`);
  }
  const flags = view.getUint32(8, true);
  const unknown = (flags & MUST_UNDERSTAND_MASK & ~KNOWN_MUST_UNDERSTAND) >>> 0;
  if (unknown !== 0) {
    throw new NavFormatError("flags", `must-understand header bits 0x${unknown.toString(16)} are unknown to this reader`);
  }
  const length = view.getUint32(12, true);
  if (length > size) {
    throw new NavFormatError("truncated", `${size} bytes, but the header says ${length}`);
  }
  if (length < size) {
    throw new NavFormatError("length", `${size} bytes, but the header says ${length}`);
  }
  const crc = view.getUint32(24, true);
  if (crc !== 0) {
    const actual = crc32(bytes.subarray(HEADER_SIZE, length));
    if (actual !== crc) {
      throw new NavFormatError("checksum", `CRC-32 is 0x${actual.toString(16)}, the header says 0x${crc.toString(16)}`);
    }
  }

  const sections = readTable(view, size);
  const find = (tag: string) => sections.find((s) => s.tag === tag && s.read);

  const strs = find("STRS");
  const strings = strs ? readStrings(bytes, view, strs) : [""];
  const node = find("NODE");
  if (!node) {
    throw new NavFormatError("missing", "no NODE section");
  }
  const nodes = readNodes(view, node, strings.length);
  const trav = find("TRAV");
  const traversals = trav ? readTraversals(view, trav, nodes.count, strings.length) : emptyTraversals();
  const link = find("LINK");
  const links = link ? readLinks(view, link, nodes.count, traversals.count) : emptyLinks(nodes.count);
  const metaSection = find("META");
  const meta = metaSection ? readMeta(bytes, metaSection) : null;

  return { major, minor, flags, nodes, links, traversals, strings, meta, sections };
}

// -- The section table -----------------------------------------------------------

function readTable(view: DataView, size: number): NavSection[] {
  const count = view.getUint32(16, true);
  const offset = view.getUint32(20, true);
  if (offset < HEADER_SIZE || offset % ALIGN !== 0 || offset + count * TABLE_ENTRY_SIZE > size) {
    throw new NavFormatError("table", `a table of ${count} entries at ${offset} does not fit ${size} bytes after the header`);
  }
  const tableEnd = offset + count * TABLE_ENTRY_SIZE;
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  const sections: NavSection[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < count; i++) {
    const at = offset + i * TABLE_ENTRY_SIZE;
    const tag = ascii(bytes, at);
    if (seen.has(tag)) {
      throw new NavFormatError("table", `section ${JSON.stringify(tag)} appears twice`);
    }
    seen.add(tag);
    const version = view.getUint16(at + 4, true);
    const flags = view.getUint16(at + 6, true);
    const start = view.getUint32(at + 8, true);
    const length = view.getUint32(at + 12, true);
    if (start % ALIGN !== 0 || start < tableEnd || start + length > size) {
      throw new NavFormatError("bounds", `section ${tag} at ${start}+${length} is misaligned or outside ${tableEnd}..${size}`);
    }
    const read = KNOWN_SECTIONS[tag] === version;
    if (!read && flags & SECTION_FLAGS.REQUIRED) {
      throw new NavFormatError("required", `section ${tag} version ${version} is REQUIRED and unknown to this reader`);
    }
    sections.push({ tag, version, flags, offset: start, length, read });
  }
  const byOffset = [...sections].sort((a, b) => a.offset - b.offset);
  for (let i = 1; i < byOffset.length; i++) {
    const prev = byOffset[i - 1]!;
    if (prev.offset + prev.length > byOffset[i]!.offset) {
      throw new NavFormatError("bounds", `sections ${prev.tag} and ${byOffset[i]!.tag} overlap`);
    }
  }
  return sections;
}

/**
 * A record section's `count` and `stride`, checked against its length. Records
 * start 8 bytes in, or `headerBytes` in when the section has more before them.
 */
function records(view: DataView, s: NavSection, minStride: number, headerBytes = 8): { count: number; stride: number; start: number } {
  if (s.length < 8) {
    throw new NavFormatError("malformed", `${s.tag} is ${s.length} bytes, shorter than its count and stride`);
  }
  const count = view.getUint32(s.offset, true);
  const stride = view.getUint32(s.offset + 4, true);
  if (stride < minStride) {
    throw new NavFormatError("malformed", `${s.tag} stride ${stride} is below version 1's ${minStride}`);
  }
  if (headerBytes + count * stride > s.length) {
    throw new NavFormatError("malformed", `${s.tag} holds ${count} records of ${stride} bytes in ${s.length - headerBytes}`);
  }
  return { count, stride, start: s.offset + headerBytes };
}

// -- Sections --------------------------------------------------------------------

function readNodes(view: DataView, s: NavSection, stringCount: number): NavNodes {
  const { count, stride, start } = records(view, s, NODE_STRIDE);
  const position = new Float32Array(count * 3);
  const yaw = new Uint16Array(count);
  const type = new Uint8Array(count);
  const flags = new Uint8Array(count);
  const abilities = new Uint32Array(count);
  const source = new Uint32Array(count);
  const name = new Uint32Array(count);
  const group = new Uint16Array(count);
  const stance = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const at = start + i * stride;
    position[i * 3] = view.getFloat32(at, true);
    position[i * 3 + 1] = view.getFloat32(at + 4, true);
    position[i * 3 + 2] = view.getFloat32(at + 8, true);
    yaw[i] = view.getUint16(at + 12, true);
    type[i] = view.getUint8(at + 14);
    flags[i] = view.getUint8(at + 15);
    abilities[i] = view.getUint32(at + 16, true);
    source[i] = view.getUint32(at + 20, true);
    name[i] = stringIndex(view.getUint32(at + 24, true), stringCount, `node ${i}'s name`);
    group[i] = view.getUint16(at + 28, true);
    stance[i] = view.getUint8(at + 30);
  }
  return { count, position, yaw, type, flags, abilities, source, name, group, stance };
}

function readLinks(view: DataView, s: NavSection, nodeCount: number, traversalCount: number): NavLinks {
  // count, stride, then the node count and a reserved word, then first[nodeCount + 1],
  // padded to 8 so the records start aligned.
  if (s.length < 16) {
    throw new NavFormatError("malformed", `LINK is ${s.length} bytes, shorter than its 16-byte head`);
  }
  const linkNodes = view.getUint32(s.offset + 8, true);
  if (linkNodes !== nodeCount) {
    throw new NavFormatError("malformed", `LINK is for ${linkNodes} nodes; NODE has ${nodeCount}`);
  }
  const csrBytes = (nodeCount + 1) * 4;
  const head = 16 + csrBytes + ((ALIGN - (csrBytes % ALIGN)) % ALIGN);
  const { count, stride, start } = records(view, s, LINK_STRIDE, head);

  const first = new Uint32Array(nodeCount + 1);
  for (let i = 0; i <= nodeCount; i++) {
    first[i] = view.getUint32(s.offset + 16 + i * 4, true);
    if (i > 0 && first[i]! < first[i - 1]!) {
      throw new NavFormatError("malformed", `LINK's first[${i}] goes backwards`);
    }
  }
  if (first[0] !== 0 || first[nodeCount] !== count) {
    throw new NavFormatError("malformed", `LINK's first[] runs ${first[0]}..${first[nodeCount]}, not 0..${count}`);
  }

  const target = new Uint32Array(count);
  const gameCost = new Float32Array(count);
  const kind = new Uint8Array(count);
  const flags = new Uint8Array(count);
  const traversal = new Uint16Array(count);
  for (let i = 0; i < count; i++) {
    const at = start + i * stride;
    const to = view.getUint32(at, true);
    if (to >= nodeCount) {
      throw new NavFormatError("malformed", `link ${i} targets node ${to} of ${nodeCount}`);
    }
    const trav = view.getUint16(at + 10, true);
    if (trav !== NO_INDEX_16 && trav >= traversalCount) {
      throw new NavFormatError("malformed", `link ${i} names traversal ${trav} of ${traversalCount}`);
    }
    target[i] = to;
    gameCost[i] = view.getFloat32(at + 4, true);
    kind[i] = view.getUint8(at + 8);
    flags[i] = view.getUint8(at + 9);
    traversal[i] = trav;
  }
  return { count, first, target, gameCost, kind, flags, traversal };
}

function readTraversals(view: DataView, s: NavSection, nodeCount: number, stringCount: number): NavTraversals {
  const { count, stride, start } = records(view, s, TRAV_STRIDE);
  if (count > NO_INDEX_16) {
    throw new NavFormatError("malformed", `${count} traversals; a link can name at most ${NO_INDEX_16}`);
  }
  const begin = new Uint32Array(count);
  const end = new Uint32Array(count);
  const kind = new Uint8Array(count);
  const animscript = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    const at = start + i * stride;
    begin[i] = view.getUint32(at, true);
    end[i] = view.getUint32(at + 4, true);
    if (begin[i]! >= nodeCount || end[i]! >= nodeCount) {
      throw new NavFormatError("malformed", `traversal ${i} runs ${begin[i]} -> ${end[i]} of ${nodeCount} nodes`);
    }
    kind[i] = view.getUint8(at + 8);
    animscript[i] = stringIndex(view.getUint32(at + 12, true), stringCount, `traversal ${i}'s animscript`);
  }
  return { count, begin, end, kind, animscript };
}

function readStrings(bytes: Uint8Array, view: DataView, s: NavSection): string[] {
  if (s.length < 8) {
    throw new NavFormatError("malformed", `STRS is ${s.length} bytes, shorter than its head`);
  }
  const count = view.getUint32(s.offset, true);
  const blob = 8 + (count + 1) * 4;
  if (count < 1 || blob > s.length) {
    throw new NavFormatError("malformed", `STRS claims ${count} strings in ${s.length} bytes`);
  }
  const offsets = (i: number) => view.getUint32(s.offset + 8 + i * 4, true);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const from = offsets(i);
    const to = offsets(i + 1);
    if (from > to || blob + to > s.length) {
      throw new NavFormatError("malformed", `STRS string ${i} spans ${from}..${to} of ${s.length - blob}`);
    }
    try {
      out.push(decoder.decode(bytes.subarray(s.offset + blob + from, s.offset + blob + to)));
    } catch {
      throw new NavFormatError("malformed", `STRS string ${i} is not UTF-8`);
    }
  }
  if (out[0] !== "") {
    throw new NavFormatError("malformed", `STRS string 0 is ${JSON.stringify(out[0])}, not ""`);
  }
  return out;
}

function readMeta(bytes: Uint8Array, s: NavSection): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(s.offset, s.offset + s.length)));
  } catch {
    throw new NavFormatError("malformed", "META is not UTF-8 JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new NavFormatError("malformed", "META is not a JSON object");
  }
  return value as Record<string, unknown>;
}

function stringIndex(index: number, count: number, what: string): number {
  if (index >= count) {
    throw new NavFormatError(count === 1 ? "missing" : "malformed", `${what} is string ${index} of ${count}`);
  }
  return index;
}

function emptyLinks(nodeCount: number): NavLinks {
  return {
    count: 0,
    first: new Uint32Array(nodeCount + 1),
    target: new Uint32Array(0),
    gameCost: new Float32Array(0),
    kind: new Uint8Array(0),
    flags: new Uint8Array(0),
    traversal: new Uint16Array(0),
  };
}

function emptyTraversals(): NavTraversals {
  return { count: 0, begin: new Uint32Array(0), end: new Uint32Array(0), kind: new Uint8Array(0), animscript: new Uint32Array(0) };
}

function ascii(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!);
}

// -- CRC-32 ----------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (IEEE 802.3, reflected, as zlib's `crc32`) of `bytes`. */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
