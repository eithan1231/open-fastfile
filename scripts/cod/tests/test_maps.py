import argparse

import pytest

from scripts.cod import export
from scripts.cod.maps import game_names, load_maps


def test_every_game_in_maps_json_can_be_exported_by_name():
    """`export --game` once hard-coded its choices and did not know bo2."""
    ap = argparse.ArgumentParser()
    export.add_arguments(ap)
    _, maps = load_maps()
    for game in {entry["game"] for entry in maps}:
        assert game in game_names()
        assert ap.parse_args(["--game", game]).game == game


def test_every_world_is_named_for_its_game_and_named_once():
    _, maps = load_maps()
    worlds = [entry["world"] for entry in maps]
    assert len(worlds) == len(set(worlds))
    for entry in maps:
        assert entry["world"].endswith("-" + entry["game"]), entry


def test_a_zone_name_two_games_ship_exports_neither(monkeypatch):
    """`export mp_village` once exported MW3's village as well as BO2's."""
    exported = []
    monkeypatch.setattr(export, "export_map", lambda name, zone, search, out, **kw: exported.append(out))
    monkeypatch.setattr(export, "resolve_map", lambda entry, games, root=None: ("", "", entry["world"], None))
    ap = argparse.ArgumentParser()
    export.add_arguments(ap)
    with pytest.raises(SystemExit, match="village-mw3, village-bo2"):
        export.main(ap.parse_args(["mp_village"]))
    assert exported == []

    export.main(ap.parse_args(["village-bo2"]))
    assert exported == ["village-bo2"]
