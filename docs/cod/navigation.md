# Navigation: each game's path nodes as a `nav.bin`

What each game's AI path data becomes in the standard navigation file. The file
itself — its bytes, its vocabularies and what a reader does with them — is
[../engine/nav-format.md](../engine/nav-format.md). How every fact below was
established, and the tools that re-check it, is
[reverse/cod-pathdata](../../reverse/cod-pathdata/README.md); the summary of the
data is [reference.md § Path nodes](reference.md#path-nodes).

The mapping lives in `scripts/cod/nav/vocab.py`, beside the standard
vocabularies, so an exporter never spells a classname or an animscript itself.

**Status.** MW3 is exported, from the entity lump, on 22 worlds
([below](#mw3-from-the-entity-lump)), Ghosts and AW from their path zones
on prisonbreak and the 14 AW worlds
([below](#ghosts-and-aw-from-the-path-zone)), Black Ops from its map zones
on all 16 of its worlds ([below](#black-ops-from-the-map-zone)), and Black Ops
II from its map zones on all 15 ([below](#black-ops-ii-from-the-map-zone)); what
the load-time bake makes of each is [below](#at-load).

## Per game

| Game   | Source of the nodes                                          | Header flags          | `FLOOR_Z` | Links in the file                  |
| ------ | ------------------------------------------------------------ | --------------------- | --------- | ---------------------------------- |
| MW2    | none: no MP zone has path data                               | no file is written    | -         | -                                  |
| MW3    | the entity lump's `node_*` entities (`export_metadata.json`) | `DERIVE_WALK_LINKS`   | no        | traversal links only               |
| MW3    | later: `PATHDATA` in `so_survival_<map>.ff` (22 maps)        | `HAS_GAME_WALK_LINKS` | yes       | every game link                    |
| BO1    | `GameWorldMp.path`                                           | `HAS_GAME_WALK_LINKS` | no        | every game link                    |
| BO2    | `GameWorldMp.path`                                           | `HAS_GAME_WALK_LINKS` | no        | every game link the game searches  |
| Ghosts | `PATHDATA` in `<map>_path.ff`                                | `HAS_GAME_WALK_LINKS` | yes       | every game link between kept nodes |
| AW     | `PATHDATA` in `<map>_path.ff`                                | `HAS_GAME_WALK_LINKS` | yes       | every game link between kept nodes |

- **The node array is the entity lump's `node_*` entities, in lump order**, in
  every game with both; so `source` is the node's rank among the `node_*`
  entities and its PathData index at once.
- **`FLOOR_Z`** follows where the source puts a node: MW3's compiled Survival
  nodes, Ghosts and AW are on the floor (within ~0.8 in); an entity's `origin`,
  and every Black Ops and Black Ops II node, is authored above it (median
  0.6–1.1 m, a few metres at worst). `vocab.FLOOR_Z` has the table by game and
  source.
- **MW3's MP zones ship no links**, so its walk links are derived at load
  (`DERIVE_WALK_LINKS`). The traversal links are still written: they come from
  the entities' `target`, not from compiled links, so they carry no `GAME` flag
  and no game cost.
- **aground and courtyard** carry 3 node entities each and no Survival zone:
  nothing is written for them.

## MW3: from the entity lump

`scripts/cod/nav/from_ents.py`, run at the end of stage 11 or on its own with
`export --nav-only` ([pipeline.md](pipeline.md#navigation)). Its input is the
`entities` of the committed `export_metadata.json`, so it needs no game files;
the engine never reads that file, only the `nav.bin` written from it.

- **Header:** `DERIVE_WALK_LINKS` and nothing else. The zone ships no links.
- **LINK:** one per traversal, `begin → end`, kind `TRAVERSE`, flag
  `NEGOTIATION`, no game cost; no `GAME` flag, since nothing compiled it. A map
  with no traversals (nola) writes no LINK section at all.
- **Nodes:** as [below](#nodes), `source` being the node's rank among the lump's
  `node_*` entities. A `node_*` classname the vocabulary lacks, or an entity with
  no `origin`, is skipped and counted in META's `skipped`; neither happens on
  any MW3 map.
- **META:** `source: "ents"`, the counts by node type and traversal kind,
  `unpaired` (the source indices of negotiation nodes in no traversal) and
  `unknownAnimscripts` (by name). The export prints both.
- **No graph under 10 nodes.** aground and courtyard carry 3 covers each, and
  deltacamp (a Spec Ops zone) none: no `navigation.world` is written for them.

| World       | Nodes | Traversals | World       | Nodes | Traversals |
| ----------- | ----- | ---------- | ----------- | ----- | ---------- |
| alpha       | 674   | 2          | mogadishu   | 1,323 | 3          |
| boardwalk   | 812   | 4          | nola        | 411   | 0          |
| bootleg     | 910   | 8          | paris       | 833   | 12         |
| bravo       | 503   | 22         | plaza2      | 944   | 8          |
| carbon      | 679   | 2          | radar       | 889   | 12         |
| dome        | 511   | 6          | roughneck   | 815   | 7          |
| exchange    | 893   | 1          | seatown     | 812   | 11         |
| hardhat     | 708   | 6          | shipbreaker | 668   | 13         |
| interchange | 1,017 | 13         | terminal    | 1,150 | 48         |
| lambeth     | 929   | 6          | underground | 834   | 42         |
| moab        | 551   | 13         | village     | 616   | 4          |

The 243 traversals are, kind for kind, MW3's pairs in the table
[below](#traversals), which were counted in the Survival zones: every MW3
animscript maps to a kind, and none is `UNKNOWN`. One negotiation node pairs
with nothing: shipbreaker's 14th `node_negotiation_end` (`node_*` #602), which
no begin targets.

**Later: the Survival zones' PathData.** On the 22 maps with a
`so_survival_<map>.ff`, its PathData holds the same nodes in the same order,
with the game's compiled links (reverse/cod-pathdata §9). Once an IW5 zone
walker exists, those 22 files are rebuilt from it: `HAS_GAME_WALK_LINKS` in
place of `DERIVE_WALK_LINKS`, every game link with its `GAME` flag, and the
Survival node's own z with `FLOOR_Z` (it is dropped to the floor, where the
entity's is authored above it). `source` is the same index either way, so a
world's `navigation.world` does not change. aground and courtyard have no
Survival zone and stay without; deltacamp gains one only if its PathData is
found, which reverse/cod-pathdata leaves open.

## Ghosts and AW: from the path zone

`scripts/cod/nav/from_pathdata.py`, over the `pathdata` dump of
`<map>_path.ff` ([pipeline.md](pipeline.md#navigation)): the game's compiled
graph, walk links included. Unlike MW3's, it needs the game's files, though
only that one small zone (a second or two to walk).

- **Header:** `HAS_GAME_WALK_LINKS`. Nothing is derived at load.
- **Nodes:** the entity nodes, as [below](#nodes), with `FLOOR_Z` (the compiler
  dropped them onto the floor), `source` their PathData index. The zone nodes
  appended after them, and any node in a dynamic group, are left out and
  counted in META's `skipped` (`zoneNodes`, `dynamicNodes`), with every link
  touching one (`links.droppedToSkippedNodes`; none on any imported world, since
  zone nodes link only to each other).
- **Checked against the entity lump, not assumed to match it:** the entity nodes
  must be the lump's `node_*` entities in count, order, x/y (within 0.1 in; the
  worst seen is 0.0002 in) and type, or the export stops. A graph off by one node
  would put every link somewhere else and still look like a graph.
- **LINK:** every link between two kept nodes, as the table [below](#links)
  says: `GAME` on all, the game's `fDist` as the cost, `ONE_WAY_IN_GAME` where
  the target has no link back (the negotiation links included, which almost
  never have one). A negotiation link between anything but a begin and an end
  (Extinction's `JUMP` nodes) stops the export: that needs a decision this
  mapping does not make.
- **TRAV:** one per negotiation link, begin → end, the animscript the begin's
  own. A begin with no negotiation link, and an end no link reaches, are listed
  in META's `unpaired` and printed.
- **META:** `source: "pathdata"`, `pathdataVersion` (the PathData's own
  `version`: 21 on Ghosts, 25 on AW), the counts by node type, link (`walk`,
  `walkOneWay`, `traverse`) and traversal kind.

| World       | Nodes | Walk links | One-way | Traversals                                                                            | Zone nodes skipped |
| ----------- | ----- | ---------- | ------- | ------------------------------------------------------------------------------------- | ------------------ |
| prisonbreak | 1,392 | 13,589     | 403     | 165: 85 JUMP_DOWN, 46 JUMP_UP, 11 MANTLE_OVER, 11 STEP_UP, 8 JUMP_ACROSS, 4 LADDER_UP | 51                 |

| AW world   | Nodes  | Walk links | One-way | Traversals                                                                                      | Zone nodes skipped |
| ---------- | ------ | ---------- | ------- | ----------------------------------------------------------------------------------------------- | ------------------ |
| comeback   | 768    | 6,643      | 52      | 120: 68 SPECIAL, 26 JUMP_DOWN, 13 JUMP_UP, 8 MANTLE_OVER, 3 STEP_UP, 1 LADDER_DOWN, 1 LADDER_UP | 37                 |
| dam        | 2,924  | 36,205     | 308     | 365: 243 SPECIAL, 52 JUMP_DOWN, 38 MANTLE_OVER, 28 JUMP_UP, 4 LADDER_UP                         | 133                |
| detroit    | 1,021  | 10,753     | 70      | 149: 46 SPECIAL, 41 JUMP_DOWN, 41 JUMP_UP, 21 MANTLE_OVER                                       | 60                 |
| greenband  | 2,547  | 38,919     | 626     | 470: 264 SPECIAL, 90 JUMP_DOWN, 63 MANTLE_OVER, 50 JUMP_UP, 3 JUMP_ACROSS                       | 73                 |
| instinct   | 1,219  | 16,634     | 72      | 147: 75 SPECIAL, 41 JUMP_DOWN, 27 JUMP_UP, 4 MANTLE_OVER                                        | 56                 |
| lab2       | 2,475  | 55,089     | 158     | 319: 148 SPECIAL, 69 JUMP_DOWN, 65 JUMP_UP, 35 MANTLE_OVER, 2 LADDER_UP                         | 97                 |
| laser2     | 2,229  | 30,579     | 342     | 259: 101 SPECIAL, 92 JUMP_DOWN, 35 JUMP_UP, 21 MANTLE_OVER, 7 LADDER_UP, 3 JUMP_ACROSS          | 83                 |
| levity     | 1,717  | 24,184     | 165     | 315: 169 SPECIAL, 84 JUMP_DOWN, 47 JUMP_UP, 14 MANTLE_OVER, 1 JUMP_ACROSS                       | 51                 |
| prison     | 2,726  | 45,341     | 192     | 345: 179 SPECIAL, 78 JUMP_DOWN, 56 JUMP_UP, 30 MANTLE_OVER, 2 LADDER_UP                         | 123                |
| recovery   | 1,857  | 21,775     | 140     | 171: 93 SPECIAL, 37 JUMP_UP, 36 JUMP_DOWN, 4 MANTLE_OVER, 1 LADDER_UP                           | 90                 |
| refraction | 1,645  | 25,405     | 9       | 162: 77 SPECIAL, 42 MANTLE_OVER, 36 JUMP_DOWN, 5 JUMP_UP, 2 LADDER_UP                           | 56                 |
| solar      | 1,240  | 12,628     | 38      | 159: 90 SPECIAL, 48 JUMP_DOWN, 15 JUMP_UP, 4 MANTLE_OVER, 2 LADDER_UP                           | 48                 |
| terrace    | 970    | 9,324      | 81      | 168: 111 SPECIAL, 22 JUMP_DOWN, 22 MANTLE_OVER, 8 JUMP_UP, 5 LADDER_UP                          | 52                 |
| venus      | 1,766  | 25,030     | 167     | 141: 53 JUMP_DOWN, 35 SPECIAL, 28 JUMP_UP, 21 MANTLE_OVER, 4 LADDER_UP                          | 67                 |
| all 14     | 25,104 | 358,509    | 2,420   | 3,290: 1,699 SPECIAL, 768 JUMP_DOWN, 455 JUMP_UP, 327 MANTLE_OVER, 30 LADDER_UP, 11 other       | 1,026              |

- **No imported world has a dynamic group**, so no node is dropped for one; the
  37 dynamic-group nodes are on five Ghosts maps not imported, and AW has none.
- **Every animscript maps to a kind.** Half of AW's traversals are `SPECIAL`: the
  exo `boost_*` moves and `bot_walk_forward`, which our player has no move for.
- **17 negotiation begins on 8 AW worlds have no negotiation link**, and so no
  traversal (listed in META's `unpaired`, printed by the export). Most target an
  end with no links at all, such as a `boost_jump_up` whose end is 6 m _below_
  its begin: the compiler made no traversal of them, and neither does the file.
  Every Ghosts begin is paired.

## Black Ops: from the map zone

The same mapping, `scripts/cod/nav/from_pathdata.py`, over the `pathdata` dump
`scripts/cod/t5/dumpers/pathdata.py` writes from the map zone's own
`GameWorldMp.path` (the zombies maps': `GameWorldSp.path`); in a full export it
reuses the map's walk, and `--nav-only` walks the map zone alone, a few seconds
([pipeline.md](pipeline.md#navigation)). What differs from Ghosts and AW:

- **No `FLOOR_Z`:** a Black Ops node keeps the height it was authored at, so the
  check against the entity lump compares z as well as x/y and type. All 11,797
  nodes of the 16 worlds agree, the worst by 0.0002 in.
- **Nothing is skipped:** no zone graph, no dynamic group. The 128 runtime slots
  after `nodeCount` must be empty, or the dump stops (it would mean the count was
  misread).
- **Links** carry `disconnectCount` and four bad-place counts, and no `flags`.
  Every shipped count is 0, so no link is `START_DISCONNECTED`.
- **Every begin is paired**, and every animscript maps to a kind: the 315
  traversals are the pairs in the table [below](#traversals).

| World       | Nodes  | Walk links | One-way | Traversals                                       |
| ----------- | ------ | ---------- | ------- | ------------------------------------------------ |
| nuked       | 316    | 1,506      | 20      | 10: 4 JUMP_DOWN, 4 MANTLE_ON, 2 MANTLE_OVER      |
| firingrange | 462    | 2,702      | 12      | 12: 12 MANTLE_OVER                               |
| array       | 911    | 4,552      | 10      | 6: 4 MANTLE_OVER, 1 JUMP_DOWN, 1 MANTLE_ON       |
| cairo       | 655    | 3,289      | 33      | 16: 16 MANTLE_OVER                               |
| cosmodrome  | 595    | 2,968      | 29      | 14: 10 MANTLE_OVER, 2 JUMP_DOWN, 2 MANTLE_ON     |
| cracked     | 873    | 5,024      | 38      | 28: 24 MANTLE_OVER, 2 JUMP_DOWN, 2 MANTLE_ON     |
| crisis      | 676    | 2,790      | 22      | 19: 12 MANTLE_OVER, 4 JUMP_DOWN, 3 MANTLE_ON     |
| duga        | 802    | 4,668      | 10      | 10: 10 MANTLE_OVER                               |
| hanoi       | 665    | 3,245      | 19      | 14: 10 MANTLE_OVER, 2 JUMP_DOWN, 2 MANTLE_ON     |
| havoc       | 549    | 2,474      | 18      | 21: 16 MANTLE_OVER, 5 MANTLE_ON                  |
| mountain    | 447    | 1,946      | 0       | 8: 8 MANTLE_OVER                                 |
| radiation   | 554    | 2,139      | 10      | 31: 18 MANTLE_OVER, 8 JUMP_DOWN, 5 MANTLE_ON     |
| russianbase | 597    | 3,015      | 24      | 20: 8 MANTLE_OVER, 6 JUMP_DOWN, 6 MANTLE_ON      |
| villa       | 735    | 3,253      | 7       | 14: 8 MANTLE_OVER, 3 JUMP_DOWN, 3 MANTLE_ON      |
| theater     | 1,568  | 15,924     | 530     | 54: 27 MANTLE_OVER, 27 JUMP_DOWN                 |
| pentagon    | 1,392  | 14,751     | 217     | 38: 33 MANTLE_OVER, 5 JUMP_DOWN                  |
| all 16      | 11,797 | 74,246     | 999     | 315: 218 MANTLE_OVER, 64 JUMP_DOWN, 33 MANTLE_ON |

## Black Ops II: from the map zone

Black Ops' mapping and source, `scripts/cod/t6/dumpers/pathdata.py` being T5's
writer over T6's 16-byte link; `--nav-only` walks the map zone, about 5 s. The
evidence for each point is [reverse/cod-pathdata § T6](../../reverse/cod-pathdata/README.md#t6-black-ops-ii).

- **The authored height, checked:** all 11,350 nodes of the 15 worlds are their
  `node_*` entities in count, order, type and x/y/z, the worst by 0.0004 in.
  The yaw bit is 0x8000, as in Black Ops.
- **Types** are numbered as `vocab._T6_TYPES`: Black Ops' without the two wide
  covers, and with `AMBUSH` and `EXPOSED` after `COVER_PILLAR`. MP ships `PATH`,
  the covers, `EXPOSED` and the negotiation pair.
- **A redundant link is left out** (`vocab.UNSEARCHED_LINK_FLAGS`). The MP
  compile marks a link `flags & 0x10` where a two-link route joins its ends, and
  every one of the game's searches skips it. On five maps that is 56–68% of the
  links (22,838 in all), counted in META's `links.unsearched`; "one way" is then
  judged against the links left. The other `flags` bits say who else may use a
  link (0x08 a double-width AI, 0x20 a quadrotor, 1/2 a cover shuffle) and are
  dropped: every link is a walker's first.
- **Negotiation hints.** Two thirds of the traversals are a begin with no
  animscript and one hint spawnflag, and they are the only ones a bot takes; it
  makes the move itself. The hint names the move in the TRAV record, and maps
  through `vocab.HINT_KINDS`: `LADDER` (0x400000) `LADDER_UP`, `MANTLE` (0x800000)
  `MANTLE_ON`, `FALL` (0x2000000) `JUMP_DOWN`. `JUMP` (0x1000000) ships on no map
  and would be `UNKNOWN`. A mantle hint is the player's mantle, which picks over
  or onto from the ledge's own flags, so its kind is a label: the follower makes
  both the same way. The begins with an animscript are an AI's, as Black Ops'
  are, and store a constant `fDist` of 15.0; a hint's is the pair's 2D length.
- **Three hint begins pair with nothing** (nuketown #300, raid #719, socotra
  #460): the compiler made no link from them, and the export names each.

| World     | Nodes  | Walk links | One-way | Redundant, left out | Traversals                                                                |
| --------- | ------ | ---------- | ------- | ------------------- | ------------------------------------------------------------------------- |
| carrier   | 734    | 1,904      | 86      | 2,629 of 4,555      | 22: 11 MANTLE_OVER, 10 JUMP_DOWN, 1 LADDER_UP                             |
| dockside  | 1,223  | 3,457      | 59      | 7,591 of 11,089     | 41: 20 MANTLE_ON, 13 JUMP_DOWN, 8 MANTLE_OVER                             |
| drone     | 1,188  | 3,130      | 36      | 5,934 of 9,095      | 31: 15 MANTLE_ON, 7 MANTLE_OVER, 5 JUMP_DOWN, 3 SPECIAL, 1 LADDER_UP      |
| express   | 665    | 1,632      | 34      | -                   | 28: 16 MANTLE_ON, 6 MANTLE_OVER, 5 JUMP_DOWN, 1 LADDER_UP                 |
| hijacked  | 426    | 1,013      | 21      | -                   | 12: 6 LADDER_UP, 4 JUMP_DOWN, 2 MANTLE_ON                                 |
| la        | 1,034  | 2,526      | 66      | -                   | 19: 8 MANTLE_OVER, 6 MANTLE_ON, 4 JUMP_DOWN, 1 LADDER_UP                  |
| meltdown  | 772    | 2,067      | 21      | -                   | 30: 16 MANTLE_ON, 6 MANTLE_OVER, 4 JUMP_DOWN, 4 LADDER_UP                 |
| nightclub | 668    | 1,594      | 30      | -                   | 22: 10 MANTLE_ON, 8 MANTLE_OVER, 2 JUMP_DOWN, 2 LADDER_UP                 |
| nuketown  | 342    | 848        | 16      | -                   | 18: 10 MANTLE_ON, 4 JUMP_DOWN, 2 LADDER_UP, 2 MANTLE_OVER                 |
| overflow  | 959    | 2,604      | 90      | 4,582 of 7,210      | 24: 12 MANTLE_OVER, 8 MANTLE_ON, 3 JUMP_DOWN, 1 LADDER_UP                 |
| raid      | 750    | 1,935      | 57      | -                   | 21: 14 MANTLE_ON, 7 JUMP_DOWN                                             |
| slums     | 527    | 1,321      | 37      | -                   | 8: 4 JUMP_DOWN, 4 MANTLE_OVER                                             |
| socotra   | 656    | 1,609      | 29      | 2,102 of 3,738      | 27: 12 MANTLE_ON, 8 MANTLE_OVER, 5 JUMP_DOWN, 2 LADDER_UP                 |
| turbine   | 809    | 1,963      | 37      | -                   | 31: 13 MANTLE_ON, 9 JUMP_DOWN, 9 MANTLE_OVER                              |
| village   | 597    | 1,440      | 16      | -                   | 27: 14 MANTLE_ON, 8 MANTLE_OVER, 4 JUMP_DOWN, 1 LADDER_UP                 |
| all 15    | 11,350 | 29,043     | 635     | 22,838 of 52,242    | 361: 156 MANTLE_ON, 97 MANTLE_OVER, 83 JUMP_DOWN, 22 LADDER_UP, 3 SPECIAL |

## Nodes

- **Position:** the entity's or node's origin through `metadata.to_engine`,
  exactly as `gameplay.world` converts an entity's `at:` (inches → metres, CoD
  Z-up → engine Y-up, to the millimetre). Never snapped here.
- **Yaw:** engine yaw = CoD yaw − 90°, in radians (CoD yaw θ faces engine
  (cos θ, 0, −sin θ), which `metadata.facing` also uses; the player faces
  (−sin φ, 0, −cos φ)). `HAS_YAW` is set exactly when the entity has `angles` —
  which is when PathData's spawnflags carry `vocab.HAS_YAW_SPAWNFLAG` (0x8000,
  AW 0x80000).
- **Type:** from the classname (`vocab.CLASSNAME_TYPES`, the same in every game)
  or from PathData's type number (`vocab.GAME_TYPES`, numbered per game: MW3 as
  `IW5_Assets.h`, Black Ops as `T5_Assets.h`, Black Ops II as its server's PDB,
  Ghosts as x64-zt's IW6 enum, and AW as Ghosts). The games agree up to `COVER_LEFT` (7) and part after it.
  `NEGOTIATION_BEGIN`/`END` become `TRAVERSE_BEGIN`/`END`. A type with no standard
  name (Ghosts' `*_3D`, which never ship) is an export error.
- **Name:** the node's `targetname`.
- **Stance:** 0 (not stated). The compiler's cover-stance bits (0x200, 0x400,
  0x800; AW 0x2000–0x8000) and the entity's 0x4/0x8/0x10 are where it would come
  from, but what each bit means is inferred, not established.
- **Abilities:** 0. AW's `pathAbility` is 0 on every node of every MP map, and
  no other game has one.

## Links

| Game data                                      | In the file                                                          |
| ---------------------------------------------- | -------------------------------------------------------------------- |
| `fDist`                                        | `game cost`, as stored (inches, unconverted): a cost, not a distance |
| `negotiationLink` = 1                          | kind `TRAVERSE`, flag `NEGOTIATION`, and the pair's traversal index  |
| no link back from the target                   | flag `ONE_WAY_IN_GAME`                                               |
| `disconnectCount` > 0                          | flag `START_DISCONNECTED` (no shipped link has one)                  |
| every link read from compiled path data        | flag `GAME`                                                          |
| `flags` 1/2 (cover to cover), bad-place counts | dropped                                                              |
| Black Ops II `flags` 0x10 (redundant)          | the link is left out, counted in `links.unsearched`                  |
| Black Ops II `flags` 0x08, 0x20                | dropped (who else may use it: a double-width AI, a quadrotor)        |

`fDist` is the horizontal distance on a walk link but not on a traversal: Black
Ops stores a constant 15.0 on every negotiation link, and AW about 1.8× the
distance on 20 exo links. Hence "a cost, never a distance".

## Traversals

A traversal is a `NEGOTIATION_BEGIN` whose `target` names exactly one
`NEGOTIATION_END` (by its `targetname`). The animscript is on the begin node,
under entity key `1983` (MW3), `animscript` (Black Ops, Black Ops II), `52`
(Ghosts) or `71` (AW) (`vocab.ANIMSCRIPT_KEYS`), and PathData's own `animscript`
field agrees. A Black Ops II begin with none is a hint, named by its spawnflag
([above](#black-ops-ii-from-the-map-zone)).

**The kind comes from the animscript's name**, through
`vocab.traversal_kind(game, animscript)`: an exact per-game table
(`vocab.ANIMSCRIPT_KINDS`), then a per-game family prefix for `SPECIAL`
(`vocab.SPECIAL_PREFIXES`), else `UNKNOWN`. The number in a name is the obstacle
the animation was made for, not the pair's rise, so the kind never comes from
the geometry; whether our player can make a move is decided at load from the
two nodes' positions. Nothing is dropped from the file for being out of reach.

Pairs per animscript, over every zone read (MW3's 22 Survival zones, 16 Black
Ops maps, 21 Ghosts zones, 16 AW zones):

| Game   | Animscript (pairs)                                                                                                    | Kind                        |
| ------ | --------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| MW3    | `step_up_32` (21), `stepup_52` (33)                                                                                   | `STEP_UP`                   |
| MW3    | `jumpdown_40` (31), `jumpdown_56` (23), `jumpdown_96` (48), `jumpdown_130` (12), `berlin_jumpdown_28` (2)             | `JUMP_DOWN`                 |
| MW3    | `wall_over_40` (41), `wall_hop` (5), `window_over_40` (2), `traverse_window_terminal` (3)                             | `MANTLE_OVER`               |
| MW3    | `jump_across_72` (4), `jump_across_100` (2)                                                                           | `JUMP_ACROSS`               |
| MW3    | `ladder_up` (16)                                                                                                      | `LADDER_UP`                 |
| BO1    | `mantle_on_40` (11), `mantle_on_56` (20), `mantle_on_96` (2)                                                          | `MANTLE_ON`                 |
| BO1    | `mantle_over_40` (114), `mantle_window_36` (44), `zombie_mantle_over_40` (60)                                         | `MANTLE_OVER`               |
| BO1    | `jump_down_40` (13), `jump_down_56` (13), `jump_down_96` (6)                                                          | `JUMP_DOWN`                 |
| BO1    | `zombie_jump_down_40` (1), `_72` (3), `_120` (1), `_127` (1), `_190` (5), `_240` (2), `_286` (2)                      | `JUMP_DOWN`                 |
| BO1    | `zombie_wall_crawl_drop` (5), `zombie_wall_crawl_drop_quick` (7), `zombie_quad_vent_jump_down` (5)                    | `JUMP_DOWN`                 |
| BO2    | `mantle_over_40` (95), `mantle_over_36` (2)                                                                           | `MANTLE_OVER`               |
| BO2    | `mantle_on_40` (2), `mantle_on_56` (3); hint `MANTLE` (151)                                                           | `MANTLE_ON`                 |
| BO2    | `jump_down_40` (6), `jump_down_56` (6); hint `FALL` (71)                                                              | `JUMP_DOWN`                 |
| BO2    | hint `LADDER` (22)                                                                                                    | `LADDER_UP`                 |
| BO2    | `generic` (3: drone's, playing its `script_animation`, `jump_over_wall_drone`)                                        | `SPECIAL`                   |
| Ghosts | `step_up` (272)                                                                                                       | `STEP_UP`                   |
| Ghosts | `jump_down` (406), `jump_down_40` (389), `jump_down_80` (550), `step_down` (25)                                       | `JUMP_DOWN`                 |
| Ghosts | `jump_up_40` (606), `jump_up_80` (268), `jump_standing_80` (28)                                                       | `JUMP_UP`                   |
| Ghosts | `wall_hop` (269), `window_over_40` (179), `wall_over` (5), `window_over_quick` (3)                                    | `MANTLE_OVER`               |
| Ghosts | `jump_across_72` (109), `jump_across` (2)                                                                             | `JUMP_ACROSS`               |
| Ghosts | `ladder_up` (50)                                                                                                      | `LADDER_UP`                 |
| Ghosts | `alien_*` (409, Extinction only)                                                                                      | `SPECIAL`                   |
| AW     | `stepup_112` (3)                                                                                                      | `STEP_UP`                   |
| AW     | `jump_down` (7), `jump_down_40` (240), `jump_down_80` (542), `jumpdown_40` (2), `jumpdown_96` (8), `jumpdown_130` (1) | `JUMP_DOWN`                 |
| AW     | `jump_up_40` (204), `jump_up_80` (261), `jump_standing_80` (10)                                                       | `JUMP_UP`                   |
| AW     | `window_over_40` (246), `wall_hop` (84), `mantle_over_low_cover_40` (5)                                               | `MANTLE_OVER`               |
| AW     | `jump_across_72` (7)                                                                                                  | `JUMP_ACROSS`               |
| AW     | `ladder_up` (30), `ladder_down` (1)                                                                                   | `LADDER_UP` / `LADDER_DOWN` |
| AW     | `boost_*` (1,670: exo moves), `bot_*` (18: `bot_walk_forward`)                                                        | `SPECIAL`                   |

By kind:

| Kind          | MW3 | BO1 | BO2 | Ghosts | AW    |
| ------------- | --- | --- | --- | ------ | ----- |
| `STEP_UP`     | 54  | -   | -   | 272    | 3     |
| `MANTLE_ON`   | -   | 33  | 156 | -      | -     |
| `MANTLE_OVER` | 51  | 218 | 97  | 456    | 335   |
| `JUMP_DOWN`   | 116 | 64  | 83  | 1,370  | 800   |
| `JUMP_UP`     | -   | -   | -   | 902    | 475   |
| `JUMP_ACROSS` | 6   | -   | -   | 111    | 7     |
| `LADDER_UP`   | 16  | -   | 22  | 50     | 30    |
| `LADDER_DOWN` | -   | -   | -   | -      | 1     |
| `SPECIAL`     | -   | -   | 3   | 409    | 1,688 |

**The zombies maps' own** are exact rows too, never a `zombie_` prefix, so a
zombies map with a script not listed reports `UNKNOWN`. Each is
`animscripts/traverse/<name>.gsc`, in `common_zombie(_patch).ff` or the map zone
(dumped by [reverse/t5-zombies](../../reverse/t5-zombies/README.md)), and is
mapped by what it plays; every pair's end is below or level with its begin:

| Animscript                       | What the GSC does                                                                                                                                                        | Rise (in)   | Kind          |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- | ------------- |
| `zombie_mantle_over_40`          | `wall_hop_zombie`: `ai_zombie_traverse_*` by speed (the window climb-in), a crawler's and a quad's own, a dog's wall hop                                                 | 0           | `MANTLE_OVER` |
| `zombie_jump_down_<n>`           | `ai_zombie_jump_down_<n>` standing, `ai_zombie_crawl_jump_down_*` legless; some a quad's or `dog_jump_down(n, 7)` too                                                    | -48 … -244  | `JUMP_DOWN`   |
| `zombie_quad_vent_jump_down`     | quads only: `ai_zombie_quad_jump_down_vent` (pentagon)                                                                                                                   | -114        | `JUMP_DOWN`   |
| `zombie_wall_crawl_drop(_quick)` | a quad crawls down a wall: `nogravity` + `noclip`, `ai_zombie_quad_crawl_sprint_wall` looped for the height to the ground, then `ai_zombie_quad_wall_jump_off` (theater) | -653 … -799 | `JUMP_DOWN`   |

A name missing from the tables maps to `UNKNOWN`, which an exporter should
report: it is a map the research did not read.

## At load

What the bake ([../engine/navigation.md](../engine/navigation.md)) makes of
MW3's files against our collision and movement. Every traversal on the 22
worlds was walked in simulation (`derive: { neighbours: 0 }`, so the traversals
alone), and **221 of the 243 validate**:

| Kind          | Valid | Invalid | Why the invalid ones fail                                                                                                                                                                    |
| ------------- | ----- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `JUMP_DOWN`   | 109   | 7       | An end node with no floor under it (`NODE`)                                                                                                                                                  |
| `MANTLE_OVER` | 49    | 2       | One end node with no floor; hardhat's `wall_hop`, where no mantle starts                                                                                                                     |
| `STEP_UP`     | 43    | 11      | 5 rise 1.54–1.66 m, past `MAX_CLIMB` (1.45 m); 5 rise 1.20–1.36 m under a mantle volume whose top is 0.2–0.4 m above the ledge, past the mantle's 0.15 m tolerance; 1 end node with no floor |
| `LADDER_UP`   | 14    | 2       | No ladder volume near either (terminal, shipbreaker), and 2 m is past a mantle                                                                                                               |
| `JUMP_ACROSS` | 6     | 0       |                                                                                                                                                                                              |

- **Nine traversal end nodes float over nothing we collide with**, 3.6–5.2 m
  above our floor: 2 on dome, 2 on paris, 2 on roughneck, 1 each on moab,
  terminal and bravo. [inferred] Something the game collides with and our
  export does not (a static model, [iw5-static-models](../../reverse/iw5-static-models/README.md))
  stands where they land. Snapping them further down would guess.
- **`step_up_32` and `stepup_52` are mantles or jumps for our player, not
  steps**, as reverse/cod-pathdata §5 predicted: of the 43 that validate, every
  one needed a jump or a mantle.
- **Spawn origins are authored above the floor** too, about 2 m on dome: a
  spawn is grounded before it is matched to a node. Grounded, every spawn on
  dome (220) and mogadishu (213) lies by a node in the graph's largest strongly
  connected component.
- **Entity nodes sit higher on some maps than others:** a median 0.67 m above
  our floor on dome, 0.71 m on mogadishu and 1.11 m on terminal, and no usable
  node more than 2.04 m.

### The game's own links

Where the file ships the game's walk links, every one is walked in simulation;
nothing is derived. The plan's guard is that at least 85% of them validate,
since a lower rate would more likely be our follower than the data
(`tests/navBakeWorld.ts`'s `GAME_LINK_FLOOR`). Measured in
`packages/game-server/tests/navBakeGhosts.test.ts` and `navBakeAw.test.ts`,
which pin the numbers:

| World       | Usable nodes                            | Game walk links valid    | Between usable nodes     | Invalid, by reason            | Bake CPU |
| ----------- | --------------------------------------- | ------------------------ | ------------------------ | ----------------------------- | -------- |
| prisonbreak | 1,368 of 1,392 (21 no ground, 3 inside) | 13,241 of 13,589 (97.4%) | 13,241 of 13,326 (99.4%) | 263 NODE, 85 STUCK            | 35 s     |
| prison (AW) | 2,690 of 2,726 (34 no ground, 2 inside) | 44,194 of 45,341 (97.5%) | 44,194 of 44,750 (98.8%) | 591 NODE, 322 FELL, 234 STUCK | 97–101 s |

| Kind          | prisonbreak valid / invalid | prison valid / invalid |
| ------------- | --------------------------- | ---------------------- |
| `JUMP_DOWN`   | 80 / 5                      | 72 / 6                 |
| `JUMP_UP`     | 25 / 21                     | 13 / 43                |
| `MANTLE_OVER` | 7 / 4                       | 26 / 4                 |
| `STEP_UP`     | 10 / 1                      | -                      |
| `JUMP_ACROSS` | 6 / 2                       | -                      |
| `LADDER_UP`   | 4 / 0                       | 2 / 0                  |
| `SPECIAL`     | -                           | 0 / 179                |

- **The compiled nodes need only settling:** a median 2 cm above our floor on
  both, 6–9 cm at the 95th percentile, none further than 0.25 m.
- **`JUMP_UP` fails most**, as reverse/cod-pathdata §5 predicted: `jump_up_80`
  and `jump_standing_80` rise past our mantle, and AW's rise further.
- **`SPECIAL` never validates:** AW's exo `boost_*` moves have no follower move
  (`NO_MOVE`), so a bot on AW walks and mantles where the game's bots boost.
- **322 of prison's walk links `FELL`:** the follower dropped far below both
  ends, where the game's character did not. [inferred] Edges our collision
  lacks, as the nodes floating over nothing (34) suggest.
- **Every spawn on prison lies by a node in the largest strongly connected
  component** (304 of 304; 1,877 nodes). **prisonbreak has no spawn to
  connect:** Ghosts' MP spawns are not in its entity lump
  ([games.md](games.md#ghosts-iw6)), so the world has only its placeholder
  spawn, which stands on no node. The `chase` gametype admits AW for that
  reason and not Ghosts.
- **The bake is all simulation, and slow:** 35 s of CPU on prisonbreak and
  about 100 s on prison, against 5.4 s on dome
  ([../engine/navigation.md](../engine/navigation.md#budgets)).

### Black Ops at load

Every Black Ops world, baked against its exported collision
(`packages/game-server/tests/navBakeBo1.test.ts` pins nuked, cairo and theater).
The game walk links clear the guard on every one, **95.4% over all 16**; the
graph they leave does not hold together:

| World       | Usable        | Game walk links valid   | Invalid, by reason              | Bake CPU | Spawns by the largest component | Farther than 8 m from a node | Without TDM's deleted brush models |
| ----------- | ------------- | ----------------------- | ------------------------------- | -------- | ------------------------------- | ---------------------------- | ---------------------------------- |
| nuked       | 314 / 316     | 1,464 / 1,506 (97.2%)   | 21 STUCK, 18 NODE, 3 TIMEOUT    | 1.5 s    | 262 / 267 (289 nodes)           | 5                            | 262 / 267                          |
| firingrange | 462 / 462     | 2,696 / 2,702 (99.8%)   | 6 STUCK                         | 2.9 s    | 203 / 233 (401)                 | 30                           | 203 / 233                          |
| array       | 906 / 911     | 4,386 / 4,552 (96.4%)   | 130 STUCK, 32 NODE, 4 TIMEOUT   | 4.8 s    | 114 / 234 (509)                 | 10                           | 224 / 234 (876)                    |
| cairo       | 653 / 655     | 3,112 / 3,289 (94.6%)   | 152 STUCK, 25 NODE              | 2.8 s    | 60 / 283 (294)                  | 23                           | 260 / 283 (583)                    |
| cosmodrome  | 577 / 595     | 2,748 / 2,968 (92.6%)   | 130 STUCK, 90 NODE              | 3.4 s    | 220 / 355 (274)                 | 23                           | 332 / 355 (546)                    |
| cracked     | 871 / 873     | 4,814 / 5,024 (95.8%)   | 182 STUCK, 25 NODE, 3 TIMEOUT   | 5.7 s    | 207 / 471 (410)                 | 62                           | 409 / 471 (808)                    |
| crisis      | 670 / 676     | 2,688 / 2,790 (96.3%)   | 52 STUCK, 50 NODE               | 3.3 s    | 199 / 349 (373)                 | 13                           | 336 / 349 (628)                    |
| duga        | 795 / 802     | 4,491 / 4,668 (96.2%)   | 103 STUCK, 74 NODE              | 4.0 s    | 179 / 347 (381)                 | 34                           | 304 / 347 (722)                    |
| hanoi       | 655 / 665     | 3,082 / 3,245 (95.0%)   | 94 NODE, 69 STUCK               | 2.8 s    | 167 / 242 (327)                 | 9                            | 215 / 242 (608)                    |
| havoc       | 539 / 549     | 2,268 / 2,474 (91.7%)   | 127 STUCK, 76 NODE, 3 TIMEOUT   | 3.6 s    | 47 / 258 (198)                  | 5                            | 187 / 258 (411)                    |
| mountain    | 445 / 447     | 1,890 / 1,946 (97.1%)   | 40 STUCK, 14 NODE, 2 FELL       | 1.9 s    | 211 / 292 (360)                 | 62                           | 230 / 292 (394)                    |
| radiation   | 550 / 554     | 2,075 / 2,139 (97.0%)   | 48 STUCK, 14 NODE, 2 TIMEOUT    | 1.7 s    | 210 / 275 (305)                 | 6                            | 269 / 275 (521)                    |
| russianbase | 591 / 597     | 2,925 / 3,015 (97.0%)   | 46 STUCK, 44 NODE               | 3.1 s    | 166 / 314 (266)                 | 0                            | 314 / 314 (549)                    |
| villa       | 735 / 735     | 3,213 / 3,253 (98.8%)   | 39 STUCK, 1 TIMEOUT             | 2.4 s    | 195 / 267 (410)                 | 4                            | 263 / 267 (687)                    |
| theater     | 1,565 / 1,568 | 15,238 / 15,924 (95.7%) | 601 STUCK, 82 NODE, 3 TIMEOUT   | 19.3 s   | 6 / 14 (139)                    | 0                            | -                                  |
| pentagon    | 1,385 / 1,392 | 13,755 / 14,751 (93.2%) | 870 STUCK, 104 NODE, 22 TIMEOUT | 11.8 s   | 2 / 16 (193)                    | 0                            | -                                  |

"Spawns by the largest component" counts the spawns whose nearest node, within
8 m, is in the graph's largest strongly connected component (its size in
brackets); the game's own graph is one component on every MP map (cracked: all
but 4 nodes).

- **Script brush models the game deletes are walls in our collision**, and they
  cut the graph apart. A Black Ops gametype hands `_gameobjects::main` the names
  it allows (TDM: `tdm`), and it deletes every entity whose space-separated
  `script_gameobjectname` names none of them (common_mp.ff's
  `maps/mp/gametypes/_gameobjects.gsc`). The wager modes' barriers
  (`oic gun hlnd shrp`: 4 to 98 brush models on 12 of the 14 MP maps) close
  whole streets, 14 m tall, and `brushmodels.py` makes every `script_brushmodel`
  solid. Every one of the 75 stuck walk links across cairo's cut has one in its
  way. Exported without the brush models TDM deletes, the bake gives the last
  column, and walk-link validity on the 14 MP maps rises from 96.1% to 97.6%.
  Other games carry gametype brush models too (`bombzone`, `hq`, `sab` on every
  IW map, AW's `horde`), but the MW3 and AW bakes measured connect every spawn.
- **`MANTLE_OVER` fails 133 of 158:** `mantle_over_40` and `mantle_window_36`
  cross 40-inch walls and windows, and only 24 of 114 `mantle_over_40` have a
  mantle volume near them (reverse/cod-pathdata §5): our player has no mantle
  there. It is what keeps two of firingrange's areas (33 and 28 nodes) apart.
  `MANTLE_ON` validates 22 of 33, `JUMP_DOWN` 28 of 32.
- **Nodes are authored above the floor:** a median 0.6–1.0 m above ours, no
  usable one more than 2.5 m, as the MW3 lump's are.
- **A sparser graph:** up to 62 spawns a map stand more than 8 m from any node.
- **The zombies maps are cut into rooms.** [inferred] Their doors and debris
  are bought open in the game and the window barricades torn down; our
  collision has them shut. The rows for theater and pentagon were measured while
  their 92 `zombie_*` traversals were still `SPECIAL`; they are now
  `MANTLE_OVER` and `JUMP_DOWN` ([above](#traversals)).
- **A zombie is not our player there.** Theater's spawners stand outside the
  windows, and the outside joins the inside only through the 27
  `zombie_mantle_over_40` climbs, which our player cannot make: the windows are
  player-clipped, and 43 of the 54 traversals fail the bake. An actor goes by the
  game's links instead ([actors](../engine/actors.md#where-it-goes)): with every
  door shut and the 22 window clips (`pf*_auto1`, AI-only, `clip:0x08020000`)
  removed, each of the three foyer `zombie_spawner` points reaches the start room
  in 5–8 links through one window climb (4.6–7.7 s of plan cost); with them
  present, none does. 48 parts shut 572 actor links while present, against 24
  parts and 548 links for a bot. A running zombie spawned at the first climbs in
  over `ai_zombie_traverse_v5` (1.57 s) and swings at a player on a start spawn
  8.7 s after it spawns (`game-server/tests/zombiesNav.test.ts`).
- **The bake is quick:** 1.5–6 s of CPU on an MP map, 12–19 s on the zombies
  maps.
- **`chase` does not admit Black Ops:** with the barriers in the collision,
  most MP maps start a chase in pieces.

### Black Ops II at load

Every Black Ops II world, baked against its exported collision
(`packages/game-server/tests/navBakeBo2.test.ts` pins la and carrier; the other
13 run with `NAV_BAKE_ALL`). Unlike Black Ops', the graph holds together: on 11
of the 15 maps at least 90% of the spawns stand by a node in the largest strongly
connected component, and on the rest most of the others stand farther than 8 m
from any node.

| World     | Usable        | Game walk links valid | File links invalid, by reason            | Bake CPU | Spawns by the largest component | Farther than 8 m from a node |
| --------- | ------------- | --------------------- | ---------------------------------------- | -------- | ------------------------------- | ---------------------------- |
| carrier   | 698 / 734     | 1,771 / 1,904 (93.0%) | 115 NODE, 20 STUCK, 11 TIMEOUT           | 3.6 s    | 281 / 290 (652 nodes)           | 8                            |
| dockside  | 1,212 / 1,223 | 3,138 / 3,457 (90.8%) | 233 STUCK, 86 NODE, 24 TIMEOUT           | 6.2 s    | 314 / 318 (992)                 | 0                            |
| drone     | 1,172 / 1,188 | 3,062 / 3,130 (97.8%) | 34 NODE, 34 STUCK, 13 TIMEOUT, 3 NO_MOVE | 4.9 s    | 265 / 269 (949)                 | 4                            |
| express   | 662 / 665     | 1,576 / 1,632 (96.6%) | 41 STUCK, 22 NODE, 4 TIMEOUT             | 3.5 s    | 290 / 294 (613)                 | 4                            |
| hijacked  | 420 / 426     | 969 / 1,013 (95.7%)   | 40 NODE, 8 STUCK                         | 1.8 s    | 256 / 285 (368)                 | 24                           |
| la        | 993 / 1,034   | 2,400 / 2,526 (95.0%) | 109 NODE, 20 STUCK, 9 TIMEOUT            | 4.6 s    | 282 / 285 (946)                 | 1                            |
| meltdown  | 763 / 772     | 1,884 / 2,067 (91.1%) | 102 STUCK, 87 NODE, 13 TIMEOUT           | 3.2 s    | 241 / 272 (690)                 | 5                            |
| nightclub | 665 / 668     | 1,582 / 1,594 (99.2%) | 10 TIMEOUT, 7 NODE, 5 STUCK              | 3.4 s    | 287 / 300 (619)                 | 13                           |
| nuketown  | 342 / 342     | 838 / 848 (98.8%)     | 11 STUCK, 11 TIMEOUT                     | 1.9 s    | 290 / 292 (307)                 | 2                            |
| overflow  | 948 / 959     | 2,519 / 2,604 (96.7%) | 46 NODE, 41 STUCK, 12 TIMEOUT            | 6.6 s    | 294 / 327 (803)                 | 26                           |
| raid      | 737 / 750     | 1,864 / 1,935 (96.3%) | 51 NODE, 22 STUCK, 3 TIMEOUT             | 3.1 s    | 274 / 279 (714)                 | 2                            |
| slums     | 517 / 527     | 1,271 / 1,321 (96.2%) | 26 NODE, 24 STUCK, 3 TIMEOUT             | 2.1 s    | 262 / 281 (465)                 | 17                           |
| socotra   | 652 / 656     | 1,585 / 1,609 (98.5%) | 18 STUCK, 12 TIMEOUT, 8 NODE             | 3.3 s    | 246 / 284 (612)                 | 35                           |
| turbine   | 798 / 809     | 1,901 / 1,963 (96.8%) | 61 NODE, 13 TIMEOUT, 6 STUCK             | 7.1 s    | 317 / 322 (754)                 | 2                            |
| village   | 585 / 597     | 1,392 / 1,440 (96.7%) | 51 NODE, 9 TIMEOUT, 6 STUCK              | 2.3 s    | 292 / 295 (527)                 | 2                            |

- **Leaving the redundant links out costs little.** Baked with them in, carrier
  connects 282 spawns rather than 281 and dockside 318 rather than 314, for 2–3×
  the bake CPU (5.1 s and 13.5 s); overflow is unchanged.
- **`MANTLE_OVER` fails 89 of 97:** they are the AI's `mantle_over_40` vaults over
  a 40-inch wall, as on Black Ops. `MANTLE_ON` (151 of them the bot's own
  `MANTLE` hints) validates 67 of 156, `JUMP_DOWN` 76 of 83, `LADDER_UP` 17 of
  22; drone's 3 `generic` scripts have no move (`NO_MOVE`).
- **Nodes are authored above the floor**, a median 0.6–1.0 m and no usable one
  more than 2.5 m, as on Black Ops; 40 of la's nodes have no floor under them.

## What is left out

| Source data                                                        | Why                                                                                 | Counted in META as            |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------- | ----------------------------- |
| Ghosts and AW zone nodes (one type-0 node per path zone, appended) | Not places: a coarse graph over the fine one. `ZONE` is reserved for it             | `zoneNodes`                   |
| Ghosts' dynamic-group nodes (37 over 5 maps)                       | Their positions are in a moving parent's frame; `DYNG` is reserved for it           | `dynamicNodes`                |
| Black Ops' 128 empty runtime node slots                            | Not in `nodeCount`, empty in every zone                                             | -                             |
| pathVis, the node tree, chain nodes                                | Visibility is not needed to walk; the tree and chains are rebuilt at load if wanted | -                             |
| exposure, noPeekVis, visBulletBlockers, pathDynStates              | Combat-AI and runtime data; `COVR` and `DSTA` are reserved                          | -                             |
| Links touching a skipped node                                      | Their other end is not in the file                                                  | `links.droppedToSkippedNodes` |

Extinction's `JUMP`/`JUMP_ATTACK` nodes link each other with
`negotiationLink` = 1 and no animscript. Neither Extinction map is imported;
should one be, those links need a decision the table above does not make.
