"""Decoding CoD textures (.iwi, plus the .dds fallback) and converting them for the web."""

import functools
import io
import os
import struct

from PIL import Image

from . import iwd

IWI_FORMATS = {1: "ARGB32", 2: "RGB24", 3: "GA16", 4: "A8", 11: "DXT1", 12: "DXT3", 13: "DXT5"}
_FOURCC = {11: b"DXT1", 12: b"DXT3", 13: b"DXT5"}

# OAT's IWI writer silently skips B8_G8_R8_X8 images, so the export also dumps
# DDS and keeps the .dds for exactly those. See docs/cod/pitfalls.md.
TEXTURE_EXTS = (".iwi", ".dds")


def _payload_size(fmtid, w, h):
    bw, bh = max(1, (w + 3) // 4), max(1, (h + 3) // 4)
    if fmtid == 11:
        return bw * bh * 8
    if fmtid in (12, 13):
        return bw * bh * 16
    if fmtid == 1:
        return w * h * 4
    if fmtid == 2:
        return w * h * 3
    if fmtid == 3:
        return w * h * 2
    if fmtid == 4:
        return w * h
    raise ValueError(f"unsupported format id {fmtid}")


def _dds_header(fmtid, w, h, size):
    hdr = bytearray(128)
    hdr[0:4] = b"DDS "
    struct.pack_into("<7I", hdr, 4, 124, 0x81007, h, w, size, 0, 0)
    struct.pack_into("<2I", hdr, 76, 32, 0x4)  # pixelformat size, DDPF_FOURCC
    hdr[84:88] = _FOURCC[fmtid]
    struct.pack_into("<I", hdr, 108, 0x1000)  # DDSCAPS_TEXTURE
    return bytes(hdr)


def decode_iwi(path):
    """(PIL image, format name, width, height) for one .iwi file."""
    with open(path, "rb") as fh:
        return decode_iwi_bytes(fh.read())


def decode_iwi_bytes(data):
    """(PIL image, format name, width, height) for one .iwi, already in memory.

    An IWI is a small header over the same block data a DDS carries. Only v8
    (IW4/IW5) starts the header with a flags dword; v6 and v13 (T5) do not. See
    docs/cod/reference.md#iwi-textures for the layouts.
    """
    if data[:3] != b"IWi":
        raise ValueError("not an IWI file")
    off = 8 if data[3] == 8 else 4
    fmtid = data[off]
    w, h, _d = struct.unpack("<HHH", data[off + 2 : off + 8])
    size = _payload_size(fmtid, w, h)
    payload = data[-size:]  # the largest mip is last in the file
    if fmtid in _FOURCC:
        img = Image.open(io.BytesIO(_dds_header(fmtid, w, h, size) + payload))
        img.load()
    elif fmtid == 1:
        img = Image.frombytes("RGBA", (w, h), payload)
        b, g, r, a = img.split()
        img = Image.merge("RGBA", (r, g, b, a))
    elif fmtid == 2:
        img = Image.frombytes("RGB", (w, h), payload)
    elif fmtid == 4:
        img = Image.frombytes("L", (w, h), payload)
    else:
        raise ValueError(f"no decoder for {IWI_FORMATS.get(fmtid, fmtid)}")
    return img, IWI_FORMATS.get(fmtid, fmtid), w, h


def decode_texture(path):
    """Decode by extension: .iwi through `decode_iwi`, .dds through Pillow."""
    if path.lower().endswith(".dds"):
        img = Image.open(path)
        img.load()
        return img, "DDS", img.width, img.height
    return decode_iwi(path)


def texture_index(root):
    """{image name: file} under `root`, preferring .iwi over the .dds fallback."""
    index = {}
    for dirpath, _dirs, files in os.walk(root):
        for f in files:
            stem, ext = os.path.splitext(f)
            if ext.lower() not in TEXTURE_EXTS:
                continue
            full = os.path.join(dirpath, f)
            if ext.lower() == ".iwi" or stem not in index:
                index[stem] = full
    return index


def convert_textures(iwi_root, wanted, out_dir, max_size=512, lossless=(), search=None):
    """Convert every wanted colour map to .jpg (opaque) or .png (alpha, or `lossless`).

    Returns (converted, missing names, failed). Multiply/add decals are
    `lossless`: they modulate the wall under them, so JPEG artefacts would land
    on the wall itself. With an .iwd `search` path, an image the dump lacks is
    read from there: a zone that names an image by reference only ships no pixels.
    """
    os.makedirs(out_dir, exist_ok=True)
    have = texture_index(iwi_root)
    ok, failed, missing = 0, 0, []
    for name in sorted(wanted):
        path = have.get(name)
        img = None
        if not path and search:
            img, path = _iwd_image(search, (f"images/{name}.iwi",))
        if not path:
            missing.append(name)
            continue
        try:
            if img is None:
                img, _, _, _ = decode_texture(path)
            if max(img.size) > max_size:
                scale = max_size / max(img.size)
                img = img.resize((max(1, int(img.width * scale)), max(1, int(img.height * scale))), Image.LANCZOS)
            has_alpha = img.mode == "RGBA" and img.getchannel("A").getextrema()[0] < 255
            if has_alpha or name in lossless:
                img.save(os.path.join(out_dir, name + ".png"))
            else:
                img.convert("RGB").save(os.path.join(out_dir, name + ".jpg"), quality=88)
            ok += 1
        except Exception as e:
            # Named: "3 failed" on its own leaves nothing to go on, and a whole
            # map's textures failing for one reason looks the same as three odd ones.
            print(f"      {name} ({os.path.basename(path)}): {e}")
            failed += 1
    return ok, missing, failed


def _iwd_image(search, candidates):
    """(PIL image, archive name) of the first candidate entry found in the .iwd search path, or (None, None)."""
    have = iwd.index(search)
    for candidate in candidates:
        hit = have.get(candidate.lower())
        if not hit:
            continue
        # Decoded from memory: writing it out as a temp .iwi put a stray file
        # in the world's own assets/ for the length of the decode.
        return decode_iwi_bytes(iwd.read(search, candidate))[0], os.path.basename(hit[0])
    return None, None


def _dumped_image(img_dir, names):
    """(PIL image, file name) of the first of `names` in an image dump, or (None, None).

    The way in for a game with no .iwd archives: the picture is an ordinary zone
    image, which the dump already wrote under its own name.
    """
    if not img_dir:
        return None, None
    have = texture_index(img_dir)
    path = next((have[n] for n in names if n in have), None)
    return (decode_texture(path)[0], os.path.basename(path)) if path else (None, None)


def _only_loadscreen(img_dir):
    """The one `*loadscreen_*` image in a load zone's dump, or nothing when there are none or several.

    Advanced Warfare names its picture after the map's short name rather than its
    zone -- `s1_loadscreen_mp_lab` in `mp_lab2_load.ff` -- and a load zone holds
    one map's picture only, so the one it has is the map's.
    """
    found = [name for name in texture_index(img_dir) if "loadscreen_" in name] if img_dir else []
    return found if len(found) == 1 else []


def export_loadscreen(search, map_name, out_dir, img_dir=None, width=640, size=None):
    """Copy the map's loading screen out of the .iwd search path as `loadscreen.jpg`.

    Read from the .iwd directly: it lives in a separate `<map>_load.ff` zone, in
    a format OAT's IWI writer skips. Spec Ops maps ship `<map>_lobby` instead.
    Ghosts, Advanced Warfare and Black Ops II ship no .iwd at all, so `img_dir` names a dump of
    that zone's images to fall back to. `size` is the shape the game draws the picture at,
    where that is not its own (Black Ops II stretches a square over the screen); else it
    is scaled to `width`. Returns (path, where it came from) or (None, None); the
    picker then falls back to the minimap.
    """
    names = (f"loadscreen_{map_name}", f"{map_name}_lobby")
    img, source = _iwd_image(search, tuple(f"images/{n}.iwi" for n in names))
    if img is None:
        img, source = _dumped_image(img_dir, (*names, *_only_loadscreen(img_dir)))
    if img is None:
        return None, None
    if size:
        img = img.resize(size, Image.LANCZOS)
    elif img.width > width:
        img = img.resize((width, max(1, round(img.height * width / img.width))), Image.LANCZOS)
    path = os.path.join(out_dir, "loadscreen.jpg")
    img.convert("RGB").save(path, quality=88, optimize=True)
    return path, source


def export_minimap(search, map_name, out_dir, img_dir=None, aliases=()):
    """Copy the map's compass image to `minimap.png`, at full size, from the first place that has it.

    The .iwd search path, where every stock IW/T5 zone ships
    `compass_map_<zone name>` loose (Black Ops lists none in the zone at all);
    then `img_dir`, a dump of the zone's own images, for a game that ships no
    .iwd, under that name or one of `aliases` (the images the map's compass
    material names: BO2's `compass_map_mp_nuketown_2020` draws
    `compass_map_mp_nuketown2020`); then the `minimap.png` a previous export already wrote, so that a run
    which cannot reach the picture leaves the world's HUD map alone rather than
    deleting it. Where it sits in the world is not in the image: see
    metadata.minimap_frame. Returns (path, where it came from, (w, h)) or (None, None, None).
    """
    path = os.path.join(out_dir, "minimap.png")
    img, source = _iwd_image(search, (f"images/compass_map_{map_name}.iwi",))
    if img is None:
        img, source = _dumped_image(img_dir, (f"compass_map_{map_name}", *aliases))
    if img is None:
        if not os.path.exists(path):
            return None, None, None
        with Image.open(path) as kept:
            return path, os.path.basename(path) + " (kept)", kept.size
    img.save(path, optimize=True)
    return path, source, img.size


def encode_image(path, max_size):
    """One texture as (bytes, mime): PNG if it carries alpha, JPEG otherwise."""
    img, _fmt, _w, _h = decode_texture(path)
    if max(img.size) > max_size:
        img.thumbnail((max_size, max_size))
    has_alpha = img.mode == "RGBA" and img.getchannel("A").getextrema()[0] < 255
    out = io.BytesIO()
    if has_alpha:
        img.convert("RGBA").save(out, "PNG", optimize=True)
        return out.getvalue(), "image/png"
    img.convert("RGB").save(out, "JPEG", quality=85, optimize=True)
    return out.getvalue(), "image/jpeg"


def alpha_mode(payload):
    """Guess a glTF alphaMode from an encoded image's alpha channel: MASK, BLEND or None.

    Only a fallback for materials with no dumped JSON; the material's own state
    bits win wherever they exist. A cutout keeps a solid opaque body with few
    partial texels (MASK); glass is broadly partial (BLEND).
    """
    img = Image.open(io.BytesIO(payload))
    if img.mode != "RGBA":
        return None
    hist = img.getchannel("A").histogram()
    total = sum(hist) or 1
    if sum(hist[:255]) == 0:
        return None
    opaque = sum(hist[250:]) / total
    partial = sum(hist[16:240]) / total
    return "MASK" if opaque >= 0.02 and partial <= 0.35 else "BLEND"


@functools.cache
def white_pixel():
    """A 1x1 white PNG, standing in for a texture the dump does not have."""
    out = io.BytesIO()
    Image.new("RGB", (1, 1), (255, 255, 255)).save(out, "PNG")
    return out.getvalue()


def decode_images(out_dir, paths):
    """`decode-image` command: write each .iwi/.dds as a PNG in `out_dir`."""
    os.makedirs(out_dir, exist_ok=True)
    ok = fail = 0
    for p in paths:
        name = os.path.splitext(os.path.basename(p))[0]
        try:
            img, fmt, w, h = decode_texture(p)
            img.save(os.path.join(out_dir, name + ".png"))
            print(f"  ok   {name:<34} {fmt:<7} {w}x{h}")
            ok += 1
        except Exception as e:
            print(f"  FAIL {name:<34} {e}")
            fail += 1
    print(f"\n{ok} converted, {fail} failed -> {out_dir}")
    return fail == 0
