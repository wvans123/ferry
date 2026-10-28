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

import re
import tempfile

import httpx

from . import PROTOCOL, __version__
from . import presets as presets_mod
from .config import (Config, apply_models_file, load_secrets, render_models_toml, save_secrets, save_settings)
from .redact import Redactor
from .store import Store

PAGE = Path(__file__).with_name("admin.html")
BUILTIN_PATTERNS = [  # name, label, regex
    ("private-ipv4", "内网 IP 地址",
     r"\b(?:10(?:\.\d{1,3}){3}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|192\.168(?:\.\d{1,3}){2})\b"),
    ("email", "邮箱地址", r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"),
    ("phone-cn", "手机号", r"(?<!\d)1[3-9]\d{9}(?!\d)"),
    ("api-key", "API Key 和令牌（sk-、ghp_ 等开头的长串）", r"\b(?:sk|pk|rk|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{16,}\b"),
]
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
                                "<b>Ferry Server</b> 图标（或命令 <code>ferry-server --ui</code>）打开管理页。</p>", 403)
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
            "record_details": cfg.record_details,
            "web": {"enabled": cfg.web_enabled, "allow": cfg.web_allow, "engine": cfg.web_engine, "proxy": cfg.web_proxy},
            "locked": {"session_store": bool(env.get("FERRY_SESSION_STORE")), "redact": bool(env.get("FERRY_REDACT")),
                       "max_upstream_bytes": bool(env.get("FERRY_MAX_UPSTREAM_BYTES"))},
            "routing": {"default": cfg.default_model, "summary": cfg.summary_model, "expose": cfg.expose_models},
            "models": [{"id": m.id, "model": m.model, "base_url": m.base_url, "key_env": m.api_key_env,
                        "provider": m.provider, "ready": m.ready} for m in cfg.models.values()],
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
            # errors of Ferry's own API; a browser asking for /favicon.ico is not one
            if a.get("status", 200) >= 400 and a.get("status") != 409 and str(a.get("path", "")).startswith(("/v1/", "/anthropic/")):
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
        if isinstance(b.get("web"), dict):
            w = b["web"]
            if "enabled" in w:
                cfg.web_enabled = bool(w["enabled"])
            if "allow" in w:
                items = w["allow"] if isinstance(w["allow"], list) else str(w["allow"]).replace(",", "\n").splitlines()
                cfg.web_allow = [x.strip().lower() for x in items if x.strip()]
            if w.get("engine") in ("bing", "duckduckgo"):
                cfg.web_engine = w["engine"]
            if "proxy" in w:
                cfg.web_proxy = str(w["proxy"]).strip()
        if "record_details" in b:
            cfg.record_details = bool(b["record_details"])
            if not cfg.record_details:
                live.details.clear()
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

    # ---------- providers and models (structured) ----------

    def provider_views() -> list[dict]:
        """Configured providers, plus older models that carry their own address, grouped by address and key."""
        secrets_ = load_secrets(cfg)
        views: dict[str, dict] = {}
        for p in cfg.providers.values():
            key = p.api_key
            views[p.id] = {"id": p.id, "name": p.name, "preset": p.preset, "base_url": p.base_url,
                           "api_key_env": p.api_key_env, "no_key": p.no_key,
                           "key_tail": key[-4:] if key else "", "key_source": (
                               "env" if p.api_key_env and os.environ.get(p.api_key_env) else
                               "saved" if secrets_.get(p.id) else ""), "models": []}
        for m in cfg.models.values():
            pid = m.provider
            if not pid:  # an older entry: group it with others that share the address and key variable
                base = m.base_url.rstrip("/")
                norm = re.sub(r"/v1$", "", base)
                pre = next((x for x in presets_mod.PRESETS if x["base_url"]
                            and re.sub(r"/v1$", "", x["base_url"].rstrip("/")) == norm), None)
                pid = (pre["id"] if pre else re.sub(r"[^a-z0-9]+", "-", norm.split("//")[-1].lower()).strip("-"))
                if pid not in views:
                    key = m.api_key
                    views[pid] = {"id": pid, "name": pre["name"] if pre else norm.split("//")[-1],
                                  "preset": pre["id"] if pre else "custom", "base_url": m.base_url,
                                  "api_key_env": m.api_key_env, "no_key": False, "key_tail": key[-4:] if key else "",
                                  "key_source": "env" if key else "", "models": []}
            views[pid]["models"].append({"id": m.id, "model": m.model, "name": m.name,
                                         "context_window": m.context_window, "max_tokens": m.max_tokens,
                                         "ready": m.ready, "api": m.api, "vision": m.vision, "price": m.price})
        return list(views.values())

    @app.get("/admin/api/presets")
    async def get_presets(request: Request):
        return {"presets": presets_mod.public()} if allowed(request) else denied()

    @app.get("/admin/api/providers")
    async def get_providers(request: Request):
        if not allowed(request):
            return denied()
        return {"providers": provider_views(), "editable": bool(cfg.models_file),
                "routing": {"default": cfg.default_model, "summary": cfg.summary_model, "expose": cfg.expose_models}}

    @app.post("/admin/api/providers/models")
    async def list_remote_models(request: Request):
        """Read a provider's own model list (GET {base}/models) with a key typed in the form or the saved one."""
        if not allowed(request, True):
            return denied()
        b = await body(request)
        base = (b.get("base_url") or "").strip()
        key = (b.get("key") or "").strip()
        if not key and b.get("provider"):
            prov = cfg.providers.get(b["provider"])
            key = prov.api_key if prov else load_secrets(cfg).get(b["provider"], "")
            if not key:  # an older entry: use the key of one of its models
                key = next((m.api_key for m in cfg.models.values()
                            if m.base_url.rstrip("/") == base.rstrip("/") and m.api_key), "")
        if not base:
            return JSONResponse({"error": "请先填写接口地址"}, 400)
        anthropic = (b.get("preset") == "claude") or "anthropic.com" in base
        url = presets_mod.anthropic_url(base).replace("/messages", "/models") if anthropic else presets_mod.models_url(base)
        auth = ({"x-api-key": key, "anthropic-version": "2023-06-01"} if anthropic else {"Authorization": f"Bearer {key}"}) if key else {}
        try:
            async with httpx.AsyncClient(timeout=20) as c:
                r = await c.get(url, headers=auth)
        except httpx.HTTPError as e:
            return JSONResponse({"error": f"连不上 {url}：{type(e).__name__}"}, 502)
        if r.status_code != 200:
            hint = {401: "Key 不对或已失效", 403: "没有权限，或者这个地区不能用"}.get(r.status_code, "")
            return JSONResponse({"error": f"HTTP {r.status_code} {hint}".strip(), "detail": r.text[:300]}, 502)
        try:
            data = r.json()
            items = data.get("data", data) if isinstance(data, dict) else data
            ids = sorted({(i.get("id") if isinstance(i, dict) else str(i)) for i in items} - {None, ""})
        except Exception:
            return JSONResponse({"error": "返回的不是模型列表，可以手动输入模型名"}, 502)
        return {"models": ids}

    @app.put("/admin/api/providers")
    async def put_providers(request: Request):
        """Save providers, their keys and models from the form; models.toml is rewritten, keys go to secrets.toml."""
        if not allowed(request, True):
            return denied()
        if not cfg.models_file:
            return JSONResponse({"error": "这台服务端用 ferry-server.toml 配置，请直接改那个文件"}, 400)
        b = await body(request)
        keys = load_secrets(cfg)
        providers, models, used = [], [], set()
        for p in b.get("providers", []):
            pid = re.sub(r"[^A-Za-z0-9_-]+", "-", (p.get("id") or "").strip()).strip("-")
            if not pid or pid in {x["id"] for x in providers}:
                return JSONResponse({"error": f"服务商标识 {p.get('id')!r} 为空或重复"}, 400)
            pre = presets_mod.BY_ID.get(p.get("preset", ""), {})
            entry = {"id": pid, "name": p.get("name") or pre.get("name", pid), "preset": p.get("preset", ""),
                     "base_url": (p.get("base_url") or pre.get("base_url", "")).strip(),
                     "api_key_env": (p.get("api_key_env") or "").strip(),
                     "drop_params": pre.get("drop_params", ["store"]), "api": pre.get("api", "openai"),
                     "rename_params": pre.get("rename_params", {}), "no_key": bool(pre.get("no_key"))}
            if not entry["base_url"]:
                return JSONResponse({"error": f"{entry['name']}：接口地址不能为空"}, 400)
            if p.get("key"):
                keys[pid] = p["key"].strip()
            elif p.get("clear_key"):
                keys.pop(pid, None)
            providers.append(entry)
            for m in p.get("models", []):
                name = (m.get("model") or "").strip()
                if not name:
                    continue
                mid = re.sub(r"[^A-Za-z0-9_.-]+", "-", (m.get("id") or name)).strip("-")
                if mid in used:
                    mid = f"{pid}-{mid}"
                used.add(mid)
                # vision and price: as sent, else as this model had them, else what a preset knows
                had = next((x for x in cfg.models.values() if x.model == name and x.provider == pid), None)
                known = presets_mod.model_extras(name)
                models.append({"id": mid, "provider": pid, "model": name, "name": m.get("name", ""),
                               "context_window": int(m.get("context_window") or 128_000),
                               "max_tokens": int(m.get("max_tokens") or 8_192),
                               "vision": bool(m["vision"]) if "vision" in m else (had.vision if had else bool(known.get("vision"))),
                               "price": m["price"] if isinstance(m.get("price"), dict) else (had.price if had and had.price
                                                                                             else known.get("price", {}))})
        if not models:
            return JSONResponse({"error": "至少要启用一个模型"}, 400)
        r = b.get("routing", {})
        ids = [m["id"] for m in models]
        routing = {"default": r.get("default") if r.get("default") in ids else ids[0],
                   "summary": r.get("summary") if r.get("summary") in ids else "",
                   "expose": bool(r.get("expose", True))}
        for gone in set(keys) - {p["id"] for p in providers}:
            keys.pop(gone)
        old_keys = load_secrets(cfg)
        save_secrets(cfg, keys)
        text = render_models_toml(providers, models, routing)
        tmp = cfg.models_file.with_suffix(".check.toml")
        tmp.write_text(text, encoding="utf-8")
        try:
            apply_models_file(cfg, tmp)
        except SystemExit as e:
            save_secrets(cfg, old_keys)
            return JSONResponse({"error": str(e)}, 400)
        finally:
            tmp.unlink(missing_ok=True)
        cfg.models_file.write_text(text, encoding="utf-8")
        cfg.models_mtime = cfg.models_file.stat().st_mtime
        return {"providers": provider_views(), "routing": routing}

    # ---------- prompts ----------

    def projects_seen() -> list[str]:
        names = {a.get("project") for a in _tail_jsonl(audit_log, 2_000_000) if a.get("event") == "chat"}
        if cfg.rules_dir and cfg.rules_dir.is_dir():
            names |= {f.stem for f in cfg.rules_dir.glob("*.md") if not f.stem.startswith("_")}
        return sorted(n for n in names if n)

    def prompt_file(name: str) -> Path | None:
        if not cfg.rules_dir:
            return None
        if name in ("_global", "_summary"):
            return cfg.rules_dir / f"{name}.md"
        safe = re.sub(r"[^A-Za-z0-9_.-]", "_", name)
        return cfg.rules_dir / f"{safe}.md" if safe and not safe.startswith("_") else None

    @app.get("/admin/api/prompts")
    async def get_prompts(request: Request):
        if not allowed(request):
            return denied()
        read = lambda n: (prompt_file(n).read_text(encoding="utf-8") if prompt_file(n) and prompt_file(n).exists() else "")
        return {"global": read("_global"), "summary": read("_summary"),
                "projects": [{"name": n, "text": read(n)} for n in projects_seen()]}

    @app.put("/admin/api/prompts/{name}")
    async def put_prompt(name: str, request: Request):
        if not allowed(request, True):
            return denied()
        f = prompt_file(name)
        if not f:
            return JSONResponse({"error": "这个名字不能用"}, 400)
        text = (await body(request)).get("text", "")
        f.parent.mkdir(parents=True, exist_ok=True)
        if text.strip():
            f.write_text(text.strip() + "\n", encoding="utf-8")
        else:
            f.unlink(missing_ok=True)
        return {"ok": True}

    # ---------- redaction (structured) ----------

    def read_dictionary() -> dict:
        f = cfg.dictionary
        raw = tomllib.loads(f.read_text(encoding="utf-8")) if f and f.exists() else {}
        pats = raw.get("patterns", [])
        builtin_names = {n for n, _, _ in BUILTIN_PATTERNS}
        return {"enabled": cfg.redact, "terms": [t for t in raw.get("terms", []) if str(t).strip()],
                "builtins": [{"name": n, "label": label, "on": any(p.get("name") == n for p in pats)}
                             for n, label, _ in BUILTIN_PATTERNS],
                "custom": [p for p in pats if p.get("name") not in builtin_names]}

    def dictionary_text(d: dict) -> str:
        from .config import _toml_value
        lines = ["# Ferry 脱敏词表，由管理页生成。命中的内容发给模型前换成 [FERRY-XXXXXXXX]，回来时再换回原文。",
                 f"terms = {_toml_value([t.strip() for t in d.get('terms', []) if str(t).strip()])}"]
        on = {b["name"] for b in d.get("builtins", []) if b.get("on")}
        for n, _, rx in BUILTIN_PATTERNS:
            if n in on:
                lines += ["", "[[patterns]]", f"name = {_toml_value(n)}", f"regex = {_toml_value(rx)}"]
        for p in d.get("custom", []):
            if p.get("regex"):
                re.compile(p["regex"])  # raises on a broken pattern
                lines += ["", "[[patterns]]", f"name = {_toml_value(p.get('name') or 'custom')}",
                          f"regex = {_toml_value(p['regex'])}"]
        return "\n".join(lines) + "\n"

    @app.get("/admin/api/redaction")
    async def get_redaction(request: Request):
        return read_dictionary() if allowed(request) else denied()

    @app.put("/admin/api/redaction")
    async def put_redaction(request: Request):
        if not allowed(request, True):
            return denied()
        d = await body(request)
        try:
            text = dictionary_text(d)
        except re.error as e:
            return JSONResponse({"error": f"自定义规则写得不对：{e}"}, 400)
        if cfg.dictionary:
            cfg.dictionary.write_text(text, encoding="utf-8")
        if "enabled" in d:
            cfg.redact = bool(d["enabled"])
            save_settings(cfg)
        rebuild(False)
        return read_dictionary()

    @app.post("/admin/api/redaction/try")
    async def try_redaction(request: Request):
        """Show what a piece of text looks like after redaction, with the settings in the form (nothing saved)."""
        if not allowed(request, True):
            return denied()
        d = await body(request)
        try:
            text = dictionary_text(d)
        except re.error as e:
            return JSONResponse({"error": f"自定义规则写得不对：{e}"}, 400)
        with tempfile.TemporaryDirectory() as t:
            f = Path(t) / "d.toml"
            f.write_text(text, encoding="utf-8")
            from collections import Counter
            red = Redactor(f, cfg.secret, Store(":memory:"))
            hits: Counter = Counter()
            out = red.mask(d.get("sample", ""), hits, "preview")
        return {"masked": out, "hits": dict(hits)}

    # ---------- call records ----------

    @app.get("/admin/api/calls")
    async def calls(request: Request, limit: int = 200):
        if not allowed(request):
            return denied()
        rows = [a for a in _tail_jsonl(audit_log) if a.get("event") in ("chat", "web")][-max(1, min(limit, 1000)):][::-1]
        for a in rows:
            if a.get("event") == "web":  # a page read or a search for the agent: shown with purpose "web"
                a.update(purpose="web", model=f"{a.get('kind', '')} {a.get('host', '')}".strip())
        have = {d["id"] for d in live.details}
        out = [{k: a.get(k) for k in ("id", "ts", "project", "model", "purpose", "messages", "upstream_bytes",
                                      "masked", "trimmed", "status", "ms", "usage")} for a in rows]
        for o in out:
            o["has_details"] = o.get("id") in have
        return {"calls": out, "record_details": cfg.record_details}

    @app.get("/admin/api/usage")
    async def usage(request: Request, days: int = 30):
        """Tokens and cost per day, per project and per model, from the audit log."""
        if not allowed(request):
            return denied()
        since = time.time() - max(1, min(days, 366)) * 86400
        empty = lambda: {"calls": 0, "input": 0, "cache_read": 0, "cache_write": 0, "output": 0, "cost": 0.0, "priced": True}  # noqa: E731
        by_day, by_project, by_model, total = {}, {}, {}, empty()
        for a in _tail_jsonl(audit_log, 50_000_000):
            if a.get("event") != "chat" or a.get("status") != 200 or (a.get("ts") or 0) < since:
                continue
            t = a.get("tokens") or {}
            day = time.strftime("%Y-%m-%d", time.localtime(a["ts"]))
            for bucket in (by_day.setdefault(day, empty()), by_project.setdefault(a.get("project") or "–", empty()),
                           by_model.setdefault(a.get("model") or "–", empty()), total):
                bucket["calls"] += 1
                for k in ("input", "cache_read", "cache_write", "output"):
                    bucket[k] += int(t.get(k) or 0)
                if a.get("cost") is None:
                    bucket["priced"] = False
                else:
                    bucket["cost"] = round(bucket["cost"] + a["cost"], 6)
        rows = lambda d: [{"key": k, **v} for k, v in d.items()]  # noqa: E731
        return {"days": sorted(rows(by_day), key=lambda r: r["key"]), "projects": sorted(rows(by_project), key=lambda r: -r["cost"]),
                "models": sorted(rows(by_model), key=lambda r: -r["cost"]), "total": total}

    @app.get("/admin/api/calls/{call_id}")
    async def call_detail(call_id: str, request: Request):
        if not allowed(request):
            return denied()
        d = next((x for x in live.details if x["id"] == call_id), None)
        return d or JSONResponse({"error": "没有这次调用的详细记录（详细记录没打开，或服务端重启过）"}, 404)
