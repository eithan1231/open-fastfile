"""Call of Duty: Black Ops (T5, x86) zones, read in Python.

The zone is walked by the game-generic interpreter in `scripts/cod/zonecode`, from
OAT's ZoneCode as data; nothing here walks. `backend` turns a walk into the dump
tree the other backends write. Where T5's records have IW5's members the writer is
IW5's; where they differ (a clipmap with no ClipInfo and flags on every brush side,
surfaces on the model rather than an XModelSurfs, a WeaponVariantDef, one sound bank
per zone) the writer is in `dumpers/`. It claims every Black Ops fastfile by
header (`backends.BACKENDS`).
"""
