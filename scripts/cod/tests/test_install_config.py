"""Finding a user's games: config precedence, Steam's VDF, multi-root installs, the 64-bit check, and slugs.

Everything is built in tmp_path; nothing here reads a real install.
"""

import os
import struct

import pytest

from scripts.cod import config, export, installs, steam
from scripts.cod.pe import is_pe32_plus

# -- Precedence ----------------------------------------------------------------------------------


def resolve(game="bo1", cli=None, environ=None, config_data=None, detected=None, use=None):
    return installs.resolve_install(
        game,
        cli_dirs=cli or {},
        cli_use=use or {},
        environ=environ or {},
        config_data=config_data or {},
        detect_fn=lambda g, u: [(detected, "steam")] if detected else [],
    )


def test_the_command_line_beats_the_environment_beats_the_config_beats_steam():
    everything = dict(
        cli={"bo1": ["/cli"]},
        environ={"COD_BO1_DIR": "/env"},
        config_data={"games": {"bo1": "/config"}},
        detected="/steam",
    )
    assert resolve(**everything).source == "cli"
    assert resolve(**{**everything, "cli": {}}).roots == [os.path.normpath("/env")]
    assert resolve(**{**everything, "cli": {}, "environ": {}}).source == "config"
    assert resolve(detected="/steam").roots == [os.path.normpath("/steam")]
    assert resolve().roots == [] and resolve().source is None


def test_a_source_is_the_whole_answer_not_merged_with_the_next():
    install = resolve(environ={"COD_BO1_DIR": os.pathsep.join(["/a", "/b"])}, config_data={"games": {"bo1": ["/c"]}})
    assert install.roots == [os.path.normpath("/a"), os.path.normpath("/b")]


def test_the_config_takes_a_folder_a_list_or_dirs_with_an_exe():
    assert resolve(config_data={"games": {"bo1": "/one"}}).roots == [os.path.normpath("/one")]
    assert resolve(config_data={"games": {"bo1": ["/a", "/b"]}}).roots == [os.path.normpath("/a"), os.path.normpath("/b")]
    install = resolve(config_data={"games": {"bo1": {"dirs": ["/a"], "exe": "/x/BlackOpsMP.exe"}}})
    assert install.roots == [os.path.normpath("/a")] and install.exe == os.path.normpath("/x/BlackOpsMP.exe")
    # The config's exe holds whichever source names the folders.
    assert resolve(cli={"bo1": ["/cli"]}, config_data={"games": {"bo1": {"dirs": [], "exe": "/x.exe"}}}).exe == "/x.exe"
    with pytest.raises(SystemExit, match="must be a folder"):
        resolve(config_data={"games": {"bo1": 7}})
    with pytest.raises(SystemExit, match="must be a folder"):
        resolve(config_data={"games": {"bo1": {"use": "retail"}}})


def test_game_dir_arguments_are_checked(monkeypatch):
    with pytest.raises(SystemExit, match="<game>=<value>"):
        config.set_cli(["/no/game"])
    with pytest.raises(SystemExit, match="no game 'bo9'"):
        config.set_cli(["bo9=/x"])
    with pytest.raises(SystemExit, match="--use takes one of"):
        config.set_cli(use=["mw3=retail"])
    config.set_cli(["mw3=/a", "mw3=/b"], ["mw3=depots"])
    try:
        assert config.cli_dirs() == {"mw3": ["/a", "/b"]} and config.cli_use() == {"mw3": "depots"}
    finally:
        config.set_cli()


def test_a_data_path_comes_from_its_old_variable_before_the_config():
    data = {"iw6_durango": "/config"}
    assert config.data_path("iw6_durango", environ={"IW6_DURANGO": "/env"}, config=data) == ("/env", "env")
    assert config.data_path("iw6_durango", environ={}, config=data) == ("/config", "config")
    assert config.data_path("iw6_durango", environ={}, config={}) == (None, None)


def test_every_game_describes_its_steam_folder_and_zones():
    for game, desc in config.games().items():
        assert desc["steam"]["folder"] and isinstance(desc["steam"]["app"], int), game
        assert desc["zones"] and desc["engine"], game


# -- Steam's VDF ---------------------------------------------------------------------------------

LIBRARYFOLDERS = r"""
"libraryfolders"
{
	// a comment, which Steam does not write but the format allows
	"0"
	{
		"path"		"%s"
		"label"		""
		"apps"
		{
			"42710"		"12345"
		}
	}
	"1"		"%s"
	"2"
	{
		"path"		"C:\\Games\\Steam \"Library\""
	}
}
"""


def test_the_vdf_parser_reads_blocks_strings_escapes_and_comments():
    data = steam.parse_vdf(LIBRARYFOLDERS % ("/one", "/two"))
    folders = data["libraryfolders"]
    assert folders["0"]["path"] == "/one" and folders["0"]["apps"] == {"42710": "12345"}
    assert folders["1"] == "/two"
    assert folders["2"]["path"] == 'C:\\Games\\Steam "Library"'


@pytest.mark.parametrize("text", ['"a" {', '"a" { "b" }', "}", '"a" "b', '{ "a" "b" }'])
def test_a_broken_vdf_is_an_error_not_an_empty_file(text):
    with pytest.raises(ValueError):
        steam.parse_vdf(text)


def test_steam_libraries_are_found_from_libraryfolders(tmp_path):
    client, other = tmp_path / "Steam", tmp_path / "Library2"
    for lib in (client, other):
        (lib / "steamapps" / "common").mkdir(parents=True)
    (other / "steamapps" / "common" / "Call of Duty Black Ops").mkdir()
    (client / "steamapps" / "libraryfolders.vdf").write_text(LIBRARYFOLDERS % (client, other))
    roots = [str(client), str(tmp_path / "missing")]
    assert steam.libraries(roots) == [str(client), str(other)]
    assert steam.find_install("Call of Duty Black Ops", roots) == str(other / "steamapps" / "common" / "Call of Duty Black Ops")
    assert steam.find_install("Call of Duty Ghosts", roots) is None


def test_steam_roots_per_platform():
    linux = steam.steam_roots("linux", {}, "/h")
    assert os.path.join("/h", ".local", "share", "Steam") in linux
    assert any("com.valvesoftware.Steam" in r for r in linux)
    assert steam.steam_roots("darwin", {}, "/h") == [os.path.join("/h", "Library", "Application Support", "Steam")]
    assert os.path.join("C:\\PF86", "Steam") in steam.steam_roots("win32", {"ProgramFiles(x86)": "C:\\PF86"}, "/h")


# -- Multi-root installs -------------------------------------------------------------------------

MW3 = {
    "zones": ["zone/english", "zone/dlc"],
    "search": ["main"],
    "common": ["zone/english/common_mp.ff", "zone/english/common.ff"],
    "exe": "iw5mp.exe",
    "engine": "iw5",
    "depots": [{"app": 1, "depot": 2, "manifest": "3", "holds": "x"}],
}


def touch(path, data=b""):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


def depots(tmp_path):
    """MW3 as four depots: base zones, one DLC folder, another DLC folder, the exe."""
    english, dlc1, dlc2, exe = (tmp_path / n for n in ("english", "dlc1", "dlc2", "exe"))
    touch(english / "zone" / "english" / "common_mp.ff")
    touch(english / "main" / "iw_00.iwd")
    touch(dlc1 / "zone" / "dlc" / "mp_terminal_cls.ff")
    touch(dlc1 / "main" / "iw_30.iwd")
    touch(dlc1 / "steam_api.dll")
    touch(dlc2 / "zone" / "dlc" / "mp_moab.ff")
    touch(exe / "iw5mp.exe", pe())
    return [str(p) for p in (english, dlc1, dlc2, exe)]


def pe(is64=False):
    """A minimal PE header: PE32, or PE32+."""
    head = bytearray(512)
    head[:2] = b"MZ"
    struct.pack_into("<I", head, 0x3C, 0x80)
    head[0x80:0x84] = b"PE\0\0"
    struct.pack_into("<H", head, 0x80 + 24, 0x20B if is64 else 0x10B)
    return bytes(head)


def test_each_path_is_looked_up_in_every_root_in_order(tmp_path):
    roots = depots(tmp_path)
    files = installs.resolve(MW3, installs.Install("mw3", roots, "config"))
    j = os.path.join
    assert files["zones"] == [j(roots[0], "zone", "english"), j(roots[1], "zone", "dlc"), j(roots[2], "zone", "dlc")]
    assert files["search"] == [j(roots[0], "main"), j(roots[1], "main")]
    assert files["exe"] == j(roots[3], "iw5mp.exe")
    # A common zone no root holds is still named, so its dump fails rather than the map losing props.
    assert files["common"] == [j(roots[0], "zone", "english", "common_mp.ff"), j(roots[0], "zone", "english", "common.ff")]


def test_an_explicit_exe_wins_and_a_missing_one_is_none(tmp_path):
    roots = depots(tmp_path)
    assert installs.resolve(MW3, installs.Install("mw3", roots, "config", exe="/x.exe"))["exe"] == "/x.exe"
    assert installs.resolve(MW3, installs.Install("mw3", roots[:3], "config"))["exe"] is None


# -- The 64-bit check ----------------------------------------------------------------------------


def test_pe32_plus_is_read_from_the_header(tmp_path):
    assert is_pe32_plus(touch(tmp_path / "a.exe", pe(is64=True)))
    assert not is_pe32_plus(touch(tmp_path / "b.exe", pe()))
    assert not is_pe32_plus(touch(tmp_path / "c.exe", b"not a PE"))


def test_the_32_bit_depots_pass(tmp_path):
    assert installs.sixty_four_bit(MW3, installs.Install("mw3", depots(tmp_path))) is None


def test_a_retail_install_with_steam_api64_is_64_bit(tmp_path):
    retail = tmp_path / "retail"
    touch(retail / "zone" / "english" / "mp_dome.ff")
    touch(retail / "steam_api64.dll")
    assert installs.sixty_four_bit(MW3, installs.Install("mw3", [str(retail)])) == str(retail)


def test_a_root_with_zones_and_a_pe32_plus_exe_is_64_bit(tmp_path):
    retail = tmp_path / "retail"
    touch(retail / "zone" / "english" / "mp_dome.ff")
    touch(retail / "iw5mp.exe", pe(is64=True))
    assert installs.sixty_four_bit(MW3, installs.Install("mw3", [str(retail)])) == str(retail)


def test_a_64_bit_exe_beside_no_zones_is_only_read_for_wavelets(tmp_path):
    """MW2's 32-bit depots ship no exe; the retail one is named alone, and only its tables are read."""
    retail = tmp_path / "retail"
    touch(retail / "iw5mp.exe", pe(is64=True))
    touch(retail / "steam_api64.dll")
    install = installs.Install("mw3", [*depots(tmp_path)[:3], str(retail)])
    assert installs.sixty_four_bit(MW3, install) is None


def test_the_64_bit_message_gives_the_depot_commands():
    text = installs.depot_instructions("mw3")
    assert "download_depot 42680 42683 6381783964590594065" in text and "cod.config.json" in text
    assert "download_depot 10180 10183 8707803059832053468" in installs.depot_instructions("mw2")


# -- Map zones and slugs -------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("name", "game", "world"),
    [
        ("mp_rust", "mw2", "rust-mw2"),
        ("mp_crash_snow", "mw2", "crash-snow-mw2"),
        ("zombie_theater", "bo1", "theater-bo1"),
        ("zm_transit", "bo2", "transit-bo2"),
        ("so_deltacamp", "mw3", "deltacamp-mw3"),
        ("mp_kgb", "cw", "kgb-cw"),
    ],
)
def test_a_map_not_in_maps_json_is_named_as_maps_json_names_its_maps(name, game, world):
    assert installs.default_world(name, game) == world


def test_map_zones_follow_each_games_rule(tmp_path):
    for name in ("mp_rust", "mp_rust_load", "mp_derail", "patch_mp", "common_mp", "mp_lost"):
        touch(tmp_path / "iw" / f"{name}.ff")
    assert sorted(installs.map_zones(config.games()["mw2"], [str(tmp_path / "iw")])) == ["mp_rust"]
    for name in ("mp_nuked", "zombie_theater", "zombie_theater_patch", "frontend"):
        touch(tmp_path / "t5" / f"{name}.ff")
    assert sorted(installs.map_zones(config.games()["bo1"], [str(tmp_path / "t5")])) == ["mp_nuked", "zombie_theater"]
    for name in ("zm_transit", "zm_transit_gump_farm", "zm_transit_patch", "mp_la"):
        touch(tmp_path / "t6" / f"{name}.ff")
    assert sorted(installs.map_zones(config.games()["bo2"], [str(tmp_path / "t6")])) == ["mp_la", "zm_transit"]


def test_export_takes_any_installed_map_and_names_its_world():
    games = {"mw2": {"zones": []}, "bo1": {"zones": []}}
    maps = [{"world": "rust-mw2", "map": "mp_rust", "game": "mw2"}]
    assert export.choose_map("mp_rust", None, None, games, maps) == maps[0]
    assert export.choose_map("mp_rust", None, "my-rust", games, maps)["world"] == "my-rust"
    assert export.choose_map("mp_crash", "mw2", None, games, maps) == {"world": "crash-mw2", "map": "mp_crash", "game": "mw2"}
    with pytest.raises(SystemExit, match="no installed game's zones hold mp_crash.ff"):
        export.choose_map("mp_crash", None, None, games, maps)


def test_export_finds_an_unlisted_map_by_which_install_holds_it(tmp_path):
    touch(tmp_path / "mp_crash.ff")
    games = {"mw2": {"zones": [str(tmp_path)]}, "bo1": {"zones": []}}
    assert export.choose_map("mp_crash", None, None, games, [])["game"] == "mw2"
    games["bo1"]["zones"] = [str(tmp_path)]
    with pytest.raises(SystemExit, match="more than one game"):
        export.choose_map("mp_crash", None, None, games, [])


# -- The shipped layouts -------------------------------------------------------------------------


def test_every_engine_s_shipped_tables_are_present():
    from scripts.cod import doctor

    for desc in config.games().values():
        for label, path in doctor.data_files(desc["engine"]):
            assert os.path.isfile(path), f"{desc['engine']}: {label}"


def test_nothing_derived_from_a_dev_build_is_shipped():
    """durango_types.json and the X360 layout.json come from debug symbols: users supply their own."""
    data = os.path.join(os.path.dirname(config.GAMES_FILE), "data")
    shipped = {os.path.relpath(os.path.join(d, f), data) for d, _, files in os.walk(data) for f in files}
    assert not any(os.path.basename(p) == "durango_types.json" for p in shipped)
    assert os.path.join("s1", "layout.json") not in shipped


# -- Classification, depots and `use` ------------------------------------------------------------


def retail64(path):
    """A 64-bit retail install of MW3: zones, steam_api64.dll and a PE32+ iw5mp.exe."""
    touch(path / "zone" / "english" / "mp_dome.ff")
    touch(path / "steam_api64.dll")
    touch(path / "iw5mp.exe", pe(is64=True))
    return str(path)


def test_folders_are_classified_by_steam_api_and_exe(tmp_path):
    mw3 = config.games()["mw3"]
    assert installs.classify(mw3, retail64(tmp_path / "retail")) == installs.BIT64
    touch(tmp_path / "pe64" / "iw5mp.exe", pe(is64=True))
    assert installs.classify(mw3, str(tmp_path / "pe64")) == installs.BIT64
    touch(tmp_path / "pe32" / "iw5mp.exe", pe())
    assert installs.classify(mw3, str(tmp_path / "pe32")) == installs.BIT32
    touch(tmp_path / "api32" / "steam_api.dll")
    assert installs.classify(mw3, str(tmp_path / "api32")) == installs.BIT32
    touch(tmp_path / "depot" / "zone" / "english" / "mp_dome.ff")
    assert installs.classify(mw3, str(tmp_path / "depot")) == installs.UNKNOWN
    # BO2 names no exe to read, but a probe to tell the builds apart.
    touch(tmp_path / "bo2" / "t6mp.exe", pe(is64=True))
    assert installs.classify(config.games()["bo2"], str(tmp_path / "bo2")) == installs.BIT64


def test_the_games_walked_with_32_bit_layouts_are_the_ones_checked():
    assert [g for g, d in config.games().items() if installs.needs_32bit(d)] == ["mw2", "mw3", "bo1", "bo2"]
    for game in ("mw2", "mw3", "bo1", "bo2"):
        assert installs.depot_commands(game), game


def fake_steam(tmp_path, retail=True, depots=True):
    """A Steam root with a 64-bit MW3 install and/or its 32-bit depots where `download_depot` puts them."""
    root = tmp_path / "Steam"
    (root / "steamapps").mkdir(parents=True)
    (root / "steamapps" / "libraryfolders.vdf").write_text(LIBRARYFOLDERS % (root, root))
    if retail:
        retail64(root / "steamapps" / "common" / "Call of Duty Modern Warfare 3")
    if depots:
        content = root / "ubuntu12_32" / "steamapps" / "content"
        touch(content / "app_42680" / "depot_42683" / "zone" / "english" / "mp_dome.ff")
        touch(content / "app_42680" / "depot_42682" / "main" / "iw_00.iwd")
        touch(content / "app_42680" / "depot_42682" / "steam_api.dll")
    roots = [str(root)]
    return (
        lambda folder: steam.find_install(folder, roots),
        lambda app, depot: steam.find_depot(app, depot, roots),
        root,
    )


def test_depots_are_found_where_download_depot_writes_them(tmp_path):
    find_install, find_depot, root = fake_steam(tmp_path)
    assert find_depot(42680, 42683) == str(root / "ubuntu12_32" / "steamapps" / "content" / "app_42680" / "depot_42683")
    assert find_depot(42690, 42698) is None
    # Windows and macOS clients write them into the library's own steamapps/content.
    touch(root / "steamapps" / "content" / "app_42690" / "depot_42698" / "zone" / "dlc" / "mp_moab.ff")
    assert find_depot(42690, 42698) == str(root / "steamapps" / "content" / "app_42690" / "depot_42698")


def picked(tmp_path, use, **kw):
    find_install, find_depot, _ = fake_steam(tmp_path, **kw)
    return [(os.path.basename(p), origin) for p, origin in installs.detect("mw3", use, find_install, find_depot)]


def test_auto_takes_the_depots_and_keeps_a_64_bit_install_for_its_exe(tmp_path):
    assert picked(tmp_path, "auto") == [
        ("depot_42683", "steam-depot"),
        ("depot_42682", "steam-depot"),
        ("Call of Duty Modern Warfare 3", "steam"),
    ]


def test_auto_prefers_a_32_bit_install(tmp_path):
    find_install, find_depot, root = fake_steam(tmp_path)
    retail = root / "steamapps" / "common" / "Call of Duty Modern Warfare 3"
    (retail / "steam_api64.dll").unlink()
    touch(retail / "iw5mp.exe", pe())
    found = installs.detect("mw3", "auto", find_install, find_depot)
    assert found == [(str(retail), "steam")]


def test_use_restricts_detection_to_one_kind(tmp_path):
    assert picked(tmp_path / "a", "install") == [("Call of Duty Modern Warfare 3", "steam")]
    assert [name for name, _ in picked(tmp_path / "b", "depots")] == [
        "depot_42683",
        "depot_42682",
        "Call of Duty Modern Warfare 3",  # still only for its exe
    ]
    assert picked(tmp_path / "c", "depots", retail=False) == [("depot_42683", "steam-depot"), ("depot_42682", "steam-depot")]
    assert picked(tmp_path / "d", "install", retail=False) == []


def test_use_comes_from_the_command_line_then_the_config():
    seen = []

    def detect_fn(game, use):
        seen.append(use)
        return []

    installs.resolve_install("mw3", {}, {}, {}, {"games": {"mw3": {"use": "depots"}}}, detect_fn)
    installs.resolve_install("mw3", {}, {"mw3": "install"}, {}, {"games": {"mw3": {"use": "depots"}}}, detect_fn)
    installs.resolve_install("mw3", {}, {}, {}, {}, detect_fn)
    assert seen == ["depots", "install", "auto"]


def test_zones_come_from_depots_and_the_exe_from_the_64_bit_install(tmp_path):
    find_install, find_depot, root = fake_steam(tmp_path)
    found = installs.detect("mw3", "auto", find_install, find_depot)
    install = installs.Install("mw3", [p for p, _ in found], "steam", origins=dict(found))
    files = installs.resolve(config.games()["mw3"], install)
    content = root / "ubuntu12_32" / "steamapps" / "content"
    assert files["zones"] == [str(content / "app_42680" / "depot_42683" / "zone" / "english")]
    assert files["search"] == [str(content / "app_42680" / "depot_42682" / "main")]
    assert files["exe"] == str(root / "steamapps" / "common" / "Call of Duty Modern Warfare 3" / "iw5mp.exe")
    assert installs.sixty_four_bit(config.games()["mw3"], install) is None
    roles = {os.path.basename(r): (kind, role) for r, _, kind, role in installs.roles(config.games()["mw3"], install, files)}
    assert roles["Call of Duty Modern Warfare 3"] == (installs.BIT64, "exe only")
    assert roles["depot_42683"] == (installs.UNKNOWN, "zones")


def test_only_64_bit_zones_are_refused_with_the_depot_steps(tmp_path):
    find_install, find_depot, _ = fake_steam(tmp_path, depots=False)
    found = installs.detect("mw3", "auto", find_install, find_depot)
    install = installs.Install("mw3", [p for p, _ in found], "steam")
    assert installs.resolve(config.games()["mw3"], install)["zones"] == []
    with pytest.raises(SystemExit, match="download_depot 42680 42683 6381783964590594065"):
        installs.require_32bit("mw3", install)


def test_merged_depot_games_are_never_read_from_separate_depots(tmp_path):
    root = tmp_path / "Steam"
    (root / "steamapps").mkdir(parents=True)
    touch(root / "steamapps" / "content" / "app_42700" / "depot_42702" / "zone" / "Common" / "mp_nuked.ff")
    roots = [str(root)]
    found = installs.detect("bo1", "depots", lambda f: steam.find_install(f, roots), lambda a, d: steam.find_depot(a, d, roots))
    assert found == []
    assert "copy them into one folder" in installs.not_found("bo1", installs.Install("bo1", use="depots"))


def test_the_docs_list_every_depot_games_json_records():
    readme = os.path.join(os.path.dirname(config.GAMES_FILE), "..", "..", "docs", "cod", "README.md")
    with open(readme, encoding="utf-8") as fh:
        text = fh.read()
    for game in config.games():
        for command in installs.depot_commands(game):
            assert command in text, command
