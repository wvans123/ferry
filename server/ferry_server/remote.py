"""Answering Ferry from the phone: an approval or a question waiting in a work computer's terminal can be answered on
a small page opened from the Bark notification.

The work computer cannot be reached from outside, so it asks. It puts the waiting item in this server's inbox
(POST /v1/ferry/remote), long-polls for the answer (GET /v1/ferry/remote/<id>?wait=25) and takes the item back when it
was answered in the terminal (DELETE). Once the item has waited phoneApprovalSeconds, the client asks for the push
(POST /v1/ferry/remote/<id>/notify); with public_url set, the push opens /m/<token> when tapped. The token is signed
with the server secret, names one item, lasts LINK_S and answers once. /m/ is the only path open without a Ferry
token; it shows that one item and takes its answer, nothing else.

Items live in memory and go after ITEM_S. The inbox does not care where an answer comes from: any channel calls
Inbox.answer().

The phone console: each running ferry with a terminal is a session in the inbox. It uploads a small status
(PUT /v1/ferry/console/<sid>: working or idle, the /goal line, the to-do list, the last steps) and long-polls for
commands (GET .../commands?wait=25). /m/<token> with a console token (id "c_<sid>", CONSOLE_S, renewed by every
refresh, revoked by /phone off or when ferry exits) shows that one session and queues commands for it: steer, pause,
resume, task. Inbox.controls() says which commands the session's state allows and Inbox.command() queues one; the page
here calls those two.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import html
import json
import re
import secrets
import time
from collections import deque
from urllib.parse import parse_qs

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse

from . import notify
from .config import Config

ITEM_S = 30 * 60   # an unanswered item is dropped after this
LINK_S = 10 * 60   # a link on the phone works this long
WAIT_S = 30        # longest single long-poll
MAX_ITEMS = 20     # waiting items per user
KINDS = ("approve", "ask")
ACTIONS = ("once", "always", "deny")

CONSOLE_S = 12 * 3600  # a console link works this long; opening the page gives a fresh one
SESSION_S = 60 * 60    # a session not heard from (status or poll) this long is dropped
STALE_S = 120          # the page says the computer is silent after this
COMMAND_S = 10 * 60    # a command the computer has not taken by then is dropped
MAX_SESSIONS = 10      # sessions per user
MAX_COMMANDS = 10      # queued commands per session
STATUS_BYTES = 16384   # largest status upload (clients send at most 8000)
COMMANDS = ("steer", "task", "pause", "resume")
SID = re.compile(r"[0-9a-f]{8,32}")


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


def _status(b: dict) -> dict:
    """A session's status upload, kept to the fields and lengths the page shows."""
    g = b.get("goal") if isinstance(b.get("goal"), dict) else {}
    turns = g.get("turns")
    last = b.get("last") if isinstance(b.get("last"), dict) else {}
    todo, steps = (b.get(k) if isinstance(b.get(k), list) else [] for k in ("todo", "steps"))
    return {
        "state": "working" if b.get("state") == "working" else "idle",
        "project": _s(b.get("project"), 60), "model": _s(b.get("model"), 80), "tasks": b.get("tasks") is not False,
        "goal": {"objective": _s(g.get("objective"), 400), "status": _s(g.get("status"), 20),
                 "turns": turns if isinstance(turns, int) and turns >= 0 else 0} if _s(g.get("objective"), 400) else None,
        "todo": [{"status": _s(t.get("status"), 12), "text": _s(t.get("text"), 200)}
                 for t in todo[:20] if isinstance(t, dict) and _s(t.get("text"), 200)],
        "steps": [_s(x, 200) for x in steps[-10:] if isinstance(x, str) and x.strip()],
        "reply": _s(b.get("reply"), 4000),
        "last": {"cmd": _s(last.get("cmd"), 10), "result": _s(last.get("result"), 20)} if last.get("cmd") else None,
    }


class Inbox:
    """What is waiting for an answer, and the running sessions, per user. Channel-agnostic: the page here, later
    others, call answer(), controls() and command()."""

    def __init__(self, clock=time.time):
        self.clock = clock
        self.items: dict[str, dict] = {}
        self.sessions: dict[str, dict] = {}

    def purge(self) -> None:
        now = self.clock()
        for k in [k for k, it in self.items.items() if now - it["created"] > ITEM_S]:
            it = self.items.pop(k)
            if it["state"] == "waiting":
                it["state"] = "expired"
            it["event"].set()
        for k in [k for k, s in self.sessions.items() if now - s["seen"] > SESSION_S]:
            self.sessions.pop(k)["event"].set()

    # ---------- sessions (the phone console) ----------

    def report(self, user: str, device_id: str, device: str, sid: str, b: dict) -> dict | str:
        """A session's status; the first one opens the session. Returns the session or why it was refused."""
        self.purge()
        if not SID.fullmatch(sid):
            return "bad session id"
        s = self.sessions.get(sid)
        if s and (s["user"], s["device_id"]) != (user, device_id):
            return "bad session id"
        if not s:
            mine = sorted((x for x in self.sessions.values() if x["user"] == user), key=lambda x: x["seen"])
            for old in mine[:max(0, len(mine) - MAX_SESSIONS + 1)]:
                self.end(old)
            s = {"id": sid, "user": user, "device_id": device_id, "device": _s(device, 60) or user, "key": secrets.token_urlsafe(9),
                 "off": False, "commands": [], "event": asyncio.Event()}
            self.sessions[sid] = s
        s.update(status=_status(b), seen=self.clock(), updated=self.clock())
        return s

    def session(self, sid: str, user: str | None = None, device_id: str | None = None) -> dict | None:
        self.purge()
        s = self.sessions.get(sid)
        if not s or (user is not None and s["user"] != user) or (device_id is not None and s["device_id"] != device_id):
            return None
        return s

    def end(self, s: dict) -> None:
        self.sessions.pop(s["id"], None)
        s["event"].set()

    def revoke(self, s: dict) -> None:
        """Every console link of the session stops working; pushes carry none until the next /phone."""
        s.update(key=secrets.token_urlsafe(9), off=True)

    def waiting(self, s: dict) -> list[dict]:
        return [it for it in self.items.values() if it["state"] == "waiting" and it["user"] == s["user"] and it["session"] == s["id"]]

    def state(self, s: dict) -> str:
        """working, idle or waiting (an approval or a question of the session waits for an answer)."""
        return "waiting" if self.waiting(s) else s["status"]["state"]

    def silent(self, s: dict) -> bool:
        return self.clock() - s["seen"] > STALE_S

    def controls(self, s: dict) -> list[str]:
        """The commands the session's state allows: steer while it works, a new task while it is idle (if allowed),
        pause or resume when there is a goal in that state."""
        st, out = s["status"], []
        out.append("steer" if st["state"] == "working" else "task" if st["tasks"] else "")
        g = (st["goal"] or {}).get("status")
        out.append("pause" if g == "pursuing" else "resume" if g == "paused" else "")
        return [c for c in out if c]

    def command(self, s: dict, cmd: str, text: str, via: str) -> str:
        """Queue a command for the session. Returns "" or why it was refused."""
        if cmd not in self.controls(s):
            return "not now"
        text = str(text or "").strip()[:4000]
        if cmd in ("steer", "task") and not text:
            return "empty"
        self._drop_old(s)
        if len(s["commands"]) >= MAX_COMMANDS:
            return "too many"
        s["commands"].append({"id": secrets.token_hex(6), "cmd": cmd, "text": text if cmd in ("steer", "task") else "",
                              "via": via, "at": self.clock()})
        s["event"].set()
        return ""

    def _drop_old(self, s: dict) -> None:
        now = self.clock()
        s["commands"] = [c for c in s["commands"] if now - c["at"] <= COMMAND_S]

    async def take(self, s: dict, secs: float) -> list[dict]:
        """The session's queued commands, waiting up to secs for one."""
        s["seen"] = self.clock()
        self._drop_old(s)
        if not s["commands"] and s["id"] in self.sessions:
            s["event"].clear()
            try:
                await asyncio.wait_for(s["event"].wait(), max(0.0, min(secs, WAIT_S)))
            except asyncio.TimeoutError:
                pass
        self._drop_old(s)
        out, s["commands"] = s["commands"], []
        s["seen"] = self.clock()
        return [{"id": c["id"], "cmd": c["cmd"], "text": c["text"], "via": c["via"]} for c in out]

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
              "event": asyncio.Event(), "nonce": "", "pushed": False, "session": _s(b.get("session"), 40), "url": "", "url_exp": 0}
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
    it["url_exp"] = int(now + LINK_S)
    it["url"] = f"/m/{sign(cfg, it['id'], it['nonce'], it['url_exp'])}"
    return f"{cfg.public_url.rstrip('/')}{it['url']}"


def item_path(cfg: Config, it: dict, now: float) -> str:
    """The item's page for the console: the link already pushed while it has a minute left, so that one keeps working."""
    if not it["url"] or it["url_exp"] - now < 60:
        link(cfg, it, now)
    return it["url"]


def console_path(cfg: Config, s: dict, now: float) -> str:
    """A console link of the session: every one stays good until it expires or the session's links are revoked."""
    return f"/m/{sign(cfg, 'c_' + s['id'], s['key'], int(now + CONSOLE_S))}"


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
a{color:#007aff}.reply{white-space:pre-wrap;word-break:break-word;margin:8px 0 0}
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


def item_page(it: dict, action: str, confirm: bool = False, note: str = "", error: str = "", console: str = "") -> HTMLResponse:
    e = html.escape
    err = f"<div class=warn>{e(error)}</div>" if error else ""
    more = f"<p class=small><a href='{e(console)}'>打开这个 Ferry 的控制台</a></p>" if console else ""
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
        return _page("Ferry 等你批准", head + form + more)
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
            f"{''.join(parts)}{submit}</form></div>{more}")
    return _page("Ferry 有问题问你", body)


STATE_TEXT = {"working": "在干活", "idle": "空闲，可以派新活", "waiting": "等你回答"}
GOAL_TEXT = {"pursuing": "进行中", "paused": "已暂停", "achieved": "已完成", "unmet": "卡住了，要你帮忙", "budget": "预算或轮数用完了"}
TODO_MARK = {"completed": "✓", "in_progress": "▶"}
SENT = {"steer": "插话", "task": "新活", "pause": "暂停目标", "resume": "继续目标"}
RESULT = {"delivered": "插话已送到，agent 下一步会看到", "started": "已经开始干了", "queued": "电脑正忙，排在当前这件事后面",
          "refused": "没有执行：电脑上关了从手机派活（remoteTasks）", "done": "已照做", "nogoal": "没有执行：现在没有这样的目标",
          "command": "已当作命令执行"}
REFUSED = {"not now": "现在不能这样做，刷新看看最新状态。", "empty": "先写点内容。", "too many": "发得太多了，等电脑取走再发。"}


def console_page(s: dict, state: str, controls: list[str], silent: int, items: list[tuple[str, str]], fresh: str,
                 done: str = "", error: str = "") -> HTMLResponse:
    """One session on the phone: what it is doing, and what it can be told in this state. silent: minutes without a
    word from the computer, 0 while it is heard from."""
    e = html.escape
    st = s["status"]
    where = " · ".join(e(x) for x in (s["device"], st["project"], st["model"]) if x)
    when = time.strftime("%H:%M:%S", time.localtime(s["updated"]))
    head = f"<div class=card><h1>{STATE_TEXT[state]}</h1><div class=meta>{where}</div><p class=small>状态更新于 {when}</p>"
    if silent:
        head += (f"<div class=warn>电脑 {silent} 分钟没有消息了，可能是公司网关要确认、电脑睡眠或断网、"
                 "ferry 退出了。这里发的东西等它连上才收到，10 分钟内没取走就作废。</div>")
    head += "</div>"
    note = (f"<div class=card><b>已发出{SENT.get(done, '')}</b>，电脑几秒内收到。刷新看结果。</div>" if done in SENT else
            f"<div class=card><div class=warn>{e(REFUSED.get(error, error))}</div></div>" if error else "")
    if st["last"] and st["last"]["cmd"] in SENT and not done:
        note += f"<div class=card>上一条手机消息（{SENT[st['last']['cmd']]}）：{e(RESULT.get(st['last']['result'], st['last']['result']))}</div>"
    wait = ("<div class=card><h2>等你回答</h2>" + "".join(f"<p><a href='{e(p)}'>{e(t)}</a></p>" for p, t in items)
            + "</div>") if items else ""
    goal = ""
    if st["goal"]:
        g = st["goal"]
        goal = (f"<div class=card><h2>目标：{GOAL_TEXT.get(g['status'], e(g['status']))} · 第 {g['turns']} 轮</h2>"
                f"<p>{e(g['objective'])}</p></div>")
    todo = ("<div class=card><h2>待办</h2>" + "".join(f"<div>{TODO_MARK.get(t['status'], '○')} {e(t['text'])}</div>" for t in st["todo"])
            + "</div>") if st["todo"] else ""
    steps = ""
    if st["steps"]:
        steps = ("<div class=card><h2>最近几步</h2>" + "".join(f"<div class=small>{e(x)}</div>" for x in st["steps"])
                 + "</div>")
    if st["reply"]:  # its own card, line breaks kept
        steps += f"<div class=card><h2>最新回复</h2><div class=reply>{e(st['reply'])}</div></div>"
    acts = []
    if "steer" in controls:
        acts.append("<textarea name=text rows=4 placeholder='插话：agent 下一步就会看到'></textarea>"
                    "<button class=go name=cmd value=steer>发送插话</button>")
    elif "task" in controls:
        acts.append("<textarea name=text rows=5 placeholder='派新活：写清楚要做什么。要它一直做到完成，开头写 /goal'></textarea>"
                    "<button class=go name=cmd value=task>开始干</button>"
                    "<p class=small>普通消息只做这一件事；以 /goal 开头是长目标，会定完成标准、列待办、做到完成为止。</p>")
    elif state == "idle":
        acts.append("<p class=small>电脑上关了从手机派活（remoteTasks），这里只能看。</p>")
    if "pause" in controls:
        acts.append("<button name=cmd value=pause>暂停目标（这一步做完就停）</button>")
    if "resume" in controls:
        acts.append("<button name=cmd value=resume>继续目标</button>")
    form = f"<div class=card><form method=post action='{e(fresh)}'>{''.join(acts)}</form></div>" if acts else ""
    foot = f"<p><a href='{e(fresh)}'>刷新</a></p>"
    return _page("Ferry 控制台", head + note + wait + goal + todo + steps + form + foot)


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


def mount(app: FastAPI, cfg: Config, audit, clock=time.time):
    """The inbox's API and the phone page. Returns console_link(user, sid): the full console address to put in a push
    for that session, or "" (no public address, links turned off, unknown session)."""
    inbox = Inbox(clock)
    per_ip, everyone, bad = Limiter(30, 60, clock), Limiter(120, 60, clock), Limiter(10, 600, clock)
    per_session = Limiter(20, 600, clock)

    def mine(request: Request, item_id: str) -> dict | None:
        return inbox.get(item_id, request.state.user or "")

    def gone() -> JSONResponse:
        return JSONResponse({"state": "gone"}, 404)

    def console_link(user: str, sid: str) -> str:
        s = inbox.session(sid, user) if sid and cfg.public_url else None
        return f"{cfg.public_url.rstrip('/')}{console_path(cfg, s, clock())}" if s and not s["off"] else ""

    def own(request: Request, sid: str) -> dict | None:
        return inbox.session(sid, request.state.user or "", getattr(request.state, "device_id", "main"))

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

    # ---------- the console: a running ferry's status and commands ----------

    @app.put("/v1/ferry/console/{sid}")
    async def status(sid: str, request: Request):
        raw = await request.body()
        if len(raw) > STATUS_BYTES:
            return JSONResponse({"error": f"status larger than {STATUS_BYTES} bytes"}, 413)
        try:
            b = json.loads(raw or b"{}")
        except ValueError:
            b = None
        if not isinstance(b, dict):
            return JSONResponse({"error": "a JSON object is needed"}, 400)
        user = request.state.user or ""
        s = inbox.report(user, getattr(request.state, "device_id", "main"), getattr(request.state, "device_name", ""), sid, b)
        if isinstance(s, str):
            return JSONResponse({"error": s}, 400)
        return {"ok": True}

    @app.get("/v1/ferry/console/{sid}/commands")
    async def commands(sid: str, request: Request, wait: float = 25):
        s = own(request, sid)
        if not s:
            return gone()
        out = await inbox.take(s, wait)
        if sid not in inbox.sessions:
            return gone()
        return {"commands": out}

    @app.post("/v1/ferry/console/{sid}/link")
    async def console_on(sid: str, request: Request):
        """/phone: links on again, and a fresh one, pushed to the phone when asked."""
        s = own(request, sid)
        if not s:
            return gone()
        try:
            b = json.loads(await request.body() or b"{}")
        except ValueError:
            b = {}
        s["off"] = False
        url = console_link(s["user"], sid)
        ok = False
        if url and isinstance(b, dict) and b.get("push"):
            title = f"Ferry · {s['status']['project']}" if s["status"]["project"] else "Ferry"
            ok, _ = await notify.send(cfg, title, "控制台：点开看它在做什么，也可以插话、暂停目标、派新活。", "console", link=url)
        audit(event="remote", step="console_link", user=s["user"], session=sid, pushed=ok)
        return {"link": url, "pushed": ok}

    @app.delete("/v1/ferry/console/{sid}/link")
    async def console_off(sid: str, request: Request):
        s = own(request, sid)
        if s:
            inbox.revoke(s)
            audit(event="remote", step="console_off", user=s["user"], session=sid)
        return {"ok": True}

    @app.delete("/v1/ferry/console/{sid}")
    async def console_end(sid: str, request: Request):
        s = own(request, sid)
        if s:
            inbox.end(s)
        return {"ok": True}

    # ---------- the phone page ----------

    def opened(request: Request, token: str) -> dict | HTMLResponse:
        """The item or the session (a dict with "status") the token names, or the page that says why not."""
        ip = request.headers.get("cf-connecting-ip") or (request.client.host if request.client else "")
        if bad.full(ip) or not per_ip.hit(ip) or not everyone.hit("*"):
            return message("请稍后再试", "这个页面被打开得太频繁了，过一会儿再试。", 429)
        found = verify(cfg, token, clock())
        console = isinstance(found, tuple) and found[0].startswith("c_")
        if found == "expired":
            return message("链接过期了", f"控制台链接 {CONSOLE_S // 3600} 小时内有效。在电脑上输入 /phone 拿新链接。"
                           if token.startswith("c_") else f"手机上的链接 {LINK_S // 60} 分钟内有效。回到电脑上回答。", 410)
        if console:
            s = inbox.session(found[0][2:])
            if s and s["key"] == found[1]:
                return s
            if not s:
                return message("控制台已关闭", "这个 Ferry 已经退出，或者很久没有消息了。")
        it = inbox.get(found[0]) if isinstance(found, tuple) and not console else None
        if isinstance(found, str) or console or (it and it["nonce"] != found[1]):
            bad.hit(ip)
            return message("链接无效", "这个链接不对，或者已经换了新的。", 403)
        if not it:
            return message("已处理", "这一项已经不在了（答过或过期了）。")
        if it["state"] != "waiting":
            return message("已处理", STATE.get(it["state"], "这一项已经处理过了。"))
        return it

    def show(s: dict, done: str = "", error: str = "") -> HTMLResponse:
        now = clock()
        items = [(item_path(cfg, it, now), push_line(it)[1]) for it in inbox.waiting(s)]
        silent = max(1, round((now - s["seen"]) / 60)) if inbox.silent(s) else 0
        return console_page(s, inbox.state(s), inbox.controls(s), silent, items, console_path(cfg, s, now), done, error)

    def console_of(it: dict) -> str:
        s = inbox.session(it["session"], it["user"]) if it["session"] else None
        return console_path(cfg, s, clock()) if s and not s["off"] else ""

    @app.get("/m/{token}")
    async def page(token: str, request: Request, done: str = ""):
        it = opened(request, token)
        if isinstance(it, HTMLResponse):
            return it
        return show(it, done) if "status" in it else item_page(it, f"/m/{token}", console=console_of(it))

    @app.post("/m/{token}")
    async def answer(token: str, request: Request):
        it = opened(request, token)
        if isinstance(it, HTMLResponse):
            return it
        raw = await request.body()
        if len(raw) > 20000:
            return message("内容太长", "写短一点再发。", 413)
        form = parse_qs(raw.decode("utf-8", "replace"), keep_blank_values=True)
        if "status" in it:
            cmd = (form.get("cmd") or [""])[0]
            if not per_session.hit(it["id"]):
                return show(it, error="too many")
            err = inbox.command(it, cmd, (form.get("text") or [""])[0], "phone")
            if err:
                return show(it, error=err)
            audit(event="remote", step="command", user=it["user"], session=it["id"], cmd=cmd, via="phone")
            return RedirectResponse(f"/m/{token}?done={cmd}", 303)
        ans = form_answer(it, form)
        action = f"/m/{token}"
        if it["kind"] == "approve" and ans["action"] == "once" and it["danger"] and (form.get("confirm") or [""])[0] != "1":
            return item_page(it, action, confirm=True, console=console_of(it))
        err = inbox.answer(it, ans, "phone")
        if err:
            return item_page(it, action, note=ans.get("note", ""), console=console_of(it), error={
                "every question needs an answer": "每个问题都要答。", "this choice is not offered here": "这里没有这个选项。"
            }.get(err, err))
        audit(event="remote", step="answered_on_phone", user=it["user"], id=it["id"], kind=it["kind"],
              action=it["answer"].get("action", ""))
        done = DONE[it["answer"]["action"]] if it["kind"] == "approve" else "回答已经发给 agent"
        return message("已处理", f"{done}。可以关掉这个页面了。")

    app.state.console_link = console_link
    app.state.inbox = inbox
    return console_link


