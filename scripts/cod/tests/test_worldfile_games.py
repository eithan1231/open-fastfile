"""`world { game: }` is written only for a game the DSL accepts.

`worldfile.DSL_GAMES` mirrors the schema's enum by hand, so this reads the
schema itself: a game added there and not here would quietly lose its line, and
one added here and not there would fail `pnpm check` on every world of it.
"""

import os
import re

from scripts.cod.maps import REPO_ROOT
from scripts.cod.worldfile import DSL_GAMES, GAMES, ensure_world_game

SCHEMA = os.path.join(REPO_ROOT, "packages", "shared", "src", "dsl", "schema.ts")


def test_the_mirror_is_the_schema():
    text = open(SCHEMA, encoding="utf-8").read()
    (values,) = re.findall(r"game: \{ valueKind: \"enum\", enumValues: \[([^\]]*)\]", text)
    assert tuple(re.findall(r'"(\w+)"', values)) == DSL_GAMES
    assert set(DSL_GAMES) <= set(GAMES)


def test_a_game_the_dsl_does_not_know_gets_no_line(tmp_path, monkeypatch):
    # Every game this imports is in the schema now, so the case is one that is not yet.
    monkeypatch.setattr("scripts.cod.worldfile.DSL_GAMES", tuple(g for g in DSL_GAMES if g != "s1"))
    (tmp_path / "world.world").write_text('world {\n  category: "AW Multiplayer"\n}\n')
    assert ensure_world_game(str(tmp_path), "s1") is False
    assert "game:" not in (tmp_path / "world.world").read_text()


def test_an_aw_world_gets_its_line(tmp_path):
    (tmp_path / "world.world").write_text('world {\n  category: "AW Multiplayer"\n}\n')
    assert ensure_world_game(str(tmp_path), "s1") is True
    assert "  game: s1\n" in (tmp_path / "world.world").read_text()
