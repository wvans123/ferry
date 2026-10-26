"""Build the offline Windows package that GitHub releases carry: dist/ferry-windows-<version>.zip

It holds the client with all its Node packages and wheels for the server and its dependencies
(Windows x64, Python 3.11 to 3.14), so `ferry install` needs no internet access.

It also carries fd and ripgrep for Windows x64 (vendor/win32-x64/), which the agent's file search tools need.

usage: python scripts/build_bundle.py [--platform win|native] [--skip-wheels] [--skip-tools]
  needs: `npm ci` done in the repo root, and internet access for pip (wheels) and GitHub (fd, ripgrep)
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import tarfile
import tomllib
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SKIP = {".git", "build", "__pycache__", "data", ".env", "ferry-server.toml", "dictionary.toml", ".pytest_cache", ".venv"}


def copy(src: Path, dst: Path) -> None:
    if src.name == "node_modules":  # copied as is: packages have their own build/ and data/ folders
        shutil.copytree(src, dst)
        return
    shutil.copytree(src, dst, ignore=lambda d, names: [n for n in names if n in SKIP or n.endswith(".egg-info")])


# Same versions as client/lib/toolbins.mjs
TOOLS = {
    "fd": "https://github.com/sharkdp/fd/releases/download/v10.2.0/fd-v10.2.0-{t}",
    "rg": "https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/ripgrep-14.1.1-{t}",
}


def fetch_tools(dest: Path, platform: str) -> None:
    """Put fd and rg for the target platform into dest (vendor/<node platform>-<arch>/)."""
    if platform == "win":
        key, asset, exe = "win32-x64", "x86_64-pc-windows-msvc.zip", ".exe"
    elif sys.platform.startswith("linux"):
        key, asset, exe = "linux-x64", "x86_64-unknown-linux-musl.tar.gz", ""
    else:
        print("tools: skipped (no prebuilt for this platform here)")
        return
    out = dest / "vendor" / key
    out.mkdir(parents=True, exist_ok=True)
    for name, url in TOOLS.items():
        archive = dest / "vendor" / asset
        urllib.request.urlretrieve(url.format(t=asset), archive)
        if asset.endswith(".zip"):
            with zipfile.ZipFile(archive) as z:
                member = next(m for m in z.namelist() if m.endswith("/" + name + exe) or m == name + exe)
                (out / (name + exe)).write_bytes(z.read(member))
        else:
            with tarfile.open(archive) as t:
                member = next(m for m in t.getmembers() if m.name.endswith("/" + name))
                (out / name).write_bytes(t.extractfile(member).read())
                (out / name).chmod(0o755)
        archive.unlink()
    print(f"tools: fd and rg in vendor/{key}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--platform", choices=["win", "native"], default="win")
    ap.add_argument("--skip-wheels", action="store_true")
    ap.add_argument("--skip-tools", action="store_true")
    a = ap.parse_args()

    version = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]
    pyproject = tomllib.loads((ROOT / "server" / "pyproject.toml").read_text(encoding="utf-8"))
    init = (ROOT / "server" / "ferry_server" / "__init__.py").read_text(encoding="utf-8")
    assert pyproject["project"]["version"] == version, "server/pyproject.toml version differs from package.json"
    assert f'__version__ = "{version}"' in init, "ferry_server.__version__ differs from package.json"
    if not (ROOT / "node_modules" / "@earendil-works" / "pi-coding-agent").is_dir():
        sys.exit("run `npm ci` in the repo root first")

    dist = ROOT / "dist"
    stage = dist / f"ferry-{version}"
    shutil.rmtree(stage, ignore_errors=True)
    stage.mkdir(parents=True)
    for name in ["package.json", "package-lock.json", "README.md", "INSTALL-WINDOWS.md", "GOAL.md", "LICENSE"]:
        if (ROOT / name).exists():
            shutil.copy2(ROOT / name, stage / name)
    for name in ["client", "server", "selftest", "docs", "deploy", "node_modules"]:
        copy(ROOT / name, stage / name)

    if not a.skip_tools:
        fetch_tools(stage, a.platform)

    if not a.skip_wheels:
        wheels = stage / "wheels"
        pip = [sys.executable, "-m", "pip", "--disable-pip-version-check"]
        subprocess.run([*pip, "wheel", "--no-deps", "-w", wheels, ROOT / "server"], check=True)
        deps = pyproject["project"]["dependencies"] + ["colorama"]  # colorama: uvicorn needs it on Windows
        if a.platform == "native":
            subprocess.run([*pip, "download", "-d", wheels, *deps], check=True)
        else:
            for pyver in ["3.11", "3.12", "3.13", "3.14"]:
                subprocess.run([*pip, "download", "--only-binary=:all:", "--platform", "win_amd64",
                                "--python-version", pyver, "-d", wheels, *deps], check=True)
        print(f"{len(list(wheels.glob('*.whl')))} wheels")

    out = dist / f"ferry-windows-{version}.zip"
    out.unlink(missing_ok=True)
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for f in sorted(stage.rglob("*")):
            if f.is_file():
                z.write(f, f.relative_to(dist).as_posix())
    shutil.rmtree(stage)
    print(f"{out} ({out.stat().st_size / 1e6:.1f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
