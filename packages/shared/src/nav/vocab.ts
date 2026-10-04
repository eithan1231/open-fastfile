// The standard navigation vocabularies: what each small number in a `nav.bin`
// means (docs/engine/nav-format.md).
//
// A value is never renumbered, because the number is what a file stores. The
// encoder's copy is scripts/cod/nav/vocab.py; both are held to the conformance
// fixture's `vocab` tables, so the two cannot drift apart silently.
//
// A decoder keeps a value it does not know rather than refusing it: a later
// file may use a type or kind this build has never heard of. What the runtime
// does with one is in the spec (an unknown node type is a plain place, an
// unknown link kind is not walked, an unknown traversal kind is UNKNOWN).

/** `u8 type` of a node: what the place is for, and nothing about how to reach it. */
export const NODE_TYPES = {
  PATH: 0,
  COVER_STAND: 1,
  COVER_CROUCH: 2,
  COVER_CROUCH_WINDOW: 3,
  COVER_PRONE: 4,
  COVER_RIGHT: 5,
  COVER_LEFT: 6,
  COVER_WIDE_RIGHT: 7,
  COVER_WIDE_LEFT: 8,
  COVER_PILLAR: 9,
  COVER_MULTI: 10,
  CONCEALMENT_STAND: 11,
  CONCEALMENT_CROUCH: 12,
  CONCEALMENT_PRONE: 13,
  EXPOSED: 14,
  AMBUSH: 15,
  GUARD: 16,
  TURRET: 17,
  DOOR: 18,
  DOOR_INTERIOR: 19,
  SCRIPTED: 20,
  BALCONY: 21,
  REACQUIRE: 22,
  TRAVERSE_BEGIN: 23,
  TRAVERSE_END: 24,
  JUMP: 25,
  JUMP_ATTACK: 26,
} as const;

/** `u8 flags` of a node. */
export const NODE_FLAGS = {
  /** `yaw` means something. */
  HAS_YAW: 1 << 0,
  /** The position is already on the floor; without it, it was authored somewhere above. */
  FLOOR_Z: 1 << 1,
  /** The position is in `group`'s frame, not the world's. */
  DYNAMIC: 1 << 2,
} as const;

/** `u8 stance` of a node: the stances the source allows there. 0 = not stated. */
export const STANCES = {
  STAND: 1 << 0,
  CROUCH: 1 << 1,
  PRONE: 1 << 2,
} as const;

/** `u32 abilities` of a node: what a mover needs to use it. 0 = nothing special. */
export const ABILITIES = {
  WALK: 1 << 0,
  DROP: 1 << 1,
  MANTLE: 1 << 2,
  LADDER: 1 << 3,
  JUMP: 1 << 4,
  BOOST: 1 << 5,
} as const;

/** `u8 kind` of a link. */
export const LINK_KINDS = {
  WALK: 0,
  TRAVERSE: 1,
} as const;

/** `u8 flags` of a link. */
export const LINK_FLAGS = {
  /** The source's own compiled link, not one this project added. */
  GAME: 1 << 0,
  /** Blocked until something connects it. */
  START_DISCONNECTED: 1 << 1,
  /** The source has no link back. */
  ONE_WAY_IN_GAME: 1 << 2,
  /** Exactly the begin → end link of a traversal. */
  NEGOTIATION: 1 << 3,
} as const;

/** `u8 kind` of a traversal. 0 is UNKNOWN, so a zeroed record claims nothing. */
export const TRAVERSAL_KINDS = {
  UNKNOWN: 0,
  STEP_UP: 1,
  MANTLE_ON: 2,
  MANTLE_OVER: 3,
  JUMP_DOWN: 4,
  JUMP_ACROSS: 5,
  JUMP_UP: 6,
  LADDER_UP: 7,
  LADDER_DOWN: 8,
  SPECIAL: 9,
} as const;

/** The header's `u32 flags`. Bits 16–31 must be understood by a reader; 0–15 may be ignored. */
export const HEADER_FLAGS = {
  /** LINK holds the source's own walk links. */
  HAS_GAME_WALK_LINKS: 1 << 0,
  /** Walk links are to be derived at load, beside any LINK holds; a reader that cannot must refuse the file. */
  DERIVE_WALK_LINKS: 1 << 16,
} as const;

/** A section table entry's `u16 flags`. */
export const SECTION_FLAGS = {
  /** A reader that does not know this tag at this version must refuse the file. */
  REQUIRED: 1 << 0,
} as const;

export type NodeType = keyof typeof NODE_TYPES;
export type LinkKind = keyof typeof LINK_KINDS;
export type TraversalKind = keyof typeof TRAVERSAL_KINDS;
