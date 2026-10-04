"""An AW costume is ids in, models out, through the game's own two tables."""

import pytest

from scripts.cod import costumes

# `costumeidtable.csv`: category, index, model start, collection, id, name, icon, hex, set, tags...
IDS = [
    ["gender", "1", "0", "0", "1", "LOOT_GENDER_STYLE1", "", "0x6100001", "", "", "", ""],
    ["gender", "2", "0", "0", "2", "LOOT_GENDER_STYLE2", "", "0x6100002", "", "", "", ""],
    ["shirt", "1", "0", "0", "1", "LOOT_ATLAS_SHIRT", "", "0x6200001", "7", "", "", ""],
    ["head", "1", "0", "0", "1", "LOOT_CORMACK", "", "0x6300001", "", "cormack", "skin0", ""],
    ["head", "2", "1", "0", "2", "LOOT_WATERS", "", "0x6300002", "", "waters", "skin1", "female"],
    ["hat", "1", "0", "0", "0", "LOOT_NONE_CAPS", "", "0x6600000", "", "", "", ""],
    ["hat", "2", "0", "0", "1", "LOOT_MASK", "", "0x6600001", "", "fullmask", "", ""],
    ["kneepads", "1", "0", "0", "0", "LOOT_NONE_CAPS", "", "0x6800000", "", "", "", ""],
    ["kneepads", "2", "0", "0", "1", "LOOT_KNEEPADS", "", "0x6800001", "5", "kneepads", "", ""],
    ["pants", "1", "0", "0", "1", "LOOT_KVA_PANTS", "", "0x6400001", "7", "", "", ""],
]
# `costumemodeltable.csv`: model, category, idIndex, primaryid, collision, transient, lob, viewmodel, mats, groups...
HEADER = ["model", "category", "idIndex", "primaryid", "collision", "transient override", "lobmodel", "viewmodel"]


def row(model, category, index, *groups, view="", transient=""):
    return [model, category, index, index, "1", transient, f"{model}_lob", view, "", "", *groups]


MODELS = [
    HEADER,
    row("mp_top_m", "shirt", "1", "!female", view="mp_view_top", transient="none"),
    row("mp_top_f", "shirt", "1", "female", view="mp_view_top_f"),
    row("mp_head_cormack", "head", "1", "!fullmask", transient="none"),
    row("mp_head_waters", "head", "2", "!fullmask"),
    row("mp_mask", "hat", "2"),
    row("mp_pants_k", "pants", "1", "kneepads"),
    row("mp_pants", "pants", "1", "!kneepads"),
    row("mp_kneepad", "kneepads", "2"),
]


@pytest.fixture
def tables(tmp_path):
    root = tmp_path / costumes.TABLE_DIR
    root.mkdir()
    (root / costumes.ID_TABLE).write_text("\n".join(",".join(r) for r in IDS) + "\n")
    (root / costumes.MODEL_TABLE).write_text("\n".join(",".join(r) for r in MODELS) + "\n")
    return costumes.read_tables(str(tmp_path))


def test_an_id_is_a_category_a_variant_and_an_item():
    assert costumes.split_id("0x6200001") == ("shirt", 0, 1)
    assert costumes.split_id("0x640A00C") == ("pants", 10, 12)
    with pytest.raises(ValueError):
        costumes.split_id("0x6D00001")


def test_each_item_takes_the_model_its_tags_choose(tables):
    c = costumes.resolve(["0x6100001", "0x6200001", "0x6300001", "0x6400001", "0x6800001", "0x6600000"], tables)
    assert c.parts == {"shirt": "mp_top_m", "head": "mp_head_cormack", "pants": "mp_pants_k", "kneepads": "mp_kneepad"}
    assert c.views == {"shirt": "mp_view_top"}
    assert c.resident["shirt"] and not c.resident["pants"]


def test_the_second_gender_is_the_one_the_models_call_female(tables):
    c = costumes.resolve(["0x6100002", "0x6200001", "0x6300002", "0x6400001", "0x6800000"], tables)
    assert c.parts["shirt"] == "mp_top_f" and c.parts["pants"] == "mp_pants"
    assert "female" in c.tags


def test_a_full_mask_leaves_no_head_and_a_variant_is_reported(tables):
    c = costumes.resolve(["0x6100001", "0x6202001", "0x6300001", "0x6600001"], tables)
    assert "head" not in c.parts and c.parts["hat"] == "mp_mask"
    assert c.variants == {"shirt": 2}


def test_two_models_answering_one_item_is_refused(tables):
    tables.models.append(row("mp_top_m_again", "shirt", "1"))
    with pytest.raises(ValueError, match="all fit"):
        costumes.resolve(["0x6100001", "0x6200001"], tables)


def test_the_default_costume_is_every_categorys_first_item():
    ids = costumes.first_items()
    assert len(ids) == len(costumes.CATEGORIES)
    assert {costumes.split_id(i)[2] for i in ids} == {1}


def test_a_costume_table_is_read_a_column_at_a_time(tmp_path):
    path = tmp_path / "bots.csv"
    path.write_text("gender,0x6100001,0x6100002\nshirt,0x6200001,0x6200002\n")
    assert costumes.costume_columns(str(path)) == [["0x6100001", "0x6200001"], ["0x6100002", "0x6200002"]]
