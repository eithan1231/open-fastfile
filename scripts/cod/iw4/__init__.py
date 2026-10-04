"""Call of Duty: Modern Warfare 2 (IW4, x86) zones, read in Python.

The zone is walked by the game-generic interpreter in `scripts/cod/zonecode`, from
OAT's ZoneCode as data; nothing here walks. `backend` turns a walk into the dump
tree the other backends write. IW4's assets are IW5's with a few members moved or
missing, so almost every writer is IW5's (`dumpers/`). It claims every MW2
fastfile by header (`backends.BACKENDS`).
"""
