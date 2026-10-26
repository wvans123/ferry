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
import threading
import time
import urllib.request
import webbrowser
from pathlib import Path

import uvicorn

from . import PROTOCOL, __version__
from .app import create_app
from .config import KEY_VARS, Config, load, load_default


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
    if cfg.home and not any(m.api_key for m in cfg.models.values()):
        out.append(f"  no model API key found: set one of {KEY_VARS}")
    route = f"  clients get model \"auto\" -> {cfg.default_model}"
    if cfg.summary_model:
        route += f" (context summaries -> {cfg.summary_model})"
    out.append(route + ("; clients may also pick a model" if cfg.expose_models else ""))
    out.append(f"  conversations kept: {dict(disk='on disk', memory='in memory only', none='not at all')[cfg.session_store]}")
    out.append(f"  mode: {mode}; data in {cfg.data_dir}")
    if cfg.max_upstream_bytes:
        out.append(f"  requests to the model are kept under {cfg.max_upstream_bytes:,} bytes")
    if not cfg.redact:
        out.append("  redaction: OFF (content goes to the model as is)")
    if cfg.home:
        out.append(f"  models: {cfg.models_file} (edit and save; applies to the next request)")
        out.append(f"  word list: {cfg.dictionary}   rules: {cfg.rules_dir}")
        out.append("  a Ferry client on this computer connects automatically; just run: ferry")
    print("\n".join(out), flush=True)


def _get(url: str, timeout: float = 2) -> dict | None:
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(url, timeout=timeout) as r:
            return json.loads(r.read())
    except Exception:
        return None


def _stop_running(cfg: Config) -> bool:
    """Ask a Ferry server (0.8+) already on this port to stop, using the shared admin key."""
    from .admin import admin_key
    req = urllib.request.Request(f"http://127.0.0.1:{cfg.port}/admin/api/stop", method="POST", data=b"{}",
                                 headers={"Cookie": f"ferry_admin={admin_key(cfg)}", "X-Ferry-Admin": "1"})
    try:
        urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req, timeout=3)
    except Exception:
        return False
    for _ in range(30):
        time.sleep(0.2)
        if not _get(f"http://127.0.0.1:{cfg.port}/health", 0.5):
            return True
    return False


def _quiet_output(cfg: Config) -> None:
    """Started without a console (pythonw, a shortcut, start with Windows): write output to server.log."""
    home = cfg.home or cfg.data_dir
    log = open(Path(home) / "server.log", "a", encoding="utf-8", buffering=1)
    sys.stdout = sys.stderr = log


def main() -> None:
    ap = argparse.ArgumentParser(prog="ferry-server")
    ap.add_argument("--config", help="path to ferry-server.toml (default: zero-config)")
    ap.add_argument("--host")
    ap.add_argument("--port", type=int)
    ap.add_argument("--ui", action="store_true", help="open the admin page (start the server first if needed)")
    ap.add_argument("--background", action="store_true", help="run without a console; output goes to server.log")
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
    if a.ui or a.background or sys.stdout is None:
        _quiet_output(cfg)

    from .admin import admin_url
    running = _get(f"http://127.0.0.1:{cfg.port}/health")
    if running and running.get("version") == __version__:
        if a.ui:
            webbrowser.open(admin_url(cfg))  # already running: just show it
        else:
            print(f"A Ferry server {__version__} is already running on port {cfg.port}.", flush=True)
        return
    if running and not _stop_running(cfg):
        msg = (f"Port {cfg.port} is used by Ferry server {running.get('version')}; close its window "
               f"(or end its python process) and start again.")
        print(msg, flush=True)
        if a.ui:
            webbrowser.open(f"http://127.0.0.1:{cfg.port}/health")
        sys.exit(1)

    banner(cfg, f"config file {Path(path).resolve()}" if path else "zero-config")
    print(f"  admin page (this computer only): {admin_url(cfg)}", flush=True)
    if cfg.home and not os.environ.get("FERRY_NO_DISCOVERY"):  # zero-config, started by hand: one local user
        write_local_discovery(cfg, next(iter(cfg.users)))
    if a.ui:
        def open_when_ready() -> None:
            for _ in range(100):
                time.sleep(0.2)
                if _get(f"http://127.0.0.1:{cfg.port}/health", 0.5):
                    webbrowser.open(admin_url(cfg))
                    return
        threading.Thread(target=open_when_ready, daemon=True).start()
    try:
        uvicorn.run(create_app(cfg), host=cfg.host, port=cfg.port, log_level="warning")
    except KeyboardInterrupt:
        sys.exit(0)


if __name__ == "__main__":
    main()
