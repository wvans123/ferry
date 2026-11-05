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
    "api.deepseek.com": {"results": [{"title": "D", "url": "https://d.example", "snippet": "short", "summary": "DeepSeek summary",
                                      "date": "2026-10-05T00:00:00Z", "authority": 3, "rerank_score": 2.1}]},
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
            cfg.search_engine = "bing"
            m = (await c.get("/v1/ferry/models", headers=hdr)).json()
            assert "search" not in m["features"]                       # "bing": the work PC reads Bing's page
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


def test_a_model_searches_for_the_work_computer_and_only_its_results_go_back(tmp_path, monkeypatch):
    from ferry_server.config import ModelConfig
    seen = []

    def handler(req: httpx.Request):
        seen.append(req)
        body = json.loads(req.content)
        if req.url.host == "api.anthropic.com":
            assert body["tools"][0]["type"] == "web_search_20250305" and body["tools"][0]["allowed_domains"] == ["3gpp.org"]
            return httpx.Response(200, json={"content": [
                {"type": "server_tool_use", "id": "s1", "name": "web_search", "input": {"query": "TS 38.300"}},
                {"type": "web_search_tool_result", "tool_use_id": "s1", "content": [
                    {"type": "web_search_result", "url": "https://www.3gpp.org/38300", "title": "TS 38.300",
                     "encrypted_content": "xyz", "page_age": "October 1, 2026"},
                    {"type": "web_search_result", "url": "https://www.3gpp.org/other", "title": "Other", "encrypted_content": "abc"}]},
                {"type": "text", "text": "done", "citations": [{"type": "web_search_result_location", "url": "https://www.3gpp.org/38300",
                                                                "title": "TS 38.300", "cited_text": "NR overall description"}]}],
                "usage": {"input_tokens": 1200, "output_tokens": 300, "server_tool_use": {"web_search_requests": 1}}})
        if req.url.path.endswith("/responses"):
            assert body["tools"][0]["filters"] == {"blocked_domains": ["reddit.com"]}
            assert body["include"] == ["web_search_call.action.sources"]
            return httpx.Response(200, json={"output": [
                {"type": "web_search_call", "action": {"type": "search", "query": "q", "sources": [
                    {"type": "url", "url": "https://a.example/x"}, {"type": "url", "url": "https://b.example/y"}]}},
                {"type": "message", "content": [{"type": "output_text", "text": "Alpha beta gamma",
                                                 "annotations": [{"type": "url_citation", "url": "https://a.example/x",
                                                                  "title": "A", "start_index": 6, "end_index": 10}]}]}]})
        return httpx.Response(404)

    cfg, app, token = setup(tmp_path, monkeypatch, [])
    monkeypatch.setattr(app_mod.httpx, "AsyncClient", lambda **kw: REAL(transport=httpx.MockTransport(handler), **kw))
    cfg.models["claude"] = ModelConfig(id="claude", base_url="https://api.anthropic.com", model="claude-opus-5-5",
                                       api="anthropic", key_value="ka", provider="p", price={"input": 5, "output": 25})
    cfg.models["gpt"] = ModelConfig(id="gpt", base_url="https://api.openai.com/v1", model="gpt-6.1-sol",
                                    api="openai-responses", key_value="ko", provider="p")
    app = app_mod.create_app(cfg)
    hdr = {"Authorization": f"Bearer {token}"}
    assert search.search_model(cfg, "model:deepseek") is None          # a Chat Completions model cannot search itself

    async def go():
        async with REAL(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
            cfg.search_engine = "model:claude"
            r = (await c.post("/v1/ferry/search", headers=hdr, json={"query": "TS 38.300", "allowed_domains": ["https://3gpp.org/"]})).json()
            assert r["engine"] == "model:claude"
            assert r["results"][0] == {"title": "TS 38.300", "url": "https://www.3gpp.org/38300",
                                       "snippet": "NR overall description", "date": "October 1, 2026"}
            assert len(r["results"]) == 2 and "encrypted" not in json.dumps(r)
            cfg.search_engine = "model:gpt"
            r = (await c.post("/v1/ferry/search", headers=hdr, json={"query": "q", "blocked_domains": ["reddit.com"]})).json()
            assert [x["url"] for x in r["results"]] == ["https://a.example/x", "https://b.example/y"]
            assert r["results"][0]["snippet"] == "beta"
            # the model's search is a model call: it shows in the call records with its tokens and cost, next to the search
            c.cookies.set("ferry_admin", (tmp_path / "admin-key").read_text().strip())
            calls = (await c.get("/admin/api/calls")).json()["calls"]
            spent = next(x for x in calls if x["purpose"] == "search" and x["model"] == "claude")
            assert spent["tokens"]["input"] == 1200 and spent["searches"] == 1 and spent["cost"] == 0.0135
            done = [x for x in calls if x["purpose"] == "search" and x["model"] == "model:claude"]
            assert done and done[0]["status"] == 200 and done[0]["results"] == 2

    asyncio.run(go())


def test_domains_go_into_the_query_or_the_api_and_bad_ones_are_dropped():
    assert search.domains(["https://www.3gpp.org/ftp/", "not a domain", "x.com"]) == ["www.3gpp.org/ftp", "x.com"]
    assert search.with_sites("q", ["a.org", "b.org"], []) == "q (site:a.org OR site:b.org)"
    assert search.with_sites("q", ["a.org"], []) == "q site:a.org"
    assert search.with_sites("q", [], ["c.com"]) == "q -site:c.com"


def test_a_page_is_read_with_a_question_by_the_summary_model_else_the_default(tmp_path, monkeypatch):
    asked = []

    def handler(req: httpx.Request):
        body = json.loads(req.content)
        asked.append(body)
        return httpx.Response(200, json={"choices": [{"message": {"role": "assistant", "content": "Clause 5.1 says X."},
                                                      "finish_reason": "stop"}],
                                         "usage": {"prompt_tokens": 900, "completion_tokens": 9}})

    cfg, app, token = setup(tmp_path, monkeypatch, [])
    monkeypatch.setattr(app_mod.httpx, "AsyncClient", lambda **kw: REAL(transport=httpx.MockTransport(handler), **kw))
    app = app_mod.create_app(cfg)
    hdr = {"Authorization": f"Bearer {token}"}

    async def go():
        async with REAL(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
            assert "extract" in (await c.get("/v1/ferry/models", headers=hdr)).json()["features"]
            page = "intro " * 30000                                    # 180k characters: only 100k go to the model
            r = (await c.post("/v1/ferry/extract", headers=hdr, json={"url": "https://x.example/spec", "title": "Spec",
                                                                       "prompt": "What does clause 5.1 say?", "text": page})).json()
            assert r["answer"] == "Clause 5.1 says X." and r["chars"] == 100_000
            user = asked[-1]["messages"][-1]["content"]
            assert user.startswith("<page>\nAddress: https://x.example/spec\nTitle: Spec") and "Question: What does clause 5.1 say?" in user
            assert "only" in asked[-1]["messages"][0]["content"]       # the reading rules
            assert (await c.post("/v1/ferry/extract", headers=hdr, json={"prompt": "q"})).status_code == 400
            assert (await c.post("/v1/ferry/extract", json={"prompt": "q", "text": "t"})).status_code == 401
        rows = [json.loads(l) for l in (tmp_path / "data" / "audit.jsonl").read_text().splitlines() if '"extract"' in l]
        assert rows and rows[-1]["tokens"]["input"] == 900

    asyncio.run(go())


def test_with_a_deepseek_key_the_server_searches_with_deepseek_by_itself(tmp_path, monkeypatch):
    seen = []
    cfg, app, token = setup(tmp_path, monkeypatch, seen)
    hdr = {"Authorization": f"Bearer {token}"}
    assert cfg.search_engine == "" and search.engine(cfg) == "deepseek"   # zero setup: the model's DeepSeek key

    async def go():
        async with REAL(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
            assert "search" in (await c.get("/v1/ferry/models", headers=hdr)).json()["features"]
            r = (await c.post("/v1/ferry/search", headers=hdr, json={"query": "TS 38.300", "recent": "year",
                                                                      "allowed_domains": ["3gpp.org"]})).json()
            assert r["engine"] == "deepseek"
            assert r["results"][0] == {"title": "D", "url": "https://d.example", "snippet": "DeepSeek summary",
                                       "date": "2026-10-05T00:00:00Z"}
            sent = json.loads(seen[-1].content)
            assert str(seen[-1].url) == "https://api.deepseek.com/v1/tools/search"
            assert seen[-1].headers["authorization"] == "Bearer k"
            assert sent["query"].startswith("TS 38.300 site:3gpp.org after:") and len(sent["query"]) <= 128
            long = (await c.post("/v1/ferry/search", headers=hdr, json={"query": "x" * 200, "blocked_domains": ["a.com"]})).json()
            assert long["engine"] == "deepseek" and len(json.loads(seen[-1].content)["query"]) <= 128
            assert json.loads(seen[-1].content)["query"].endswith(" -site:a.com")

    asyncio.run(go())


def test_the_server_reads_public_pages_and_hands_back_private_ones_and_files(tmp_path, monkeypatch):
    seen = []

    def handler(req: httpx.Request):
        seen.append(req)
        if req.url.path == "/v1/tools/fetch":
            return httpx.Response(200, json={"title": "Spec", "content": "# Spec\n\nClause 5.1: the value is 42."})
        if req.url.path.endswith("/chat/completions"):
            return httpx.Response(200, json={"choices": [{"message": {"role": "assistant", "content": "It is 42."},
                                                          "finish_reason": "stop"}], "usage": {"prompt_tokens": 50, "completion_tokens": 4}})
        if req.url.host == "public.example" and req.url.path == "/page":
            return httpx.Response(200, headers={"content-type": "text/html"},
                                  text="<html><title>P</title><body><nav>menu</nav><h1>Hello</h1><p>" + "word " * 100 + "</p></body></html>")
        if req.url.host == "public.example" and req.url.path == "/moved":
            return httpx.Response(302, headers={"location": "http://router.lan/admin"})
        if req.url.path.endswith(".pdf"):
            return httpx.Response(200, headers={"content-type": "application/pdf"}, content=b"%PDF")
        return httpx.Response(404)

    cfg, app, token = setup(tmp_path, monkeypatch, [])
    monkeypatch.setattr(app_mod.httpx, "AsyncClient", lambda **kw: REAL(transport=httpx.MockTransport(handler), **kw))
    monkeypatch.setattr(search, "private_host", lambda h: h.endswith(".lan"))
    app = app_mod.create_app(cfg)
    hdr = {"Authorization": f"Bearer {token}"}

    async def go():
        async with REAL(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
            assert "read" in (await c.get("/v1/ferry/models", headers=hdr)).json()["features"]
            # with DeepSeek: its Fetch API reads the page, a model answers the question; only the answer goes back
            r = (await c.post("/v1/ferry/read", headers=hdr, json={"url": "https://spec.example/38300", "prompt": "What value?"})).json()
            assert r["answer"] == "It is 42." and r["via"] == "deepseek" and "text" not in r
            assert json.loads(next(x for x in seen if x.url.path == "/v1/tools/fetch").content) == {"url": "https://spec.example/38300"}
            # the same page again within 15 minutes: not fetched again; without a question its text in parts
            n = len([x for x in seen if x.url.path == "/v1/tools/fetch"])
            r = (await c.post("/v1/ferry/read", headers=hdr, json={"url": "https://spec.example/38300"})).json()
            assert r["text"].startswith("# Spec") and r["next_offset"] is None
            assert len([x for x in seen if x.url.path == "/v1/tools/fetch"]) == n
            # without DeepSeek: the server fetches it itself
            monkeypatch.setattr(search, "deepseek_key", lambda cfg: "")
            r = (await c.post("/v1/ferry/read", headers=hdr, json={"url": "http://public.example/page"})).json()
            assert r["via"] == "server" and r["title"] == "P" and r["text"].startswith("# Hello") and "menu" not in r["text"]
            # an address on a private network, also after a redirect: the work computer reads it
            r = await c.post("/v1/ferry/read", headers=hdr, json={"url": "http://intranet.lan/wiki"})
            assert r.status_code == 422 and "private network" in r.json()["unreachable"]
            r = await c.post("/v1/ferry/read", headers=hdr, json={"url": "http://public.example/moved"})
            assert r.status_code == 422
            assert not any(x.url.host == "router.lan" for x in seen)
            # a file: the work computer downloads it
            r = await c.post("/v1/ferry/read", headers=hdr, json={"url": "http://public.example/spec.pdf"})
            assert r.status_code == 415 and r.json()["file"] == "application/pdf"
            assert (await c.post("/v1/ferry/read", json={"url": "http://public.example/page"})).status_code == 401

    asyncio.run(go())
