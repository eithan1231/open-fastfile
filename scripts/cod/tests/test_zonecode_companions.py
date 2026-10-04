"""A LOD whose surfaces another zone holds (a comma name), resolved from the companion zones.

Stand-ins pin the lookup: IW4 keeps an `XModelSurfs` header on the model that holds it,
IW5 an asset; a name no companion holds is reported, not guessed; a companion let go is
walked again, once. Where MW3 is installed, mp_nola's flag is resolved from the real
`common_mp.ff` and decoded.
"""

from collections import Counter

from scripts.cod.iw5.dumpers import xmodel
from scripts.cod.zonecode.companions import Companions
from scripts.cod.zonecode.values import Asset

from .test_iw5_assets import zone_or_skip


class Rec(dict):
    def __getitem__(self, path):
        return self.get(path)


class Named:
    def __init__(self, name, record):
        self.name, self.record = name, record


class Walk:
    def __init__(self, path, **by_type):
        self.path, self.by = path, by_type

    def by_type(self, kind):
        return self.by.get(kind, [])


def lod(name, surfs=None):
    return Rec({"name": name, "surfs": surfs, "numsurfs": len(surfs or ())})


def companion():
    """IW4's shape (a model keeps the header) for LOD 0, IW5's (an asset) for LOD 1."""
    flag = Named("prop_flag_neutral", Rec({"numLods": 1, "lodInfo[0].modelSurfs": lod("flag2_lod000", ["iw4 surface"])}))
    asset = Asset(0, "xmodelsurfs", "flag2_lod100", lod("flag2_lod100", ["iw5 surface"]), 0)
    return Walk("/zones/common_mp.ff", xmodel=[flag], xmodelsurfs=[asset])


def map_model():
    comma = Asset(0, "xmodelsurfs", ",flag2_lod100", lod(",flag2_lod100"), 1)
    lods = {"lodInfo[0].modelSurfs": lod(",flag2_lod000"), "lodInfo[1].modelSurfs": comma, "lodInfo[2].modelSurfs": lod(",gone")}
    return Named("prop_flag_delta", Rec({"numLods": 3, **lods}))


def test_a_comma_named_lod_takes_the_surfaces_a_companion_holds():
    zone = companion()
    walks = []
    companions = Companions(lambda path: walks.append(path) or zone, lambda path: True)
    companions.note(zone)
    model = map_model()
    assert xmodel.surfaces(model.record, 0) is None
    resolved, missing = xmodel.resolve_foreign(Walk("/zones/mp_x.ff"), [model], companions)
    assert resolved == {("prop_flag_delta", 0): ["iw4 surface"], ("prop_flag_delta", 1): ["iw5 surface"]}
    assert missing == [("prop_flag_delta", 2, ",gone")]  # kept empty, and named
    assert walks == ["/zones/common_mp.ff"]


def test_a_companion_let_go_is_walked_again_once_and_an_unknown_name_walks_nothing():
    zone = companion()
    walks = []
    companions = Companions(lambda path: walks.append(path) or zone, lambda path: False)
    companions.note(zone)
    found = companions.find("surfaces", {"flag2_lod000", "flag2_lod100", "flag3_lod000"})
    assert set(found) == {"flag2_lod000", "flag2_lod100"} and walks == ["/zones/common_mp.ff"]
    assert companions.find("surfaces", {"flag3_lod000"}) == {} and len(walks) == 1


def test_without_companions_a_comma_named_lod_stays_empty():
    resolved, missing = xmodel.resolve_foreign(Walk("/zones/mp_x.ff"), [map_model()], None)
    assert resolved == {} and len(missing) == 3


def test_a_zone_s_own_comma_names_are_not_what_it_holds():
    zone = Walk("/zones/mp_x.ff", xmodel=[map_model()])
    assert xmodel.held_surfaces(zone) == {}


def test_mp_nola_s_flag_draws_from_common_mp():
    """prop_flag_american02's two LODs name `,flag2_lod000` and `,flag2_lod100`."""
    from scripts.cod.iw5.backend import Backend

    common, nola = zone_or_skip("common_mp"), zone_or_skip("mp_nola")
    backend = Backend()
    backend.walk(common)
    walk = backend.walk(nola)
    [flag] = [a for a in walk.by_type("xmodel") if a.name == "prop_flag_american02"]
    resolved, missing = xmodel.resolve_foreign(walk, [flag], backend.companions)
    assert not missing and sorted(resolved) == [("prop_flag_american02", 0), ("prop_flag_american02", 1)]
    data = xmodel.lod_data(walk, flag.record, flag.name, 0, resolved[flag.name, 0], [], Counter())
    assert len(data.positions) == 305 and sum(len(s.triangles) for s in data.surfaces) == 520
    heights = [p[2] for p in data.positions]
    assert 90 < max(heights) - min(heights) < 110  # a pole about 2.5 m tall, in inches
