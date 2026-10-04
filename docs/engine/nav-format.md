# The `nav.bin` format

A world's navigation graph, as the file a bot's pathfinding is loaded from: a
set of **nodes** (places), directed **links** between them, and **traversals**
(special moves from one node to another, such as a mantle or a ladder). This
page is the byte-level specification of version 1. What each source game's data
becomes in it is in [../cod/navigation.md](../cod/navigation.md).

**Status.** The format, its vocabularies, the encoder
(`scripts/cod/nav/format.py`) and the reader
(`packages/shared/src/nav/format.ts`) are built, and held to each other by a
conformance fixture ([below](#conformance)). A world names its file with a
`navigation` node ([worlds/AUTHORING.md](../../worlds/AUTHORING.md)), and
`pnpm check` decodes it. What the runtime makes of one — snapping, derived
links, validation, paths — is [navigation.md](navigation.md).

## What the file holds, and what it never does

**The file holds the source's truth and nothing computed from our collision.**
Where a node is, what kind of place it is, which links and traversals the source
itself compiled. Snapped heights, whether a node is usable, links we derive, and
the cost of walking a link are all computed when a world loads, against the same
capsule collision movement uses. So a change to that collision never needs the
graph re-exported, and one definition of "walkable" serves the load-time bake
and the bots alike.

It follows that a file never drops something because our player could not do it.
A traversal too tall for our mantle stays in the file; the loader decides it is
unusable.

## Conventions

- **Little-endian** throughout.
- **Every section starts at a multiple of 8** from the start of the file, and is
  followed by zero bytes up to the next multiple of 8. The file length is
  therefore a multiple of 8.
- **Positions are `f32` engine metres, Y up**, converted from the source by the
  same conversion the rest of a world's positions use, and never snapped to a
  floor.
- **Yaw is a `u16` fraction of a full turn** (65536 to the turn), about +Y, in
  the player's own convention: yaw 0 faces −Z, and a yaw faces
  (−sin yaw, 0, −cos yaw). A writer rounds half up and wraps.
- **"None" in an index field** is all ones: `0xFFFFFFFF` in a `u32`, `0xFFFF` in
  a `u16`.
- **Strings** are indices into the STRS table; index 0 is always `""`, so a
  zeroed string field means "no string".
- **Reserved bytes** are written as 0 and ignored by a reader.

## Header (32 bytes)

| Offset | Type    | Field         | Meaning                                                                                     |
| ------ | ------- | ------------- | ------------------------------------------------------------------------------------------- |
| 0      | 4 bytes | magic         | ASCII `3DNV`                                                                                |
| 4      | u16     | major         | 1. A reader refuses any other major version                                                 |
| 6      | u16     | minor         | 0. A reader accepts any minor version of its major                                          |
| 8      | u32     | flags         | [Header flags](#header-flags). Bits 16–31 must be understood; bits 0–15 may be ignored      |
| 12     | u32     | length        | The whole file, in bytes. A reader refuses a buffer of any other length                     |
| 16     | u32     | section count | Entries in the section table                                                                |
| 20     | u32     | table offset  | Where the section table starts; a multiple of 8, at least 32 (a writer puts it at 32)       |
| 24     | u32     | CRC-32        | CRC-32 (IEEE 802.3, zlib's) of bytes 32 to the end. 0 means "not stated" and is not checked |
| 28     | u32     | reserved      | 0                                                                                           |

### Header flags

| Bit | Name                  | Must understand | Meaning                                                                                    |
| --- | --------------------- | --------------- | ------------------------------------------------------------------------------------------ |
| 0   | `HAS_GAME_WALK_LINKS` | no              | LINK holds the source's own walk links                                                     |
| 16  | `DERIVE_WALK_LINKS`   | yes             | The loader must derive walk links, beside any LINK holds. A reader that cannot must refuse |

A reader refuses a file that sets any bit in 16–31 it does not know. A writer
never sets an undefined bit.

## Section table

`section count` entries of 16 bytes, at `table offset`, in file order:

| Offset | Type    | Field   | Meaning                                                            |
| ------ | ------- | ------- | ------------------------------------------------------------------ |
| 0      | 4 bytes | tag     | ASCII, space-padded (`VIS `)                                       |
| 4      | u16     | version | The section's own layout version, 1 for every section defined here |
| 6      | u16     | flags   | Bit 0 `REQUIRED`; the rest reserved                                |
| 8      | u32     | offset  | From the start of the file; a multiple of 8, after the table       |
| 12     | u32     | length  | Bytes, not counting the padding after the section                  |

- **A tag appears once.** Sections lie inside the file and do not overlap.
- **A reader skips a section it does not know** — an unknown tag, or a known tag
  at a version it does not know — **unless it is `REQUIRED`**, in which case it
  refuses the file. `REQUIRED` means "what the rest of the file means depends on
  this". A version-1 writer marks NODE, LINK, TRAV and STRS required and META
  not.
- **NODE must be present.** Every other section may be absent: no LINK means no
  stored links, no TRAV no traversals, no STRS every string `""`.

### Record sections

NODE, LINK and TRAV hold fixed-size records and start with:

| Offset | Type | Field  |
| ------ | ---- | ------ |
| 0      | u32  | count  |
| 4      | u32  | stride |

**A record can grow without a new version.** A reader reads the fields it knows
from the start of each record and skips the rest of the stride; it refuses a
stride smaller than the version-1 size given below. New fields go on the end of
a record, in a minor version, and must mean "nothing" when zero (or when absent,
to an older reader). A change that moves or reinterprets a field is a new
section version.

## Sections

### `NODE` — the places (version 1, required, must be present)

`count`, `stride` (≥ 32), then `count` records:

| Offset | Type | Field     | Meaning                                                                                     |
| ------ | ---- | --------- | ------------------------------------------------------------------------------------------- |
| 0      | f32  | x         | Engine metres                                                                               |
| 4      | f32  | y         | Engine metres, up                                                                           |
| 8      | f32  | z         | Engine metres                                                                               |
| 12     | u16  | yaw       | Fraction of a turn. Meaningful only with `HAS_YAW`, otherwise 0                             |
| 14     | u8   | type      | [Node type](#node-types)                                                                    |
| 15     | u8   | flags     | [Node flags](#node-flags)                                                                   |
| 16     | u32  | abilities | [Ability](#abilities) bits a mover needs to use this node; 0 = nothing special              |
| 20     | u32  | source    | The node's index in the data it came from, or none                                          |
| 24     | u32  | name      | STRS index of the node's name in its source (what another node or a script refers to it by) |
| 28     | u16  | group     | Its dynamic group, or none. Set exactly when `DYNAMIC` is                                   |
| 30     | u8   | stance    | [Stances](#stances) the source allows here; 0 = not stated                                  |
| 31     | u8   | reserved  | 0                                                                                           |

A node's index is its position in this section; LINK and TRAV refer to nodes by
it.

### `LINK` — directed links, per node (version 1)

Compressed sparse rows: node `i`'s links are records `first[i]` up to
`first[i + 1]`, in the order the writer was given them.

| Offset | Type                   | Field      | Meaning                                            |
| ------ | ---------------------- | ---------- | -------------------------------------------------- |
| 0      | u32                    | count      | Links                                              |
| 4      | u32                    | stride     | ≥ 12                                               |
| 8      | u32                    | node count | Equal to NODE's count                              |
| 12     | u32                    | reserved   | 0                                                  |
| 16     | u32 × (node count + 1) | first      | `first[0]` = 0, never decreasing, last = `count`   |
| then   | zero bytes             |            | To the next multiple of 8 from the section's start |
| then   | `count` × `stride`     | records    |                                                    |

Each record:

| Offset | Type | Field     | Meaning                                                                                                   |
| ------ | ---- | --------- | --------------------------------------------------------------------------------------------------------- |
| 0      | u32  | target    | The node the link leads to. The node it leaves is the row it is in                                        |
| 4      | f32  | game cost | The source's own number for the link, or NaN for none. **A cost, never a distance** ([below](#game-cost)) |
| 8      | u8   | kind      | [Link kind](#link-kinds)                                                                                  |
| 9      | u8   | flags     | [Link flags](#link-flags)                                                                                 |
| 10     | u16  | traversal | TRAV index, or none. Set exactly when kind is `TRAVERSE`                                                  |

A link is one direction. Its reverse is a separate link, or absent — and absent
is information: the source did not link back (`ONE_WAY_IN_GAME`).

#### Game cost

Whatever the source stored, kept for comparison and debugging, never read as a
length. A source may store a horizontal distance on a walk link and a constant
or a scaled cost on a traversal; the loader's own cost is the simulated time to
walk the link, which the file never holds.

### `TRAV` — traversals (version 1)

`count`, `stride` (≥ 16), then `count` records. At most 65,535, since a link
names one in a `u16`.

| Offset | Type | Field      | Meaning                                          |
| ------ | ---- | ---------- | ------------------------------------------------ |
| 0      | u32  | begin      | Node                                             |
| 4      | u32  | end        | Node                                             |
| 8      | u8   | kind       | [Traversal kind](#traversal-kinds)               |
| 9      | u8   | flags      | None defined in version 1: 0                     |
| 10     | u16  | reserved   | 0                                                |
| 12     | u32  | animscript | STRS index of the source's own name for the move |

**The kind comes from the source's name for the move, and nothing else.** The
geometry — how far up, how far across — comes from the two nodes' positions, and
whether our player can make it is decided at load. The file does not record a
rise or a length.

When LINK is present, each traversal is expected to have exactly one link,
`begin → end`, of kind `TRAVERSE`, naming it. A writer reading a source whose
walk links are derived still writes these links: the traversal links are source
truth even when the walk links are not.

### `STRS` — strings (version 1)

| Offset              | Type              | Field    | Meaning                                                             |
| ------------------- | ----------------- | -------- | ------------------------------------------------------------------- |
| 0                   | u32               | count    | Strings, at least 1                                                 |
| 4                   | u32               | reserved | 0                                                                   |
| 8                   | u32 × (count + 1) | offsets  | String `i` is bytes `offsets[i]` up to `offsets[i + 1]` of the blob |
| 8 + 4 × (count + 1) | bytes             | blob     | UTF-8, no terminators                                               |

String 0 is `""`. A writer interns each distinct string once, in first-use order
(node names in node order, then traversal names). A reader refuses invalid UTF-8,
and a string index past the end of the table.

### `META` — for a human (version 1, never required)

A UTF-8 JSON object: where the file came from, what generated it, and what the
source had that the file leaves out (`"skipped": {"<kind>": count}`). Nothing
may behave differently because of it. A writer emits sorted, compact JSON so
the file is deterministic.

### Reserved tags

Named now so that no two uses of one tag can arise. None is defined in version 1;
a reader skips each unless a later writer marks it `REQUIRED`.

| Tag    | For                                                                            |
| ------ | ------------------------------------------------------------------------------ |
| `VIS ` | Node-to-node visibility                                                        |
| `ZONE` | A coarse zone graph over the nodes: each node's zone, and the zones' own links |
| `DYNG` | Dynamic groups: the moving thing each group's frame belongs to                 |
| `DSTA` | Dynamic states: link sets a scripted change turns on or off                    |
| `COVR` | Cover data (exposure, peek directions)                                         |
| `ABIL` | Names for ability bits beyond the standard ones                                |
| `BLKR` | Blockers: volumes that disconnect the links they cross                         |
| `POLY` | A polygon layer, should one ever sit beside the nodes                          |
| `PNOD` | The mapping between that polygon layer and the nodes                           |

## Vocabularies

Defined once each, in `packages/shared/src/nav/vocab.ts` and
`scripts/cod/nav/vocab.py`, and checked against each other through the
conformance fixture. A number is never reassigned.

**A reader keeps a value it does not know** rather than refusing the file: a
later writer may use a type or kind this reader has never seen. The loader
treats an unknown node type as `PATH`, an unknown link kind as not walkable, an
unknown traversal kind as `UNKNOWN`, and ignores node, link and stance bits it
does not know. A writer never writes a value this page does not define.

### Node types

| Value | Name                  | Value | Name                 | Value | Name             |
| ----- | --------------------- | ----- | -------------------- | ----- | ---------------- |
| 0     | `PATH`                | 9     | `COVER_PILLAR`       | 18    | `DOOR`           |
| 1     | `COVER_STAND`         | 10    | `COVER_MULTI`        | 19    | `DOOR_INTERIOR`  |
| 2     | `COVER_CROUCH`        | 11    | `CONCEALMENT_STAND`  | 20    | `SCRIPTED`       |
| 3     | `COVER_CROUCH_WINDOW` | 12    | `CONCEALMENT_CROUCH` | 21    | `BALCONY`        |
| 4     | `COVER_PRONE`         | 13    | `CONCEALMENT_PRONE`  | 22    | `REACQUIRE`      |
| 5     | `COVER_RIGHT`         | 14    | `EXPOSED`            | 23    | `TRAVERSE_BEGIN` |
| 6     | `COVER_LEFT`          | 15    | `AMBUSH`             | 24    | `TRAVERSE_END`   |
| 7     | `COVER_WIDE_RIGHT`    | 16    | `GUARD`              | 25    | `JUMP`           |
| 8     | `COVER_WIDE_LEFT`     | 17    | `TURRET`             | 26    | `JUMP_ATTACK`    |

A type says what a place is for, not how to reach it: every type is a place a
mover can stand, and reaching it is the links' business.

### Node flags

| Bit | Name      | Meaning                                                                                     |
| --- | --------- | ------------------------------------------------------------------------------------------- |
| 0   | `HAS_YAW` | `yaw` means something (a cover's facing)                                                    |
| 1   | `FLOOR_Z` | The position is already on the floor. Without it, it was authored somewhere above the floor |
| 2   | `DYNAMIC` | The position is in `group`'s frame, which moves; it is not a world position                 |

**Snapping, as guidance for the loader** (not a rule of the format): a
`FLOOR_Z` node is settled onto the floor within ±0.25 m; any other is found by
searching down from its position, up to about 2.5 m. A node with no floor within
that is unusable, not moved further.

**A `DYNAMIC` node is not a place** until something resolves its group's frame.
Version 1 defines no section that does (`DYNG` is reserved), so a version-1
loader treats such nodes, and every link touching them, as unusable. A writer
may instead leave them out and count them in META.

### Stances

| Bit | Name     |
| --- | -------- |
| 0   | `STAND`  |
| 1   | `CROUCH` |
| 2   | `PRONE`  |

### Abilities

| Bit | Name     |
| --- | -------- |
| 0   | `WALK`   |
| 1   | `DROP`   |
| 2   | `MANTLE` |
| 3   | `LADDER` |
| 4   | `JUMP`   |
| 5   | `BOOST`  |

A mover has a set of these; a node whose `abilities` are not all in that set is
not for it. Links have no ability field: what a link needs is decided at load
from its kind, its traversal and its geometry.

### Link kinds

| Value | Name       | Meaning                              |
| ----- | ---------- | ------------------------------------ |
| 0     | `WALK`     | Walk from one node to the other      |
| 1     | `TRAVERSE` | Perform the traversal the link names |

### Link flags

| Bit | Name                 | Meaning                                                                     |
| --- | -------------------- | --------------------------------------------------------------------------- |
| 0   | `GAME`               | The source's own compiled link                                              |
| 1   | `START_DISCONNECTED` | Blocked when a match starts, until something connects it (a door, a script) |
| 2   | `ONE_WAY_IN_GAME`    | The source has no link back                                                 |
| 3   | `NEGOTIATION`        | Exactly the `begin → end` link of a traversal                               |

### Traversal kinds

| Value | Name          | Value | Name          |
| ----- | ------------- | ----- | ------------- |
| 0     | `UNKNOWN`     | 5     | `JUMP_ACROSS` |
| 1     | `STEP_UP`     | 6     | `JUMP_UP`     |
| 2     | `MANTLE_ON`   | 7     | `LADDER_UP`   |
| 3     | `MANTLE_OVER` | 8     | `LADDER_DOWN` |
| 4     | `JUMP_DOWN`   | 9     | `SPECIAL`     |

`UNKNOWN` is 0 so that a zeroed record claims nothing. `SPECIAL` is a move the
source's own characters make and ours have no equivalent for.

## Sizes

With the version-1 strides (32-byte nodes, 12-byte links, 4 bytes of CSR per
node), measured by encoding real source data:

| Graph                                                     | Nodes | Links  | Bytes   |
| --------------------------------------------------------- | ----- | ------ | ------- |
| A 511-node map, traversal links only (walk links derived) | 511   | 6      | ≈19 KB  |
| The same map with its source's 3,833 walk links           | 511   | 3,833  | ≈65 KB  |
| A dense 2,849-node map with its source's links            | 2,849 | 46,123 | ≈670 KB |

Links dominate once the source ships them, which is why they are 12 bytes.

## Conformance

`packages/shared/tests/fixtures/nav/conformance.json` describes a small file
that fills every version-1 section, with non-ASCII strings, both header flags,
every node flag, a link with no game cost, and a section (`ZZZZ`) no reader
knows; it also carries every vocabulary table. `conformance.nav.bin` beside it
is that description encoded by `python3 -m scripts.cod.nav.conformance`.

- `scripts/cod/tests/test_nav_format.py` requires the encoder to reproduce the
  committed bytes exactly, and `vocab.py` to equal the fixture's tables.
- `packages/shared/tests/navFormat.test.ts` requires the reader to decode them
  back to the JSON (after `f32` rounding), `vocab.ts` to equal the same tables,
  and every refusal to fire on a mutated copy: an unknown `REQUIRED` section, a
  bad major version, an unknown must-understand flag, truncation, a CRC mismatch
  and a section out of bounds, among others.

A change to the format changes those bytes, so it shows in review. Regenerate
them only for a deliberate format change, and bump the version the change calls
for: a minor for a new trailing field or a new optional section, a section
version for a changed layout, the major for anything an existing reader would
misread without noticing.
