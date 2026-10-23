"""Run the Ferry server.

  ferry-server                       zero-config: DeepSeek via DEEPSEEK_API_KEY, files in ~/.ferry-server
  ferry-server --config FILE.toml    full configuration (several users, several models, your own paths)

A ferry-server.toml in the current folder is picked up automatically.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

import uvicorn

from . import PROTOCOL, __version__
from .app import create_app
from .config import Config, load, load_default


def client_home() -> Path:
    return Path(os.environ.get("FERRY_HOME") or Path.home() / ".ferry")


def write_local_discovery(cfg: Config, token: str) -> Path:
    """Tell a Ferry client on this machine (same user) where we are, so it needs no login."""
    home = client_home()
    home.mkdir(parents=True, exist_ok=True)
    path = home / "local-server.json"
    path.write_text(json.dumps({"url": f"http://127.0.0.1:{cfg.port}", "token": token, "pid": os.getpid()}),
                    encoding="utf-8")
    try:
        path.chmod(0o600)
    except OSError:
        pass
    return path


def banner(cfg: Config, mode: str) -> None:
    out = [f"Ferry server {__version__} (protocol {PROTOCOL}) on http://{cfg.host}:{cfg.port}"]
    for m in cfg.models.values():
        key = "found" if m.api_key else "MISSING: set it before chatting"
        out.append(f"  model {m.id} -> {m.model} at {m.base_url} ({m.api_key_env or 'no key'} {key})")
    out.append(f"  mode: {mode}; data in {cfg.data_dir}")
    if cfg.max_upstream_bytes:
        out.append(f"  requests to the model are kept under {cfg.max_upstream_bytes:,} bytes")
    if cfg.home:
        out.append(f"  word list: {cfg.dictionary}   rules: {cfg.rules_dir}")
        out.append("  a Ferry client on this computer connects automatically; just run: ferry")
    print("\n".join(out), flush=True)


def main() -> None:
    ap = argparse.ArgumentParser(prog="ferry-server")
    ap.add_argument("--config", help="path to ferry-server.toml (default: zero-config)")
    ap.add_argument("--host")
    ap.add_argument("--port", type=int)
    ap.add_argument("--version", action="store_true")
    a = ap.parse_args()
    if a.version:
        print(__version__)
        return
    path = a.config or ("ferry-server.toml" if Path("ferry-server.toml").exists() else None)
    cfg = load(path) if path else load_default()
    if a.host:
        cfg.host = a.host
    if a.port:
        cfg.port = a.port
    banner(cfg, f"config file {Path(path).resolve()}" if path else "zero-config")
    if cfg.home and not os.environ.get("FERRY_NO_DISCOVERY"):  # zero-config, started by hand: one local user
        write_local_discovery(cfg, next(iter(cfg.users)))
    try:
        uvicorn.run(create_app(cfg), host=cfg.host, port=cfg.port, log_level="warning")
    except KeyboardInterrupt:
        sys.exit(0)


if __name__ == "__main__":
    main()
