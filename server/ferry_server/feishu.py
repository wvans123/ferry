"""The Feishu (飞书) bot: a second channel on remote.py's inbox, next to the Bark push and the phone page.

The owner makes a self-built app with the bot capability in the Feishu console and puts its App ID, App Secret and
Verification Token on the admin page (kept in <home>/feishu.json, readable by the owner only). Feishu posts message
events (im.message.receive_v1) and card callbacks (card.action.trigger) to /feishu/event, which besides /m/ is the only
path open without a Ferry token. A request counts only with the app's Verification Token. The Encrypt Key must stay
empty: decrypting needs AES, which Python's standard library does not have, and the tunnel is HTTPS already.

One Feishu user is listened to: the owner, bound by sending the bot the one-time code the admin page shows. Anyone
else is ignored and logged without content. The owner acts for the server's first user.

Out: when a waiting approval or question is pushed (the client asks after phoneApprovalSeconds), it also becomes a
card with the terminal's choices; once it is answered anywhere (here, the phone page, the terminal) or expires, the
card says so. Every other notification (goal done or stuck, recap, watchdog) goes as a line of text.
In: "状态" sends a card per running session with buttons by its state. Other text steers the session that works, or
gives an idle one a new task, through Inbox.command(): the same rules as the phone page. When several run, replying
to a session's card or message, or "/s <n> <text>", picks one.
"""
from __future__ import annotations

import asyncio
import hmac
import json
import os
import re
import secrets
import time
from collections import OrderedDict
from pathlib import Path

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from . import notify
from . import remote
from .config import Config

API = "https://open.feishu.cn"
CODE_S = 10 * 60       # a binding code works this long
CODE_TRIES = 20        # wrong codes from strangers before the code is dropped
RETRIES = 3            # tries of one Feishu API call
BACKOFF_S = 0.5        # first wait between tries; doubles
KEEP = 500             # cards and messages remembered (for replies and later updates)
BODY_BYTES = 64_000    # largest event
TOKEN_CODES = {99991661, 99991663, 99991668}  # the tenant token is missing, invalid or expired: fetch a new one
BUSY_CODES = {99991400}                         # Feishu's rate limit
DEFAULTS = {"on": False, "app_id": "", "app_secret": "", "token": "", "owner": "", "user": "", "code": "", "code_exp": 0}

HELP = ("发“状态”看开着的 Ferry。直接写字：在干活的会收到插话，空闲的会开始干新活。"
        "开着几个时，回复它的卡片或消息，或者写 /s 编号 内容。“暂停”“继续”管 /goal。")
NONE_OPEN = "现在没有开着的 Ferry（工作电脑上的 ferry 要开着终端，并且连得上服务端）。"
VIA = {"feishu": "在飞书上答的", "phone": "在手机页面上答的"}
DONE = {"once": "允许了这一次", "always": "允许了，以后也允许", "deny": "拒绝了"}
ERRORS = {"every question needs an answer": "每个问题都要答。", "this choice is not offered here": "这里没有这个选项。",
          "already handled": "这一项已经处理过了。"}


class Failed(Exception):
    pass


# ---------- settings: <home>/feishu.json ----------

_cache: dict[str, tuple[int, dict]] = {}


def path(cfg: Config) -> Path:
    return (cfg.home or cfg.data_dir) / "feishu.json"


def settings(cfg: Config) -> dict:
    p = path(cfg)
    try:
        mtime = p.stat().st_mtime_ns
    except OSError:
        return dict(DEFAULTS)
    hit = _cache.get(str(p))
    if hit and hit[0] == mtime:
        return dict(hit[1])
    try:
        raw = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raw = {}
    s = {**DEFAULTS, **{k: raw[k] for k in DEFAULTS if isinstance(raw, dict) and k in raw}}
    _cache[str(p)] = (mtime, s)
    return dict(s)


def save(cfg: Config, **changes) -> dict:
    s = {**settings(cfg), **changes}
    p = path(cfg)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(s, ensure_ascii=False), encoding="utf-8")
    try:
        p.chmod(0o600)
    except OSError:
        pass
    _cache[str(p)] = (p.stat().st_mtime_ns, s)
    return dict(s)


def ready(cfg: Config) -> bool:
    """Switched on, the app's credentials are in, and the owner is bound."""
    s = settings(cfg)
    return bool(s["on"] and s["app_id"] and s["app_secret"] and s["token"] and s["owner"])


def apply(cfg: Config, b: dict) -> None:
    """The admin page's settings: feishu_on, feishu_app_id, feishu_app_secret, feishu_token, feishu_unbind."""
    ch: dict = {}
    if "feishu_on" in b:
        ch["on"] = bool(b["feishu_on"])
    for k in ("app_id", "app_secret", "token"):
        if f"feishu_{k}" in b:
            ch[k] = str(b[f"feishu_{k}"] or "").strip()[:200]
    if b.get("feishu_unbind"):
        ch.update(owner="", user="")
    if ch:
        save(cfg, **ch)


def new_code(cfg: Config, clock=time.time) -> str:
    code = f"{secrets.randbelow(10 ** 6):06d}"
    save(cfg, code=code, code_exp=int(clock() + CODE_S))
    return code


def status(cfg: Config, bot: "Bot | None", clock=time.time) -> dict:
    """What the admin page shows: never the secrets themselves."""
    s = settings(cfg)
    left = int(s["code_exp"] - clock()) if s["code"] else 0
    return {"on": bool(s["on"]), "app_id": s["app_id"], "secret": bool(s["app_secret"]), "token": bool(s["token"]),
            "bound": bool(s["owner"]), "code": s["code"] if left > 0 else "", "code_left": max(0, left),
            "url": f"{cfg.public_url.rstrip('/')}/feishu/event" if cfg.public_url else "", "ready": ready(cfg),
            "error": bot.error if bot else ""}


# ---------- cards (Feishu card JSON 2.0) ----------

def _text(t: str) -> dict:
    return {"tag": "div", "text": {"tag": "plain_text", "content": t}}


def _button(label: str, value: dict, kind: str = "default", name: str = "") -> dict:
    """A button that calls back with value; with a name it submits the form it sits in."""
    b = {"tag": "button", "text": {"tag": "plain_text", "content": label}, "type": kind,
         "behaviors": [{"type": "callback", "value": value}]}
    if name:
        b.update(name=name, form_action_type="submit")
    return b


def _row(*buttons: dict) -> dict:
    return {"tag": "column_set", "columns": [{"tag": "column", "width": "auto", "elements": [b]} for b in buttons]}


def _input(name: str, hint: str) -> dict:
    return {"tag": "input", "name": name, "max_length": 1000, "placeholder": {"tag": "plain_text", "content": hint}}


def _card(title: str, color: str, elements: list[dict]) -> dict:
    return {"schema": "2.0", "config": {"update_multi": True},
            "header": {"title": {"tag": "plain_text", "content": title[:100]}, "template": color},
            "body": {"elements": elements}}


def _head(it: dict) -> str:
    where = " · ".join(x for x in (it["device"], it["project"]) if x)
    when = time.strftime("%H:%M", time.localtime(it["created"]))
    return f"{remote.who_text(it)}{' · ' + where if where else ''} · {when} 起在等"


def _ordered(q: dict) -> list[tuple[int, dict]]:
    rec = set(q["recommended"])
    opts = list(enumerate(q["options"]))
    return [x for x in opts if x[1]["label"] in rec] + [x for x in opts if x[1]["label"] not in rec]


def item_card(it: dict, confirm: bool = False, error: str = "") -> dict:
    """The card of a waiting approval or question; once it stops waiting, what became of it."""
    iid, err = it["id"], [_text(f"⚠️ {error}")] if error else []
    if it["state"] != "waiting":
        if it["kind"] == "approve":
            what = f"{it['tool']}：{' '.join(it['target'].split())[:300]}"
        else:
            what = it["questions"][0]["question"][:300]
        if it["state"] == "answered":
            a = it["answer"]
            got = (DONE.get(a.get("action"), "") + (f"：{a['note']}" if a.get("note") else "") if it["kind"] == "approve"
                   else "回答：" + " / ".join(a.get("answers", [])))
            line = f"已处理 · {VIA.get(a.get('via'), '在别处答的')}"
        else:
            got, line = "", "已处理 · 在电脑上答的" if it["state"] == "cancelled" else "等太久，已经过期了"
        return _card(line, "grey" if it["state"] == "expired" else "green",
                     [_text(_head(it)), _text(what)] + ([_text(got)] if got else []))
    if it["kind"] == "approve":
        els = [_text(_head(it)), _text(f"要运行 {it['tool']}"), _text(it["target"] or "（没有参数）")]
        if it["danger"]:
            els.append(_text(f"⚠️ 小心：{it['danger']}"))
        elif it["outside"]:
            els.append(_text("⚠️ 在项目文件夹外面"))
        if confirm:
            els += [_text("这一步有风险，再点一次确认。"),
                    _row(_button("再点一次确认", {"k": "a", "i": iid, "a": "once", "c": 1}, "danger"),
                         _button("算了，回去", {"k": "b", "i": iid}))]
            return _card("等你批准（再确认一次）", "red", els)
        buttons = [_button("允许这一次", {"k": "a", "i": iid, "a": "once"}, "danger" if it["danger"] else "primary", "once")]
        if it["always"]:
            buttons.append(_button("以后也允许", {"k": "a", "i": iid, "a": "always"}, "default", "always"))
        buttons.append(_button("拒绝", {"k": "a", "i": iid, "a": "deny"}, "default", "deny"))
        els += err + [{"tag": "form", "name": "f", "elements": [
            _input("note", "拒绝时可以告诉 agent 改做什么（可不填）"), _row(*buttons)]}]
        if it["always"]:
            els.append(_text(f"以后也允许：{it['always']}"))
        return _card(f"等你批准 · {it['project']}" if it["project"] else "等你批准", "red" if it["danger"] else "orange", els)
    qs = it["questions"]
    els = [_text(_head(it))] + err
    if len(qs) == 1 and not qs[0]["multiSelect"]:  # one tap answers
        q = qs[0]
        els.append(_text(q["question"]))
        rec = set(q["recommended"])
        for n, o in _ordered(q):
            mark = "（推荐）" if o["label"] in rec else ""
            els.append(_button(f"{o['label']}{mark}", {"k": "q", "i": iid, "o": n}, "primary" if mark else "default"))
            if o["description"]:
                els.append(_text(o["description"]))
        els.append({"tag": "form", "name": "f", "elements": [
            _input("t0", "或者自己写"), _button("发送我写的", {"k": "qf", "i": iid}, "default", "send")]})
    else:
        fields = []
        for i, q in enumerate(qs):
            rec = set(q["recommended"])
            opts = [{"text": {"tag": "plain_text", "content": o["label"] + ("（推荐）" if o["label"] in rec else "")},
                     "value": str(n)} for n, o in _ordered(q)]
            fields += [_text(q["question"] + ("（可以选几个）" if q["multiSelect"] else "")),
                       {"tag": "multi_select_static" if q["multiSelect"] else "select_static", "name": f"a{i}",
                        "placeholder": {"tag": "plain_text", "content": "选一个" if not q["multiSelect"] else "选几个"},
                        "options": opts},
                       _input(f"t{i}", "其他（自己写）")]
        els.append({"tag": "form", "name": "f", "elements": fields + [_button("提交", {"k": "qf", "i": iid}, "primary", "send")]})
    return _card(f"有问题要你回答 · {it['project']}" if it["project"] else "有问题要你回答", "blue", els)


def form_answers(it: dict, form: dict) -> dict:
    """The question card's form as an answer for Inbox.answer() (like remote.form_answer for the page)."""
    answers = []
    for i, q in enumerate(it["questions"]):
        raw = form.get(f"a{i}")
        picked = raw if isinstance(raw, list) else [raw] if raw not in (None, "") else []
        labels = [q["options"][int(p)]["label"] for p in picked if str(p).isdigit() and int(p) < len(q["options"])]
        text = str(form.get(f"t{i}") or "").strip()
        answers.append("; ".join(labels + ([text] if text else [])) if q["multiSelect"] else (labels[0] if labels else text))
    return {"answers": answers}


def console_card(inbox: remote.Inbox, s: dict, n: int, note: str = "") -> dict:
    """One running session, as the phone console shows it, with the buttons its state allows."""
    st, state = s["status"], inbox.state(s)
    where = " · ".join(x for x in (s["device"], st["project"], st["model"]) if x)
    els = [_text(f"{where}（编号 {n}）"),
           _text(f"状态更新于 {time.strftime('%H:%M:%S', time.localtime(s['updated']))}")]
    if inbox.silent(s):
        mins = max(1, round((inbox.clock() - s["seen"]) / 60))
        els.append(_text(f"⚠️ 电脑 {mins} 分钟没有消息了，可能是公司网关要确认、电脑睡眠或断网、ferry 退出了。"))
    if note:
        els.append(_text(note))
    if st["last"] and st["last"]["cmd"] in remote.SENT and not note:
        els.append(_text(f"上一条手机消息（{remote.SENT[st['last']['cmd']]}）："
                         f"{remote.RESULT.get(st['last']['result'], st['last']['result'])}"))
    waits = inbox.waiting(s)
    if waits:
        els.append(_text("等你回答：\n" + "\n".join(remote.push_line(it)[1] for it in waits)))
    if st["goal"]:
        g = st["goal"]
        els.append(_text(f"目标：{remote.GOAL_TEXT.get(g['status'], g['status'])} · 第 {g['turns']} 轮\n{g['objective']}"))
    if st["todo"]:
        els.append(_text("待办：\n" + "\n".join(f"{remote.TODO_MARK.get(t['status'], '○')} {t['text']}" for t in st["todo"])))
    if st["steps"] or st["reply"]:
        els.append(_text("最近几步：\n" + "\n".join(st["steps"]) + (f"\n最新回复：{st['reply']}" if st["reply"] else "")))
    controls, sid = inbox.controls(s), s["id"]
    if "steer" in controls or "task" in controls:
        cmd = "steer" if "steer" in controls else "task"
        els.append({"tag": "form", "name": "f", "elements": [
            _input("text", "插话：agent 下一步就会看到" if cmd == "steer" else "派新活：写清楚要做什么"),
            _button("发送插话" if cmd == "steer" else "开始干", {"k": "c", "s": sid, "c": cmd}, "primary", "send")]})
    elif state == "idle":
        els.append(_text("电脑上关了从手机派活（remoteTasks），这里只能看。"))
    buttons = [_button(label, {"k": "c", "s": sid, "c": c}) for c, label in
               (("pause", "暂停目标"), ("resume", "继续目标")) if c in controls]
    els.append(_row(*buttons, _button("刷新", {"k": "r", "s": sid})))
    color = {"working": "blue", "waiting": "orange"}.get(state, "grey")
    return _card(f"Ferry {n} · {remote.STATE_TEXT[state]}", color, els)


def _raw(card: dict) -> dict:
    return {"type": "raw", "data": card}


def _toast(text: str, kind: str = "info") -> dict:
    return {"type": kind, "content": text}


# ---------- the bot ----------

class Bot:
    def __init__(self, cfg: Config, inbox: remote.Inbox, audit, transport=None, clock=time.time, pause=asyncio.sleep):
        self.cfg, self.inbox, self.audit, self.clock, self.pause = cfg, inbox, audit, clock, pause
        self.http = httpx.AsyncClient(timeout=10, **({"transport": transport} if transport else {}))
        self.base = (os.environ.get("FERRY_FEISHU_API") or API).rstrip("/")
        self.tok: tuple[str, float, tuple[str, str]] = ("", 0.0, ("", ""))
        self.seen: OrderedDict[str, float] = OrderedDict()  # event and message ids already handled
        self.cards: OrderedDict[str, str] = OrderedDict()   # item id -> its card's message id
        self.refs: OrderedDict[str, tuple[str, str]] = OrderedDict()  # message id -> ("s", session id) | ("i", item id)
        self.limit = remote.Limiter(20, 600, clock)        # commands per session
        self.wrong = 0                                      # wrong binding codes since the last code
        self.error = ""
        self.tasks: set[asyncio.Task] = set()
        inbox.watchers.append(self.watch)

    def on(self) -> bool:
        return ready(self.cfg)

    def user(self) -> str:
        """The Ferry user the owner acts for: the server's first one."""
        return settings(self.cfg)["user"] or next(iter(self.cfg.users.values()), "")

    def later(self, coro) -> None:
        t = asyncio.create_task(self._quietly(coro))
        self.tasks.add(t)
        t.add_done_callback(self.tasks.discard)

    async def _quietly(self, coro) -> None:
        try:
            await coro
        except Failed:
            pass  # api() logged it
        except Exception as e:  # a bug must not take the request or the server with it
            self.audit(event="feishu", step="error", error=type(e).__name__)

    @staticmethod
    def _keep(d: OrderedDict, k, v) -> None:
        d[k] = v
        while len(d) > KEEP:
            d.popitem(last=False)

    def dup(self, key: str) -> bool:
        if not key or key.endswith(":"):
            return False
        if key in self.seen:
            return True
        self.seen[key] = self.clock()
        while len(self.seen) > 4 * KEEP:
            self.seen.popitem(last=False)
        return False

    # ----- Feishu's API -----

    async def token(self, fresh: bool = False) -> str:
        s = settings(self.cfg)
        key = (s["app_id"], s["app_secret"])
        tok, exp, had = self.tok
        if tok and not fresh and had == key and self.clock() < exp - 300:
            return tok
        r = await self.http.post(f"{self.base}/open-apis/auth/v3/tenant_access_token/internal",
                                 json={"app_id": key[0], "app_secret": key[1]})
        b = _json(r)
        if r.status_code != 200 or b.get("code") != 0 or not b.get("tenant_access_token"):
            raise Failed(f"token: HTTP {r.status_code} code {b.get('code')}")
        self.tok = (str(b["tenant_access_token"]), self.clock() + int(b.get("expire") or 7200), key)
        return self.tok[0]

    async def api(self, method: str, url: str, body: dict, params: dict | None = None) -> dict:
        """One call, tried up to RETRIES times (network errors, 5xx, rate limits; a refused token is fetched again)."""
        fresh, last = False, ""
        for n in range(RETRIES):
            if n:
                await self.pause(BACKOFF_S * 2 ** (n - 1))
            try:
                tok = await self.token(fresh)
                r = await self.http.request(method, self.base + url, params=params, json=body,
                                            headers={"Authorization": f"Bearer {tok}"})
            except httpx.HTTPError as e:
                last = type(e).__name__
                continue
            except Failed as e:
                last = str(e)
                continue
            b = _json(r)
            if r.status_code == 200 and b.get("code") == 0:
                self.error = ""
                return b.get("data") or {}
            last = f"HTTP {r.status_code} code {b.get('code')}"
            if b.get("code") in TOKEN_CODES:
                fresh = True
            elif not (r.status_code == 429 or r.status_code >= 500 or b.get("code") in BUSY_CODES):
                break
        self.error = f"飞书接口出错：{last}"
        self.audit(event="feishu", step="api_error", call=f"{method} {re.sub(r'/om_[^/?]+', '/<id>', url)}", error=last)
        raise Failed(last)

    async def send(self, msg_type: str, content: dict, uuid: str = "") -> str:
        """A message to the owner; uuid makes Feishu send it once even when a try is repeated. Returns its id."""
        body = {"receive_id": settings(self.cfg)["owner"], "msg_type": msg_type,
                "content": json.dumps(content, ensure_ascii=False), "uuid": uuid or secrets.token_hex(16)}
        d = await self.api("POST", "/open-apis/im/v1/messages", body, {"receive_id_type": "open_id"})
        return str(d.get("message_id") or "")

    async def update(self, mid: str, card: dict) -> None:
        await self.api("PATCH", f"/open-apis/im/v1/messages/{mid}", {"content": json.dumps(card, ensure_ascii=False)})

    async def say(self, text: str, sid: str = "") -> str:
        mid = await self.send("text", {"text": text})
        if mid and sid:
            self._keep(self.refs, mid, ("s", sid))
        return mid

    # ----- out: the inbox's items and the other notifications -----

    def watch(self, what: str, it: dict) -> None:
        if not self.on() or it["user"] != self.user():
            return
        if what == "push":
            self.later(self.post_item(it))
        elif it["id"] in self.cards and not (it["state"] == "answered" and it["answer"]["via"] == "feishu"):
            self.later(self.update(self.cards[it["id"]], item_card(it)))

    async def post_item(self, it: dict) -> None:
        mid = await self.send("interactive", item_card(it), uuid=f"ferry-{it['id']}")
        if not mid:
            return
        self._keep(self.cards, it["id"], mid)
        self._keep(self.refs, mid, ("i", it["id"]))
        self.audit(event="feishu", step="card", user=it["user"], id=it["id"], kind=it["kind"])
        if it["state"] != "waiting":  # answered while the card was on its way
            await self.update(mid, item_card(it))

    def notice(self, title: str, body: str, kind: str, user: str, session: str) -> None:
        if user != self.user():
            return
        s = self.inbox.session(session, user) if session else None
        self.later(self.say(f"{title}\n{body}", s["id"] if s else ""))

    # ----- in: card buttons -----

    def sessions(self) -> list[dict]:
        self.inbox.purge()
        user = self.user()
        return [s for s in self.inbox.sessions.values() if s["user"] == user]

    def number(self, s: dict) -> int:
        return next((n for n, x in enumerate(self.sessions(), 1) if x is s), 0)

    def action(self, ev: dict) -> dict:
        """A card button: the answer to the callback, which also replaces the card (Feishu wants it within 3 s)."""
        act = ev.get("action") if isinstance(ev.get("action"), dict) else {}
        v = act.get("value") if isinstance(act.get("value"), dict) else {}
        form = act.get("form_value") if isinstance(act.get("form_value"), dict) else {}
        k, user = v.get("k"), self.user()
        if k in ("a", "b", "q", "qf"):
            it = self.inbox.get(str(v.get("i") or ""), user)
            if not it:
                return {"toast": _toast("这一项已经不在了（答过或过期了）。")}
            if it["state"] != "waiting" or k == "b":
                return {"card": _raw(item_card(it))}
            if k == "a":
                if v.get("a") == "once" and it["danger"] and not v.get("c"):
                    return {"card": _raw(item_card(it, confirm=True))}
                ans = {"action": v.get("a"), "note": str(form.get("note") or "")}
            elif k == "q":
                q, o = it["questions"][0], v.get("o")
                ans = {"answers": [q["options"][o]["label"] if isinstance(o, int) and 0 <= o < len(q["options"]) else ""]}
            else:
                ans = form_answers(it, form)
            err = self.inbox.answer(it, ans, "feishu")
            if err:
                return {"toast": _toast(ERRORS.get(err, err), "error"), "card": _raw(item_card(it, error=ERRORS.get(err, err)))}
            self.audit(event="remote", step="answered_on_feishu", user=user, id=it["id"], kind=it["kind"],
                       action=it["answer"].get("action", ""))
            return {"toast": _toast("已发给 agent", "success"), "card": _raw(item_card(it))}
        if k in ("c", "r"):
            s = self.inbox.session(str(v.get("s") or ""), user)
            if not s:
                return {"toast": _toast("这个 Ferry 已经退出，或者很久没有消息了。")}
            note = ""
            if k == "c":
                cmd = str(v.get("c") or "")
                err = self.command(s, cmd, str(form.get("text") or ""))
                if err:
                    return {"toast": _toast(err, "error"), "card": _raw(console_card(self.inbox, s, self.number(s)))}
                note = f"已发出{remote.SENT[cmd]}，电脑几秒内收到。刷新看结果。"
            return {"card": _raw(console_card(self.inbox, s, self.number(s), note))}
        return {}

    def command(self, s: dict, cmd: str, text: str) -> str:
        """Inbox.command() from here: "" or why not, in words."""
        if not self.limit.hit(s["id"]):
            return remote.REFUSED["too many"]
        err = self.inbox.command(s, cmd, text, "feishu")
        if err == "not now" and cmd == "task" and s["status"]["state"] == "idle" and not s["status"]["tasks"]:
            return "电脑上关了从手机派活（remoteTasks），没有发出。"
        if err:
            return remote.REFUSED.get(err, err)
        self.audit(event="remote", step="command", user=s["user"], session=s["id"], cmd=cmd, via="feishu")
        return ""

    # ----- in: the owner's text -----

    async def text(self, text: str, parent: str) -> None:
        t, user = text.strip(), self.user()
        low = t.lower()
        sessions = self.sessions()
        if low in ("状态", "status", "/status"):
            if not sessions:
                await self.say(NONE_OPEN)
            for n, s in enumerate(sessions, 1):
                mid = await self.send("interactive", console_card(self.inbox, s, n))
                if mid:
                    self._keep(self.refs, mid, ("s", s["id"]))
            return
        if low in ("帮助", "help", "/help", "?", "？"):
            await self.say(HELP)
            return
        target = None
        m = re.fullmatch(r"/s\s*(\d+)\s+(.+)", t, re.S)
        if m:
            n, t = int(m[1]), m[2].strip()
            if not 1 <= n <= len(sessions):
                await self.say(f"没有编号 {n} 的 Ferry。发“状态”看编号。")
                return
            target = sessions[n - 1]
        elif parent in self.refs:
            kind, ref = self.refs[parent]
            if kind == "i":
                await self.reply_item(ref, parent, t)
                return
            target = self.inbox.session(ref, user)
            if not target:
                await self.say("那个 Ferry 已经退出了，或者很久没有消息了。")
                return
        if target is None:
            working = [s for s in sessions if s["status"]["state"] == "working"]
            if not sessions:
                await self.say(NONE_OPEN)
                return
            if len(sessions) > 1 and len(working) != 1:
                await self.say(f"开着 {len(sessions)} 个 Ferry，不知道发给哪个。回复它的卡片或消息，或者写 /s 编号 内容（发“状态”看编号）。")
                return
            target = sessions[0] if len(sessions) == 1 else working[0]
        cmd = {"暂停": "pause", "pause": "pause", "继续": "resume", "resume": "resume"}.get(t.lower())
        cmd = cmd or ("steer" if target["status"]["state"] == "working" else "task")
        err = self.command(target, cmd, t)
        where = " · ".join(x for x in (target["device"], target["status"]["project"]) if x)
        await self.say(err or f"已发出{remote.SENT[cmd]}（{where}），电脑几秒内收到。", target["id"])

    async def reply_item(self, iid: str, mid: str, t: str) -> None:
        """A text reply to an approval card denies it with that note; to a one-question card, it is the answer."""
        it = self.inbox.get(iid, self.user())
        if not it or it["state"] != "waiting":
            await self.say("这一项已经处理过了。")
            return
        if it["kind"] == "approve":
            ans = {"action": "deny", "note": t}
        elif len(it["questions"]) == 1:
            ans = {"answers": [t]}
        else:
            await self.say("这几个问题要在卡片上答。")
            return
        err = self.inbox.answer(it, ans, "feishu")
        if err:
            await self.say(ERRORS.get(err, err))
            return
        self.audit(event="remote", step="answered_on_feishu", user=it["user"], id=it["id"], kind=it["kind"],
                   action=it["answer"].get("action", ""))
        await self.update(mid, item_card(it))
        await self.say("已拒绝，你写的话转给了 agent。" if it["kind"] == "approve" else "回答已经发给 agent。")

    # ----- in: binding -----

    def bind(self, open_id: str, text: str) -> bool:
        """The admin page's one-time code from someone: that someone becomes the owner."""
        s = settings(self.cfg)
        if not s["code"] or self.clock() > s["code_exp"]:
            return False
        if not hmac.compare_digest(text.strip().encode("utf-8"), s["code"].encode("utf-8")):
            self.wrong += 1
            if self.wrong >= CODE_TRIES:
                save(self.cfg, code="", code_exp=0)
            return False
        self.wrong = 0
        save(self.cfg, owner=open_id, user=next(iter(self.cfg.users.values()), ""), code="", code_exp=0)
        self.audit(event="feishu", step="bound")
        return True


def _json(r: httpx.Response) -> dict:
    try:
        b = r.json()
    except ValueError:
        return {}
    return b if isinstance(b, dict) else {}


def mount(app: FastAPI, cfg: Config, audit, transport=None, clock=time.time, pause=asyncio.sleep) -> Bot:
    """POST /feishu/event for Feishu's events and card callbacks; the bot hears the inbox and the notifications."""
    bot = Bot(cfg, app.state.inbox, audit, transport, clock, pause)
    notify.also(app, bot.on, bot.notice)
    strangers = remote.Limiter(60, 60, clock)

    @app.post("/feishu/event")
    async def event(request: Request):
        raw = await request.body()
        if len(raw) > BODY_BYTES:
            return JSONResponse({"error": "too large"}, 413)
        try:
            b = json.loads(raw or b"{}")
        except ValueError:
            b = None
        if not isinstance(b, dict):
            return JSONResponse({"error": "a JSON object is needed"}, 400)
        s = settings(cfg)
        if "encrypt" in b:
            bot.error = "飞书后台填了 Encrypt Key：Ferry 收不了加密的推送，到飞书后台把 Encrypt Key 清空"
            audit(event="feishu", step="encrypted")
            return JSONResponse({"error": "encrypted events are not supported: clear the Encrypt Key"}, 400)
        head = b.get("header") if isinstance(b.get("header"), dict) else {}
        token = str(head.get("token") or b.get("token") or "")
        if (not s["token"] or not hmac.compare_digest(token.encode("utf-8"), s["token"].encode("utf-8"))
                or (head.get("app_id") and s["app_id"] and head.get("app_id") != s["app_id"])):
            if strangers.hit("bad"):
                audit(event="feishu", step="bad_token")
            return JSONResponse({"error": "bad verification token"}, 401)
        if b.get("type") == "url_verification":
            return {"challenge": str(b.get("challenge") or "")}
        if not s["on"]:
            return {}
        ev = b.get("event") if isinstance(b.get("event"), dict) else {}
        kind, eid = head.get("event_type"), str(head.get("event_id") or "")
        if kind == "card.action.trigger":
            who = (ev.get("operator") or {}).get("open_id") if isinstance(ev.get("operator"), dict) else ""
            if bot.dup(f"e:{eid}"):
                return {}
            if not s["owner"] or who != s["owner"]:
                audit(event="feishu", step="ignored", why="card from someone else")
                return {}
            return bot.action(ev)
        if kind != "im.message.receive_v1":
            return {}
        msg = ev.get("message") if isinstance(ev.get("message"), dict) else {}
        sender = ev.get("sender") if isinstance(ev.get("sender"), dict) else {}
        who = (sender.get("sender_id") or {}).get("open_id", "") if isinstance(sender.get("sender_id"), dict) else ""
        if bot.dup(f"e:{eid}") | bot.dup(f"m:{msg.get('message_id') or ''}"):
            return {}
        if sender.get("sender_type") != "user" or msg.get("chat_type") != "p2p":
            return {}
        try:
            content = json.loads(msg.get("content") or "{}")
        except ValueError:
            content = {}
        text = str(content.get("text") or "") if msg.get("message_type") == "text" and isinstance(content, dict) else ""
        if text and who and bot.bind(who, text):
            bot.later(bot.say("绑定好了。以后 Ferry 的确认、提问和通知会发到这里。" + HELP))
            return {}
        if not s["owner"] or who != s["owner"]:
            audit(event="feishu", step="ignored", why="message from someone else")
            return {}
        if not text.strip():
            bot.later(bot.say("只认文字消息。" + HELP))
            return {}
        bot.later(bot.text(text, str(msg.get("parent_id") or msg.get("root_id") or "")))
        return {}

    app.state.feishu = bot
    return bot
