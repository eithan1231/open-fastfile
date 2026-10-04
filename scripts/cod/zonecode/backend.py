"""A dump backend over a zonecode walk, for one 32-bit game.

    class Backend(zonecode.backend.Backend):     # scripts/cod/iw5/backend.py
        name, spec, dumpers, exe = "iw5", IW5, iw5.dumpers, ("IW5_EXE", "mw3")

    backend = Backend(search)             # `search`: the `;`-joined .iwd archives, or None
    backend.dump(ff, out, "clipmap")      # writes the clipmap dump under `out`

The shape is IW6's (scripts/cod/iw6/backend.py): a fastfile is walked on the first
dump that names it and every later kind is written from that walk. A game says
which fastfiles it claims (its `ZoneSpec`), which writer each kind has (its
`dumpers` package: `DUMPERS`, `COMPLETE`, `PARTS`, `Context`), and where its
executable is, which is read (never run) for the wavelet image tables.
"""

import os

from .. import fastfile, installs
from . import listing, program
from .companions import Companions
from .walker import walk_fastfile


class Backend:
    name = None
    spec = None  # the ZoneSpec whose fastfiles this backend claims
    dumpers = None  # the game's writer registry
    exe = (None, None)  # ($ENV naming the executable, the games.json game whose `exe` it is)
    pictures = "iwd"  # IW4 and IW5 ship the compass and loading screen loose in .iwd archives

    kinds = frozenset()  # the kinds dumped whole

    def __init_subclass__(cls, **kwargs):
        super().__init_subclass__(**kwargs)
        cls.kinds = frozenset(cls.dumpers.COMPLETE)

    def __init__(self, search=None):
        self.search = search  # the `;`-joined .iwd archives an image's pixels may be kept in
        self._walked = {}
        # What each companion zone holds, by name, for what a map names under a leading
        # comma (a LOD's surfaces): zonecode/companions.py.
        self.companions = Companions(self.companion_walk, lambda path: path in self._walked)

    @classmethod
    def claims(cls, fastfile_path):
        """Whether `fastfile_path` is this game's fastfile (signed or not), from its header."""
        container = fastfile.claim(fastfile_path)
        return container is not None and container.spec is cls.spec

    def check(self):
        """Refuse to start without the load program a walk interprets."""
        path = program.path_for(self.spec.game)
        if not os.path.exists(path):
            raise SystemExit(f"no {self.name} load program at {path}: it ships in scripts/cod/data/ (scripts/cod/data/README.md)")

    def dumps(self, kind):
        """Whether `kind` can be dumped at all, whole or in part."""
        return kind in self.dumpers.DUMPERS

    def provides(self, *kinds):
        """Whether every kind is dumped whole."""
        return all(kind in self.kinds for kind in kinds)

    def writes(self, kind, *fields):
        """Whether `kind`'s dump holds these top-level fields, whole or not."""
        return self.provides(kind) or set(fields) <= self.dumpers.PARTS.get(kind, set())

    def dump(self, fastfile_path, out, kind):
        """Write `kind` from `fastfile_path` under `out`."""
        writers = self.dumpers.DUMPERS
        if kind not in writers:
            raise SystemExit(f"the {self.name} backend cannot dump {kind!r} yet (it can: {', '.join(sorted(writers))})")
        walk = self.walk(fastfile_path)
        context = self.dumpers.Context(search=self.search, exe=self.executable(), companions=self.companions)
        writers[kind](walk, out, context)
        # The zone's asset listing goes beside whatever was dumped: stage 11 reads
        # it for the game and for what the zone holds.
        listing.write_listing(walk, _folder(out, "zone_source"))

    def walk(self, fastfile_path):
        """The walked zone, walking it on first use. The latest map's walk and the latest
        other zone's are kept: an export returns to its map after the companions, and a
        catalogue walking every map for sound would otherwise hold all of them."""
        key = os.path.abspath(fastfile_path)
        if key not in self._walked:
            print(f"      walking {os.path.basename(fastfile_path)}")
            walk = walk_fastfile(fastfile_path)
            problems = walk.check()
            if problems:
                raise SystemExit(f"{fastfile_path}: the walk is not exact: {'; '.join(problems)}")
            is_map = _is_map(walk)
            self._walked = {k: w for k, w in self._walked.items() if _is_map(w) != is_map}
            self._walked[key] = walk
            if not is_map:
                self.companions.note(walk)
        return self._walked[key]

    def release(self, keep=()):
        """Let go of every walk but those of the fastfiles in `keep`: an export calls this
        once its dumps are written, so the later stages do not run beside two zones."""
        keep = {os.path.abspath(path) for path in keep}
        self._walked = {k: w for k, w in self._walked.items() if k in keep}

    def companion_walk(self, fastfile_path):
        """A companion zone's walk, walked again if a later companion replaced it. The one
        held now is let go first, so a map's dump never holds two companions at once."""
        if os.path.abspath(fastfile_path) not in self._walked:
            self._walked = {k: w for k, w in self._walked.items() if _is_map(w)}
        return self.walk(fastfile_path)

    @classmethod
    def executable(cls):
        """The game's executable, read (never run) for the wavelet image tables: $<G>_EXE, else the install's (installs.py)."""
        env, game = cls.exe
        if env and os.environ.get(env):
            return os.environ[env]
        return installs.game_files(game)[0]["exe"] if game else None


def _is_map(walk):
    return bool(walk.by_type("gfxworld"))


def _folder(out, name):
    path = os.path.join(out, name)
    os.makedirs(path, exist_ok=True)
    return path
