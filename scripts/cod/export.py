"""Export one map end to end: dump it (the backend its fastfile names, backends.py), then write the world.

Stages, in order: dump -> classify materials -> convert textures -> shell and
decals -> props -> collision -> props.world -> viewmodel -> characters ->
loadscreen -> minimap, minimap.world, export_metadata.json and navigation ->
world.world.
See docs/cod/pipeline.md.
"""

import gc
import glob
import os
import shutil
import sys
from collections import Counter

from . import (
    animations,
    backends,
    brushmodels,
    characters,
    collision,
    gameobjects,
    gameplay,
    harvest,
    ladder,
    lightmap,
    mantle,
    metadata,
    pack,
    props,
    shell,
    triggers,
    viewmodel,
    worldfile,
)
from . import fx as fxmod
from . import sound as soundmod
from .files import find_file, read_json
from .installs import default_world
from .maps import CACHE_DIR, MAPS_FILE, REPO_ROOT, game_names, load_maps, require_game
from .materials import classify_materials, colour_maps, material_images, surface_images
from .nav import from_ents, from_pathdata
from .nav.format import encode as encode_nav
from .textures import convert_textures, export_loadscreen, export_minimap
from .volumes import require_axial_faces
from .zones import companion_zones

# What the stages after the shell read, so that a backend which does not dump all
# of it skips the stage that would read a gap as absence rather than running on a
# partial dump. Props (5, 7) need the models whole and the clipmap's model lists;
# clips and scripts only decide what animates. Collision (6) is the one the world
# file cannot do without: `world.world` names `assets/collision.glb`, so without
# a whole clipmap the export stops after props.world. Stages 5-13 are each
# skipped on their own, and world.world includes only the files that were written.
PROPS_DUMPS = ("xmodel",)
PROPS_CLIPMAP_FIELDS = ("staticModels", "dynEnts")
# Stages 8 and 9: the view hands, the gun and their clips. The weapon files are
# asked for by key rather than whole, because a game's own structs need not have
# a member for every key the weapon dump's schema has (scripts/cod/iw6/dumpers/weapon.py).
VIEWMODEL_DUMPS = ("xanim",)
METADATA_DUMPS = ("rawfile",)  # stage 11: the .vision and the map's scripts (the `.zone` listing comes with any dump)
EFFECTS_DUMPS = ("fx",)  # stage 12
# Stage 13: the alias table and the PCM behind the loaded half of it.
SOUND_DUMPS = ("sound", "loadedsound")


def export_map(
    map_name,
    zone,
    search,
    out,
    *,
    work=None,
    keep_work=False,
    common=None,
    metadata_only=False,
    loadscreen_only=False,
    viewmodel_only=False,
    characters_only=False,
    gameplay_only=False,
    effects_only=False,
    sounds_only=False,
    sound_export_only=False,
    effects_export_only=False,
    climbing_only=False,
    collision_only=False,
    nav_only=False,
    volumes_only=False,
    loadscreen=None,
):
    """Export `<zone>/<map_name>.ff` into the world folder `out`.

    `loadscreen` names the picture where it is not `loadscreen_<map_name>`: a
    Black Ops II zombies session formats it from the map, its gametype and its
    start location (`zm_transit_zclassic_transit`; maps.json's `loadscreen`).

    `metadata_only` runs stage 11 alone (two small dumps); `loadscreen_only` stage
    10, and records in `export_metadata.json` whether it found a picture; `viewmodel_only` and
    `characters_only` run stages 8 and 9, leaving every other file in `out` as it
    is. The characters stage needs the weapon the viewmodel stage picks, so
    neither runs without the other.

    `gameplay_only` is the odd one: it rewrites `gameplay.world` from the
    `export_metadata.json` already in `out`, so it needs no fastfile and no
    game install at all. Everything it emits was parsed by a
    previous export and written down. `effects_only` does the same for `fx.world`,
    against the `assets/fx/effects.json` a full export left beside it, and
    `sounds_only` for `sound.world` against `assets/sounds/sounds.json`.
    `nav_only` does the same for `navigation.world` and `assets/nav.bin`.

    `sound_export_only` runs stage 13 alone from a fresh dump: the aliases of the
    map and its companion zones, `assets/sounds/` and `sound.world`, leaving every
    other file as it is bar the one include line in `world.world`.
    `effects_export_only` does the same for stage 12: the effect definitions,
    their materials and images, `assets/fx/` and `fx.world`.

    `climbing_only` rewrites `mantle.world` and `ladder.world` from a fresh
    clipmap dump (plus the GfxWorld and entities, to place brush models), and
    `collision_only` rewrites `assets/collision.glb` from the same three. Both
    leave every other file alone, so a change to the collision format can be
    taken one map at a time. `volumes_only` rewrites `volumes.world` from a fresh
    clipmap and entity dump in the same way.
    """
    if gameplay_only:
        rewrite_gameplay(map_name, out)
        return
    if effects_only:
        rewrite_effects(map_name, out)
        return
    if sounds_only:
        rewrite_sound(map_name, out)
        return
    if nav_only:
        rewrite_navigation(map_name, out, [zone])
        return

    ff = os.path.join(zone, map_name + ".ff")
    if not os.path.exists(ff):
        sys.exit(f"no such fastfile: {ff}")
    backend = backends.for_fastfile(ff, search)
    dump = backend.dump

    work = work or os.path.join(CACHE_DIR, os.path.basename(os.path.normpath(out)))
    assets = os.path.join(out, "assets")
    os.makedirs(work, exist_ok=True)
    os.makedirs(assets, exist_ok=True)

    if metadata_only:
        backends.require(backend, "--metadata-only", "mapents", "rawfile")
        dump(ff, os.path.join(work, "ents"), "mapents")
        dump(ff, os.path.join(work, "raw"), "rawfile")
        game_key, _ = metadata.zone_listing(find_file(os.path.join(work, "ents"), ".zone"))
        if game_key not in worldfile.GAMES:
            sys.exit(f"{map_name}: the zone listing names no game this exporter knows (got {game_key!r})")
        pathdata = _dump_pathdata(backend, map_name, zone, work, game_key)
        has_minimap, has_gameplay, has_nav = export_gameplay(
            map_name, game_key, search, out, work, _zone_images(backend, work), pathdata
        )
        if has_minimap:
            worldfile.ensure_include(out, "minimap.world")
        if has_gameplay:
            worldfile.ensure_include(out, "gameplay.world")
        _set_include(out, "navigation.world", has_nav)
        if not keep_work:
            shutil.rmtree(work, ignore_errors=True)
        return
    if loadscreen_only:
        export_loadscreen_stage(backend, search, map_name, zone, assets, work, loadscreen)
        if metadata.record_images(out):
            print(f"      {metadata.METADATA_FILE}: images updated")
        if not keep_work:
            shutil.rmtree(work, ignore_errors=True)
        return
    if climbing_only:
        export_climbing_only(map_name, ff, out, backend, work)
        if not keep_work:
            shutil.rmtree(work, ignore_errors=True)
        return
    if volumes_only:
        export_volumes_only(map_name, ff, out, backend, work)
        if not keep_work:
            shutil.rmtree(work, ignore_errors=True)
        return
    if collision_only:
        export_collision_only(map_name, ff, out, backend, work)
        if not keep_work:
            shutil.rmtree(work, ignore_errors=True)
        return
    if sound_export_only:
        export_sound_only(map_name, ff, out, backend, work, search, companion_zones(zone, common))
        if not keep_work:
            shutil.rmtree(work, ignore_errors=True)
        return
    if effects_export_only:
        export_effects_only(map_name, ff, out, backend, work, companion_zones(zone, common), search)
        if not keep_work:
            shutil.rmtree(work, ignore_errors=True)
        return
    if viewmodel_only or characters_only:
        export_parts_only(map_name, ff, zone, out, backend, work, common, characters_only)
        if not keep_work:
            shutil.rmtree(work, ignore_errors=True)
        return

    print(f"[1/13] dumping {map_name} ({backend.name})")
    dump(ff, os.path.join(work, "gw"), "gfxworld")

    # Assets the map only references (a leading comma on the name) live in a
    # companion zone. Dumped unconditionally: a map can reference images and
    # materials without referencing a single model. The map's own dump follows,
    # so its copy of a shared name wins.
    referenced = props.referenced_placements(_gfxworld_manifest(work))
    companions = companion_zones(zone, common)
    if referenced and not companions:
        print(
            f"      WARNING: {referenced} placement(s) reference assets this zone does not "
            f"contain, and no companion fastfile was found beside {map_name}.ff.\n"
            f"      Those props will be missing. Pass --common <path-to-common_mp.ff>."
        )
    img_dir = _dump_models(backend, ff, companions, work, referenced)
    dump(ff, os.path.join(work, "ents"), "mapents")
    dump(ff, os.path.join(work, "clip"), "clipmap")
    for sub, kind in (
        ("raw", "rawfile"),  # the .vision; IW4/T5 animated-model scripts
        ("anim", "xanim"),  # the animated props' clips
        ("fx", "fx"),  # effect definitions
        ("snd", "sound"),  # sound aliases
        ("snd", "loadedsound"),  # the PCM the loaded half of them names
    ):
        if backend.dumps(kind):
            dump(ff, os.path.join(work, sub), kind)

    manifest_path = _gfxworld_manifest(work)
    manifest = read_json(manifest_path)
    game = worldfile.game_of(manifest)
    game_key = manifest["_game"]
    print(f"      {game_key} -> {game[1]}")
    if animations.SCRIPTS_BY_GAME[game_key] == "compiled" and backend.dumps("scriptfile"):
        dump(ff, os.path.join(work, "scripts"), "scriptfile")  # the animated-model scripts
    _release_walks(backend, map_name, ff, game_key)
    ents_path = manifest_path.replace(".gfxworld.json", ".ents").replace("/gw/", "/ents/")
    clip_path = find_file(os.path.join(work, "clip"), ".clipmap.json")
    clip = read_json(clip_path) if clip_path else {}
    if clip and clip.get("_game") != game_key:
        sys.exit(f"the clipmap dump says _game={clip.get('_game')!r} but the GfxWorld says {game_key!r}")
    facts = gameobjects.facts_from_ents(map_name, ents_path, game_key) if os.path.exists(ents_path) else None
    placements = brushmodels.preflight(manifest, clip, os.path.exists(ents_path), ents_path, facts)
    if backend.provides("clipmap"):
        require_axial_faces(clip)

    # The shell is drawn from `stateBits`, so a partial material dump would classify
    # every surface as plain opaque and look like a map with no glass in it.
    if not backend.provides("material"):
        _stop(
            work,
            keep_work,
            out,
            "the dump",
            f"classifying surfaces needs a whole material dump, which the {backend.name} backend does not write yet",
        )
        return

    print(f"[2/13] classifying {len(manifest['surfaces'])} surfaces")
    used = {s["material"] for s in manifest["surfaces"] if "material" in s}
    colormap, decal, drop, states = classify_materials(os.path.join(work, "mat", "materials"), used, game_key)
    shell_states = [states[m] for m in used if m in states]
    blended = sum(1 for s in shell_states if s["blend"])
    cutouts = sum(1 for s in shell_states if not s["blend"] and s["alphaTest"])
    print(
        f"      {len(used)} materials ({len(states)} dumped), {len(colormap)} with a colour "
        f"map, {len(decal)} decals, {blended} blended, {cutouts} cutouts, "
        f"{len(drop)} non-surfaces dropped"
    )

    print("[3/13] converting textures")
    lossless = {colormap[m] for m in used if m in colormap and states.get(m, {}).get("blend") not in (None, "alpha")}
    tex_dir = os.path.join(work, "tex")
    ok, missing, failed = convert_textures(
        img_dir, surface_images(colormap, drop, states), tex_dir, lossless=lossless, search=search
    )
    print(f"      {ok} converted, {len(missing)} missing, {failed} failed")
    if missing:
        print(
            f"      MISSING colour map(s), their surfaces will render untextured: "
            f"{', '.join(sorted(missing)[:8])}{' ...' if len(missing) > 8 else ''}"
        )
    atlas = lightmap.convert(img_dir, assets, game_key, manifest_path)  # full resolution, not through the 512 px cap
    if atlas:
        pages = f", {len(atlas.uv)} pages stacked" if atlas.uv else ""
        print(f"      lightmap: {atlas.file} at intensity {atlas.intensity}{pages}")
    elif game_key in lightmap.UNREAD_GAMES:
        print(f"      lightmap: not written, {game_key}'s pages are not decoded yet (scripts/cod/lightmap.py)")
    else:
        print("      lightmap: none found in zone")

    print("[4/13] exporting shell and decals")
    shell.export_shell(
        manifest_path,
        os.path.join(assets, "world.glb"),
        os.path.join(assets, "decals.glb"),
        tex_dir,
        colormap,
        decal,
        drop,
        states,
        placements,
        atlas.uv if atlas else None,
    )

    print("[5/13] placing props")
    has_props = _has_prop_dumps(backend)
    entities, props_dir, animated = [], os.path.join(assets, "props"), {}
    if has_props:
        clips = animations.load_clips(os.path.join(work, "anim", "xanim"))
        assignments = animations.ClipAssignments.from_dumps(
            game_key, os.path.join(work, "raw"), os.path.join(work, "scripts"), clips
        )
        entities = props.collect_placements(manifest, ents_path, assignments.clip_for, facts)
        # Keyed by the path under model_export, which is the model's name: it can hold a folder.
        model_export = os.path.join(work, "models", "model_export")
        exported = {}
        for dirpath, _, files in os.walk(model_export):
            for f in files:
                if f.endswith(".glb"):
                    path = os.path.join(dirpath, f)
                    exported[os.path.relpath(path, model_export)[:-4]] = path
        wanted, counts = set(e["model"] for e in entities), Counter(e["model"] for e in entities)
        needed, absent = [], []
        for name in sorted(wanted):
            hit = next((exported[name + s] for s in ("_lod0", "_lod1", "_lod2", "_lod3", "") if name + s in exported), None)
            if hit:
                needed.append(hit)
            else:
                absent.append(name)
        print(f"      {len(needed)}/{len(wanted)} models available; {sum(counts[m] for m in absent)} placement(s) unplaceable")

        shutil.rmtree(props_dir, ignore_errors=True)
        neutralize = pack.RGB_IS_LAYER_WEIGHTS_BY_GAME[game_key]
        colours = colour_maps(os.path.join(work, "mat", "materials"), game_key)
        pack.pack_models(props_dir, needed, img_dir, states, neutralize_rgb=neutralize, root=model_export, colours=colours)
        animated = animations.embed_clips(props_dir, entities, clips)
        _report_animations(entities, animated, clips, assignments)
    else:
        print(f"      {_skipped(backend, PROPS_DUMPS)}")
        _drop_props(out, props_dir)

    print("[6/13] exporting collision")
    if not backend.provides("clipmap"):
        if has_props:
            print("[7/13] generating props.world")
            props.write_props_world(
                entities, props_dir, os.path.join(out, "props.world"), os.path.join(work, "models", "xmodel"), clip_path, animated
            )
        _stop(
            work,
            keep_work,
            out,
            "props.world" if has_props else "the shell",
            f"world.world names assets/collision.glb, and the {backend.name} backend does not dump the clipmap whole",
        )
        return
    collision.export_collision(clip_path, os.path.join(assets, "collision.glb"), placements)
    has_mantle, has_ladder = export_climbing(map_name, out, clip_path, placements)
    has_volumes = export_volumes(map_name, out, clip, ents_path, game_key, facts)

    print("[7/13] generating props.world")
    if has_props:
        props.write_props_world(
            entities, props_dir, os.path.join(out, "props.world"), os.path.join(work, "models", "xmodel"), clip_path, animated
        )
    else:
        print(f"      {_skipped(backend, PROPS_DUMPS)}")

    print("[8/13] exporting the viewmodel")
    has_viewmodel, weapon_info = False, None
    if _has_viewmodel_dumps(backend):
        has_viewmodel, weapon_info = export_viewmodel_stage(map_name, game_key, out, work, states)
    else:
        print(f"      {_skipped(backend, VIEWMODEL_DUMPS)}")

    print("[9/13] exporting player characters")
    has_characters = False
    if _has_viewmodel_dumps(backend):
        has_characters = export_characters_stage(map_name, out, work, game_key, states, weapon_info)
    else:
        print(f"      {_skipped(backend, VIEWMODEL_DUMPS)}")

    export_loadscreen_stage(backend, search, map_name, zone, assets, work, loadscreen)

    has_minimap = has_gameplay = has_nav = False
    if backend.provides(*METADATA_DUMPS):
        pathdata = _dump_pathdata(backend, map_name, zone, work, game_key)
        has_minimap, has_gameplay, has_nav = export_gameplay(
            map_name, game_key, search, out, work, _zone_images(backend, work), pathdata, facts
        )
    else:
        print(f"[11/13] extracting minimap, export_metadata.json and minimap.world\n      {_skipped(backend, METADATA_DUMPS)}")

    print("[12/13] exporting world effects")
    has_fx = False
    if backend.provides(*EFFECTS_DUMPS):
        has_fx = export_effects(map_name, out, work, img_dir, states, search)
    else:
        print(f"      {_skipped(backend, EFFECTS_DUMPS)}")

    print("[13/13] exporting world sound")
    has_sound = False
    if backend.provides(*SOUND_DUMPS):
        has_sound = export_sound(map_name, out, work, search)
    else:
        print(f"      {_skipped(backend, SOUND_DUMPS)}")

    # The cast the two stages above staged in `assets/` belongs to no one map, so it
    # goes to the catalogue rather than into a world file. Done here rather than
    # inside each stage because the clip file is merged across every world of the
    # game, which one map's export cannot see on its own.
    if has_viewmodel or has_characters:
        problems = harvest.harvest_after_export(os.path.dirname(os.path.abspath(out)))
        for problem in problems:
            print(f"      !! {problem}")

    vision = find_file(os.path.join(work, "raw"), map_name + ".vision")
    _, had_spawn, had_sun, applied = worldfile.write_world_file(
        out,
        map_name,
        ents_path,
        assets,
        vision,
        game,
        game_key,
        lightmap=atlas,
        props=has_props,
        gameplay=has_gameplay,
        volumes=has_volumes,
        minimap=has_minimap,
        mantle=has_mantle,
        ladder=has_ladder,
        navigation=has_nav,
        fx=has_fx,
        sound=has_sound,
    )
    print(
        f"      world.world written"
        f"{'' if had_sun else ' (NO worldspawn lighting found — defaults used)'}"
        f"{'' if had_spawn else ' (NO spawn entity found — placeholder used)'}"
    )
    if applied:
        print(f"      {worldfile.OVERRIDES_FILE} applied: {', '.join(applied)}")

    if not keep_work:
        shutil.rmtree(work, ignore_errors=True)
    print(f"\ndone -> {out}")


def _has_prop_dumps(backend):
    """Whether stages 5 and 7 can run: the models whole, and the clipmap's model lists."""
    return backend.provides(*PROPS_DUMPS) and backend.writes("clipmap", *PROPS_CLIPMAP_FIELDS)


def _drop_props(out, props_dir):
    """Leave no `props.world` or packed prop behind when stages 5 and 7 are skipped.

    `world.world` then includes no props.world, so a stale one from an older
    export would be a file nothing reads describing props nothing placed.
    """
    stale = os.path.join(out, "props.world")
    if os.path.exists(stale):
        os.remove(stale)
    shutil.rmtree(props_dir, ignore_errors=True)


def _has_viewmodel_dumps(backend):
    """Whether stages 8 and 9 can run: the view clips whole, and the weapon keys they read."""
    return backend.provides(*VIEWMODEL_DUMPS) and backend.writes("weapon", *viewmodel.WEAPON_KEYS)


def _skipped(backend, kinds):
    """Why a stage did not run: the dumps this backend does not write whole."""
    missing = [kind for kind in kinds if not backend.provides(kind)]
    if kinds is VIEWMODEL_DUMPS and not backend.writes("weapon", *viewmodel.WEAPON_KEYS):
        missing.append("the weapon keys stages 8 and 9 read")
    if kinds is PROPS_DUMPS and not backend.writes("clipmap", *PROPS_CLIPMAP_FIELDS):
        missing.append(f"clipmap ({', '.join(PROPS_CLIPMAP_FIELDS)})")
    return f"skipped: the {backend.name} backend does not dump {', '.join(missing)} yet"


def _stop(work, keep_work, out, reached, why):
    """End an export early, by design: the backend does not dump what the next stages read."""
    print(f"\n      stopping after {reached}: {why}")
    if not keep_work:
        shutil.rmtree(work, ignore_errors=True)
    print(f"\ndone (to {reached}) -> {out}")


def _dump_models(backend, ff, companions, work, referenced=0):
    """Models, images and materials from the companion zones and then the map (so its copies win),
    plus the companions' weapon files and clips for the viewmodel. Returns the image directory.

    A kind the backend cannot dump yet is left out; the stages that read it do not run."""
    models = ("models", "xmodel")
    images = ("img", "image")
    companion_dumps = (
        models,
        images,
        ("mat", "material"),
        ("weapons", "weapon"),
        ("fx", "fx"),  # most effects are defined here, not in the map
        # Alias definitions only: a map's emitter may layer in an alias defined
        # here, and the table is small. The PCM behind a companion alias is not
        # dumped -- that is the catalogue's job, and a common_mp loadedsound dump
        # is two orders of magnitude larger than everything else a map needs.
        ("snd", "sound"),
        ("view_anim", "xanim"),  # apart from the map's prop clips
    )
    for name, common_ff in companions:
        print(f"      + {name}" + (f" ({referenced} referenced placement(s))" if referenced else " (referenced assets)"))
        for sub, kind in companion_dumps:
            if backend.dumps(kind):
                backend.dump(common_ff, os.path.join(work, sub), kind)

    img_dir = os.path.join(work, "img")
    for sub, kind in (models, images):
        if backend.dumps(kind):
            backend.dump(ff, os.path.join(work, sub), kind)
    if backend.dumps("material"):
        backend.dump(ff, os.path.join(work, "mat"), "material")
    return img_dir


def export_climbing(map_name, out, clip_path, placements):
    """Stage 6's world files: `mantle.world` and `ladder.world`. Returns whether each was written.

    Both come out of the clipmap, but as world-file nodes rather than geometry:
    each is a permission to climb, not a surface. A mantle volume blocks nothing
    and stays out of the BVH; a ladder is also a wall, which collision.glb
    already holds (scripts/cod/mantle.py, scripts/cod/ladder.py).
    """
    mantle_volumes, mantle_stats = mantle.read_mantles(clip_path, placements)
    mantle.report(mantle_volumes, mantle_stats)
    has_mantle = worldfile.write_mantle_world(out, map_name, mantle_volumes) is not None
    ladders, ladder_stats = ladder.read_ladders(clip_path, placements)
    ladder.report(ladders, ladder_stats)
    has_ladder = worldfile.write_ladder_world(out, map_name, ladders) is not None
    return has_mantle, has_ladder


def export_volumes(map_name, out, clip, ents_path, game_key, facts=None):
    """Stage 6's `volumes.world`: every brush-volume trigger and zone, a box per brush. Returns whether it was written.

    From the clipmap, so `--gameplay-only` cannot rewrite it; tagged and linked
    by the entity lump exactly as `gameplay.world` is (scripts/cod/gameplay.py).
    """
    entities = metadata.read_entities(ents_path, game_key) if os.path.exists(ents_path) else []
    modes_of = gameplay.modes_function(game_key, map_name, entities, facts)
    found, stats, targets = triggers.read_triggers(clip, entities, modes_of)
    triggers.report(found, stats, targets)
    return worldfile.write_volumes_world(out, map_name, found) is not None


def export_volumes_only(map_name, ff, out, backend, work):
    """`--volumes-only`: `volumes.world` from a fresh clipmap and entity dump; every other file is left alone."""
    backends.require(backend, "--volumes-only", "mapents", "clipmap")
    backend.dump(ff, os.path.join(work, "ents"), "mapents")
    backend.dump(ff, os.path.join(work, "clip"), "clipmap")
    ents_path = find_file(os.path.join(work, "ents"), ".ents")
    clip_path = find_file(os.path.join(work, "clip"), ".clipmap.json")
    if not ents_path or not clip_path:
        sys.exit(f"--volumes-only: the backend wrote no {'entity lump' if not ents_path else 'clipmap'} for {map_name}")
    clip = read_json(clip_path)
    game_key = clip["_game"]
    facts = gameobjects.facts_from_ents(map_name, ents_path, game_key)
    print("[6/13] exporting trigger volumes")
    _set_include(out, "volumes.world", export_volumes(map_name, out, clip, ents_path, game_key, facts))


def export_collision_only(map_name, ff, out, backend, work):
    """`--collision-only`: `assets/collision.glb` from the three dumps it needs.

    The same three `--climbing-only` takes, and for the same reason: the clipmap
    is the geometry, and the GfxWorld and the entities only say where a brush
    model goes. Everything else about the world -- its shell, its props, its
    gameplay -- is left exactly as it is, which is what makes a collision-format
    change re-exportable one map at a time.
    """
    backends.require(backend, "--collision-only", "gfxworld", "mapents", "clipmap")
    backend.dump(ff, os.path.join(work, "gw"), "gfxworld")
    backend.dump(ff, os.path.join(work, "ents"), "mapents")
    backend.dump(ff, os.path.join(work, "clip"), "clipmap")
    manifest_path = _gfxworld_manifest(work)
    ents_path = manifest_path.replace(".gfxworld.json", ".ents").replace("/gw/", "/ents/")
    clip_path = find_file(os.path.join(work, "clip"), ".clipmap.json")
    clip = read_json(clip_path) if clip_path else {}
    manifest = read_json(manifest_path)
    facts = gameobjects.facts_from_ents(map_name, ents_path, manifest["_game"]) if os.path.exists(ents_path) else None
    placements = brushmodels.preflight(manifest, clip, os.path.exists(ents_path), ents_path, facts)
    require_axial_faces(clip)
    print("[6/13] exporting collision")
    collision.export_collision(clip_path, os.path.join(out, "assets", "collision.glb"), placements)


def export_climbing_only(map_name, ff, out, backend, work):
    """`--climbing-only`: `mantle.world` and `ladder.world` from the three dumps they need.

    The GfxWorld and the entities are only there to place brush models, and are
    checked the way a full export checks them.
    """
    backends.require(backend, "--climbing-only", "gfxworld", "mapents", "clipmap")
    backend.dump(ff, os.path.join(work, "gw"), "gfxworld")
    backend.dump(ff, os.path.join(work, "ents"), "mapents")
    backend.dump(ff, os.path.join(work, "clip"), "clipmap")
    manifest_path = _gfxworld_manifest(work)
    ents_path = manifest_path.replace(".gfxworld.json", ".ents").replace("/gw/", "/ents/")
    clip_path = find_file(os.path.join(work, "clip"), ".clipmap.json")
    clip = read_json(clip_path) if clip_path else {}
    placements = brushmodels.preflight(read_json(manifest_path), clip, os.path.exists(ents_path), ents_path)
    require_axial_faces(clip)
    print("[6/13] exporting mantle volumes and ladders")
    has_mantle, has_ladder = export_climbing(map_name, out, clip_path, placements)
    if has_mantle:
        worldfile.ensure_include(out, "mantle.world")
    if has_ladder:
        worldfile.ensure_include(out, "ladder.world")


def export_viewmodel_stage(map_name, game_key, out, work, states):
    """Stage 8: the map's view hands and one weapon into `assets/viewmodel/`.

    No world file any more: what a player holds is a gametype's choice out of the
    catalogue (docs/engine/scripting.md). `assets/viewmodel/` is where the pairs
    land, and `harvest` is what moves them into `catalog/viewhands/`.

    Returns (whether anything was exported, the chosen weapon's name and
    infostring or None) — the characters stage holds the gun that weapon names.
    """
    choice = worldfile.Overrides(out).data.get("viewmodel") or {}
    if choice:
        print(f"      {worldfile.OVERRIDES_FILE}: {', '.join(f'{k} {v}' for k, v in choice.items())}")
    shutil.rmtree(os.path.join(out, "assets", viewmodel.OUT_DIR), ignore_errors=True)
    assets = os.path.join(out, "assets")
    result = viewmodel.export_viewmodel(work, assets, game_key, states, choice.get("weapon"), choice.get("hands"))
    if result is None:
        return False, None
    return True, result[3]


def export_characters_stage(map_name, out, work, game_key, states, weapon_info):
    """Stage 9: the map's player bodies, heads and held weapon into `assets/characters/`.

    No world file any more, for the reason the viewmodel stage has none: who a
    player is comes out of the catalogue now, and `harvest` is what puts these
    there.

    Needs the weapon the viewmodel stage chose, whose `worldModel` is the gun a
    player is seen holding; without one there is nothing to hold and no stage.
    """
    choice = worldfile.Overrides(out).data.get("characters") or {}
    if choice:
        print(f"      {worldfile.OVERRIDES_FILE}: {', '.join(f'{k} {v}' for k, v in choice.items())}")
    shutil.rmtree(os.path.join(out, "assets", characters.OUT_DIR), ignore_errors=True)
    result = None
    if weapon_info is None:
        print("      no characters: this map exported no viewmodel, so no weapon to hold")
    else:
        weapon, info = weapon_info
        try:
            result = characters.export_characters(work, os.path.join(out, "assets"), game_key, states, info, weapon, choice)
        except ValueError as exc:
            sys.exit(f"{map_name}: {exc}")
    return result is not None


def export_parts_only(map_name, ff, zone, out, backend, work, common, want_characters):
    """`--viewmodel-only` / `--characters-only`: stages 8 and 9 from the dumps they need.

    Both run either way — the characters stage needs the weapon the viewmodel
    stage picks — but only the asked-for world file's include is ensured, so
    `--viewmodel-only` on a world with no characters leaves it that way.
    """
    backends.require(backend, "--viewmodel-only and --characters-only", "xmodel", "image", "material", "mapents")
    backends.require_fields(backend, "--viewmodel-only and --characters-only", "weapon", *viewmodel.WEAPON_KEYS)
    _dump_models(backend, ff, companion_zones(zone, common), work)
    backend.dump(ff, os.path.join(work, "ents"), "mapents")
    game_key, _ = metadata.zone_listing(find_file(os.path.join(work, "ents"), ".zone"))
    if game_key == "t5":
        backend.dump(ff, os.path.join(work, "raw"), "rawfile")  # the create-a-class scripts (cac.py)
    _, _, _, states = classify_materials(os.path.join(work, "mat", "materials"), [], game_key)
    print("[8/13] exporting the viewmodel")
    has_viewmodel, weapon_info = export_viewmodel_stage(map_name, game_key, out, work, states)
    print("[9/13] exporting player characters")
    has_characters = export_characters_stage(map_name, out, work, game_key, states, weapon_info)
    # No include to ensure either way: neither stage writes a world file now. Both
    # still run whichever was asked for, because the characters stage needs the
    # weapon the viewmodel stage picks.
    if has_viewmodel or has_characters:
        problems = harvest.harvest_after_export(os.path.dirname(os.path.abspath(out)))
        for problem in problems:
            print(f"      !! {problem}")


def export_gameplay(map_name, game_key, search, out, work, img_dir=None, pathdata=None, facts=None):
    """Stage 11: `assets/minimap.png`, `export_metadata.json`, and the world files made from them alone.

    Those are `gameplay.world`, `minimap.world` and `navigation.world`. Reads
    only the mapents and rawfile dumps, and for Ghosts, AW and Black Ops the `pathdata`
    dump (`_dump_pathdata`). `img_dir` is the image dump the compass
    picture comes from for a game with no .iwd archives (`Backend.pictures`).
    Returns whether `minimap.world` (which needs both the image and its frame),
    `gameplay.world` and `navigation.world` were written.
    """
    print("[11/13] extracting minimap, export_metadata.json and minimap.world")
    compass = material_images(os.path.join(work, "mat", "materials"), f"compass_map_{map_name}")
    shot, source, size = export_minimap(search, map_name, os.path.join(out, "assets"), img_dir, compass)
    print(
        f"      minimap.png {size[0]}x{size[1]} from {source}"
        if shot
        else f"      WARNING: no compass_map_{map_name} in the search path or the dump; no minimap"
    )
    ents_dir = os.path.join(work, "ents")
    _, data = metadata.write_metadata(
        out,
        map_name,
        game_key,
        find_file(ents_dir, ".ents"),
        os.path.join(work, "raw"),
        find_file(ents_dir, ".zone"),
        (source, size) if shot else None,
    )
    frame = data["minimap"]["image_corners"]
    print(
        f"      {len(data['spawns'])} spawns ({', '.join(f'{m} {sum(c.values())}' for m, c in data['spawn_counts'].items())}), "
        f"{sum(len(v) for v in data['game_objects'].values())} game objects, {len(data['fx']['placements'])} fx, "
        f"{len(data['entities'])} entities"
    )
    if not frame:
        print(f"      WARNING: {len(data['minimap']['corners'])} minimap_corner entities (the game needs 2); minimap not placed")
    if data["unnamed_keys"]:
        print(f"      {len(data['unnamed_keys'])} numeric entity key(s) with no known name, kept as numbers")
    written = worldfile.write_gameplay_world(out, map_name, data, facts)
    if written.path:
        print(f"      gameplay.world: {_gameplay_counts(written)}")
    if written.dropped:
        print(f"      {written.dropped}")
    gameplay_path = written.path
    has_minimap = worldfile.write_minimap_world(out, map_name, data["minimap"] if shot else None) is not None
    has_nav, report = export_navigation(map_name, out, data, pathdata)
    print(f"      {report}")
    return has_minimap, gameplay_path is not None, has_nav


# The games whose path nodes `export_navigation` maps from the entity lump, and those
# it maps from a `pathdata` dump, by the zone that dump is read from: Ghosts' and AW's
# own `<map>_path.ff`, Black Ops' and Black Ops II's map zone (its GameWorldMp). MW2 has
# none to map (docs/cod/navigation.md).
NAV_GAMES = ("iw5",)
PATHDATA_ZONES = {"iw6": "{map}_path.ff", "s1": "{map}_path.ff", "t5": "{map}.ff", "t6": "{map}.ff"}
PATHDATA_GAMES = tuple(PATHDATA_ZONES)


def export_navigation(map_name, out, data, pathdata=None):
    """`assets/nav.bin` and `navigation.world`, from the game's path nodes.

    MW3's are the `node_*` entities in the metadata a previous export wrote
    (scripts/cod/nav/from_ents.py), so they need no game files. Ghosts', AW's and
    Black Ops' are compiled into a zone (`PATHDATA_ZONES`), and `pathdata` is its
    dump (scripts/cod/nav/from_pathdata.py), checked against the metadata's entities.
    Returns (written, a line to report): a map with no graph leaves neither file
    behind, and one that could not be read (a game not wired yet, a path zone
    not dumped) is left as it is, with `written` None.
    """
    game_key = data.get("game")
    if game_key == "iw4":
        nav, why = None, "MW2's MP zones ship no path nodes"
    elif game_key in NAV_GAMES:
        nav, why = from_ents.from_entities(data.get("entities", []), game_key, map_name)
    elif game_key in PATHDATA_GAMES:
        if pathdata is None:
            zone = PATHDATA_ZONES[game_key].format(map=map_name)
            return None, f"navigation: no {zone} dumped, so the files already there are left as they are"
        try:
            nav, why = from_pathdata.from_pathdata(read_json(pathdata), data.get("entities", []), game_key, map_name)
        except from_pathdata.NavSourceError as e:
            sys.exit(f"navigation: {e}")
    else:
        return None, f"navigation: not wired yet for {game_key}"
    bin_path = os.path.join(out, worldfile.NAV_FILE)
    if nav is None:
        if os.path.exists(bin_path):
            os.remove(bin_path)
        worldfile.write_nav_world(out, map_name, None)
        return False, f"navigation: none, {why}"
    blob = encode_nav(nav)
    os.makedirs(os.path.dirname(bin_path), exist_ok=True)
    with open(bin_path, "wb") as fh:
        fh.write(blob)
    worldfile.write_nav_world(out, map_name, nav)
    meta = nav.meta
    kinds = ", ".join(f"{n} {k}" for k, n in meta["traversals"].items())
    report = f"navigation.world: {len(nav.nodes)} node(s), {len(nav.traversals)} traversal(s)"
    report += f" ({kinds})" if kinds else ""
    if "walk" in meta.get("links", {}):
        report += f", {meta['links']['walk']} game walk link(s) ({meta['links'].get('walkOneWay', 0)} one-way)"
    if meta.get("links", {}).get("unsearched"):
        report += f", {meta['links']['unsearched']} redundant link(s) left out"
    report += f", {len(blob) / 1024:.1f} KB"
    if "entityMatch" in meta:
        match = meta["entityMatch"]
        report += f"\n      all {match['nodes']} node_* entities agree in {match['compared']} (worst {match['worst']} in)"
    for side, sources in meta.get("unpaired", {}).items():
        report += f"\n      {len(sources)} negotiation {side} node(s) in no traversal: node_* #{', #'.join(map(str, sources))}"
    if meta.get("unknownAnimscripts"):
        names = ", ".join(f"{a or '(none)'} x{n}" for a, n in meta["unknownAnimscripts"].items())
        report += f"\n      UNKNOWN animscript(s), traversal kind unknown: {names}"
    if nav.skipped:
        report += f"\n      skipped: {', '.join(f'{k} x{n}' for k, n in nav.skipped.items())}"
    return True, report


def rewrite_navigation(map_name, out, zones=()):
    """`--nav-only`: rewrite `navigation.world` and `assets/nav.bin` from the committed metadata.

    MW3's needs nothing else. Ghosts', AW's and Black Ops' graphs are in the game's
    own zone (`PATHDATA_ZONES`), looked for in `zones`: that zone is dumped alone
    (a path zone takes a second or two, a Black Ops map a few), and without the
    game installed nothing is changed.
    """
    meta = os.path.join(out, metadata.METADATA_FILE)
    if not os.path.exists(meta):
        print(f"  ! {map_name}: no {metadata.METADATA_FILE}; run a full export first")
        return False
    data = read_json(meta)
    work, pathdata = None, None
    game_key = data.get("game")
    if game_key in PATHDATA_GAMES:
        name = PATHDATA_ZONES[game_key].format(map=map_name)
        path_ff = next((f for f in (os.path.join(z, name) for z in zones) if os.path.exists(f)), None)
        if path_ff is None:
            print(
                f"  ! {map_name}: {game_key}'s path nodes are read from the game's own {name}, "
                f"which is in none of: {', '.join(zones) or '(no zone folder)'}. Is the game installed? Nothing was changed"
            )
            return None
        work = os.path.join(CACHE_DIR, os.path.basename(os.path.normpath(out)) + "-nav")
        pathdata = _dump_pathdata(backends.for_fastfile(path_ff), map_name, os.path.dirname(path_ff), work, game_key)
    try:
        written, report = export_navigation(map_name, out, data, pathdata)
    finally:
        if work:
            shutil.rmtree(work, ignore_errors=True)
    _set_include(out, "navigation.world", written)
    print(f"  {'+' if written else '-'} {map_name}: {report}")
    return written


def _release_walks(backend, map_name, ff, game_key):
    """Stage 1's dumps are written: let go of the zone walks (a map's and a companion's are
    each hundreds of MB, most of a GB on Ghosts and AW), keeping the map's only where
    stage 11 dumps its path nodes from it (docs/cod/pipeline.md#memory)."""
    release = getattr(backend, "release", None)
    if release is not None:
        own_zone = PATHDATA_ZONES.get(game_key, "").format(map=map_name) == os.path.basename(ff)
        release(keep=[ff] if own_zone else [])
        gc.collect()  # a walk's records point back at it: only the cycle collector frees one


def _dump_pathdata(backend, map_name, zone_dir, work, game_key):
    """The `pathdata` dump of the zone `PATHDATA_ZONES` names for the game, or None.

    Ghosts and AW compile a map's path nodes into a small `<map>_path.ff` of its
    own, which the map zone never names; Black Ops into the map zone itself, so
    in a full export its dump reuses the map's walk (docs/cod/navigation.md).
    """
    if game_key not in PATHDATA_GAMES:
        return None
    name = PATHDATA_ZONES[game_key].format(map=map_name)
    path_ff = os.path.join(zone_dir, name)
    if not os.path.exists(path_ff):
        print(f"      no {name} beside {map_name}.ff; no path nodes to read")
        return None
    out = os.path.join(work, "path")
    backend.dump(path_ff, out, "pathdata")
    found = find_file(out, ".pathdata.json")
    if found is None:
        sys.exit(f"{path_ff} holds no PATHDATA asset")
    return found


def _set_include(out, name, written):
    """Include `name` in world.world exactly when it was written; None (the stage did not run) leaves it be."""
    if written:
        worldfile.ensure_include(out, name)
    elif written is not None:
        worldfile.drop_include(out, name)


def _zone_images(backend, work):
    """The image dump stage 11 takes the compass picture from, or None where an .iwd holds it."""
    return os.path.join(work, "img") if backend.pictures == "zone" else None


def export_loadscreen_stage(backend, search, map_name, zone_dir, assets, work, name=None):
    """Stage 10: `assets/loadscreen.jpg`, from the .iwd archives or the zones that hold it.

    `name` is the picture's name after `loadscreen_` where it is not the map's own."""
    print("[10/13] extracting loadscreen")
    img_dir = _load_zone_images(backend, map_name, zone_dir, work)
    size = getattr(backend, "loadscreen_size", None)
    shot, source = export_loadscreen(search, name or map_name, assets, img_dir, size=size)
    print(
        f"      loadscreen.jpg from {source}"
        if shot
        else "      no loadscreen in the search path; the picker will fall back to minimap.png"
    )


def _load_zone_images(backend, map_name, zone_dir, work):
    """Stage 10's image dump for a game whose pictures are zone images, or None.

    Ghosts ships no .iwd archives, and its loading screen is not in the map's own
    zone either: it is an ordinary image in `<map>_load.ff`, the small zone the
    game shows it from, which is stock across every Ghosts map. So that zone is
    walked for its images alone, into a dump of its own. A backend names other
    zones in `loadscreen_zones` (globs; Black Ops II keeps every map's in one), and
    a `loadscreen` dump kind writes only the pictures rather than every image. A
    pattern may name `{mode}`, the zone name's prefix: Black Ops II's `mp_` maps
    load `code_post_gfx_mp.ff` and its `zm_` maps `code_post_gfx_zm.ff`.
    """
    kind = "loadscreen" if backend.dumps("loadscreen") else "image"
    if backend.pictures != "zone" or not backend.dumps(kind):
        return None
    patterns = getattr(backend, "loadscreen_zones", ("{map}_load.ff",))
    mode = map_name.split("_", 1)[0]
    found = [
        p
        for pattern in patterns
        for p in sorted(glob.glob(os.path.join(glob.escape(zone_dir), pattern.format(map=map_name, mode=mode))))
    ]
    if not found:
        print(f"      no {' or '.join(patterns).format(map=map_name, mode=mode)} beside {map_name}.ff; no loading screen to read")
        return None
    out = os.path.join(work, "load")
    for load_ff in found:
        backend.dump(load_ff, out, kind)
    return out


def export_effects(map_name, out, work, img_dir, states, search=None):
    """`assets/fx/`, and the `fx.world` that names what plays where.

    The placements were parsed into `export_metadata.json` by the metadata stage;
    what is new here is the effect definitions behind them, and the closure over
    the children they spawn.
    """
    meta_path = os.path.join(out, metadata.METADATA_FILE)
    if not os.path.exists(meta_path):
        print("      no metadata; nothing to place")
        return False
    data = read_json(meta_path)
    return _write_effects(map_name, out, os.path.join(work, "fx", "fx"), data, img_dir, states, search)


def _write_effects(map_name, out, fx_root, data, img_dir=None, states=None, search=None):
    """The effects stage once the definitions are dumped: closure, textures and `fx.world`."""
    fx_data = data.get("fx") or {}
    aliases = fx_data.get("effects", {})
    placed = {p.get("fxid") for p in fx_data.get("placements", []) if p.get("create") in worldfile.EFFECT_CREATES}
    wanted = {aliases[f] for f in placed if f in aliases}
    if not wanted:
        print("      the map places no effects")
        return False
    if not os.path.isdir(fx_root):
        print(f"      no fx dump at {fx_root}; run a full export")
        return False

    assets_fx = os.path.join(out, "assets", "fx")
    mat_root = os.path.join(os.path.dirname(os.path.dirname(fx_root)), "mat", "materials")
    wind = fxmod.global_wind(data)
    effects, missing, images, counts = fxmod.export_fx(
        fx_root, wanted, assets_fx, mat_root if os.path.isdir(mat_root) else None, wind
    )
    children = len(effects) - len(wanted)
    print(f"      {len(effects)} effect(s) from {len(wanted)} placed ({children} pulled in as children)")
    if missing:
        print(
            f"      MISSING {len(missing)} effect(s), they will not play: "
            f"{', '.join(sorted(missing)[:4])}{' ...' if len(missing) > 4 else ''}"
        )
    undrawn = fxmod.undrawn(counts)
    if undrawn:
        kinds = ", ".join(f"{n} {t}" for t, n in undrawn.items())
        print(f"      {sum(undrawn.values())} element(s) exported but not drawn yet: {kinds}")

    if img_dir and images:
        # Every fx sprite is lossless: an additive card carries its shape in
        # brightness, so JPEG ringing would be added straight into the frame.
        wanted_tex = set(images.values())
        tex_out = os.path.join(assets_fx, "textures")
        ok, miss, failed = convert_textures(img_dir, wanted_tex, tex_out, lossless=wanted_tex, search=search)
        print(f"      {ok} texture(s) converted, {len(miss)} missing, {failed} failed")

    path, n_effects, n_places, skipped, unknown = worldfile.write_fx_world(out, map_name, data, set(effects), counts)
    if path:
        print(f"      fx.world: {n_places} placement(s) of {n_effects} effect(s)")
    return path is not None


def rewrite_effects(map_name, out):
    """Rewrite `fx.world` from the metadata and the `assets/fx/` already beside it."""
    meta = os.path.join(out, metadata.METADATA_FILE)
    if not os.path.exists(meta):
        print(f"  ! {map_name}: no {metadata.METADATA_FILE}; run a full export first")
        return False
    data = read_json(meta)
    effects_json = os.path.join(out, "assets", "fx", "effects.json")
    if not os.path.exists(effects_json):
        print(f"  ! {map_name}: no assets/fx/effects.json; run a full export first")
        return False
    library = read_json(effects_json)["effects"]
    # The same element counts a full export writes, so a re-emit is byte-identical.
    counts = {}
    for effect in library.values():
        for elem in effect["elems"]:
            counts[elem["type"]] = counts.get(elem["type"], 0) + 1
    path, n_effects, n_places, skipped, unknown = worldfile.write_fx_world(out, map_name, data, set(library), counts)
    if not path:
        print(f"  - {map_name}: places no effects")
        return False
    worldfile.ensure_include(out, "fx.world")
    print(f"  + {map_name}: {n_places} placement(s) of {n_effects} effect(s)")
    return True


def export_sound(map_name, out, work, search):
    """`assets/sounds/`, and the `sound.world` that names what plays where.

    The placements are the `createLoopSound` half of the createfx script the
    metadata stage already parsed; what is new here is the alias table behind
    them, the layers those pull in, and the clips -- from the zone's own PCM dump
    where the alias is loaded, and out of the game's .iwd archives where it is
    streamed.
    """
    meta_path = os.path.join(out, metadata.METADATA_FILE)
    if not os.path.exists(meta_path):
        print("      no metadata; nothing to place")
        return False
    data = read_json(meta_path)
    return _write_sound(map_name, out, os.path.join(work, "snd"), data, search)


def _write_sound(map_name, out, snd_root, data, search=None):
    """The sound stage once the aliases are dumped: closure, clips and `sound.world`."""
    fx_data = data.get("fx") or {}
    placements = fx_data.get("placements", [])
    wanted = {p["soundalias"] for p in placements if p.get("create") == "createLoopSound" and p.get("soundalias")}
    if not wanted:
        print("      the map places no sound")
        return False
    alias_root = os.path.join(snd_root, "sound_aliases")
    if not os.path.isdir(alias_root):
        print(f"      no sound dump at {alias_root}; run a full export")
        return False

    assets_sound = os.path.join(out, "assets", "sounds")
    aliases, missing, clips, lost, size_in, size_out = soundmod.export_sounds(
        alias_root,
        wanted,
        assets_sound,
        sound_root=os.path.join(snd_root, "sound"),
        search=search,
    )
    layers = len(aliases) - (len(wanted) - len(missing))
    print(f"      {len(aliases)} alias(es) from {len(wanted)} placed ({layers} pulled in as layers)")
    if missing:
        print(
            f"      MISSING {len(missing)} alias(es), they will not play: "
            f"{', '.join(sorted(missing)[:4])}{' ...' if len(missing) > 4 else ''}"
        )
    print(f"      {clips} clip(s) at {soundmod.BITRATE}: {size_in / 1e6:.1f} MB in, {size_out / 1e6:.1f} MB out")
    if lost:
        print(
            f"      MISSING {len(lost)} clip(s), silent where they are picked: "
            f"{', '.join(sorted(lost)[:4])}{' ...' if len(lost) > 4 else ''}"
        )

    path, n_aliases, n_places, unknown = worldfile.write_sound_world(out, map_name, data, set(aliases))
    if path:
        print(f"      sound.world: {n_places} placement(s) of {n_aliases} alias(es)")
    if unknown:
        print(f"      {len(unknown)} placed alias(es) not exported: {', '.join(sorted(unknown)[:4])}")
    return path is not None


def export_sound_only(map_name, ff, out, backend, work, search, companions):
    """Stage 13 from a fresh dump: the companions' aliases, then the map's (so its own win), then the table and `sound.world`.

    The companions are dumped for their aliases as a full export dumps them
    (`_dump_models`): a map's emitter may name an alias its companion defines --
    TranZit's whole bank is in `so_zclassic_zm_transit.ff`, and `zm_transit.ff`
    holds none.
    """
    backends.require(backend, "--sound-export-only", *SOUND_DUMPS)
    snd = os.path.join(work, "snd")
    for _name, common_ff in companions:
        backend.dump(common_ff, snd, "sound")
    for kind in SOUND_DUMPS:
        backend.dump(ff, snd, kind)
    if export_sound(map_name, out, work, search):
        worldfile.ensure_include(out, "sound.world")


def export_effects_only(map_name, ff, out, backend, work, companions, search=None):
    """Stage 12 from a fresh dump: the companions' effects, materials and images, then the map's (so its own win)."""
    backends.require(backend, "--effects-export-only", *EFFECTS_DUMPS, "material", "image")
    for _name, common_ff in companions:
        for sub, kind in (("fx", "fx"), ("mat", "material"), ("img", "image")):
            backend.dump(common_ff, os.path.join(work, sub), kind)
    for sub, kind in (("fx", "fx"), ("mat", "material"), ("img", "image")):
        backend.dump(ff, os.path.join(work, sub), kind)
    if export_effects(map_name, out, work, os.path.join(work, "img"), None, search):
        worldfile.ensure_include(out, "fx.world")


def rewrite_sound(map_name, out):
    """Rewrite `sound.world` from the metadata and the `assets/sounds/` already beside it."""
    meta = os.path.join(out, metadata.METADATA_FILE)
    if not os.path.exists(meta):
        print(f"  ! {map_name}: no {metadata.METADATA_FILE}; run a full export first")
        return False
    data = read_json(meta)
    sounds_json = os.path.join(out, "assets", "sounds", "sounds.json")
    if not os.path.exists(sounds_json):
        print(f"  ! {map_name}: no assets/sounds/sounds.json; run a full export first")
        return False
    library = read_json(sounds_json)["aliases"]
    path, n_aliases, n_places, unknown = worldfile.write_sound_world(out, map_name, data, set(library))
    if not path:
        print(f"  - {map_name}: places no sound")
        return False
    worldfile.ensure_include(out, "sound.world")
    print(f"  + {map_name}: {n_places} placement(s) of {n_aliases} alias(es)")
    return True


def rewrite_gameplay(map_name, out):
    """Rewrite `gameplay.world` from the metadata already committed beside it.

    No fastfile and no game files: `export_metadata.json` holds the whole entity
    lump a previous export read, so the spawn points and triggers can be put into
    the world file without going back to the game's own files.
    """
    meta = os.path.join(out, metadata.METADATA_FILE)
    if not os.path.exists(meta):
        print(f"  ! {map_name}: no {metadata.METADATA_FILE}; run a full export first")
        return False

    data = read_json(meta)
    written = worldfile.write_gameplay_world(out, map_name, data)
    if not written.path:
        print(f"  - {map_name}: no spawns, triggers, points or solids in its metadata")
        return False

    worldfile.ensure_include(out, "gameplay.world")
    print(f"  + {map_name}: {_gameplay_counts(written)}" + (f"; {written.dropped}" if written.dropped else ""))
    return True


def _gameplay_counts(written):
    """One line of what write_gameplay_world wrote."""
    return (
        f"{written.spawns} spawn(s), {written.triggers} trigger(s), {written.points} point(s)"
        + (f", {written.solids} removable solid(s)" if written.solids else "")
        + (f", {written.volumes} brush-volume trigger(s) left to volumes.world" if written.volumes else "")
        + (f", {written.skipped} trigger(s) with no volume to export" if written.skipped else "")
    )


def _report_animations(entities, animated, clips, assignments):
    """One line of counts, and the animated entities left still, by model."""
    playing = [e for e in entities if e.get("anim") and e["anim"] in animated.get(e["model"], ())]
    if clips or assignments.missing:
        print(
            f"      {len(playing)} placement(s) animate: {len({e['anim'] for e in playing})} of {len(clips)} clip(s) "
            f"over {len(animated)} model(s)"
        )
    if assignments.missing:
        detail = ", ".join(f"{m} x{n}" for m, n in assignments.missing.most_common(6))
        print(f"      {sum(assignments.missing.values())} animated_model entities left still, no clip in this zone: {detail}")


def _gfxworld_manifest(work):
    path = find_file(os.path.join(work, "gw"), ".gfxworld.json")
    if not path:
        sys.exit(f"no .gfxworld.json under {os.path.join(work, 'gw')}: the backend wrote no GfxWorld for this zone")
    return path


def resolve_map(entry, games, worlds_root=None):
    """(zone dir, search path, world folder, companion zones or None) for one maps.json entry.

    The world folder is `<worlds_root>/<world>`, the repo's `worlds/` by default.

    An entry's own `common` (file names beside the map) beats its game's: a Black
    Ops zombies map takes its props from `common_zombie.ff`, not `common_mp.ff`,
    and the models that differ by region (the morgue cadavers, Kino's lobby
    doors) from its `../English/en_<map>.ff`, which the map zone only references.
    """
    require_game(entry["game"])
    game = games[entry["game"]]
    zone = next((z for z in game["zones"] if os.path.exists(os.path.join(z, entry["map"] + ".ff"))), None)
    if zone is None:
        sys.exit(f"{entry['map']}.ff is in none of the {entry['game']} zone folders: {', '.join(game['zones'])}")
    common = [os.path.join(zone, name) for name in entry["common"]] if "common" in entry else game.get("common")
    return zone, ";".join(game["search"]), os.path.join(worlds_root or os.path.join(REPO_ROOT, "worlds"), entry["world"]), common


def choose_map(name, game, world, games, maps):
    """The maps.json-shaped entry `export <name> [--game g] [--world w]` means.

    `name` is a maps.json world or zone name, or any map zone of an installed game:
    maps.json records the repo's own worlds and is no limit on what can be exported.
    A map it does not list goes to `<name>-<game>` (installs.default_world) unless
    `--world` says otherwise, and its game is whichever install holds it.
    """
    listed = [m for m in maps if m["world"] == name] or [m for m in maps if m["map"] == name]
    if game:
        listed = [m for m in listed if m["game"] == game]
    # Two games can ship one zone name (mp_village is MW3's and BO2's); exporting
    # both would rewrite a world nobody asked for, and undo its props harvest.
    if len(listed) > 1:
        sys.exit(f"{name} is more than one map: name the world ({', '.join(m['world'] for m in listed)}) or pass --game")
    if listed:
        return {**listed[0], "world": world} if world else listed[0]
    if game is None:
        holders = [g for g, files in games.items() if any(os.path.exists(os.path.join(z, name + ".ff")) for z in files["zones"])]
        if not holders:
            sys.exit(
                f"{name} is not in {MAPS_FILE}, and no installed game's zones hold {name}.ff: pass --game "
                "(`python3 -m scripts.cod maps` lists what each install holds)"
            )
        if len(holders) > 1:
            sys.exit(f"{name}.ff is in more than one game's zones ({', '.join(holders)}): pass --game")
        game = holders[0]
    return {"world": world or default_world(name, game), "map": name, "game": game}


def add_arguments(ap):
    ap.add_argument(
        "map",
        nargs="?",
        help="zone name (mp_hardhat) or maps.json world (hardhat-mw3); any map zone your install holds, "
        "unless --zone/--search/--out are given",
    )
    ap.add_argument("--all", action="store_true", help="export every map in maps.json")
    ap.add_argument(
        "--game",
        choices=game_names(),
        help="with a map, the game whose zone it is; alone, export every maps.json map of that game",
    )
    ap.add_argument("--world", help="the world folder a map is written to (default: maps.json's, else <name>-<game>)")
    ap.add_argument("--zone", help="directory holding <map>.ff")
    ap.add_argument("--search", help="semicolon-separated .iwd search path")
    ap.add_argument("--out", help="world directory to write")
    ap.add_argument(
        "--worlds",
        help="the worlds root a maps.json map is written under (default: the repo's worlds/); "
        "the cast is harvested into its catalog/, so a scratch root leaves worlds/ untouched",
    )
    ap.add_argument("--work", help="scratch directory (default: .cache/cod/<out folder>); one map only")
    ap.add_argument("--keep-work", action="store_true", help="keep the scratch directory afterwards")
    ap.add_argument(
        "--metadata-only",
        action="store_true",
        help="only re-extract assets/minimap.png and export_metadata.json; every other file is left as it is",
    )
    ap.add_argument(
        "--loadscreen-only",
        action="store_true",
        help="only re-extract assets/loadscreen.jpg, and record it in export_metadata.json's images; "
        "every other file is left as it is",
    )
    ap.add_argument(
        "--gameplay-only",
        action="store_true",
        help="only rewrite gameplay.world (spawns and triggers) from the committed export_metadata.json; needs no game files",
    )
    ap.add_argument(
        "--sounds-only",
        action="store_true",
        help="only rewrite sound.world from the committed export_metadata.json and the assets/sounds/sounds.json "
        "a full export left beside it: no fastfile, no game files",
    )
    ap.add_argument(
        "--sound-export-only",
        action="store_true",
        help="only re-export assets/sounds/ and sound.world from a fresh dump of the map's and its companions' "
        "aliases; every other file is left as it is",
    )
    ap.add_argument(
        "--effects-export-only",
        action="store_true",
        help="only re-export assets/fx/ and fx.world from a fresh dump of the map's and its companions' "
        "effects, materials and images; every other file is left as it is",
    )
    ap.add_argument(
        "--effects-only",
        action="store_true",
        help="only rewrite fx.world from the committed export_metadata.json and the assets/fx/effects.json "
        "a full export wrote; needs no game files",
    )
    ap.add_argument(
        "--nav-only",
        action="store_true",
        help="only rewrite navigation.world and assets/nav.bin from the committed export_metadata.json; "
        "needs no game files for MW3, only <map>_path.ff for Ghosts and AW, and the map zone for Black Ops",
    )
    ap.add_argument(
        "--climbing-only",
        action="store_true",
        help="only rewrite mantle.world and ladder.world from a fresh clipmap dump; every other file is left as it is",
    )
    ap.add_argument(
        "--volumes-only",
        action="store_true",
        help="only rewrite volumes.world (brush-volume triggers and zones) from a fresh clipmap dump; "
        "every other file is left as it is",
    )
    ap.add_argument(
        "--collision-only",
        action="store_true",
        help="only rewrite assets/collision.glb from a fresh clipmap dump; every other file is left as it is",
    )
    ap.add_argument(
        "--viewmodel-only",
        action="store_true",
        help="only re-export assets/viewmodel/ and re-harvest it (the weapon and view hands)",
    )
    ap.add_argument(
        "--characters-only",
        action="store_true",
        help="only re-export assets/characters/ and re-harvest it (the player bodies, heads and clips)",
    )
    ap.add_argument(
        "--common",
        action="append",
        metavar="ZONE",
        help="companion fastfile holding assets this map only references (repeatable). "
        "Defaults to common_mp.ff/common.ff beside the map; --common '' disables.",
    )


def main(args):
    if args.zone or args.search or args.out:
        if not (args.map and args.zone and args.search and args.out):
            sys.exit("an explicit export needs a map, --zone, --search and --out")
        export_map(
            args.map,
            args.zone,
            args.search,
            args.out,
            work=args.work,
            keep_work=args.keep_work,
            common=args.common,
            metadata_only=args.metadata_only,
            loadscreen_only=args.loadscreen_only,
            viewmodel_only=args.viewmodel_only,
            characters_only=args.characters_only,
            gameplay_only=args.gameplay_only,
            effects_only=args.effects_only,
            sounds_only=args.sounds_only,
            sound_export_only=args.sound_export_only,
            effects_export_only=args.effects_export_only,
            climbing_only=args.climbing_only,
            collision_only=args.collision_only,
            nav_only=args.nav_only,
            volumes_only=args.volumes_only,
        )
        return

    games, maps = load_maps()
    if args.map:
        chosen = [choose_map(args.map, args.game, args.world, games, maps)]
    elif args.world:
        sys.exit("--world names one map's folder; name the map too")
    elif args.all or args.game:
        chosen = [m for m in maps if args.all or m["game"] == args.game]
    else:
        sys.exit("name a map, or pass --all or --game")
    if args.work and len(chosen) > 1:
        sys.exit("--work names one map's scratch directory; name one map")

    failed = []
    for n, entry in enumerate(chosen, 1):
        print(f"\n==== [{n}/{len(chosen)}] {entry['map']} -> worlds/{entry['world']}")
        try:
            if args.nav_only:
                # The world folder, and the zone folders as named: resolving the map's own
                # zone would need the game installed, which MW3's graph does not.
                zones = games[entry["game"]]["zones"]
                worlds = args.worlds or os.path.join(REPO_ROOT, "worlds")
                rewrite_navigation(entry["map"], os.path.join(worlds, entry["world"]), zones)
                continue
            zone, search, out, common = resolve_map(entry, games, args.worlds)
            export_map(
                entry["map"],
                zone,
                search,
                out,
                work=args.work,
                keep_work=args.keep_work,
                common=args.common or common,
                metadata_only=args.metadata_only,
                loadscreen_only=args.loadscreen_only,
                viewmodel_only=args.viewmodel_only,
                characters_only=args.characters_only,
                gameplay_only=args.gameplay_only,
                sounds_only=args.sounds_only,
                sound_export_only=args.sound_export_only,
                effects_export_only=args.effects_export_only,
                effects_only=args.effects_only,
                climbing_only=args.climbing_only,
                collision_only=args.collision_only,
                volumes_only=args.volumes_only,
                loadscreen=entry.get("loadscreen"),
            )
        except SystemExit as e:  # one bad map must not stop a batch
            if len(chosen) == 1:
                raise
            print(f"FAILED {entry['map']}: {e}")
            failed.append(entry["map"])
    if len(chosen) > 1:
        print(f"\n{len(chosen) - len(failed)}/{len(chosen)} exported" + (f"; failed: {', '.join(failed)}" if failed else ""))
    if failed:
        sys.exit(1)
