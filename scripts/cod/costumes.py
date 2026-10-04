"""Advanced Warfare's costumes: which models dress a player, as the game's own tables say.

An AW player is not a body model. A costume is eleven ids, one per category
(`gender`, `shirt`, `head`, `pants`, `gloves`, `shoes`, `kneepads`, `gear`, `hat`,
`eyewear`, `exo`), each `0xCCVVIII`: the category's byte, a material variant and
the item's id. Three string tables turn one into models, all in
`english/eng_patch_code_post_gfx_mp.ff` (dumped by `s1/dumpers/stringtable.py`):

- `mp/costumeidtable.csv`: an item's row, the tags it contributes (`female`,
  `skin2`, `helmet`, the head's own name) and the index its models are listed by;
- `mp/costumemodeltable.csv`: every model of an item, each with conditions on the
  costume's tags (`!female`, `kneepads`, `cormack`) -- a shirt has one model per
  gender and skin tone, a hat one per head it is cut for;
- `mp/botcostumetable.csv` and kin: whole costumes, one per column.

Pure: tables in, model names out. What is built from them: `aw_cast.py`.
"""

import csv
import os
from collections import namedtuple

TABLE_DIR = "mp"
ID_TABLE = "costumeidtable.csv"
MODEL_TABLE = "costumemodeltable.csv"
# The costumes the game dresses its bots in, and a practice round's players: the
# only whole outfits it ships, since a real player builds their own.
BOT_TABLE = "botcostumetable.csv"

# The category byte of a costume id, as the MP scripts' `costumetypehexids` spell it.
CATEGORIES = {
    0x61: "gender",
    0x62: "shirt",
    0x63: "head",
    0x64: "pants",
    0x66: "hat",
    0x67: "gear",
    0x68: "kneepads",
    0x69: "gloves",
    0x6A: "shoes",
    0x6B: "exo",
    0x6C: "eyewear",
}
# `gender` has no model; its second style is the one the model table calls `female`.
FEMALE_GENDER_ID = 2
# `costumemodeltable.csv`'s columns.
MODEL, CATEGORY, ID_INDEX, TRANSIENT, VIEWMODEL = 0, 1, 2, 5, 7
CONDITIONS = slice(10, 18)  # group1..group8
# `costumeidtable.csv`'s: category, index (the model table's `idIndex`), ..., id, ..., tags.
ROW_CATEGORY, ROW_INDEX, ROW_ID = 0, 1, 4
ROW_TAGS = slice(9, None)
# A model the game keeps resident rather than streaming from a `mp_<category>_*_tr` zone.
RESIDENT = "none"

Tables = namedtuple("Tables", "ids models")
# `parts`: {category: model}; `views`: {category: its first-person model};
# `variants`: {category: a nonzero material variant the model is drawn without}.
Costume = namedtuple("Costume", "ids tags parts views variants resident")


def read_csv(path):
    with open(path, newline="", encoding="utf-8") as fh:
        return [row for row in csv.reader(fh)]


def read_tables(tables_root):
    """The id and model tables under a string-table dump's root."""
    ids = read_csv(os.path.join(tables_root, TABLE_DIR, ID_TABLE))
    models = read_csv(os.path.join(tables_root, TABLE_DIR, MODEL_TABLE))
    return Tables({(r[ROW_CATEGORY], int(r[ROW_ID])): r for r in ids if len(r) > ROW_ID and r[ROW_ID].isdigit()}, models[1:])


def costume_columns(path):
    """Each costume a table holds, as its ids in category order: [[hex id, ...], ...]."""
    rows = [r for r in read_csv(path) if r and r[0] in CATEGORIES.values()]
    return [[row[c] for row in rows] for c in range(1, min(len(r) for r in rows))]


def split_id(value):
    """`0x6200001` -> ("shirt", variant 0, id 1)."""
    v = int(value, 16)
    category = CATEGORIES.get((v >> 20) & 0xFF)
    if category is None:
        raise ValueError(f"{value}: no costume category {(v >> 20) & 0xFF:#x}")
    return category, (v >> 12) & 0xFF, v & 0xFFF


def _holds(condition, tags):
    return condition[1:] not in tags if condition.startswith("!") else condition in tags


def resolve(ids, tables):
    """The models one costume dresses a player in.

    A category whose item has no model -- `none`, or a head a full mask replaces --
    is simply absent. More than one model answering an item's conditions is a
    reading this module does not have, and is refused rather than picked from.
    """
    items = {}
    for value in ids:
        category, variant, ident = split_id(value)
        row = tables.ids.get((category, ident))
        if row is None:
            raise ValueError(f"{value}: no {category} {ident} in {ID_TABLE}")
        items[category] = (row, variant)
    tags = {t for row, _ in items.values() for t in row[ROW_TAGS] if t}
    gender = items.get("gender")
    if gender and int(gender[0][ROW_ID]) == FEMALE_GENDER_ID:
        tags.add("female")
    parts, views, variants, resident = {}, {}, {}, {}
    for category, (row, variant) in items.items():
        if category == "gender":
            continue
        rows = [m for m in tables.models if m[CATEGORY] == category and m[ID_INDEX] == row[ROW_INDEX]]
        fit = [m for m in rows if all(_holds(c, tags) for c in m[CONDITIONS] if c)]
        if len({m[MODEL] for m in fit}) > 1:
            raise ValueError(f"{category} {row[ROW_ID]}: {', '.join(m[MODEL] for m in fit)} all fit {sorted(tags)}")
        if not fit:
            continue
        parts[category] = fit[0][MODEL]
        resident[category] = fit[0][TRANSIENT] == RESIDENT
        if len(fit[0]) > VIEWMODEL and fit[0][VIEWMODEL]:
            views[category] = fit[0][VIEWMODEL]
        if variant:
            variants[category] = variant
    return Costume(list(ids), tags, parts, views, variants, resident)


def first_items():
    """The costume of every category's id 1: the one whose models `common_mp.ff` keeps resident."""
    return [f"{byte << 20 | 1:#x}" for byte in sorted(CATEGORIES)]
