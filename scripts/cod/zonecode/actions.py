"""The custom actions OAT's generated loaders call, written by hand (reverse/x86-zone/README.md#custom-actions).

None of them reads the stream, so none changes the walk. In OAT each copies something
out of TEMP before TEMP is rewound. Here the walk reads the zone's own bytes, which are
never rewound, so "copying out" is keeping a view of them: each action files what it
kept on a record under `@<action>`, read back with `Record.captured(name)`, and makes
the record say what OAT's in-memory copy would.

An action is called with the walker and the current instances its `args` name.
"""

from .values import Array, Pointer


def _loaded_bytes(walk, value, size):
    """`size` bytes of what a data pointer resolved to (an Array, or earlier memory)."""
    if isinstance(value, Array):
        if value.at is None:
            return memoryview(bytes(size))
        if size > value.elem * value.count:
            raise ValueError(f"{size} bytes asked of {value!r}")
        return memoryview(walk.data)[value.at : value.at + size]
    if isinstance(value, Pointer):
        return memoryview(value.bytes(size))
    raise ValueError(f"no loaded data behind {value!r}")


def on_image_loaded(field):
    """GfxImage's asset action: zeroes a runtime field, which nothing downstream reads."""

    def action(walker, image):
        if field in image:
            image.set(field, 0)

    return action


def load_image_data(walker, load_def, image):
    """GfxTexture.loadDef is loaded in TEMP: keep its header and `resourceSize` bytes of
    pixels (offsetof(GfxImageLoadDef, data) + resourceSize), on the image."""
    size = load_def.info.locate("data")[0] + load_def["resourceSize"]
    if load_def.at is None:
        raise ValueError(f"{load_def!r}: an image's loadDef in a runtime block")
    image.set("@LoadImageData", memoryview(walker.data)[load_def.at : load_def.at + size])


def set_sound_data(walker, sound):
    """MssSound.data is loaded in TEMP: keep `info.data_len` bytes of it, or null it when empty."""
    length = sound["info.data_len"]
    if length > 0:
        sound.set("@SetSoundData", _loaded_bytes(walker, sound["data"], length))
    else:
        sound.set("data", None)
        sound.set("@SetSoundData", None)


def realloc_clip_info(walker, clip_info, clip_map):
    """clipMap_t.pInfo is loaded in TEMP: keep the ClipInfo header (its arrays are in VIRTUAL)."""
    clip_map.set("pInfo", clip_info)
    clip_map.set("@ReallocClipInfo", clip_info)


def set_model_surfs(walker, lod_info, model_surfs):
    """IW4's XModelLodInfo.modelSurfs is loaded in TEMP: keep the XModelSurfs header."""
    if model_surfs is not None:
        lod_info.set("modelSurfs", model_surfs)
        lod_info.set("@SetModelSurfs", model_surfs)


# Per game, by the name zonecode.json gives each action (OAT's *_actions.cpp).
ACTIONS = {
    "iw4": {
        "OnImageLoaded": on_image_loaded("cardMemory.platform[0]"),
        "LoadImageData": load_image_data,
        "SetSoundData": set_sound_data,
        "SetModelSurfs": set_model_surfs,
    },
    "iw5": {
        "OnImageLoaded": on_image_loaded("cardMemory.platform[0]"),
        "LoadImageData": load_image_data,
        "SetSoundData": set_sound_data,
        "ReallocClipInfo": realloc_clip_info,
    },
    "t5": {
        "OnImageLoaded": on_image_loaded("loadedSize"),
        "LoadImageData": load_image_data,
    },
    "t6": {
        "OnImageLoaded": on_image_loaded("loadedSize"),
        "LoadImageData": load_image_data,
    },
}
