"""Configured server models are the sole catalog; all traffic stays local/mocked."""
import asyncio

import httpx

from ferry_server.app import create_app
from ferry_server.config import load_default


def setup(tmp_path, monkeypatch, text=None):
    for k in ("ANTHROPIC_API_KEY", "OPENAI_API_KEY", "DEEPSEEK_API_KEY", "FERRY_MODEL",
              "FERRY_SUMMARY_MODEL", "FERRY_EXPOSE_MODELS", "FERRY_TOKEN", "FERRY_SECRET", "FERRY_CATALOG_TEST_KEY"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("FERRY_SERVER_HOME", str(tmp_path))
    if text is not None:
        (tmp_path / "models.toml").write_text(text)
    cfg = load_default()
    app = create_app(cfg)
    token = (tmp_path / "token").read_text().strip()
    return cfg, app, {"Authorization": f"Bearer {token}"}


CONFIG = '\n'.join(['[routing]', 'default = "second"', 'expose = true',
    '[models.first]', 'base_url = "http://127.0.0.1:1/v1"', 'model = "first-upstream"', 'api_key_env = "FERRY_CATALOG_TEST_KEY"',
    '[models.second]', 'base_url = "http://127.0.0.1:1/v1"', 'model = "second-upstream"', 'api_key_env = "FERRY_CATALOG_TEST_KEY"'])


def test_explicit_catalog_and_stale_requests(tmp_path, monkeypatch):
    cfg, app, headers = setup(tmp_path, monkeypatch, CONFIG)

    async def go():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
            r = await c.get("/v1/ferry/models", headers=headers)
            assert r.status_code == 200
            assert [m["id"] for m in r.json()["models"]] == ["second", "first"]
            assert all(not m["ready"] for m in r.json()["models"])
            assert r.json()["defaultModel"] == "second"
            for path in ("/v1/chat/completions", "/anthropic/v1/messages"):
                bad = await c.post(path, headers=headers, json={"model": "unconfigured", "messages": []})
                assert bad.status_code == 400
                assert "not configured" in bad.json()["detail"]
    asyncio.run(go())


def test_new_install_has_no_unconfigured_defaults(tmp_path, monkeypatch):
    cfg, app, headers = setup(tmp_path, monkeypatch)
    assert not cfg.models and cfg.default_model == cfg.summary_model == ""
    assert not load_default().models  # survives a restart without inventing placeholders

    async def go():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
            assert (await c.get("/health")).status_code == 200
            assert (await c.get("/v1/ferry/models", headers=headers)).json()["models"] == []
            for path in ("/v1/chat/completions", "/anthropic/v1/messages"):
                r = await c.post(path, headers=headers, json={"model": "auto", "messages": []})
                assert r.status_code == 503
            assert (await c.post("/v1/ferry/judge", headers=headers, json={})).status_code == 404  # removed upstream in v0.25
    asyncio.run(go())


def test_admin_can_delete_all_models_without_fallback(tmp_path, monkeypatch):
    cfg, app, headers = setup(tmp_path, monkeypatch, CONFIG)
    key = (tmp_path / "admin-key").read_text().strip()

    async def go():
        transport = httpx.ASGITransport(app=app, client=("127.0.0.1", 5555))
        async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1:8787") as c:
            c.cookies.set("ferry_admin", key)
            r = await c.put("/admin/api/providers", headers={"X-Ferry-Admin": "1"},
                json={"providers": [], "routing": {"default": "second", "summary": "first", "expose": True}})
            assert r.status_code == 200, r.text
            assert (await c.get("/v1/ferry/models", headers=headers)).json()["models"] == []
            assert cfg.default_model == cfg.summary_model == ""
    asyncio.run(go())
    assert load_default().models == {}


def test_hidden_routing_keeps_legacy_auto(tmp_path, monkeypatch):
    cfg, app, headers = setup(tmp_path, monkeypatch, CONFIG.replace("expose = true", "expose = false"))

    async def go():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
            listed = (await c.get("/v1/ferry/models", headers=headers)).json()["models"]
            assert [m["id"] for m in listed] == ["auto"]
            assert listed[0]["routesTo"] == "second"
    asyncio.run(go())
