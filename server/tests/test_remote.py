import asyncio

from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from ferry_server import notify, remote
from ferry_server.config import Config
from ferry_server.remote import Inbox, Limiter, sign, verify


class Clock:
    def __init__(self):
        self.now = 1_000_000.0

    def __call__(self):
        return self.now


APPROVE = {"kind": "approve", "project": "specs", "tool": "bash", "target": "npm test", "always": "Always allow in this project: bash(npm test:*)"}
DANGER = {"kind": "approve", "project": "specs", "who": "#2 general (clean up)", "tool": "bash", "target": "rm -rf old",
          "danger": "deletes files Ferry did not make", "always": "Always allow ..."}
ASK = {"kind": "ask", "project": "specs", "questions": [{"question": "Which format?", "options": [{"label": "Word"}, {"label": "PPT"}],
                                                         "recommended": ["PPT"]}]}


def stack(monkeypatch, public_url="https://ferry.example.com"):
    cfg = Config(secret="s" * 32, bark_url="https://api.day.app/KEY", public_url=public_url)
    sent = []

    async def fake_send(c, title, body, kind="", link=""):
        sent.append({"title": title, "body": body, "kind": kind, "link": link})
        return True, ""

    monkeypatch.setattr(notify, "send", fake_send)
    app = FastAPI()
    rows = []

    @app.middleware("http")
    async def auth(request: Request, call_next):  # what app.py's guard sets for a device token
        request.state.user = request.headers.get("x-user", "wesley")
        request.state.device_name = "工作电脑"
        request.state.device_id = request.headers.get("x-device", "d1")
        return await call_next(request)

    clock = Clock()
    app.state.links = remote.mount(app, cfg, lambda **r: rows.append(r), clock)
    return TestClient(app), cfg, sent, clock, rows


def link_of(c, sent, body) -> tuple[str, str]:
    item_id = c.post("/v1/ferry/remote", json=body).json()["id"]
    assert c.post(f"/v1/ferry/remote/{item_id}/notify").json() == {"ok": True, "link": True}
    return item_id, sent[-1]["link"].removeprefix("https://ferry.example.com")


def test_token_sign_verify_expiry_and_tampering():
    cfg = Config(secret="s" * 32)
    t = sign(cfg, "abc123", "nonce", 2000)
    assert verify(cfg, t, 1999) == ("abc123", "nonce")
    assert verify(cfg, t, 2001) == "expired"
    assert verify(cfg, t.replace("abc123", "abc124"), 1999) == "bad"
    assert verify(cfg, t.replace(".2000.", ".9000."), 1999) == "bad"
    assert verify(Config(secret="t" * 32), t, 1999) == "bad", "another server's secret"
    assert verify(cfg, "a.b", 0) == "bad" and verify(cfg, "a.b.c.d", 0) == "bad" and verify(cfg, "é.b.1.d", 0) == "bad"


def test_register_wait_answer_and_cancel():
    async def run():
        inbox = Inbox()
        it = inbox.add("wesley", "pc", APPROVE)
        assert await inbox.wait(it, 0.01) == "waiting"
        later = asyncio.get_running_loop().call_later(0.02, lambda: inbox.answer(it, {"action": "once"}, "phone"))
        assert await inbox.wait(it, 5) == "answered"
        later.cancel()
        assert it["answer"] == {"action": "once", "note": "", "via": "phone"}
        assert inbox.answer(it, {"action": "deny"}, "phone") == "already handled"
        two = inbox.add("wesley", "pc", ASK)
        assert inbox.cancel(two) and two["state"] == "cancelled" and not inbox.cancel(two)
        assert inbox.answer(two, {"answers": ["Word"]}, "phone") == "already handled"
    asyncio.run(run())


def test_answers_follow_the_terminal_rules():
    inbox = Inbox()
    d = inbox.add("wesley", "pc", DANGER)
    assert d["always"] == "", "a dangerous step never offers always"
    assert inbox.answer(d, {"action": "always"}, "phone") == "this choice is not offered here"
    out = inbox.add("wesley", "pc", {**APPROVE, "outside": True})
    assert out["always"] == "" and inbox.answer(out, {"action": "always"}, "phone")
    assert inbox.answer(inbox.add("wesley", "pc", APPROVE), {"action": "maybe"}, "phone")
    q = inbox.add("wesley", "pc", ASK)
    assert inbox.answer(q, {"answers": [""]}, "phone") == "every question needs an answer"
    assert inbox.answer(q, {"answers": ["a", "b"]}, "phone")
    assert inbox.answer(q, {"answers": ["PPT"]}, "phone") == "" and q["answer"]["answers"] == ["PPT"]
    assert isinstance(inbox.add("wesley", "pc", {"kind": "run"}), str)
    assert isinstance(inbox.add("wesley", "pc", {"kind": "ask", "questions": []}), str)


def test_items_expire_and_waiters_hear_it():
    clock = Clock()
    inbox = Inbox(clock)
    it = inbox.add("wesley", "pc", APPROVE)
    clock.now += remote.ITEM_S + 1
    assert inbox.get(it["id"]) is None and it["state"] == "expired" and it["event"].is_set()


def test_client_api_is_per_user(monkeypatch):
    c, _, sent, _, _ = stack(monkeypatch)
    item_id = c.post("/v1/ferry/remote", json=APPROVE).json()["id"]
    assert c.get(f"/v1/ferry/remote/{item_id}?wait=0", headers={"x-user": "bob"}).status_code == 404
    assert c.post(f"/v1/ferry/remote/{item_id}/notify", headers={"x-user": "bob"}).status_code == 404
    c.delete(f"/v1/ferry/remote/{item_id}", headers={"x-user": "bob"})
    assert c.get(f"/v1/ferry/remote/{item_id}?wait=0").json() == {"state": "waiting"}
    c.delete(f"/v1/ferry/remote/{item_id}")
    assert c.get(f"/v1/ferry/remote/{item_id}?wait=0").status_code == 404
    assert c.post("/v1/ferry/remote", json={"kind": "approve"}).status_code == 400
    assert sent == []


def test_push_carries_one_line_and_the_link(monkeypatch):
    c, _, sent, _, _ = stack(monkeypatch)
    item_id, path = link_of(c, sent, DANGER)
    assert sent[0]["title"] == "Ferry · specs" and sent[0]["kind"] == "approval"
    assert sent[0]["body"] == "子 agent #2 general (clean up)等你批准 bash（有风险）：rm -rf old"
    assert path.startswith("/m/") and item_id in path
    c.post(f"/v1/ferry/remote/{item_id}/notify")
    assert len(sent) == 1, "one push per item"
    c2, _, sent2, _, _ = stack(monkeypatch, public_url="")
    i2 = c2.post("/v1/ferry/remote", json=ASK).json()["id"]
    assert c2.post(f"/v1/ferry/remote/{i2}/notify").json()["link"] is False
    assert sent2[0]["link"] == "" and sent2[0]["body"] == "主 agent问你：Which format?"


def test_page_shows_the_item_and_records_the_answer_once(monkeypatch):
    c, _, sent, _, rows = stack(monkeypatch)
    item_id, path = link_of(c, sent, APPROVE)
    page = c.get(path)
    assert page.status_code == 200 and "npm test" in page.text and "以后也允许" in page.text and "允许这一次" in page.text
    assert page.headers["cache-control"] == "no-store" and "default-src 'none'" in page.headers["content-security-policy"]
    assert "<script" not in page.text and "http" not in page.text.split("<body>")[1], "no scripts, no outside links"
    done = c.post(path, data={"action": "deny", "note": "use pytest instead"})
    assert "已处理" in done.text and "拒绝了" in done.text
    got = c.get(f"/v1/ferry/remote/{item_id}?wait=0").json()
    assert got == {"state": "answered", "answer": {"action": "deny", "note": "use pytest instead", "via": "phone"}}
    again = c.post(path, data={"action": "once"})
    assert "已处理" in again.text and c.get(f"/v1/ferry/remote/{item_id}?wait=0").json()["answer"]["action"] == "deny"
    assert "已处理" in c.get(path).text
    assert not any("pytest" in str(r) for r in rows), "the answer's text is not logged"


def test_no_always_button_where_the_terminal_has_none(monkeypatch):
    c, _, sent, _, _ = stack(monkeypatch)
    _, path = link_of(c, sent, {**APPROVE, "always": ""})
    assert "以后也允许" not in c.get(path).text
    assert "这里没有这个选项" in c.post(path, data={"action": "always"}).text


def test_a_dangerous_approval_needs_a_second_tap(monkeypatch):
    c, _, sent, _, _ = stack(monkeypatch)
    item_id, path = link_of(c, sent, DANGER)
    page = c.get(path).text
    assert "小心：deletes files Ferry did not make" in page and "以后也允许" not in page
    first = c.post(path, data={"action": "once"})
    assert "再点一次确认" in first.text
    assert c.get(f"/v1/ferry/remote/{item_id}?wait=0").json() == {"state": "waiting"}
    second = c.post(path, data={"action": "once", "confirm": "1"})
    assert "允许了这一次" in second.text
    assert c.get(f"/v1/ferry/remote/{item_id}?wait=0").json()["answer"]["action"] == "once"


def test_ask_page_options_and_free_text(monkeypatch):
    c, _, sent, _, _ = stack(monkeypatch)
    item_id, path = link_of(c, sent, ASK)
    page = c.get(path).text
    assert "Which format?" in page and page.index("PPT（推荐）") < page.index(">Word<"), "the recommendation first"
    assert "每个问题都要答" in c.post(path, data={"t0": "  "}).text
    c.post(path, data={"a0": "Word"})
    assert c.get(f"/v1/ferry/remote/{item_id}?wait=0").json()["answer"]["answers"] == ["Word"]
    multi = {"kind": "ask", "questions": [{"question": "Which?", "options": [{"label": "A"}, {"label": "B"}], "multiSelect": True},
                                          {"question": "When?", "options": [{"label": "Now"}, {"label": "Later"}]}]}
    i2, p2 = link_of(c, sent, multi)
    assert "type=checkbox" in c.get(p2).text
    c.post(p2, data={"a0": ["A", "B", "not an option"], "t0": "C", "t1": "tomorrow"})
    assert c.get(f"/v1/ferry/remote/{i2}?wait=0").json()["answer"]["answers"] == ["A; B; C", "tomorrow"]


def test_links_expire_are_single_item_and_bad_ones_are_refused(monkeypatch):
    c, cfg, sent, clock, _ = stack(monkeypatch)
    item_id, path = link_of(c, sent, APPROVE)
    other, _ = link_of(c, sent, ASK)
    forged = "/m/" + sign(cfg, other, "guess", int(clock.now + 60))
    assert c.get(forged).status_code == 403, "a link names one item and its nonce"
    assert c.get(path.replace(item_id, other)).status_code == 403
    clock.now += remote.LINK_S + 1
    assert c.get(path).status_code == 410
    assert c.post(path, data={"action": "once"}).status_code == 410
    assert c.get(f"/v1/ferry/remote/{item_id}?wait=0").json() == {"state": "waiting"}


def test_cancelled_here_shows_handled_on_the_phone(monkeypatch):
    c, _, sent, _, _ = stack(monkeypatch)
    item_id, path = link_of(c, sent, APPROVE)
    c.delete(f"/v1/ferry/remote/{item_id}")
    assert "已经在电脑上答了" in c.get(path).text
    assert "已经在电脑上答了" in c.post(path, data={"action": "once"}).text


def test_rate_limit(monkeypatch):
    c, _, sent, _, _ = stack(monkeypatch)
    for i in range(10):
        assert c.get(f"/m/x.y.1.bad{i}").status_code == 403
    assert c.get("/m/x.y.1.bad").status_code == 429, "too many bad links from one address"
    c2, _, sent2, clock, _ = stack(monkeypatch)
    _, path = link_of(c2, sent2, APPROVE)
    codes = [c2.get(path).status_code for _ in range(31)]
    assert codes[:30] == [200] * 30 and codes[30] == 429
    clock.now += 61
    assert c2.get(path).status_code == 200


def test_limiter_window():
    clock = Clock()
    lim = Limiter(2, 10, clock)
    assert lim.hit("a") and lim.hit("a") and not lim.hit("a") and lim.hit("b")
    clock.now += 11
    assert lim.hit("a")


def test_ready_needs_bark_and_a_public_address():
    assert remote.ready(Config(bark_url="https://api.day.app/K", public_url="https://f.example.com"))
    assert not remote.ready(Config(bark_url="https://api.day.app/K"))
    assert not remote.ready(Config(public_url="https://f.example.com"))


# ---------- the phone console ----------

SID = "0123456789abcdef"
WORKING = {"state": "working", "project": "specs", "model": "kiro/claude-opus-5.5", "tasks": True,
           "goal": {"objective": "Write the CR for 38.331", "status": "pursuing", "turns": 3},
           "todo": [{"status": "completed", "text": "read the spec"}, {"status": "in_progress", "text": "draft the change"},
                    {"status": "pending", "text": "check the revisions"}],
           "steps": ["bash (python build.py)", "read (CR.docx)"], "reply": "Drafting section 5.3.1 now."}
IDLE = {**WORKING, "state": "idle", "goal": None, "todo": [], "steps": [], "reply": "Done: the CR is saved."}


def console(monkeypatch, status=WORKING):
    c, cfg, sent, clock, rows = stack(monkeypatch)
    assert c.put(f"/v1/ferry/console/{SID}", json=status).json() == {"ok": True}
    got = c.post(f"/v1/ferry/console/{SID}/link", json={"push": True}).json()
    assert got["pushed"] and got["link"].startswith("https://ferry.example.com/m/c_" + SID)
    return c, cfg, sent, clock, rows, got["link"].removeprefix("https://ferry.example.com")


def test_console_page_shows_the_session(monkeypatch):
    c, _, sent, _, _, path = console(monkeypatch)
    assert sent[-1]["link"].endswith(path) and sent[-1]["title"] == "Ferry · specs"
    page = c.get(path)
    t = page.text
    assert page.status_code == 200 and "在干活" in t and "工作电脑 · specs · kiro/claude-opus-5.5" in t
    assert "Write the CR for 38.331" in t and "进行中" in t and "第 3 轮" in t
    assert "✓ read the spec" in t and "▶ draft the change" in t and "○ check the revisions" in t
    assert "bash (python build.py)" in t and "Drafting section 5.3.1 now." in t
    assert "发送插话" in t and "暂停目标" in t and "开始干" not in t and "继续目标" not in t
    assert page.headers["cache-control"] == "no-store" and "<script" not in t and "http" not in t.split("<body>")[1]


def test_controls_follow_the_state(monkeypatch):
    inbox = Inbox()
    s = inbox.report("wesley", "d1", "pc", SID, WORKING)
    assert inbox.controls(s) == ["steer", "pause"]
    s = inbox.report("wesley", "d1", "pc", SID, {**WORKING, "goal": {**WORKING["goal"], "status": "paused"}})
    assert inbox.controls(s) == ["steer", "resume"]
    s = inbox.report("wesley", "d1", "pc", SID, IDLE)
    assert inbox.controls(s) == ["task"]
    s = inbox.report("wesley", "d1", "pc", SID, {**IDLE, "tasks": False})
    assert inbox.controls(s) == []
    s = inbox.report("wesley", "d1", "pc", SID, {**IDLE, "goal": {"objective": "x", "status": "achieved", "turns": 9}})
    assert inbox.controls(s) == ["task"]
    assert inbox.command(s, "steer", "hi", "phone") == "not now" and inbox.command(s, "pause", "", "phone") == "not now"
    assert inbox.command(s, "task", "  ", "phone") == "empty"


def test_idle_page_offers_a_task_or_says_tasks_are_off(monkeypatch):
    c, _, _, _, _, path = console(monkeypatch, IDLE)
    t = c.get(path).text
    assert "空闲" in t and "开始干" in t and "发送插话" not in t and "暂停目标" not in t and "Done: the CR is saved." in t
    c.put(f"/v1/ferry/console/{SID}", json={**IDLE, "tasks": False})
    t = c.get(path).text
    assert "开始干" not in t and "remoteTasks" in t
    assert "现在不能这样做" in c.post(path, data={"cmd": "task", "text": "make slides"}).text
    assert c.get(f"/v1/ferry/console/{SID}/commands?wait=0").json() == {"commands": []}


def test_commands_queue_and_poll_and_are_audited_without_text(monkeypatch):
    c, _, _, _, rows, path = console(monkeypatch)
    r = c.post(path, data={"cmd": "steer", "text": "use the 2026-09 version"}, follow_redirects=False)
    assert r.status_code == 303 and r.headers["location"] == f"{path}?done=steer"
    assert "已发出插话" in c.get(r.headers["location"]).text
    c.post(path, data={"cmd": "pause"})
    got = c.get(f"/v1/ferry/console/{SID}/commands?wait=0").json()["commands"]
    assert [(x["cmd"], x["text"], x["via"]) for x in got] == [("steer", "use the 2026-09 version", "phone"), ("pause", "", "phone")]
    assert c.get(f"/v1/ferry/console/{SID}/commands?wait=0").json() == {"commands": []}, "taken once"
    assert [r["cmd"] for r in rows if r.get("step") == "command"] == ["steer", "pause"]
    assert not any("2026-09" in str(r) for r in rows), "the message's text is not logged"
    c.put(f"/v1/ferry/console/{SID}", json={**WORKING, "last": {"cmd": "steer", "result": "delivered"}})
    assert "插话已送到" in c.get(path).text


def test_a_waiting_poll_hears_a_command():
    async def run():
        inbox = Inbox()
        s = inbox.report("wesley", "d1", "pc", SID, WORKING)
        asyncio.get_running_loop().call_later(0.02, lambda: inbox.command(s, "steer", "now", "phone"))
        assert [x["text"] for x in await inbox.take(s, 5)] == ["now"]
        assert await inbox.take(s, 0.01) == []
    asyncio.run(run())


def test_commands_are_capped_and_go_stale():
    clock = Clock()
    inbox = Inbox(clock)
    s = inbox.report("wesley", "d1", "pc", SID, WORKING)
    for i in range(remote.MAX_COMMANDS):
        assert inbox.command(s, "steer", f"m{i}", "phone") == ""
    assert inbox.command(s, "steer", "one more", "phone") == "too many"
    clock.now += remote.COMMAND_S + 1
    assert inbox.command(s, "steer", "fresh", "phone") == ""
    assert [x["text"] for x in asyncio.run(inbox.take(s, 0))] == ["fresh"], "a command not taken in time is dropped"


def test_status_upload_is_capped_and_trimmed(monkeypatch):
    c, _, _, _, _, _ = console(monkeypatch)
    assert c.put(f"/v1/ferry/console/{SID}", content=b"{" + b" " * remote.STATUS_BYTES + b"}").status_code == 413
    s = Inbox().report("wesley", "d1", "pc", SID, {**WORKING, "steps": [f"s{i}" for i in range(30)], "reply": "x" * 5000,
                                                    "goal": {"objective": "o", "status": "pursuing", "turns": "lots"}})
    assert s["status"]["steps"] == [f"s{i}" for i in range(20, 30)] and len(s["status"]["reply"]) == 400
    assert s["status"]["goal"]["turns"] == 0
    odd = Inbox().report("wesley", "d1", "pc", SID, {"todo": {"a": 1}, "steps": "abc", "goal": "x", "last": [1]})["status"]
    assert odd["todo"] == [] and odd["steps"] == [] and odd["goal"] is None and odd["last"] is None
    assert c.put("/v1/ferry/console/NOT-HEX", json=WORKING).status_code == 400


def test_a_session_is_one_device_and_one_user(monkeypatch):
    c, _, _, _, _, path = console(monkeypatch)
    for h in ({"x-user": "bob"}, {"x-device": "d2"}):
        assert c.put(f"/v1/ferry/console/{SID}", json=IDLE, headers=h).status_code == 400
        assert c.get(f"/v1/ferry/console/{SID}/commands?wait=0", headers=h).status_code == 404
        assert c.post(f"/v1/ferry/console/{SID}/link", json={}, headers=h).status_code == 404
        c.delete(f"/v1/ferry/console/{SID}/link", headers=h)
        c.delete(f"/v1/ferry/console/{SID}", headers=h)
    assert c.get(path).status_code == 200 and "在干活" in c.get(path).text
    assert c.app.state.links("bob", SID) == "" and c.app.state.links("wesley", SID).startswith("https://ferry.example.com/m/c_")


def test_revoke_and_renew_console_links(monkeypatch):
    c, cfg, sent, clock, _, path = console(monkeypatch)
    page = c.get(path).text
    fresh = page.split("<a href='")[-1].split("'")[0]
    assert fresh.startswith("/m/c_")
    c.delete(f"/v1/ferry/console/{SID}/link")
    assert c.get(path).status_code == 403 and c.get(fresh).status_code == 403
    assert c.app.state.links("wesley", SID) == "", "pushes carry no console link while it is off"
    again = c.post(f"/v1/ferry/console/{SID}/link", json={}).json()
    assert again["link"] and not again["pushed"] and len(sent) == 1, "/phone without push only prints"
    assert c.get(again["link"].removeprefix("https://ferry.example.com")).status_code == 200
    assert c.get(path).status_code == 403, "an old link stays dead"

    def later(hours):
        for _ in range(hours * 2):  # the computer keeps reporting
            clock.now += 1800
            c.put(f"/v1/ferry/console/{SID}", json=WORKING)

    later(11)
    renewed = c.get(again["link"].removeprefix("https://ferry.example.com")).text.split("<a href='")[-1].split("'")[0]
    later(2)
    old = c.get(again["link"].removeprefix("https://ferry.example.com"))
    assert old.status_code == 410 and "/phone" in old.text
    assert c.get(renewed).status_code == 200, "opening the page renews the link"


def test_ended_or_silent_sessions_go(monkeypatch):
    c, _, _, clock, _, path = console(monkeypatch)
    clock.now += remote.STALE_S + 60
    assert "3 分钟没有消息" in c.get(path).text
    clock.now += remote.SESSION_S
    assert "控制台已关闭" in c.get(path).text
    assert c.get(f"/v1/ferry/console/{SID}/commands?wait=0").status_code == 404
    c.put(f"/v1/ferry/console/{SID}", json=WORKING)
    assert c.get(path).status_code == 403, "a session opened again has a new key"
    c.delete(f"/v1/ferry/console/{SID}")
    assert c.app.state.links("wesley", SID) == ""


def test_waiting_items_show_on_the_console_and_link_back(monkeypatch):
    c, _, sent, _, _, path = console(monkeypatch)
    item_id, item = link_of(c, sent, {**APPROVE, "session": SID})
    t = c.get(path).text
    assert "等你回答" in t and item in t, "the link already pushed keeps working"
    page = c.get(item).text
    assert "打开这个 Ferry 的控制台" in page and "/m/c_" + SID in page
    c.delete(f"/v1/ferry/remote/{item_id}")
    assert "在干活" in c.get(path).text
    other_id, other = link_of(c, sent, APPROVE)
    assert "控制台" not in c.get(other).text and other not in c.get(path).text
