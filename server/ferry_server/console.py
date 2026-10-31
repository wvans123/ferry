"""Phone console at /m: what each computer's ferry is doing, and a way to approve, deny or stop from the phone.

Off unless switched on and given a password on the admin page (设备和手机). Unlike the admin page it is meant to be
opened from anywhere through the server's public address, so it has its own sign-in:
- a password, stored as a scrypt hash; wrong guesses are limited per address and in total;
- a signed cookie (HttpOnly, SameSite=Strict, Secure behind https) that a new password makes invalid;
- changing requests need the X-Ferry-M header, which a page on another site cannot send.

How it works: each running ferry reports a short status to /v1/ferry/status (with its own token) every few seconds
while it works and every 30 seconds while idle, and picks up the phone's answers in the reply. The work computer
only ever connects out, as it already does for the model; nothing connects into it.

What the phone can do:
- stop the current work (like pressing Esc at the computer), always;
- approve or deny a waiting action, only when that computer allows it (`ferry config set remoteApprove true`);
  its own rules decide what may be asked at all, and dangerous actions are never approved from the phone.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import time
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse

from .config import Config, save_settings

PAGE = Path(__file__).with_name("console.html")
COOKIE = "ferry_m"
SESSION_DAYS = 30
ONLINE_S = 90          # no report for this long: shown as offline
FORGET_S = 3600        # ... and after this long, not shown at all
BUSY_EVERY, IDLE_EVERY, OFF_EVERY = 3, 30, 300  # how often a client reports, by state (seconds)


def hash_password(pw: str) -> str:
    salt = secrets.token_bytes(16)
    h = hashlib.scrypt(pw.encode("utf-8"), salt=salt, n=2 ** 14, r=8, p=1, dklen=32)
    return f"scrypt${salt.hex()}${h.hex()}"


def check_password(pw: str, stored: str) -> bool:
    try:
        kind, salt, h = stored.split("$")
        if kind != "scrypt":
            return False
        got = hashlib.scrypt(pw.encode("utf-8"), salt=bytes.fromhex(salt), n=2 ** 14, r=8, p=1, dklen=32)
        return hmac.compare_digest(got.hex(), h)
    except (ValueError, TypeError):
        return False


class Console:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.clients: dict[str, dict] = {}     # "<user>\x1f<instance>" -> last report
        self.commands: dict[str, list] = {}    # same key -> answers waiting to be picked up
        self.fails: dict[str, list[float]] = {}

    # ---------- sign-in ----------

    def _sign(self, expires: int) -> str:
        msg = f"m:{expires}:{self.cfg.console_password[-16:]}".encode()
        return f"{expires}.{hmac.new(self.cfg.secret.encode(), msg, hashlib.sha256).hexdigest()}"

    def signed_in(self, request: Request) -> bool:
        if not (self.cfg.console and self.cfg.console_password):
            return False
        v = request.cookies.get(COOKIE, "")
        try:
            expires = int(v.split(".")[0])
        except ValueError:
            return False
        return expires > time.time() and hmac.compare_digest(v, self._sign(expires))

    def too_many(self, ip: str) -> bool:
        now = time.time()
        for k in list(self.fails):
            self.fails[k] = [t for t in self.fails[k] if now - t < 600]
            if not self.fails[k]:
                del self.fails[k]
        return len(self.fails.get(ip, [])) >= 5 or sum(len(v) for v in self.fails.values()) >= 30

    # ---------- reports from the computers ----------

    def report(self, user: str, device_id: str, device_name: str, b: dict) -> dict:
        if not self.cfg.console:
            return {"console": False, "every": OFF_EVERY}
        inst = str(b.get("instance") or "")[:40]
        if not inst:
            return {"console": True, "every": IDLE_EVERY, "commands": []}
        key = f"{user}\x1f{inst}"
        done = set(b.get("done") or [])
        waiting = [c for c in self.commands.get(key, []) if c["id"] not in done]
        self.commands[key] = waiting
        if b.get("closing"):
            self.clients.pop(key, None)
            self.commands.pop(key, None)
            return {"console": True, "every": IDLE_EVERY, "commands": []}
        pend = b.get("pending") if isinstance(b.get("pending"), dict) else None
        state = b.get("state") if b.get("state") in ("idle", "working", "asking") else "idle"
        self.clients[key] = {
            "key": key, "instance": inst, "user": user, "device_id": device_id, "device": device_name,
            "project": str(b.get("project") or "")[:80], "title": str(b.get("title") or "")[:120],
            "state": state, "tool": str(b.get("tool") or "")[:60], "detail": str(b.get("detail") or "")[:200],
            "goal": str(b.get("goal") or "")[:200], "text": str(b.get("text") or "")[:300],
            "since": float(b.get("since") or 0), "mode": str(b.get("mode") or "")[:20],
            "pending": {k: str(pend.get(k) or "")[:300] for k in ("id", "tool", "detail", "danger")} if pend else None,
            "remote_approve": bool(b.get("remote_approve")), "version": str(b.get("version") or "")[:20],
            "seen": time.time(),
        }
        return {"console": True, "every": BUSY_EVERY if state != "idle" else IDLE_EVERY, "commands": waiting}

    def state(self) -> list[dict]:
        now = time.time()
        for k in [k for k, c in self.clients.items() if now - c["seen"] > FORGET_S]:
            self.clients.pop(k, None)
            self.commands.pop(k, None)
        out = []
        for c in sorted(self.clients.values(), key=lambda c: (c["device"], c["project"])):
            out.append({**{k: v for k, v in c.items() if k != "key"}, "id": hashlib.sha256(c["key"].encode()).hexdigest()[:16],
                        "online": now - c["seen"] < ONLINE_S, "ago": int(now - c["seen"]),
                        "queued": len(self.commands.get(c["key"], []))})
        return out

    def act(self, cid: str, action: str, approval: str = "") -> tuple[bool, str]:
        c = next((c for c in self.clients.values() if hashlib.sha256(c["key"].encode()).hexdigest()[:16] == cid), None)
        if not c:
            return False, "这台电脑上的 ferry 已经不在了"
        if time.time() - c["seen"] > ONLINE_S:
            return False, "这台电脑离线了，命令发不过去"
        if action in ("approve", "deny"):
            p = c.get("pending")
            if not p or p["id"] != approval:
                return False, "这个确认已经不在了（可能已经在电脑上回答了）"
            if action == "approve" and not c["remote_approve"]:
                return False, "这台电脑没有允许在手机上批准（在电脑上运行 ferry config set remoteApprove true）"
            if action == "approve" and p.get("danger"):
                return False, "危险操作只能在电脑上批准"
        elif action != "stop":
            return False, "未知操作"
        self.commands.setdefault(c["key"], []).append(
            {"id": secrets.token_hex(6), "action": action, "approval": approval, "ts": time.time()})
        return True, ""


def secure_request(request: Request) -> bool:
    return request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https" \
        or '"https"' in request.headers.get("cf-visitor", "")


def mount_console(app: FastAPI, cfg: Config, live, audit_log: Path) -> Console:
    con = Console(cfg)
    live.console = con

    def audit(**row):
        with open(audit_log, "a", encoding="utf-8") as f:
            f.write(json.dumps({"ts": round(time.time(), 3), **row}, ensure_ascii=False) + "\n")

    def ip_of(request: Request) -> str:
        return request.headers.get("cf-connecting-ip") or (request.client.host if request.client else "")

    off = HTMLResponse("<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width'>"
                       "<title>Ferry</title><p style='font:16px system-ui;margin:2em'>手机控制台没有打开。"
                       "在服务端电脑的管理页 → 设备和手机 里打开，并设一个密码。</p>", 404)

    @app.get("/m")
    @app.get("/m/")
    async def page(request: Request):
        if not (cfg.console and cfg.console_password):
            return off
        return HTMLResponse(PAGE.read_text(encoding="utf-8"),
                            headers={"Cache-Control": "no-store", "X-Frame-Options": "DENY",
                                     "Content-Security-Policy": "default-src 'self'; style-src 'unsafe-inline'; "
                                                                "script-src 'unsafe-inline'; frame-ancestors 'none'",
                                     "Referrer-Policy": "no-referrer"})

    @app.post("/m/login")
    async def login(request: Request):
        if not (cfg.console and cfg.console_password):
            return JSONResponse({"error": "手机控制台没有打开"}, 404)
        if request.headers.get("x-ferry-m") != "1":
            return JSONResponse({"error": "bad request"}, 400)
        ip = ip_of(request)
        if con.too_many(ip):
            return JSONResponse({"error": "试错次数太多，10 分钟后再试"}, 429)
        b = json.loads(await request.body() or b"{}")
        if not check_password(str(b.get("password") or ""), cfg.console_password):
            con.fails.setdefault(ip, []).append(time.time())
            audit(event="console_login", ok=False, ip=ip)
            return JSONResponse({"error": "密码不对"}, 401)
        audit(event="console_login", ok=True, ip=ip)
        expires = int(time.time()) + SESSION_DAYS * 86400
        r = JSONResponse({"ok": True})
        r.set_cookie(COOKIE, con._sign(expires), max_age=SESSION_DAYS * 86400, httponly=True, samesite="strict",
                     secure=secure_request(request), path="/m")
        return r

    @app.post("/m/logout")
    async def logout(request: Request):
        r = JSONResponse({"ok": True})
        r.delete_cookie(COOKIE, path="/m")
        return r

    @app.get("/m/api/state")
    async def get_state(request: Request):
        if not con.signed_in(request):
            return JSONResponse({"error": "signin"}, 401)
        return {"clients": con.state(), "now": time.time()}

    @app.post("/m/api/act")
    async def act(request: Request):
        if not con.signed_in(request):
            return JSONResponse({"error": "signin"}, 401)
        if request.headers.get("x-ferry-m") != "1":
            return JSONResponse({"error": "bad request"}, 400)
        b = json.loads(await request.body() or b"{}")
        ok, err = con.act(str(b.get("id") or ""), str(b.get("action") or ""), str(b.get("approval") or ""))
        audit(event="console_act", action=str(b.get("action"))[:10], ok=ok, ip=ip_of(request))
        return {"ok": ok, **({"error": err} if err else {})}

    @app.post("/v1/ferry/status")
    async def status(request: Request):
        b = json.loads(await request.body() or b"{}")
        return con.report(request.state.user or "", request.state.device_id, request.state.device_name, b)

    return con


def set_console(cfg: Config, enabled: bool | None, password: str | None) -> str:
    """Admin page: switch the console on/off and set its password. Returns an error or ""."""
    if password is not None:
        if len(password) < 8:
            return "密码至少 8 个字符"
        cfg.console_password = hash_password(password)
    if enabled is not None:
        if enabled and not cfg.console_password:
            return "先设一个密码"
        cfg.console = enabled
    save_settings(cfg)
    return ""
