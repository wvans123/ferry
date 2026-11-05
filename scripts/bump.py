"""Set Ferry's version in every file that carries it: python scripts/bump.py 0.31.0

package.json, package-lock.json (the root package only), server/pyproject.toml and
server/ferry_server/__init__.py. Run it instead of opening those files, so a release does not
need to read the 60 KB lock file.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# (file, pattern whose group 1 is the version, how many matches to expect)
TARGETS = [
    ("package.json", r'^  "version": "([^"]+)"', 1),
    # the lock file's own version, then packages[""].version; dependencies are indented deeper
    ("package-lock.json", r'^  "version": "([^"]+)"|^      "version": "([^"]+)"', 2),
    ("server/pyproject.toml", r'^version = "([^"]+)"', 1),
    ("server/ferry_server/__init__.py", r'^__version__ = "([^"]+)"', 1),
]


def bump(version: str) -> None:
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        sys.exit(f"not a version: {version!r} (want x.y.z)")
    for rel, pattern, count in TARGETS:
        path = ROOT / rel
        text = path.read_text(encoding="utf-8")
        done = 0

        def repl(m: re.Match) -> str:
            nonlocal done
            done += 1
            old = m.group(1) or m.group(2) if m.re.groups > 1 else m.group(1)
            return m.group(0).replace(old, version)

        text = re.sub(pattern, repl, text, count=count, flags=re.M)
        if done != count:
            sys.exit(f"{rel}: expected {count} version line(s), found {done}")
        path.write_text(text, encoding="utf-8", newline="\n")
        print(f"{rel}: {version}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    bump(sys.argv[1])
