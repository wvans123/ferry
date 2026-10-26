import asyncio

import httpx

from ferry_server.app import create_app
from ferry_server.config import load_default


def make(tmp_path, monkeypatch):
    for k in ("ANTHROPIC_API_KEY", "OPENAI_API_KEY", "FERRY_SESSION_STORE", "FERRY_REDACT", "FERRY_TOKEN", "FERRY_SECRET"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("DEEPSEEK_API_KEY", "d")
    monkeypatch.setenv("FERRY_SERVER_HOME", str(tmp_path))
    cfg = load_default()
    return cfg, create_app(cfg)


def run(coro):
    return asyncio.run(coro)


def client(app, host="127.0.0.1"):
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app, client=(host, 5555)), base_url="http://127.0.0.1:8787")


def test_admin_is_local_and_keyed(tmp_path, monkeypatch):
    cfg, app = make(tmp_path, monkeypatch)
    key = (tmp_path / "admin-key").read_text().strip()

    async def go():
        async with client(app) as c:
            assert (await c.get("/admin")).status_code == 403                      # no key yet
            assert (await c.get("/admin?key=wrong")).status_code == 403
            r = await c.get(f"/admin?key={key}")
            assert r.status_code == 303 and "ferry_admin" in r.headers["set-cookie"]
            c.cookies.set("ferry_admin", key)
            assert (await c.get("/admin")).status_code == 200
            st = (await c.get("/admin/api/status")).json()
            assert st["models"][0]["id"] == "deepseek" and st["token"]
            # changing needs the header a foreign page cannot send
            assert (await c.put("/admin/api/settings", json={"redact": False})).status_code == 403
            r = await c.put("/admin/api/settings", json={"redact": False, "public_url": "https://f.example.com/",
                                                         "session_store": "disk"}, headers={"X-Ferry-Admin": "1"})
            assert r.status_code == 200 and r.json()["redact"] is False and r.json()["public_url"] == "https://f.example.com"
            assert cfg.session_store == "disk" and "session_store = \"disk\"" in (tmp_path / "server.toml").read_text()
            # through a tunnel the request also comes from 127.0.0.1 but carries Cloudflare headers
            assert (await c.get("/admin/api/status", headers={"cf-connecting-ip": "1.2.3.4"})).status_code == 403
            # a broken models.toml is refused and the old one kept
            bad = await c.put("/admin/api/models", json={"text": "[models.x]\nnope"}, headers={"X-Ferry-Admin": "1"})
            assert bad.status_code == 400 and list(cfg.models) == ["deepseek"]
            good = (tmp_path / "models.toml").read_text().replace('default = "deepseek"', 'default = "deepseek"\n')
            assert (await c.put("/admin/api/models", json={"text": good}, headers={"X-Ferry-Admin": "1"})).status_code == 200
            t = (await c.get("/admin/api/traffic?minutes=60")).json()
            assert len(t["series"]) == 61 and t["totals"]["chats"] == 0
        async with client(app, host="10.0.0.5") as other:
            other.cookies.set("ferry_admin", key)
            assert (await other.get("/admin/api/status")).status_code == 403     # not this computer

    run(go())
    # settings survive a restart
    cfg2 = load_default()
    assert cfg2.redact is False and cfg2.public_url == "https://f.example.com" and cfg2.session_store == "disk"
