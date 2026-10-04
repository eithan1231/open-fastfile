"""Call of Duty: Advanced Warfare (S1, x64) zones, read in Python: OpenAssetTools cannot.

`ff` decompresses a fastfile (`lz4` is the codec it needs), `assets` reads the
list at its head, and `walkers` walks the zone the way the game's loaders do.
`backend` turns a walk into the dump tree OpenAssetTools writes for the other
games, so the rest of scripts/cod reads S1 the same way; `images` pulls a
zone's textures out of the `imagefile<N>.pak` spans.

Three modules are IW6's rather than copies of them: `iw6/zone.py` (the block
model and the pointer rules, which are the same container), `iw6/records.py`
(what a walk keeps, which is plain data) and the DXGI half of `iw6/images.py`.
S1 changes none of them; where it differs it subclasses, as `walkers.Layout`
does. Nothing goes the other way: `scripts/cod/iw6` does not import this package.

There is no separate world walker here as there is in `iw6/gfxworld.py`. That
split exists because IW6 runs the Xbox One loaders for the asset types it has no
Python walker for; S1's console build is PowerPC, so nothing can be emulated and
every walker is in `walkers.py`.

How the format was established: reverse/s1-zone/README.md.
"""
