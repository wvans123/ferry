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
        return await call_next(request)

    clock = Clock()
    remote.mount(app, cfg, lambda **r: rows.append(r), clock)
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
