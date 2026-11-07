import asyncio
import json
import time

import httpx
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from ferry_server import feishu, notify, remote
from ferry_server.config import Config


class Clock:
    def __init__(self):
        self.now = 1_000_000.0

    def __call__(self):
        return self.now


class FakeFeishu:
    """Feishu's open API as far as the bot uses it; fail lists answers to give before the real ones."""

    def __init__(self):
        self.calls, self.fail, self.n = [], [], 0

    def __call__(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content or b"{}")
        self.calls.append({"method": request.method, "path": request.url.path, "body": body,
                           "auth": request.headers.get("authorization", "")})
        if self.fail:
            status, code = self.fail.pop(0)
            return httpx.Response(status, json={"code": code, "msg": "x"})
        if request.url.path.endswith("/tenant_access_token/internal"):
            self.n += 1
            return httpx.Response(200, json={"code": 0, "msg": "ok", "tenant_access_token": f"t-{self.n}", "expire": 7200})
        if request.method == "POST" and request.url.path == "/open-apis/im/v1/messages":
            self.n += 1
            return httpx.Response(200, json={"code": 0, "data": {"message_id": f"om_{self.n}"}})
        return httpx.Response(200, json={"code": 0, "data": {}})

    def sent(self) -> list[dict]:
        return [c["body"] for c in self.calls if c["method"] == "POST" and c["path"] == "/open-apis/im/v1/messages"]

    def cards(self) -> list[dict]:
        return [json.loads(b["content"]) for b in self.sent() if b["msg_type"] == "interactive"]

    def texts(self) -> list[str]:
        return [json.loads(b["content"])["text"] for b in self.sent() if b["msg_type"] == "text"]

    def patches(self) -> list[tuple[str, dict]]:
        return [(c["path"].rsplit("/", 1)[1], json.loads(c["body"]["content"])) for c in self.calls if c["method"] == "PATCH"]

    def tokens(self) -> int:
        return sum(1 for c in self.calls if c["path"].endswith("/tenant_access_token/internal"))


APPROVE = {"kind": "approve", "project": "specs", "tool": "bash", "target": "npm test", "always": "Always allow in this project: bash(npm test:*)"}
DANGER = {"kind": "approve", "project": "specs", "tool": "bash", "target": "rm -rf old", "danger": "deletes files Ferry did not make"}
ASK = {"kind": "ask", "project": "specs", "questions": [{"question": "Which format?", "options": [{"label": "Word"}, {"label": "PPT"}],
                                                         "recommended": ["PPT"]}]}
WORKING = {"state": "working", "project": "specs", "model": "m1", "goal": {"objective": "finish the CR", "status": "pursuing", "turns": 3},
           "todo": [{"status": "in_progress", "text": "read the spec"}], "steps": ["bash (npm test)"]}


def stack(tmp_path, bound=True, on=True):
    cfg = Config(secret="s" * 32, data_dir=tmp_path, users={"tok": "wesley", "tok2": "bob"})
    feishu.save(cfg, on=on, app_id="cli_x", app_secret="sec", token="vt", owner="ou_owner" if bound else "")
    api, rows, waits = FakeFeishu(), [], []
    app = FastAPI()

    @app.middleware("http")
    async def auth(request: Request, call_next):  # what app.py's guard sets for a device token
        request.state.user = request.headers.get("x-user", "wesley")
        request.state.device_name = "工作电脑"
        request.state.device_id = "d1"
        return await call_next(request)

    async def pause(s):
        waits.append(s)

    clock = Clock()
    remote.mount(app, cfg, lambda **r: rows.append(r), clock)
    bot = feishu.mount(app, cfg, lambda **r: rows.append(r), httpx.MockTransport(api), clock, pause)
    return app, cfg, api, bot, clock, rows, waits


def until(cond, secs=3.0):
    end = time.time() + secs
    while time.time() < end:
        if cond():
            return True
        time.sleep(0.02)
    return False


def event(kind: str, ev: dict, eid: str = "", token: str = "vt") -> dict:
    return {"schema": "2.0", "header": {"event_id": eid or f"ev{time.time_ns()}", "token": token, "event_type": kind, "app_id": "cli_x"},
            "event": ev}


def text_event(text: str, who: str = "ou_owner", parent: str = "", mid: str = "", eid: str = "") -> dict:
    return event("im.message.receive_v1", {
        "sender": {"sender_id": {"open_id": who}, "sender_type": "user"},
        "message": {"message_id": mid or f"om_in{time.time_ns()}", "chat_type": "p2p", "message_type": "text",
                    "content": json.dumps({"text": text}), **({"parent_id": parent} if parent else {})}}, eid)


def click(value: dict, form: dict | None = None, who: str = "ou_owner", eid: str = "") -> dict:
    return event("card.action.trigger", {"operator": {"open_id": who},
                                         "action": {"tag": "button", "value": value, **({"form_value": form} if form else {})}}, eid)


def buttons(card) -> list[tuple[str, dict]]:
    out = []

    def walk(x):
        if isinstance(x, dict):
            if x.get("tag") == "button":
                out.append((x["text"]["content"], x["behaviors"][0]["value"]))
            for v in x.values():
                walk(v)
        elif isinstance(x, list):
            for v in x:
                walk(v)
    walk(card)
    return out


def words(card) -> str:
    return json.dumps(card, ensure_ascii=False)


def pushed(c, body) -> str:
    iid = c.post("/v1/ferry/remote", json=body).json()["id"]
    c.post(f"/v1/ferry/remote/{iid}/notify")
    return iid


def test_url_verification_token_and_encryption(tmp_path):
    app, cfg, api, bot, *_ = stack(tmp_path)
    with TestClient(app) as c:
        assert c.post("/feishu/event", json={"type": "url_verification", "challenge": "c-1", "token": "vt"}).json() == {"challenge": "c-1"}
        assert c.post("/feishu/event", json={"type": "url_verification", "challenge": "c-1", "token": "nope"}).status_code == 401
        assert c.post("/feishu/event", json=text_event("状态", eid="e1") | {"header": {"token": "nope", "event_type": "im.message.receive_v1"}}).status_code == 401
        other_app = event("im.message.receive_v1", {}, token="vt")
        other_app["header"]["app_id"] = "cli_other"
        assert c.post("/feishu/event", json=other_app).status_code == 401
        r = c.post("/feishu/event", json={"encrypt": "abc"})
        assert r.status_code == 400 and "Encrypt Key" in bot.error
        assert c.post("/feishu/event", content=b"not json").status_code == 400
        assert feishu.status(cfg, bot)["error"] and not api.calls


def test_token_is_cached_refreshed_and_retried(tmp_path):
    app, cfg, api, bot, clock, rows, waits = stack(tmp_path)

    async def run():
        assert await bot.say("a") == "om_2" and await bot.say("b")
        assert api.tokens() == 1, "the tenant token is reused"
        clock.now += 7200
        await bot.say("c")
        assert api.tokens() == 2, "an old token is fetched again"
        api.fail = [(200, 99991663)]  # Feishu says the token is invalid
        await bot.say("d")
        assert api.tokens() == 3 and api.texts()[-1] == "d"
        api.fail = [(500, None), (429, 99991400)]
        await bot.say("e")
        assert api.texts()[-1] == "e" and waits[-2:] == [0.5, 1.0], "backs off between tries"
        uuids = [b["uuid"] for b in api.sent()]
        assert len(set(uuids)) == 5
        api.fail = [(400, 230001)]  # a request Feishu refuses: no point trying again
        try:
            await bot.say("f")
            raise AssertionError("should fail")
        except feishu.Failed:
            pass
        assert "230001" in bot.error and rows[-1]["step"] == "api_error" and "f" not in json.dumps(rows[-1]).replace("feishu", "")
    asyncio.run(run())


def test_binding_and_strangers(tmp_path):
    app, cfg, api, bot, clock, rows, _ = stack(tmp_path, bound=False)
    with TestClient(app) as c:
        assert c.post("/feishu/event", json=text_event("状态", who="ou_someone")).json() == {}
        assert not api.calls and rows[-1] == {"event": "feishu", "step": "ignored", "why": "message from someone else"}
        code = feishu.new_code(cfg, clock)
        assert feishu.status(cfg, bot, clock)["code"] == code
        c.post("/feishu/event", json=text_event("000000" if code != "000000" else "111111", who="ou_me"))
        assert not feishu.settings(cfg)["owner"]
        c.post("/feishu/event", json=text_event(code, who="ou_me"))
        assert feishu.settings(cfg)["owner"] == "ou_me" and feishu.settings(cfg)["user"] == "wesley"
        assert until(lambda: api.texts() and "绑定好了" in api.texts()[0])
        assert api.sent()[0]["receive_id"] == "ou_me" and not feishu.settings(cfg)["code"]
        c.post("/feishu/event", json=text_event(code, who="ou_someone"))
        assert feishu.settings(cfg)["owner"] == "ou_me", "a code works once"
        code = feishu.new_code(cfg, clock)
        clock.now += feishu.CODE_S + 1
        c.post("/feishu/event", json=text_event(code, who="ou_someone"))
        assert feishu.settings(cfg)["owner"] == "ou_me", "an old code does nothing"
        it = c.post("/v1/ferry/remote", json=APPROVE).json()["id"]
        r = c.post("/feishu/event", json=click({"k": "a", "i": it, "a": "once"}, who="ou_someone")).json()
        assert r == {} and c.get(f"/v1/ferry/remote/{it}?wait=0").json() == {"state": "waiting"}
        assert "npm test" not in json.dumps(rows, ensure_ascii=False), "nothing of the content in the log"


def test_approval_card_sent_answered_and_confirmed(tmp_path):
    app, cfg, api, bot, clock, rows, _ = stack(tmp_path)
    with TestClient(app) as c:
        it = pushed(c, APPROVE)
        assert until(lambda: api.cards())
        card = api.cards()[0]
        assert "npm test" in words(card) and "等你批准 · specs" in words(card)
        assert [b[0] for b in buttons(card)] == ["允许这一次", "以后也允许", "拒绝"]
        assert api.sent()[0]["uuid"] == f"ferry-{it}", "a repeated try does not send a second card"
        r = c.post("/feishu/event", json=click({"k": "a", "i": it, "a": "deny"}, {"note": "run the unit tests only"})).json()
        assert r["toast"]["type"] == "success" and "拒绝了：run the unit tests only" in words(r["card"]) and "在飞书上答的" in words(r["card"])
        assert c.get(f"/v1/ferry/remote/{it}?wait=0").json() == {"state": "answered", "answer": {
            "action": "deny", "note": "run the unit tests only", "via": "feishu"}}
        assert not api.patches(), "the callback's answer already replaced the card"
        again = c.post("/feishu/event", json=click({"k": "a", "i": it, "a": "once"})).json()
        assert "已处理" in words(again["card"])

        d = pushed(c, DANGER)
        assert until(lambda: len(api.cards()) == 2)
        assert [b[0] for b in buttons(api.cards()[1])] == ["允许这一次", "拒绝"], "no always for a dangerous step"
        first = c.post("/feishu/event", json=click({"k": "a", "i": d, "a": "once"})).json()
        assert "再点一次确认" in words(first["card"]) and c.get(f"/v1/ferry/remote/{d}?wait=0").json() == {"state": "waiting"}
        back = c.post("/feishu/event", json=click({"k": "b", "i": d})).json()
        assert "允许这一次" in words(back["card"])
        ok = c.post("/feishu/event", json=click({"k": "a", "i": d, "a": "once", "c": 1})).json()
        assert "允许了这一次" in words(ok["card"]) and c.get(f"/v1/ferry/remote/{d}?wait=0").json()["answer"]["action"] == "once"
        bad = pushed(c, DANGER)
        r = c.post("/feishu/event", json=click({"k": "a", "i": bad, "a": "always"})).json()
        assert r["toast"]["type"] == "error" and "这里没有这个选项" in r["toast"]["content"]
        assert any(x.get("step") == "answered_on_feishu" for x in rows)


def test_card_updated_after_an_answer_elsewhere(tmp_path):
    app, cfg, api, bot, clock, rows, _ = stack(tmp_path)
    with TestClient(app) as c:
        a = pushed(c, APPROVE)
        b = pushed(c, ASK)
        assert until(lambda: len(api.cards()) == 2)
        c.portal.call(lambda: bot.inbox.answer(bot.inbox.get(a), {"action": "once"}, "phone"))
        c.delete(f"/v1/ferry/remote/{b}")
        assert until(lambda: len(api.patches()) == 2)
        got = dict(api.patches())
        assert "在手机页面上答的" in words(got[bot.cards[a]]) and "允许了这一次" in words(got[bot.cards[a]])
        assert "在电脑上答的" in words(got[bot.cards[b]])
        c.post("/v1/ferry/remote", json=APPROVE, headers={"x-user": "bob"})
        assert not until(lambda: len(api.sent()) > 2, 0.3), "another user's items are not the owner's"


def test_question_card_buttons_and_form(tmp_path):
    app, cfg, api, bot, *_ = stack(tmp_path)
    with TestClient(app) as c:
        q = pushed(c, ASK)
        assert until(lambda: api.cards())
        assert [b[0] for b in buttons(api.cards()[0])] == ["PPT（推荐）", "Word", "发送我写的"]
        r = c.post("/feishu/event", json=click({"k": "q", "i": q, "o": 0})).json()
        assert "回答：Word" in words(r["card"]) and c.get(f"/v1/ferry/remote/{q}?wait=0").json()["answer"]["answers"] == ["Word"]
        two = {"kind": "ask", "questions": [
            {"question": "Which parts?", "multiSelect": True, "options": [{"label": "A"}, {"label": "B"}, {"label": "C"}]},
            {"question": "Format?", "options": [{"label": "Word"}, {"label": "PPT"}]}]}
        t = pushed(c, two)
        assert until(lambda: len(api.cards()) == 2)
        card = words(api.cards()[1])
        assert "multi_select_static" in card and "select_static" in card
        r = c.post("/feishu/event", json=click({"k": "qf", "i": t}, {"a0": ["0", "2"], "t0": "and D", "a1": "", "t1": ""})).json()
        assert r["toast"]["type"] == "error", "every question needs an answer"
        r = c.post("/feishu/event", json=click({"k": "qf", "i": t}, {"a0": ["0", "2"], "t0": "and D", "a1": "1"})).json()
        assert c.get(f"/v1/ferry/remote/{t}?wait=0").json()["answer"]["answers"] == ["A; C; and D", "PPT"]


def test_text_steers_a_working_session_and_tasks_an_idle_one(tmp_path):
    app, cfg, api, bot, clock, rows, _ = stack(tmp_path)
    with TestClient(app) as c:
        c.post("/feishu/event", json=text_event("use short names"))
        assert until(lambda: api.texts() and "没有开着的 Ferry" in api.texts()[-1])
        c.put("/v1/ferry/console/aaaa1111", json=WORKING)
        c.post("/feishu/event", json=text_event("use short names", eid="same"))
        c.post("/feishu/event", json=text_event("use short names", eid="same"))  # Feishu sends an event again
        assert until(lambda: len(api.texts()) == 2)
        got = c.get("/v1/ferry/console/aaaa1111/commands?wait=0").json()["commands"]
        assert [(x["cmd"], x["text"], x["via"]) for x in got] == [("steer", "use short names", "feishu")], "once, not twice"
        assert "已发出插话" in api.texts()[-1]
        c.put("/v1/ferry/console/aaaa1111", json={**WORKING, "state": "idle"})
        c.post("/feishu/event", json=text_event("write the summary"))
        assert until(lambda: len(api.texts()) == 3) and "已发出新活" in api.texts()[-1]
        assert [x["cmd"] for x in c.get("/v1/ferry/console/aaaa1111/commands?wait=0").json()["commands"]] == ["task"]
        c.put("/v1/ferry/console/aaaa1111", json={**WORKING, "state": "idle", "tasks": False})
        c.post("/feishu/event", json=text_event("another"))
        assert until(lambda: len(api.texts()) == 4) and "remoteTasks" in api.texts()[-1]
        c.post("/feishu/event", json=text_event("暂停"))
        assert until(lambda: len(api.texts()) == 5) and "已发出暂停目标" in api.texts()[-1]


def test_several_sessions_status_cards_and_picking_one(tmp_path):
    app, cfg, api, bot, clock, rows, _ = stack(tmp_path)
    with TestClient(app) as c:
        c.put("/v1/ferry/console/aaaa1111", json={**WORKING, "state": "idle"})
        c.put("/v1/ferry/console/bbbb2222", json={**WORKING, "state": "idle", "project": "docs", "goal": None})
        c.post("/feishu/event", json=text_event("hello"))
        assert until(lambda: api.texts() and "开着 2 个 Ferry" in api.texts()[-1])
        c.post("/feishu/event", json=text_event("状态"))
        assert until(lambda: len(api.cards()) == 2)
        one, two = api.cards()
        assert "Ferry 1 · 空闲，可以派新活" in words(one) and "finish the CR" in words(one) and "read the spec" in words(one)
        assert "docs" in words(two) and [b[0] for b in buttons(one)] == ["开始干", "暂停目标", "刷新"]
        c.post("/feishu/event", json=text_event("/s 2 check the docs"))
        assert until(lambda: "已发出新活" in (api.texts() or [""])[-1])
        assert c.get("/v1/ferry/console/bbbb2222/commands?wait=0").json()["commands"][0]["text"] == "check the docs"
        first_card = [mid for mid, ref in bot.refs.items() if ref == ("s", "aaaa1111")][0]
        c.post("/feishu/event", json=text_event("from the reply", parent=first_card))
        assert until(lambda: len(api.texts()) == 3)
        assert c.get("/v1/ferry/console/aaaa1111/commands?wait=0").json()["commands"][0]["text"] == "from the reply"
        c.post("/feishu/event", json=text_event("/s 9 nothing"))
        assert until(lambda: "没有编号 9" in api.texts()[-1])
        # buttons on the console card
        r = c.post("/feishu/event", json=click({"k": "c", "s": "aaaa1111", "c": "pause"})).json()
        assert "已发出暂停目标" in words(r["card"])
        r = c.post("/feishu/event", json=click({"k": "c", "s": "aaaa1111", "c": "steer"}, {"text": "x"})).json()
        assert r["toast"]["type"] == "error", "no steer while it is idle"
        r = c.post("/feishu/event", json=click({"k": "r", "s": "aaaa1111"})).json()
        assert "Ferry 1" in r["card"]["data"]["header"]["title"]["content"]
        r = c.post("/feishu/event", json=click({"k": "r", "s": "ffff0000"})).json()
        assert "已经退出" in r["toast"]["content"]


def test_reply_to_an_item_card(tmp_path):
    app, cfg, api, bot, *_ = stack(tmp_path)
    with TestClient(app) as c:
        it = pushed(c, APPROVE)
        assert until(lambda: bot.cards.get(it))
        c.post("/feishu/event", json=text_event("use pytest instead", parent=bot.cards[it]))
        assert until(lambda: api.patches())
        assert c.get(f"/v1/ferry/remote/{it}?wait=0").json()["answer"] == {"action": "deny", "note": "use pytest instead", "via": "feishu"}
        assert "已拒绝" in api.texts()[-1] or until(lambda: "已拒绝" in api.texts()[-1])


def test_notifications_go_to_feishu_too(tmp_path):
    app, cfg, api, bot, *_ = stack(tmp_path)
    with TestClient(app) as c:
        c.put("/v1/ferry/console/aaaa1111", json=WORKING)

        async def run():
            ok, err = await notify.everywhere(app, cfg, "Ferry · specs", "Goal achieved", "goal", user="wesley", session="aaaa1111")
            assert not ok and "Bark" in err, "Bark is not set; Feishu still gets it"
            await notify.everywhere(app, cfg, "Ferry", "for bob", user="bob")
        c.portal.call(run)
        assert until(lambda: api.texts() == ["Ferry · specs\nGoal achieved"])
        mid = [m for m, ref in bot.refs.items() if ref == ("s", "aaaa1111")]
        assert mid, "a reply to the notice goes to its session"
        assert notify.ready(app, cfg) and feishu.ready(cfg)
        feishu.apply(cfg, {"feishu_on": False})
        assert not notify.ready(app, cfg) and not feishu.ready(cfg)
        assert c.post("/feishu/event", json=text_event("状态")).json() == {}
        assert not until(lambda: len(api.sent()) > 1, 0.3), "switched off: nothing goes out"


def test_admin_settings_status_never_show_secrets(tmp_path):
    cfg = Config(secret="s" * 32, data_dir=tmp_path, public_url="https://f.example.com", users={"t": "local"})
    feishu.apply(cfg, {"feishu_app_id": " cli_a ", "feishu_app_secret": "SECRET1", "feishu_token": "TOKEN1", "feishu_on": True})
    st = feishu.status(cfg, None)
    assert st["url"] == "https://f.example.com/feishu/event" and st["app_id"] == "cli_a" and st["secret"] and st["token"]
    assert "SECRET1" not in json.dumps(st) and "TOKEN1" not in json.dumps(st) and not st["ready"] and not st["bound"]
    feishu.save(cfg, owner="ou_1", user="local")
    assert feishu.ready(cfg)
    feishu.apply(cfg, {"feishu_unbind": True})
    assert not feishu.ready(cfg) and not feishu.settings(cfg)["owner"]
    assert oct(feishu.path(cfg).stat().st_mode & 0o777) in ("0o600", "0o666")  # 0o666 on Windows
