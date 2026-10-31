import asyncio
import json

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


def client(app, host="127.0.0.1"):
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app, client=(host, 5555)), base_url="http://127.0.0.1:8787")


ADMIN = {"X-Ferry-Admin": "1"}


def test_each_device_has_its_own_token(tmp_path, monkeypatch):
    cfg, app = make(tmp_path, monkeypatch)
    key = (tmp_path / "admin-key").read_text().strip()
    main = next(iter(cfg.users))

    async def go():
        async with client(app) as c:
            c.cookies.set("ferry_admin", key)
            r = (await c.post("/admin/api/devices", json={"name": "家里的笔记本"}, headers=ADMIN)).json()
            laptop, tok = r["id"], r["token"]
            assert tok.startswith("fd_") and r["login"].endswith(tok) and r["user"] == "local"
            r2 = (await c.post("/admin/api/devices", json={"name": "work pc"}, headers=ADMIN)).json()
            # the token is stored only as a hash
            stored = (tmp_path / "devices.json").read_text()
            assert tok not in stored and "家里的笔记本" in stored

            api = lambda t: {"Authorization": f"Bearer {t}"}  # noqa: E731
            assert (await c.get("/v1/ferry/models", headers=api(tok))).status_code == 200
            assert (await c.get("/v1/ferry/models", headers=api(r2["token"]))).status_code == 200
            assert (await c.get("/v1/ferry/models", headers=api(main))).status_code == 200
            assert (await c.get("/v1/ferry/models", headers=api("fd_" + "x" * 43))).status_code == 401
            # the Anthropic-style header works too
            assert (await c.get("/v1/ferry/models", headers={"x-api-key": tok})).status_code == 200

            rows = (await c.get("/admin/api/devices")).json()["devices"]
            assert [x["name"] for x in rows] == ["主令牌", "家里的笔记本", "work pc"]
            assert all(x["last_seen"] > 0 for x in rows)

            # retire one: only it is locked out
            assert (await c.delete(f"/admin/api/devices/{laptop}", headers=ADMIN)).status_code == 200
            assert (await c.get("/v1/ferry/models", headers=api(tok))).status_code == 401
            assert (await c.get("/v1/ferry/models", headers=api(r2["token"]))).status_code == 200
            assert (await c.delete("/admin/api/devices/main", headers=ADMIN)).status_code == 404
            # only from the server's own computer, with the admin header
            assert (await c.post("/admin/api/devices", json={"name": "x"})).status_code == 403
        async with client(app, host="10.0.0.9") as other:
            other.cookies.set("ferry_admin", key)
            assert (await other.get("/admin/api/devices")).status_code == 403

    asyncio.run(go())
    # devices survive a restart
    cfg2, app2 = make(tmp_path, monkeypatch)
    names = [d["name"] for d in json.loads((tmp_path / "devices.json").read_text())["devices"]]
    assert names == ["work pc"]
