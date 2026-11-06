"""Answering Ferry from the phone: an approval or a question waiting in a work computer's terminal can be answered on
a small page opened from the Bark notification.

The work computer cannot be reached from outside, so it asks. It puts the waiting item in this server's inbox
(POST /v1/ferry/remote), long-polls for the answer (GET /v1/ferry/remote/<id>?wait=25) and takes the item back when it
was answered in the terminal (DELETE). Once the item has waited phoneApprovalSeconds, the client asks for the push
(POST /v1/ferry/remote/<id>/notify); with public_url set, the push opens /m/<token> when tapped. The token is signed
with the server secret, names one item, lasts LINK_S and answers once. /m/ is the only path open without a Ferry
token; it shows that one item and takes its answer, nothing else.

Items live in memory and go after ITEM_S. The inbox does not care where an answer comes from: another channel (a
Feishu bot) calls Inbox.answer() the same way, and messages that start on the phone (steer, pause a goal, a new task)
become items of new kinds that the client long-polls like these.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import html
import secrets
import time
from collections import deque
from urllib.parse import parse_qs

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse

from . import notify
from .config import Config

ITEM_S = 30 * 60   # an unanswered item is dropped after this
LINK_S = 10 * 60   # a link on the phone works this long
WAIT_S = 30        # longest single long-poll
MAX_ITEMS = 20     # waiting items per user
KINDS = ("approve", "ask")
ACTIONS = ("once", "always", "deny")


def ready(cfg: Config) -> bool:
    """A link on the phone needs Bark to carry it and a public address to open it."""
    return bool(cfg.bark_url and cfg.public_url)


def _s(v, n: int) -> str:
    return str(v or "").strip()[:n]


def _questions(raw) -> list[dict] | None:
    if not isinstance(raw, list) or not 1 <= len(raw) <= 4:
        return None
    out = []
    for q in raw:
        if not isinstance(q, dict) or not _s(q.get("question"), 1000):
            return None
        opts = [{"label": _s(o.get("label"), 200), "description": _s(o.get("description"), 300)}
                for o in (q.get("options") or [])[:6] if isinstance(o, dict) and _s(o.get("label"), 200)]
        if not opts:
            return None
        out.append({"question": _s(q.get("question"), 1000), "options": opts, "multiSelect": bool(q.get("multiSelect")),
                    "recommended": [_s(r, 200) for r in (q.get("recommended") or [])[:6] if isinstance(r, str)]})
    return out


class Inbox:
    """What is waiting for an answer, per user. Channel-agnostic: the page here, later others, call answer()."""

    def __init__(self, clock=time.time):
        self.clock = clock
        self.items: dict[str, dict] = {}

    def purge(self) -> None:
        now = self.clock()
        for k in [k for k, it in self.items.items() if now - it["created"] > ITEM_S]:
            it = self.items.pop(k)
            if it["state"] == "waiting":
                it["state"] = "expired"
            it["event"].set()

    def add(self, user: str, device: str, b: dict) -> dict | str:
        """A new waiting item, or why it was refused."""
        self.purge()
        kind = b.get("kind")
        if kind not in KINDS:
            return f"kind must be one of {', '.join(KINDS)}"
        if sum(1 for it in self.items.values() if it["user"] == user and it["state"] == "waiting") >= MAX_ITEMS:
            return "too many items waiting"
        it = {"id": secrets.token_hex(8), "user": user, "device": _s(device, 60), "kind": kind, "created": self.clock(),
              "project": _s(b.get("project"), 60), "who": _s(b.get("who"), 200), "state": "waiting", "answer": None,
              "event": asyncio.Event(), "nonce": "", "pushed": False}
        if kind == "approve":
            if not _s(b.get("tool"), 80):
                return "tool is missing"
            danger, outside = _s(b.get("danger"), 300), bool(b.get("outside"))
            # as in the terminal: a dangerous step or one outside the project has no "always" choice
            it.update(tool=_s(b.get("tool"), 80), target=_s(b.get("target"), 4000), danger=danger,
                      outside=outside, always="" if danger or outside else _s(b.get("always"), 300))
        else:
            qs = _questions(b.get("questions"))
            if not qs:
                return "questions: 1 to 4, each with a question and 1 to 6 options"
            it["questions"] = qs
        self.items[it["id"]] = it
        return it

    def get(self, item_id: str, user: str | None = None) -> dict | None:
        self.purge()
        it = self.items.get(item_id)
        return it if it and (user is None or it["user"] == user) else None

    async def wait(self, it: dict, secs: float) -> str:
        if it["state"] == "waiting":
            try:
                await asyncio.wait_for(it["event"].wait(), max(0.0, min(secs, WAIT_S)))
            except asyncio.TimeoutError:
                pass
        return it["state"]

    def cancel(self, it: dict) -> bool:
        if it["state"] != "waiting":
            return False
        it["state"] = "cancelled"
        it["event"].set()
        return True

    def answer(self, it: dict, ans: dict, via: str) -> str:
        """Record an answer by the rules the terminal follows. Returns "" or why it was refused."""
        if it["state"] != "waiting":
            return "already handled"
        if it["kind"] == "approve":
            action = ans.get("action")
            if action not in ACTIONS or (action == "always" and not it["always"]):
                return "this choice is not offered here"
            out = {"action": action, "note": _s(ans.get("note"), 2000) if action == "deny" else ""}
        else:
            answers = ans.get("answers")
            if not isinstance(answers, list) or len(answers) != len(it["questions"]) or not all(_s(a, 2000) for a in answers):
                return "every question needs an answer"
            out = {"answers": [_s(a, 2000) for a in answers]}
        it.update(state="answered", answer={**out, "via": via})
        it["event"].set()
        return ""


def _key(cfg: Config) -> bytes:
    return hashlib.sha256(b"ferry-remote\0" + cfg.secret.encode("utf-8")).digest()


def sign(cfg: Config, item_id: str, nonce: str, expires: int) -> str:
    body = f"{item_id}.{nonce}.{int(expires)}"
    mac = hmac.new(_key(cfg), body.encode("ascii"), hashlib.sha256).digest()[:18]
    return f"{body}.{base64.urlsafe_b64encode(mac).decode('ascii')}"


def verify(cfg: Config, token: str, now: float) -> tuple[str, str] | str:
    """(item id, nonce) for a good token; "bad" or "expired" otherwise."""
    parts = token.split(".")
    if len(parts) != 4 or not parts[2].isdigit():
        return "bad"
    try:
        good = sign(cfg, parts[0], parts[1], int(parts[2]))
    except UnicodeEncodeError:
        return "bad"
    if not hmac.compare_digest(good.encode("ascii"), token.encode("utf-8", "replace")):
        return "bad"
    if now > int(parts[2]):
        return "expired"
    return parts[0], parts[1]


def link(cfg: Config, it: dict, now: float) -> str:
    """A fresh link for the item; an earlier link of the same item stops working."""
    it["nonce"] = secrets.token_urlsafe(9)
    return f"{cfg.public_url.rstrip('/')}/m/{sign(cfg, it['id'], it['nonce'], int(now + LINK_S))}"


class Limiter:
    """At most n hits per window seconds for each key."""

    def __init__(self, n: int, window: float, clock=time.time):
        self.n, self.window, self.clock = n, window, clock
        self.seen: dict[str, deque] = {}

    def _q(self, key: str) -> deque:
        if len(self.seen) > 5000:
            self.seen.clear()
        q = self.seen.setdefault(key, deque())
        now = self.clock()
        while q and now - q[0] > self.window:
            q.popleft()
        return q

    def full(self, key: str) -> bool:
        return len(self._q(key)) >= self.n

    def hit(self, key: str) -> bool:
        q = self._q(key)
        if len(q) >= self.n:
            return False
        q.append(self.clock())
        return True


def who_text(it: dict) -> str:
    return f"子 agent {it['who']}" if it["who"] else "主 agent"


def push_line(it: dict) -> tuple[str, str]:
    """Title and one line for the notification: who waits, and for what."""
    title = f"Ferry · {it['project']}" if it["project"] else "Ferry"
    if it["kind"] == "approve":
        target = " ".join(it["target"].split())
        line = f"{who_text(it)}等你批准 {it['tool']}{'（有风险）' if it['danger'] else ''}：{target[:120]}"
    else:
        more = f"（共 {len(it['questions'])} 个问题）" if len(it["questions"]) > 1 else ""
        line = f"{who_text(it)}问你：{it['questions'][0]['question'][:120]}{more}"
    return title, line


# ---------- the page ----------

CSS = """
body{font:17px/1.5 -apple-system,system-ui,"PingFang SC",sans-serif;margin:0;padding:16px;background:#f2f2f7;color:#1c1c1e}
.card{background:#fff;border-radius:14px;padding:16px;margin:0 auto 12px;max-width:640px}
h1{font-size:21px;margin:0 0 6px}h2{font-size:17px;margin:14px 0 4px}
.meta{color:#6c6c70;font-size:14px}.small{color:#6c6c70;font-size:13px;margin:4px 0 0}
pre{white-space:pre-wrap;word-break:break-all;background:#f2f2f7;border-radius:8px;padding:10px;margin:8px 0;
font:14px/1.45 ui-monospace,Menlo,monospace}
.warn{background:#fdecea;color:#b3261e;border-radius:8px;padding:10px;margin:8px 0}
button{display:block;width:100%;font-size:17px;padding:14px;margin:10px 0 0;border:0;border-radius:12px;
background:#e5e5ea;color:#1c1c1e}
.go{background:#007aff;color:#fff}.red{background:#d70015;color:#fff}.no{background:#fff;color:#b3261e;border:1px solid #f0b8b3}
textarea,input[type=text]{width:100%;box-sizing:border-box;font:16px system-ui;padding:10px;border:1px solid #c7c7cc;
border-radius:10px;margin-top:10px}
label{display:block;padding:12px;border:1px solid #c7c7cc;border-radius:12px;margin-top:8px}
a{color:#007aff}
"""


def _page(title: str, body: str, status: int = 200) -> HTMLResponse:
    doc = ("<!doctype html><html lang=zh-CN><meta charset=utf-8>"
           "<meta name=viewport content='width=device-width,initial-scale=1'><meta name=robots content=noindex>"
           f"<title>{html.escape(title)}</title><style>{CSS}</style><body>{body}</body></html>")
    return HTMLResponse(doc, status, headers={
        "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'"})


def message(title: str, text: str, status: int = 200) -> HTMLResponse:
    return _page(title, f"<div class=card><h1>{html.escape(title)}</h1><p>{html.escape(text)}</p></div>", status)


def _head(it: dict, heading: str) -> str:
    e = html.escape
    when = time.strftime("%H:%M", time.localtime(it["created"]))
    where = " · ".join(x for x in (it["device"], it["project"]) if x)
    return (f"<h1>{e(heading)}</h1><div class=meta>{e(who_text(it))}{' · ' + e(where) if where else ''} · {when} 起在等</div>")


def item_page(it: dict, action: str, confirm: bool = False, note: str = "", error: str = "") -> HTMLResponse:
    e = html.escape
    err = f"<div class=warn>{e(error)}</div>" if error else ""
    if it["kind"] == "approve":
        risk = (f"<div class=warn>小心：{e(it['danger'])}</div>" if it["danger"]
                else "<div class=warn>在项目文件夹外面</div>" if it["outside"] else "")
        head = f"<div class=card>{_head(it, '等你批准')}<h2>要运行 {e(it['tool'])}</h2><pre>{e(it['target'])}</pre>{risk}</div>"
        if confirm:
            form = (f"<div class=card><form method=post action='{e(action)}'><p><b>这一步有风险，再点一次确认。</b></p>"
                    "<input type=hidden name=confirm value=1>"
                    "<button class=red name=action value=once>再点一次确认</button></form>"
                    f"<p><a href='{e(action)}'>算了，回去</a></p></div>")
        else:
            always = (f"<button name=action value=always>以后也允许</button><p class=small>{e(it['always'])}</p>"
                      if it["always"] else "")
            form = (f"<div class=card>{err}<form method=post action='{e(action)}'>"
                    f"<button class={'red' if it['danger'] else 'go'} name=action value=once>允许这一次</button>{always}"
                    f"<textarea name=note rows=2 placeholder='拒绝时可以告诉 agent 改做什么（可不填）'>{e(note)}</textarea>"
                    "<button class=no name=action value=deny>拒绝</button></form></div>")
        return _page("Ferry 等你批准", head + form)
    parts = []
    single = len(it["questions"]) == 1 and not it["questions"][0]["multiSelect"]
    for i, q in enumerate(it["questions"]):
        rec = set(q["recommended"])
        opts = [o for o in q["options"] if o["label"] in rec] + [o for o in q["options"] if o["label"] not in rec]
        rows = []
        for o in opts:
            text = e(o["label"]) + ("（推荐）" if o["label"] in rec else "")
            desc = f"<div class=small>{e(o['description'])}</div>" if o["description"] else ""
            if single:  # one tap answers
                rows.append(f"<button class={'go' if o['label'] in rec else ''} name=a0 value='{e(o['label'])}'>{text}</button>{desc}")
            else:
                kind = "checkbox" if q["multiSelect"] else "radio"
                rows.append(f"<label><input type={kind} name=a{i} value='{e(o['label'])}'> {text}{desc}</label>")
        hint = "<p class=small>可以选几个</p>" if q["multiSelect"] else ""
        other = f"<input type=text name=t{i} placeholder='{'或者自己写' if single else '其他（自己写）'}'>"
        send = "<button name=send value=1>发送我写的</button>" if single else ""
        parts.append(f"<h2>{e(q['question'])}</h2>{hint}{''.join(rows)}{other}{send}")
    submit = "" if single else "<button class=go>提交</button>"
    body = (f"<div class=card>{_head(it, '有问题要你回答')}</div><div class=card>{err}<form method=post action='{e(action)}'>"
            f"{''.join(parts)}{submit}</form></div>")
    return _page("Ferry 有问题问你", body)


def form_answer(it: dict, form: dict[str, list[str]]) -> dict:
    """The page's form as an answer for Inbox.answer()."""
    if it["kind"] == "approve":
        return {"action": (form.get("action") or [""])[0], "note": (form.get("note") or [""])[0]}
    answers = []
    for i, q in enumerate(it["questions"]):
        labels = {o["label"] for o in q["options"]}
        picks = [p for p in form.get(f"a{i}", []) if p in labels]
        text = (form.get(f"t{i}") or [""])[0].strip()
        answers.append("; ".join(picks + ([text] if text else [])) if q["multiSelect"] else (picks[0] if picks else text))
    return {"answers": answers}


DONE = {"once": "允许了这一次", "always": "允许了，以后也允许", "deny": "拒绝了"}
STATE = {"answered": "这一项已经答过了。", "cancelled": "已经在电脑上答了。", "expired": "等太久，已经过期了。"}


def mount(app: FastAPI, cfg: Config, audit, clock=time.time) -> None:
    inbox = Inbox(clock)
    per_ip, everyone, bad = Limiter(30, 60, clock), Limiter(120, 60, clock), Limiter(10, 600, clock)

    def mine(request: Request, item_id: str) -> dict | None:
        return inbox.get(item_id, request.state.user or "")

    def gone() -> JSONResponse:
        return JSONResponse({"state": "gone"}, 404)

    @app.post("/v1/ferry/remote")
    async def register(request: Request):
        try:
            b = await request.json()
        except ValueError:
            b = None
        if not isinstance(b, dict):
            return JSONResponse({"error": "a JSON object is needed"}, 400)
        it = inbox.add(request.state.user or "", getattr(request.state, "device_name", ""), b)
        if isinstance(it, str):
            return JSONResponse({"error": it}, 400)
        audit(event="remote", step="wait", user=it["user"], kind=it["kind"], id=it["id"])
        return {"id": it["id"], "expires": ITEM_S}

    @app.get("/v1/ferry/remote/{item_id}")
    async def poll(item_id: str, request: Request, wait: float = 25):
        it = mine(request, item_id)
        if not it:
            return gone()
        state = await inbox.wait(it, wait)
        if state == "answered":
            return {"state": state, "answer": it["answer"]}
        return {"state": "waiting"} if state == "waiting" else gone()

    @app.delete("/v1/ferry/remote/{item_id}")
    async def cancel(item_id: str, request: Request):
        it = mine(request, item_id)
        if it and inbox.cancel(it):
            audit(event="remote", step="answered_here", user=it["user"], id=it["id"])
        return {"ok": True}

    @app.post("/v1/ferry/remote/{item_id}/notify")
    async def push(item_id: str, request: Request):
        it = mine(request, item_id)
        if not it or it["state"] != "waiting":
            return gone()
        if it["pushed"]:
            return {"ok": True, "link": bool(it["nonce"])}
        it["pushed"] = True
        url = link(cfg, it, clock()) if cfg.public_url else ""
        title, line = push_line(it)
        ok, err = await notify.send(cfg, title, line, "approval", link=url)
        audit(event="notify", user=it["user"], kind="remote", ok=ok, link=bool(url))
        return {"ok": ok, "link": bool(url), **({"error": err} if err else {})}

    def opened(request: Request, token: str) -> dict | HTMLResponse:
        ip = request.headers.get("cf-connecting-ip") or (request.client.host if request.client else "")
        if bad.full(ip) or not per_ip.hit(ip) or not everyone.hit("*"):
            return message("请稍后再试", "这个页面被打开得太频繁了，过一会儿再试。", 429)
        found = verify(cfg, token, clock())
        if found == "expired":
            return message("链接过期了", f"手机上的链接 {LINK_S // 60} 分钟内有效。回到电脑上回答。", 410)
        it = inbox.get(found[0]) if isinstance(found, tuple) else None
        if isinstance(found, str) or (it and it["nonce"] != found[1]):
            bad.hit(ip)
            return message("链接无效", "这个链接不对，或者已经换了新的。", 403)
        if not it:
            return message("已处理", "这一项已经不在了（答过或过期了）。")
        if it["state"] != "waiting":
            return message("已处理", STATE.get(it["state"], "这一项已经处理过了。"))
        return it

    @app.get("/m/{token}")
    async def page(token: str, request: Request):
        it = opened(request, token)
        return it if isinstance(it, HTMLResponse) else item_page(it, f"/m/{token}")

    @app.post("/m/{token}")
    async def answer(token: str, request: Request):
        it = opened(request, token)
        if isinstance(it, HTMLResponse):
            return it
        raw = await request.body()
        if len(raw) > 20000:
            return message("内容太长", "写短一点再发。", 413)
        form = parse_qs(raw.decode("utf-8", "replace"), keep_blank_values=True)
        ans = form_answer(it, form)
        action = f"/m/{token}"
        if it["kind"] == "approve" and ans["action"] == "once" and it["danger"] and (form.get("confirm") or [""])[0] != "1":
            return item_page(it, action, confirm=True)
        err = inbox.answer(it, ans, "phone")
        if err:
            return item_page(it, action, note=ans.get("note", ""), error={
                "every question needs an answer": "每个问题都要答。", "this choice is not offered here": "这里没有这个选项。"
            }.get(err, err))
        audit(event="remote", step="answered_on_phone", user=it["user"], id=it["id"], kind=it["kind"],
              action=it["answer"].get("action", ""))
        done = DONE[it["answer"]["action"]] if it["kind"] == "approve" else "回答已经发给 agent"
        return message("已处理", f"{done}。可以关掉这个页面了。")
