"""python3 -m scripts.cod <command> ..."""

import argparse
import sys

from . import actors, catalog, config, doctor, equiv, export, harvest, hitboxes, maplist, migrate, textures


def main(argv=None):
    ap = argparse.ArgumentParser(prog="python3 -m scripts.cod", description=__doc__)
    commands = ap.add_subparsers(dest="command", required=True)
    # The commands that read game files take `--game-dir`, which wins over every other source (config.py).
    games = argparse.ArgumentParser(add_help=False)
    games.add_argument(
        "--game-dir",
        action="append",
        metavar="GAME=DIR",
        help="where a game is installed, e.g. bo1=/games/blackops (repeatable; a game's dirs are tried in order)",
    )
    games.add_argument(
        "--use",
        action="append",
        metavar="GAME=KIND",
        help="what Steam detection may pick for a game: auto (default), depots or install, e.g. mw3=depots",
    )

    export.add_arguments(commands.add_parser("export", parents=[games], help="export one map into a world folder"))

    doc = commands.add_parser("doctor", parents=[games], help="say where each game was found and what is missing")
    doc.add_argument("--game", choices=config.games(), help="check one game")

    lst = commands.add_parser("maps", parents=[games], help="list the map zones each install holds")
    lst.add_argument("--game", choices=config.games(), help="list one game's")
    lst.add_argument("--worlds", help="the worlds root to mark exported maps from (default: the repo's worlds/)")

    decode = commands.add_parser("decode-image", help="decode .iwi/.dds textures to PNG")
    decode.add_argument("out_dir")
    decode.add_argument("files", nargs="+")

    cat = commands.add_parser("catalog", parents=[games], help="build the shared asset catalogue")
    cat.add_argument("--worlds", default="worlds", help="the worlds root the catalogue is written into")
    cat.add_argument(
        "--work",
        help="a companion-zone dump (.cache/cod/<name>) to take every player weapon from; one of --work or --dump is required",
    )
    cat.add_argument(
        "--game",
        choices=("iw4", "iw5", "t5", "t6", "iw6", "s1"),
        help="which game --work holds; read from its zone listing if omitted",
    )
    cat.add_argument("--hands", help="the view-hands model to rig weapons onto (default: the zone's plainest pair)")
    cat.add_argument(
        "--dump",
        choices=("mw2", "mw3", "bo1", "bo2", "ghosts", "aw"),
        help="dump that game's companion zone first, then take every weapon from it",
    )
    cat.add_argument(
        "--sounds-only",
        action="store_true",
        help="build the sound bank alone (catalog/sounds/<game>/mp/); weapons, props and the index are left as they are",
    )
    cat.add_argument(
        "--clips-only",
        action="store_true",
        help="build the clip set the game's bodies play (catalog/animations/<game>/) and the index; nothing else is rebuilt",
    )

    mig = commands.add_parser("migrate", help="bring the worlds on disk up to date with a DSL change (no game files)")
    mig.add_argument("--worlds", default="worlds", help="the worlds root to migrate")
    mig.add_argument("--dry-run", action="store_true", help="report what would change and write nothing")
    mig.add_argument(
        "--retire-cast",
        action="store_true",
        help="delete viewmodel.world and characters.world, their includes and their overrides",
    )
    mig.add_argument(
        "--object-modes",
        action="store_true",
        help="give props.world's placements of models only some game modes have their `mode:`",
    )

    har = commands.add_parser("harvest", help="move the cast the worlds already ship into the catalogue (no game files)")
    har.add_argument("--worlds", default="worlds", help="the worlds root to harvest from and write into")
    har.add_argument(
        "--kinds",
        nargs="+",
        choices=harvest.ALL_HARVESTERS,
        help="which kinds to harvest (default: the cast; props are asked for by name)",
    )
    har.add_argument("--dry-run", action="store_true", help="report what would be written and write nothing")
    har.add_argument(
        "--prune",
        action="store_true",
        help="after harvesting props, delete the per-world copies no world names any more",
    )

    act = commands.add_parser(
        "actors", parents=[games], help="build the creatures a script spawns (Black Ops zombies) into the catalogue"
    )
    act.add_argument("--worlds", default="worlds", help="the worlds root the catalogue is written into")
    act.add_argument("--work", help=f"with --game, where its zone dumps go and are reused from (default {actors.WORK} for bo1)")
    act.add_argument("--no-dump", action="store_true", help="build from what --work already holds")
    act.add_argument("--game", choices=actors.GAMES, help="build one game's actors (default: every one)")

    hit = commands.add_parser("hitboxes", help="derive per-bone hitboxes for the exported bodies (no game files)")
    hit.add_argument("--worlds", default="worlds", help="the worlds root whose catalogue to read and write")
    hit.add_argument("--dry-run", action="store_true", help="report what would be written and write nothing")

    equiv.add_arguments(
        commands.add_parser("equiv", help="prove one export holds everything another does (effective identity, not bytes)")
    )

    args = ap.parse_args(argv)
    config.set_cli(getattr(args, "game_dir", None), getattr(args, "use", None))
    if args.command == "export":
        export.main(args)
    elif args.command == "doctor":
        sys.exit(0 if doctor.main(args) else 1)
    elif args.command == "maps":
        sys.exit(0 if maplist.main(args) else 1)
    elif args.command == "decode-image":
        sys.exit(0 if textures.decode_images(args.out_dir, args.files) else 1)
    elif args.command == "catalog":
        sys.exit(0 if catalog.main(args) else 1)
    elif args.command == "migrate":
        sys.exit(0 if migrate.main(args) else 1)
    elif args.command == "harvest":
        sys.exit(0 if harvest.main(args) else 1)
    elif args.command == "actors":
        sys.exit(0 if actors.main(args) else 1)
    elif args.command == "hitboxes":
        sys.exit(0 if hitboxes.main(args) else 1)
    elif args.command == "equiv":
        sys.exit(0 if equiv.main(args) else 1)


if __name__ == "__main__":
    main()
