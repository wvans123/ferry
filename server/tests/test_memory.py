import asyncio

import httpx

from ferry_server.app import create_app
from ferry_server.config import load_default

ADMIN = {"X-Ferry-Admin": "1"}
M = {"X-Ferry-M": "1"}


def make(tmp_path, monkeypatch):
    for k in ("ANTHROPIC_API_KEY", "OPENAI_API_KEY", "FERRY_SESSION_STORE", "FERRY_TOKEN", "FERRY_SECRET"):
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
