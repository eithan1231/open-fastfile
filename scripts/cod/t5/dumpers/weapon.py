"""`weapon`: each WeaponVariantDef as a `WEAPONFILE` infostring, its AI accuracy graphs, and
the flame tables a flamethrower names.

The infostring is IW5's writer (iw5/dumpers/weapon.py) over T5's field table
(`scripts/cod/data/t5/weapon_fields.json`): OAT's `WeaponFullDef` is T5's variant def and the
WeaponDef it points at, so `weapVariantDef.` paths read the asset's own record.
T5 names its sounds as plain strings, and a flamethrower's WeaponDef points at two
`FlameTable`s, each written once as a `FLAMETABLEFILE` at `weapons/<name>`
(OAT's WeaponDumperT5), its keys the table's `flame_fields`.
"""

from ...iw5.dumpers import weapon as iw

FLAME_HEADER = "FLAMETABLEFILE"
FLAMES = (("flameTableFirstPerson", "flameTableFirstPersonPtr"), ("flameTableThirdPerson", "flameTableThirdPersonPtr"))


class Flame:
    """A FlameTable, read the way `iw.value` reads a weapon: by its own member paths."""

    def __init__(self, walk, record):
        self.walk, self.record = walk, record

    def get(self, path):
        return self.record[path]

    int_at = get  # OAT's FlameTable fields declare no CSPFT_INT on a narrower member

    def script_string(self, index):
        return (self.walk.script_string(index) or "") if index is not None else ""


def flame_tables(walk, weapon, table, seen):
    """{file: text} of the flame tables this weapon points at that were not written yet."""
    out = {}
    weap_def = weapon.weap_def
    if weap_def is None:
        return out
    for name_key, pointer_key in FLAMES:
        name, flame = weap_def[name_key], weap_def[pointer_key]
        if not name or flame is None or flame.address in seen:
            continue
        seen.add(flame.address)
        values = {key: iw.value(Flame(walk, flame), key, path, kind, {}) for key, path, kind in table["flame_fields"]}
        out[f"{iw.FOLDER}/{name}"] = FLAME_HEADER + "".join(f"\\{k}\\{v}" for k, v in values.items())
    return out


def write(walk, out, ctx=None):
    table = iw.load_fields(walk.game)
    enums = walk.program.data["enums"]
    found = walk.by_type("weapon")
    written, graphs, flames = 0, set(), set()
    for asset in found:
        if asset.name.startswith(","):
            continue
        weapon = iw.Weapon(walk, asset.record, enums)
        iw.write_file(out, f"{iw.FOLDER}/{asset.name}", iw.infostring(weapon, table))
        written += 1
        for name, text in iw.accuracy_graphs(weapon).items():
            if name not in graphs:
                graphs.add(name)
                iw.write_file(out, name, text)
        for name, text in flame_tables(walk, weapon, table, flames).items():
            iw.write_file(out, name, text)
    print(f"      {written} of {len(found)} weapons written, {len(graphs)} accuracy graph(s), {len(flames)} flame table(s)")
