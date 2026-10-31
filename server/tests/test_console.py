import asyncio

import httpx

from ferry_server.app import create_app
from ferry_server.config import load_default

ADMIN = {"X-Ferry-Admin": "1"}
M = {"X-Ferry-M": "1"}


def make(tmp_path, monkeypatch):
    for k in ("ANTHROPIC_API_KEY", "OPENAI_API_KEY", "FERRY_SESSION_STORE", "FERRY_REDACT", "FERRY_TOKEN", "FERRY_SECRET"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("DEEPSEEK_API_KEY", "d")
    monkeypatch.setenv("FERRY_SERVER_HOME", str(tmp_path))
    cfg = load_default()
    return cfg, create_app(cfg)


def client(app, host="127.0.0.1"):
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app, client=(host, 5555)), base_url="http://127.0.0.1:8787")


def test_global_memory_is_shared_by_devices_and_off_by_default(tmp_path, monkeypatch):
    cfg, app = make(tmp_path, monkeypatch)
    key = (tmp_path / "admin-key").read_text().strip()
    main = {"Authorization": f"Bearer {next(iter(cfg.users))}"}

    async def go():
        async with client(app) as c:
            assert (await c.get("/v1/ferry/memory", headers=main)).json() == {"enabled": False, "index": ""}
            assert (await c.put("/v1/ferry/memory/x", json={"content": "y"}, headers=main)).status_code == 403
            c.cookies.set("ferry_admin", key)
            assert (await c.put("/admin/api/remote", json={"shared_memory": True}, headers=ADMIN)).json()["shared_memory"]
            other = {"Authorization": "Bearer " + (await c.post("/admin/api/devices", json={"name": "laptop"},
                                                                 headers=ADMIN)).json()["token"]}
            r = await c.put("/v1/ferry/memory/Prefers Chinese", headers=main,
                            json={"description": "replies in Chinese", "content": "Answer in Chinese."})
            assert r.json() == {"ok": True, "name": "prefers-chinese"}
            # the other computer sees it
            idx = (await c.get("/v1/ferry/memory", headers=other)).json()
            assert idx["enabled"] and "- [prefers-chinese](prefers-chinese.md): replies in Chinese" in idx["index"]
            assert (await c.get("/v1/ferry/memory/prefers-chinese", headers=other)).json()["content"].strip() == "Answer in Chinese."
            assert (await c.put("/v1/ferry/memory/big", json={"content": "x" * 20000}, headers=main)).status_code == 400
            assert len((await c.get("/admin/api/memory")).json()["items"]) == 1
            assert (await c.delete("/v1/ferry/memory/prefers-chinese", headers=other)).json()["existed"]
            assert (await c.get("/v1/ferry/memory", headers=main)).json()["index"] == ""

    asyncio.run(go())


def test_phone_console(tmp_path, monkeypatch):
    cfg, app = make(tmp_path, monkeypatch)
    key = (tmp_path / "admin-key").read_text().strip()
    tok = {"Authorization": f"Bearer {next(iter(cfg.users))}"}

    async def go():
        async with client(app, host="203.0.113.7") as phone, client(app) as c:
            # off: no page, reports are not kept
            assert (await phone.get("/m")).status_code == 404
            assert (await c.post("/v1/ferry/status", json={"instance": "a"}, headers=tok)).json() == {"console": False, "every": 300}
            c.cookies.set("ferry_admin", key)
            assert (await c.put("/admin/api/remote", json={"console": True}, headers=ADMIN)).status_code == 400  # no password yet
            assert (await c.put("/admin/api/remote", json={"password": "short"}, headers=ADMIN)).status_code == 400
            st = (await c.put("/admin/api/remote", json={"console": True, "password": "correct horse"}, headers=ADMIN)).json()
            assert st["console"] and st["console_password"]
            assert "correct horse" not in (tmp_path / "server.toml").read_text()

            # the phone signs in (from anywhere, unlike the admin page)
            assert (await phone.get("/m")).status_code == 200
            assert (await phone.get("/m/api/state")).status_code == 401
            assert (await phone.post("/m/login", json={"password": "correct horse"})).status_code == 400  # no header
            assert (await phone.post("/m/login", json={"password": "wrong"}, headers=M)).status_code == 401
            r = await phone.post("/m/login", json={"password": "correct horse"}, headers=M)
            assert r.status_code == 200 and "httponly" in r.headers["set-cookie"].lower()
            assert (await phone.get("/m/api/state")).json()["clients"] == []

            # a ferry reports: working, then waiting for approval
            rep = {"instance": "w1", "project": "demo", "title": "fix bug", "state": "working", "tool": "bash", "detail": "npm test"}
            assert (await c.post("/v1/ferry/status", json=rep, headers=tok)).json() == {"console": True, "every": 3, "commands": []}
            s = (await phone.get("/m/api/state")).json()["clients"]
            assert len(s) == 1 and s[0]["device"] == "主令牌" and s[0]["online"] and s[0]["tool"] == "bash"
            cid = s[0]["id"]
            pend = {**rep, "state": "asking", "pending": {"id": "p1", "tool": "bash", "detail": "rm -rf build"}}
            await c.post("/v1/ferry/status", json=pend, headers=tok)
            # approving needs the computer's own consent
            r = (await phone.post("/m/api/act", json={"id": cid, "action": "approve", "approval": "p1"}, headers=M)).json()
            assert not r["ok"] and "remoteApprove" in r["error"]
            await c.post("/v1/ferry/status", json={**pend, "remote_approve": True}, headers=tok)
            assert (await phone.post("/m/api/act", json={"id": cid, "action": "approve", "approval": "zz"}, headers=M)).json()["ok"] is False
            assert (await phone.post("/m/api/act", json={"id": cid, "action": "approve", "approval": "p1"}, headers=M)).json()["ok"]
            got = (await c.post("/v1/ferry/status", json={**pend, "remote_approve": True}, headers=tok)).json()["commands"]
            assert [x["action"] for x in got] == ["approve"] and got[0]["approval"] == "p1"
            # once the computer says it is done with a command, it is not sent again
            again = (await c.post("/v1/ferry/status", json={**rep, "done": [got[0]["id"]]}, headers=tok)).json()["commands"]
            assert again == []
            # dangerous actions are never approved from the phone
            await c.post("/v1/ferry/status", json={**pend, "remote_approve": True,
                                                   "pending": {"id": "p2", "tool": "bash", "detail": "x", "danger": "deletes"}}, headers=tok)
            r = (await phone.post("/m/api/act", json={"id": cid, "action": "approve", "approval": "p2"}, headers=M)).json()
            assert not r["ok"]
            assert (await phone.post("/m/api/act", json={"id": cid, "action": "stop"}, headers=M)).json()["ok"]
            assert (await phone.post("/m/api/act", json={"id": cid, "action": "stop"})).status_code == 400  # header needed
            # a new password signs the phone out
            await c.put("/admin/api/remote", json={"password": "another one!"}, headers=ADMIN)
            assert (await phone.get("/m/api/state")).status_code == 401
            # too many wrong guesses
            for _ in range(5):
                await phone.post("/m/login", json={"password": "nope"}, headers=M)
            assert (await phone.post("/m/login", json={"password": "another one!"}, headers=M)).status_code == 429

    asyncio.run(go())
