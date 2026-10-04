"""Black Ops' create-a-class scripts, which say which head and arms each body wears.

The trap they replace is the name reading the IW games use: every Black Ops head
shares two words with every body (`c_`, `mp`), so it would dress one faction in
the other's faces and look fine doing it.
"""

from scripts.cod.cac import factions_in, read_cast, side_of

BODY = """main()
{
	level.cac_assets[ "usa_cia" ][ "standard_mp" ] = "c_usa_cia_mp_body_standard";
	level.cac_assets[ "rus_spet" ][ "standard_mp" ] = "c_rus_spet_mp_body_standard";
	level.cac_assets[ "usa_cia" ][ "viewmodel" ][ "standard_mp" ] = "viewmodel_usa_cia_standard_arms";
	level.cac_assets[ "rus_spet" ][ "viewmodel" ][ "standard_mp" ] = "viewmodel_rus_spet_standard_arms";
}

get_default_head()
{
	return( "head_standard_mp" );
}
"""

HEAD = """main()
{
	level.cac_assets[ "usa_cia" ][ "head_standard_mp" ] = "c_usa_cia_mp_head_4";
	level.cac_assets[ "rus_spet" ][ "head_standard_mp" ] = "c_rus_spet_mp_head_4";
}
"""


def raw_dir(tmp_path, body=BODY, head=HEAD):
    (tmp_path / "mpbody").mkdir()
    (tmp_path / "mphead").mkdir()
    (tmp_path / "mpbody" / "standard_mp.gsc").write_text(body)
    (tmp_path / "mphead" / "head_standard_mp.gsc").write_text(head)
    return str(tmp_path)


def test_a_body_wears_its_own_factions_default_head_and_arms(tmp_path):
    cast = read_cast(raw_dir(tmp_path))
    assert cast["usa_cia"]["standard_mp"] == (
        "c_usa_cia_mp_body_standard",
        "c_usa_cia_mp_head_4",
        "viewmodel_usa_cia_standard_arms",
    )
    assert cast["rus_spet"]["standard_mp"][1] == "c_rus_spet_mp_head_4"


def test_a_class_with_no_head_is_left_out_rather_than_half_dressed(tmp_path):
    cast = read_cast(raw_dir(tmp_path, head=HEAD.replace('"rus_spet"', '"vtn_nva"')))
    assert "rus_spet" not in cast
    assert "usa_cia" in cast


def test_only_the_factions_the_zone_dumped_allies_first(tmp_path):
    cast = read_cast(raw_dir(tmp_path))
    assert factions_in(cast, {"c_rus_spet_mp_body_standard", "c_usa_cia_mp_body_standard"}) == ["usa_cia", "rus_spet"]
    assert factions_in(cast, {"c_rus_spet_mp_body_standard"}) == ["rus_spet"]


def test_a_zone_without_the_scripts_has_no_cast(tmp_path):
    assert read_cast(str(tmp_path)) == {}


def test_side_is_the_teamsets_answer():
    assert side_of("c_cub_rebels_mp_body_camo") == "allies"
    assert side_of("c_cub_tropas_mp_body_camo") == "axis"
    assert side_of("c_vtn_nva_mp_body_flak") == "axis"
    assert side_of("mp_body_delta_elite_assault_aa") is None
