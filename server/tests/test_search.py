import asyncio
import json

import httpx

import ferry_server.app as app_mod
from ferry_server import search
from ferry_server.config import load_default

REAL = httpx.AsyncClient

ANSWERS = {
    "api.tavily.com": {"results": [{"title": "T", "url": "https://t.example", "content": "tavily text", "published_date": "2026-10-02"}]},
    "api.search.brave.com": {"web": {"results": [{"title": "B", "url": "https://b.example", "description": "brave text", "page_age": "2026-10-03"}]}},
    "api.bochaai.com": {"code": 200, "data": {"webPages": {"value": [{"name": "博", "url": "https://c.example", "snippet": "s", "summary": "博查摘要", "datePublished": "2026-10-04"}]}}},
}


def setup(tmp_path, monkeypatch, seen):
    for k in ("ANTHROPIC_API_KEY", "OPENAI_API_KEY", "FERRY_SEARCH", "FERRY_SEARCH_KEY", "FERRY_TOKEN", "FERRY_SECRET"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("DEEPSEEK_API_KEY", "k")
    monkeypatch.setenv("FERRY_SERVER_HOME", str(tmp_path))

    def handler(req: httpx.Request):
        seen.append(req)
        if req.headers.get("authorization") == "Bearer bad":
            return httpx.Response(401, json={"detail": "invalid key"})
        return httpx.Response(200, json=ANSWERS[req.url.host])

    monkeypatch.setattr(app_mod.httpx, "AsyncClient", lambda **kw: REAL(transport=httpx.MockTransport(handler), **kw))
    cfg = load_default()
    return cfg, app_mod.create_app(cfg), (tmp_path / "token").read_text().strip()


def test_each_engine_answers_in_one_shape_and_the_key_stays_on_the_server(tmp_path, monkeypatch):
    seen = []
    cfg, app, token = setup(tmp_path, monkeypatch, seen)
    hdr = {"Authorization": f"Bearer {token}"}

    async def go():
        async with REAL(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
            m = (await c.get("/v1/ferry/models", headers=hdr)).json()
            assert "search" not in m["features"]                       # nothing set: the work PC reads Bing
            assert (await c.post("/v1/ferry/search", headers=hdr, json={"query": "x"})).status_code == 404
            search.save_key(cfg, "secret-key")
            for name, title, snippet in (("tavily", "T", "tavily text"), ("brave", "B", "brave text"), ("bocha", "博", "博查摘要")):
                cfg.search_engine = name
                assert "search" in (await c.get("/v1/ferry/models", headers=hdr)).json()["features"]
                r = (await c.post("/v1/ferry/search", headers=hdr, json={"query": "agent memory", "count": 5, "recent": "week"})).json()
                assert r["engine"] == name
                assert r["results"][0]["title"] == title and r["results"][0]["snippet"] == snippet
                assert r["results"][0]["date"].startswith("2026-10")
            tav, brave, bocha = seen
            assert json.loads(tav.content) == {"query": "agent memory", "max_results": 5, "search_depth": "basic", "time_range": "week"}
            assert brave.headers["x-subscription-token"] == "secret-key" and brave.url.params["freshness"] == "pw"
            assert json.loads(bocha.content)["freshness"] == "oneWeek"
            # an API error comes back as a short reason the client can show (it then reads Bing instead)
            search.save_key(cfg, "bad")
            r = await c.post("/v1/ferry/search", headers=hdr, json={"query": "x"})
            assert r.status_code == 502 and "博查 answered HTTP 401" in r.json()["error"]
            # without the token nobody can use the search key
            assert (await c.post("/v1/ferry/search", json={"query": "x"})).status_code == 401

    asyncio.run(go())


def test_the_admin_page_sets_the_engine_and_keeps_the_key_out_of_view(tmp_path, monkeypatch):
    seen = []
    cfg, app, _ = setup(tmp_path, monkeypatch, seen)
    key = (tmp_path / "admin-key").read_text().strip()
    adm = {"Cookie": f"ferry_admin={key}", "X-Ferry-Admin": "1"}

    async def go():
        async with REAL(transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1") as c:
            s = (await c.put("/admin/api/settings", headers=adm, json={"search_engine": "tavily", "search_key": "tvly-123"})).json()
            assert s["search_engine"] == "tavily" and s["search_key"] is True and "tvly-123" not in json.dumps(s)
            assert 'search_engine = "tavily"' in (tmp_path / "server.toml").read_text()
            t = (await c.post("/admin/api/search/test", headers=adm, json={})).json()
            assert t["ok"] and t["results"][0]["title"] == "T"
            s = (await c.put("/admin/api/settings", headers=adm, json={"search_engine": "nope"})).json()
            assert s["search_engine"] == "tavily"                       # unknown engines are ignored

    asyncio.run(go())
