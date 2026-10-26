"""Admin page for the person running the server: status, traffic, models, settings, rules and word list.

Only reachable from the server's own computer: the request must come from 127.0.0.1 / ::1 without any proxy or
Cloudflare header (a request through a tunnel also arrives from 127.0.0.1, but carries cf-connecting-ip), and it
must carry the admin cookie, which is set by opening the one-time link that `ferry-server --ui` prints and opens.
Changing requests also need the X-Ferry-Admin header, which a page on another site cannot send.
"""
from __future__ import annotations

import asyncio
import json
import os
import secrets
import subprocess
import sys
import time
import tomllib
from collections import defaultdict
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response

from . import PROTOCOL, __version__
from .config import Config, apply_models_file, save_settings

PAGE = Path(__file__).with_name("admin.html")
PROXY_HEADERS = ("cf-connecting-ip", "cf-ray", "x-forwarded-for", "x-real-ip", "forwarded")
STARTUP_LNK = "Ferry server.lnk"


def admin_key_path(cfg: Config) -> Path:
    return (cfg.home or cfg.data_dir) / "admin-key"


def admin_key(cfg: Config) -> str:
    p = admin_key_path(cfg)
    if p.exists():
        return p.read_text(encoding="utf-8").strip()
    p.parent.mkdir(parents=True, exist_ok=True)
    k = secrets.token_urlsafe(24)
    p.write_text(k, encoding="utf-8")
    try:
        p.chmod(0o600)
    except OSError:
        pass
    return k


def admin_url(cfg: Config) -> str:
    return f"http://127.0.0.1:{cfg.port}/admin?key={admin_key(cfg)}"


def _tail_jsonl(path: Path, max_bytes: int = 4_000_000) -> list[dict]:
    if not path.exists():
        return []
    with open(path, "rb") as f:
        f.seek(0, os.SEEK_END)
        size = f.tell()
        f.seek(max(0, size - max_bytes))
        data = f.read().decode("utf-8", errors="replace")
    lines = data.splitlines()[1:] if size > max_bytes else data.splitlines()
    out = []
    for line in lines:
        try:
            out.append(json.loads(line))
        except ValueError:
            pass
    return out


def _startup_dir() -> Path | None:
    appdata = os.environ.get("APPDATA")
    return Path(appdata) / "Microsoft/Windows/Start Menu/Programs/Startup" if sys.platform == "win32" and appdata else None


def _pythonw() -> str:
    exe = Path(sys.executable)
    w = exe.with_name("pythonw.exe")
    return str(w if w.exists() else exe)


def make_shortcut(path: Path, cfg: Config, args: str = "-m ferry_server --ui") -> None:
    """A Windows .lnk that starts the server without a console window."""
    home = str(cfg.home or "")
    ps = ("$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:LNK);"
          "$s.TargetPath=$env:TGT;$s.Arguments=$env:ARGS;$s.WorkingDirectory=$env:WD;"
          "$s.Description='Ferry server';$s.Save()")
    env = {**os.environ, "LNK": str(path), "TGT": _pythonw(), "ARGS": args, "WD": home or str(Path.home())}
    subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", ps], env=env, check=True,
                   capture_output=True, timeout=30)


def mount_admin(app: FastAPI, cfg: Config, live, rebuild, run_check, access_log: Path, audit_log: Path) -> None:
    key = admin_key(cfg)

    def local(request: Request) -> bool:
        host = request.client.host if request.client else ""
        return host in ("127.0.0.1", "::1", "localhost") and not any(h in request.headers for h in PROXY_HEADERS)

    def allowed(request: Request, changing: bool = False) -> bool:
        if not local(request) or not secrets.compare_digest(request.cookies.get("ferry_admin", ""), key):
            return False
        return not changing or request.headers.get("x-ferry-admin") == "1"

    def denied() -> JSONResponse:
        return JSONResponse({"error": "open the admin page on the server's own computer: ferry-server --ui"}, 403)

    @app.get("/admin")
    async def page(request: Request):
        if not local(request):
            return Response("The Ferry admin page only opens on the server's own computer.", 403)
        given = request.query_params.get("key")
        if given:
            if not secrets.compare_digest(given, key):
                return Response("This admin link is not valid any more. Start it again with: ferry-server --ui", 403)
            r = RedirectResponse("/admin", 303)
            r.set_cookie("ferry_admin", key, httponly=True, samesite="strict", max_age=30 * 86400)
            return r
        if not allowed(request):
            return HTMLResponse("<!doctype html><meta charset=utf-8><title>Ferry</title>"
                                "<p style='font:16px system-ui;margin:3em'>请在服务端电脑上用桌面的 "
                                "<b>Ferry 服务端</b> 图标（或命令 <code>ferry-server --ui</code>）打开管理页。</p>", 403)
        return HTMLResponse(PAGE.read_text(encoding="utf-8"), headers={"Cache-Control": "no-store"})

    # ---------- read ----------

    def status() -> dict:
        startup = _startup_dir()
        env = os.environ
        return {
            "version": __version__, "protocol": PROTOCOL, "pid": os.getpid(),
            "uptime": int(time.time() - live.started), "port": cfg.port, "host": cfg.host,
            "home": str(cfg.home or cfg.data_dir), "public_url": cfg.public_url,
            "token": next(iter(cfg.users)) if cfg.home else "", "zero_config": bool(cfg.home),
            "session_store": cfg.session_store, "redact": cfg.redact, "max_upstream_bytes": cfg.max_upstream_bytes,
            "locked": {"session_store": bool(env.get("FERRY_SESSION_STORE")), "redact": bool(env.get("FERRY_REDACT")),
                       "max_upstream_bytes": bool(env.get("FERRY_MAX_UPSTREAM_BYTES"))},
            "routing": {"default": cfg.default_model, "summary": cfg.summary_model, "expose": cfg.expose_models},
            "models": [{"id": m.id, "model": m.model, "base_url": m.base_url, "key_env": m.api_key_env,
                        "ready": bool(m.api_key) or not m.api_key_env} for m in cfg.models.values()],
            "models_file": str(cfg.models_file or ""), "platform": sys.platform,
            "autostart": bool(startup and (startup / STARTUP_LNK).exists()),
        }

    @app.get("/admin/api/status")
    async def get_status(request: Request):
        return status() if allowed(request) else denied()

    @app.get("/admin/api/traffic")
    async def traffic(request: Request, minutes: int = 60):
        if not allowed(request):
            return denied()
        minutes = max(10, min(minutes, 24 * 60))
        now = time.time()
        start = now - minutes * 60
        width = 60 if minutes <= 180 else 600
        buckets: dict[int, dict] = defaultdict(lambda: {"in": 0, "up": 0, "requests": 0, "chats": 0})
        totals = {"in": 0, "up": 0, "requests": 0, "chats": 0, "errors": 0, "tokens_in": 0, "tokens_out": 0,
                  "masked": 0, "trimmed": 0}
        for a in _tail_jsonl(access_log):
            ts = a.get("ts", 0)
            if ts < start:
                continue
            b = buckets[int((ts - start) // width)]
            b["in"] += a.get("bytes", 0)
            b["requests"] += 1
            totals["in"] += a.get("bytes", 0)
            totals["requests"] += 1
            if a.get("status", 200) >= 400 and a.get("status") != 409:
                totals["errors"] += 1
        recent = []
        for a in _tail_jsonl(audit_log):
            ts = a.get("ts", 0)
            if ts < start or a.get("event") != "chat":
                continue
            b = buckets[int((ts - start) // width)]
            b["up"] += a.get("upstream_bytes", 0)
            b["chats"] += 1
            totals["up"] += a.get("upstream_bytes", 0)
            totals["chats"] += 1
            usage = a.get("usage") or {}
            totals["tokens_in"] += usage.get("prompt_tokens", 0) or 0
            totals["tokens_out"] += usage.get("completion_tokens", 0) or 0
            totals["masked"] += sum((a.get("masked") or {}).values())
            totals["trimmed"] += a.get("trimmed", 0) or 0
            recent.append({k: a.get(k) for k in ("ts", "user", "project", "model", "purpose", "messages",
                                                 "upstream_bytes", "masked", "trimmed", "status", "ms", "usage")})
        series = [{"t": start + i * width, **buckets.get(i, {"in": 0, "up": 0, "requests": 0, "chats": 0})}
                  for i in range(int(minutes * 60 // width) + 1)]
        return {"width": width, "series": series, "totals": totals, "recent": recent[-40:][::-1]}

    # ---------- change ----------

    async def body(request: Request) -> dict:
        try:
            return json.loads(await request.body() or b"{}")
        except ValueError:
            return {}

    @app.get("/admin/api/models")
    async def get_models(request: Request):
        if not allowed(request):
            return denied()
        f = cfg.models_file
        return {"text": f.read_text(encoding="utf-8") if f and f.exists() else "", "editable": bool(f)}

    @app.put("/admin/api/models")
    async def put_models(request: Request):
        if not allowed(request, True):
            return denied()
        if not cfg.models_file:
            return JSONResponse({"error": "this server uses ferry-server.toml; edit that file instead"}, 400)
        text = (await body(request)).get("text", "")
        tmp = cfg.models_file.with_suffix(".check.toml")
        tmp.write_text(text, encoding="utf-8")
        try:
            apply_models_file(cfg, tmp)  # validates and applies; raises on mistakes
        except SystemExit as e:
            return JSONResponse({"error": str(e).replace(str(tmp), "models.toml")}, 400)
        finally:
            tmp.unlink(missing_ok=True)
        cfg.models_file.write_text(text, encoding="utf-8")
        cfg.models_mtime = cfg.models_file.stat().st_mtime
        return status()

    @app.post("/admin/api/models/test")
    async def test_models(request: Request):
        if not allowed(request, True):
            return denied()
        return {"models": await run_check((await body(request)).get("model"), "admin")}

    @app.put("/admin/api/settings")
    async def put_settings(request: Request):
        if not allowed(request, True):
            return denied()
        b = await body(request)
        store_changed = False
        if "public_url" in b:
            cfg.public_url = str(b["public_url"]).strip().rstrip("/")
        if b.get("session_store") in ("disk", "memory", "none") and b["session_store"] != cfg.session_store:
            cfg.session_store, store_changed = b["session_store"], True
        if "redact" in b:
            cfg.redact = bool(b["redact"])
        if "max_upstream_bytes" in b:
            cfg.max_upstream_bytes = max(0, int(b["max_upstream_bytes"]))
        rebuild(store_changed)
        save_settings(cfg)
        return status()

    @app.post("/admin/api/token/rotate")
    async def rotate(request: Request):
        if not allowed(request, True):
            return denied()
        if not cfg.home:
            return JSONResponse({"error": "tokens come from ferry-server.toml in this mode"}, 400)
        new = secrets.token_urlsafe(32)
        (cfg.home / "token").write_text(new, encoding="utf-8")
        cfg.users.clear()
        cfg.users[new] = "local"
        return status()

    FILES = {"rules": lambda: (cfg.rules_dir / "_global.md") if cfg.rules_dir else None,
             "dictionary": lambda: cfg.dictionary}

    @app.get("/admin/api/file/{name}")
    async def get_file(name: str, request: Request):
        if not allowed(request) or name not in FILES:
            return denied()
        f = FILES[name]()
        return {"text": f.read_text(encoding="utf-8") if f and f.exists() else "", "path": str(f or "")}

    @app.put("/admin/api/file/{name}")
    async def put_file(name: str, request: Request):
        if not allowed(request, True) or name not in FILES:
            return denied()
        f = FILES[name]()
        if not f:
            return JSONResponse({"error": "not available in this mode"}, 400)
        text = (await body(request)).get("text", "")
        if name == "dictionary":
            try:
                tomllib.loads(text)
            except tomllib.TOMLDecodeError as e:
                return JSONResponse({"error": f"word list not saved: {e}"}, 400)
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(text, encoding="utf-8")
        if name == "dictionary":
            try:
                rebuild(False)
            except Exception as e:  # a bad regular expression
                return JSONResponse({"error": f"saved, but a pattern is not valid: {e}"}, 400)
        return {"ok": True}

    @app.put("/admin/api/autostart")
    async def autostart(request: Request):
        if not allowed(request, True):
            return denied()
        d = _startup_dir()
        if not d:
            return JSONResponse({"error": "start with Windows is only available on Windows"}, 400)
        lnk = d / STARTUP_LNK
        if (await body(request)).get("on"):
            try:
                make_shortcut(lnk, cfg, "-m ferry_server --background")
            except Exception as e:
                return JSONResponse({"error": f"could not create the startup item: {e}"}, 500)
        else:
            lnk.unlink(missing_ok=True)
        return status()

    @app.post("/admin/api/open-folder")
    async def open_folder(request: Request):
        if not allowed(request, True):
            return denied()
        folder = str(cfg.home or cfg.data_dir)
        if sys.platform == "win32":
            os.startfile(folder)  # noqa: S606 - the person's own data folder, on their own computer
        elif sys.platform == "darwin":
            subprocess.Popen(["open", folder])
        return {"ok": True, "path": folder}

    @app.post("/admin/api/stop")
    async def stop(request: Request):
        if not allowed(request, True):
            return denied()
        asyncio.get_running_loop().call_later(0.5, os._exit, 0)
        return {"ok": True}
