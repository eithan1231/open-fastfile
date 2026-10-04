"""Call of Duty: Black Ops II (T6, x86) zones, read in Python.

`ff` decrypts and inflates a PC fastfile (Salsa20 over four streams, raw deflate per
chunk) into the zone; `fastfile.py` claims T6 files and hands them to it. The zone is
then walked by the game-generic interpreter in `scripts/cod/zonecode`, from OAT's
ZoneCode as data, like IW4, IW5 and T5. `backend` turns a walk into the dump tree the
other backends write, through `dumpers/`; `vertices` decodes T6's packed normals and
texture coordinates. How the format was established: reverse/t6-zone/README.md.
"""
