"""Call of Duty: Ghosts (IW6, x64) zones, read in Python: OpenAssetTools cannot.

`ff` inflates a fastfile, `zone` and `walkers`/`gfxworld` walk the zone the way
the game's loaders do (`emulate`/`emulated` run the Xbox One server's own loaders
for the asset types without a Python walker), and `records` is what a walk keeps.
`backend` turns a walk into the dump tree OpenAssetTools writes for the other
games, so the rest of scripts/cod reads IW6 the same way; `renderstate` decodes
the material render state it writes, and `skeleton` a model's bones and weights.

How the format was established: reverse/iw6-zone/README.md.
"""
