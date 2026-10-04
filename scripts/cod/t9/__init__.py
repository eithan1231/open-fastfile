"""Call of Duty: Black Ops Cold War (T9, x64) zones, read in Python by content.

`ff` inflates a TAFF v9 fastfile (Oodle, through `oodle`), `zone` reads the
asset list and finds each asset's record by its own signature, and `zoneset`
resolves the stubs a map names against the zones its load list names. The
geometry readers are `world` (render surfaces, collision, placements, entities)
and `models` (XModel and its streamed meshes); `images` and `materials` read
textures, whose pixels stream from `.xpak` packages (`xpak`). `backend` writes
the dump tree the rest of scripts/cod reads.

There is no struct walker as IW6 and S1 have: nothing symbolised describes T9,
so every record is found by content and every offset in it was read off the
data. How each was established, and what is still open: reverse/t9-zone/README.md.
"""
