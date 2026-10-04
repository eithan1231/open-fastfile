"""Call of Duty: Modern Warfare 3 (IW5, x86) zones, read in Python.

The zone is walked by the game-generic interpreter in `scripts/cod/zonecode`, from
OAT's ZoneCode as data; nothing here walks. `backend` turns a walk into the dump
tree the other backends write, one writer per kind in `dumpers/`. It claims every
MW3 fastfile by header (`backends.BACKENDS`).
"""
