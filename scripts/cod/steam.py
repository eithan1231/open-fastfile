"""Where Steam keeps its games on this machine: `libraryfolders.vdf`, read from the standard roots.

    steam.find_install("Call of Duty Black Ops")   # its steamapps/common folder, or None
    steam.find_depot(42680, 42683)                 # a depot `download_depot` wrote, or None

Only ever a fallback: every user can name any folder (config.py). Nothing here
writes to Steam or asks it anything: the files are read as text.
"""

import os
import sys


def parse_vdf(text):
    """Valve's KeyValues text, as nested dicts of str. Keys repeat rarely and the last one wins.

    Enough of the format for `libraryfolders.vdf` and `appmanifest_*.acf`: quoted or
    bare tokens, `{` `}` blocks, `//` comments, and `\\` escapes inside quotes.
    Raises ValueError on an unbalanced block, so a truncated file is not read as empty.
    """
    tokens = _tokens(text)
    root = {}
    stack = [root]
    key = None
    for token, quoted in tokens:
        if not quoted and token == "{":
            if key is None:
                raise ValueError("vdf: a block with no key")
            child = {}
            stack[-1][key] = child
            stack.append(child)
            key = None
        elif not quoted and token == "}":
            if len(stack) == 1 or key is not None:
                raise ValueError("vdf: unbalanced '}'")
            stack.pop()
        elif key is None:
            key = token
        else:
            stack[-1][key] = token
            key = None
    if len(stack) != 1 or key is not None:
        raise ValueError("vdf: unterminated block")
    return root


def _tokens(text):
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if c.isspace():
            i += 1
        elif text.startswith("//", i):
            end = text.find("\n", i)
            i = n if end < 0 else end + 1
        elif c in "{}":
            yield c, False
            i += 1
        elif c == '"':
            out, i = [], i + 1
            while i < n and text[i] != '"':
                if text[i] == "\\" and i + 1 < n:
                    i += 1
                    out.append({"n": "\n", "t": "\t"}.get(text[i], text[i]))
                else:
                    out.append(text[i])
                i += 1
            if i >= n:
                raise ValueError("vdf: unterminated string")
            i += 1
            yield "".join(out), True
        else:
            start = i
            while i < n and not text[i].isspace() and text[i] not in '{}"':
                i += 1
            yield text[start:i], False


def steam_roots(platform=None, environ=None, home=None):
    """The folders a Steam client may be installed in, for this platform, in the order tried."""
    platform = platform or sys.platform
    environ = os.environ if environ is None else environ
    home = home or os.path.expanduser("~")
    if platform.startswith("win"):
        roots = [_registry_steam_path()]
        for var in ("ProgramFiles(x86)", "ProgramFiles"):
            if environ.get(var):
                roots.append(os.path.join(environ[var], "Steam"))
    elif platform == "darwin":
        roots = [os.path.join(home, "Library", "Application Support", "Steam")]
    else:
        roots = [
            os.path.join(home, ".local", "share", "Steam"),
            os.path.join(home, ".steam", "steam"),
            os.path.join(home, ".var", "app", "com.valvesoftware.Steam", ".local", "share", "Steam"),
        ]
    return [r for r in roots if r]


def _registry_steam_path():
    try:
        import winreg  # Windows only
    except ImportError:
        return None
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Valve\Steam") as key:
            return os.path.normpath(winreg.QueryValueEx(key, "SteamPath")[0])
    except OSError:
        return None


def libraries(roots=None):
    """Every Steam library folder (the one holding `steamapps/`), each once, from each root's libraryfolders.vdf."""
    out = []
    for root in steam_roots() if roots is None else roots:
        if not os.path.isdir(os.path.join(root, "steamapps")):
            continue
        found = [root]
        vdf = os.path.join(root, "steamapps", "libraryfolders.vdf")
        if os.path.exists(vdf):
            try:
                with open(vdf, encoding="utf-8", errors="replace") as fh:
                    data = parse_vdf(fh.read())
            except (OSError, ValueError):
                data = {}
            folders = data.get("libraryfolders") or data.get("LibraryFolders") or {}
            for value in folders.values():
                # Current clients write a block with a "path"; older ones the path itself.
                path = value.get("path") if isinstance(value, dict) else value
                if isinstance(path, str) and os.path.isdir(path):
                    found.append(path)
        for path in found:
            # ~/.steam/steam is usually a link to ~/.local/share/Steam: one library, not two.
            if not any(os.path.realpath(path) == os.path.realpath(p) for p in out):
                out.append(path)
    return out


def find_install(folder, roots=None):
    """`steamapps/common/<folder>` in the first library that has it, or None."""
    for library in libraries(roots):
        path = os.path.join(library, "steamapps", "common", folder)
        if os.path.isdir(path):
            return path
    return None


def content_dirs(library):
    """Where `download_depot` writes in or beside a library: `steamapps/content`, and on Linux the
    client's own `ubuntu12_32/steamapps/content` (the library that is the Steam root holds it)."""
    return [
        os.path.join(library, "steamapps", "content"),
        os.path.join(library, "ubuntu12_32", "steamapps", "content"),
    ]


def find_depot(app, depot, roots=None):
    """`app_<app>/depot_<depot>` under the first library's content folder that has it, or None."""
    for library in libraries(roots):
        for content in content_dirs(library):
            path = os.path.join(content, f"app_{app}", f"depot_{depot}")
            if os.path.isdir(path):
                return path
    return None
