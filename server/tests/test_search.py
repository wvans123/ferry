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
EXA_TEXT = ("Title: Exa page\nURL: https://www.d.example/\nPublished: 2026-10-06\nAuthor: N/A\nHighlights:\nIntro line.\n\n"
            "The agent memory module keeps notes between sessions.\n\n---\n\n"
            "Title: N/A\nURL: https://e.example/x\nPublished: N/A\nAuthor: N/A\nHighlights:\nSomething else")


def exa_reply(text=EXA_TEXT):
    data = json.dumps({"result": {"content": [{"type": "text", "text": text}]}, "jsonrpc": "2.0", "id": 1})
    return httpx.Response(200, headers={"content-type": "text/event-stream"}, text=f"event: message\ndata: {data}\n\n")


def setup(tmp_path, monkeypatch, seen):
    for k in ("ANTHROPIC_API_KEY", "OPENAI_API_KEY", "FERRY_SEARCH", "FERRY_SEARCH_KEY", "FERRY_TOKEN", "FERRY_SECRET",
              *(f"FERRY_SEARCH_KEY_{e.upper()}" for e in search.ENGINES), "FERRY_SEARCH_API_EXA"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("DEEPSEEK_API_KEY", "k")
    monkeypatch.setenv("FERRY_SEARCH_EXA", "off")
    monkeypatch.setenv("FERRY_SERVER_HOME", str(tmp_path))
    monkeypatch.setattr(search, "private_host", lambda h: h.endswith(".lan"))

    def handler(req: httpx.Request):
        seen.append(req)
        if req.headers.get("authorization") == "Bearer bad" or req.headers.get("x-subscription-token") == "bad":
            return httpx.Response(401, json={"detail": "invalid key"})
        if req.url.host == "mcp.exa.ai":
            return exa_reply()
        if req.url.path == "/v1/tools/fetch" or req.url.host not in ANSWERS:
            return httpx.Response(404)
        return httpx.Response(200, json=ANSWERS[req.url.host])

    monkeypatch.setattr(app_mod.httpx, "AsyncClient", lambda **kw: REAL(transport=httpx.MockTransport(handler), **kw))
    cfg = load_default()
    return cfg, app_mod.create_app(cfg), (tmp_path / "token").read_text().strip()


def test_every_source_is_asked_at_once_and_the_keys_stay_on_the_server(tmp_path, monkeypatch):
    seen = []
    cfg, app, token = setup(tmp_path, monkeypatch, seen)
    hdr = {"Authorization": f"Bearer {token}"}
    asked = lambda host: [x for x in seen if x.url.host == host]  # noqa: E731

    async def go():
        async with REAL(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
            cfg.search_engine = "bing"
            m = (await c.get("/v1/ferry/models", headers=hdr)).json()
            assert "search" not in m["features"]                       # "bing": the work PC reads Bing's page
            assert (await c.post("/v1/ferry/search", headers=hdr, json={"query": "x"})).status_code == 404
            cfg.search_engine = ""
            for name in ("tavily", "brave", "bocha"):
                search.save_key(cfg, name, f"{name}-key")
            assert search.sources(cfg) == ["deepseek", "tavily", "brave", "bocha"]
            r = (await c.post("/v1/ferry/search", headers=hdr, json={"query": "agent memory", "count": 5, "recent": "week"})).json()
            assert r["engine"] == "deepseek+tavily+brave+bocha" and "failed" not in r
            got = {x["title"]: x for x in r["results"]}
            assert set(got) == {"D", "T", "B", "博"}
            assert got["T"]["snippet"] == "tavily text" and got["博"]["snippet"] == "博查摘要" and got["B"]["date"].startswith("2026-10")
            tav, brave, bocha = asked("api.tavily.com")[0], asked("api.search.brave.com")[0], asked("api.bochaai.com")[0]
            assert json.loads(tav.content) == {"query": "agent memory", "max_results": 5, "search_depth": "basic", "time_range": "week"}
            assert tav.headers["authorization"] == "Bearer tavily-key"
            assert brave.headers["x-subscription-token"] == "brave-key" and brave.url.params["freshness"] == "pw"
            assert json.loads(bocha.content)["freshness"] == "oneWeek"
            # the same search within 10 minutes comes from the cache
            n = len(seen)
            again = (await c.post("/v1/ferry/search", headers=hdr, json={"query": "agent memory", "count": 5, "recent": "week"})).json()
            assert again == r and len(seen) == n
            # one source failing loses only its own results
            search.save_key(cfg, "bocha", "bad")
            r = (await c.post("/v1/ferry/search", headers=hdr, json={"query": "y"})).json()
            assert len(r["results"]) == 3 and "博查 answered HTTP 401" in r["failed"]["bocha"]
            # all of them failing: a short reason the client can show (it then reads Bing instead)
            for name in search.ENGINES:
                search.save_key(cfg, name, "bad")
            monkeypatch.setenv("FERRY_SEARCH_KEY_DEEPSEEK", "bad")
            r = await c.post("/v1/ferry/search", headers=hdr, json={"query": "z"})
            assert r.status_code == 502 and "博查 answered HTTP 401" in r.json()["error"]
            # without the token nobody can use the search keys
            assert (await c.post("/v1/ferry/search", json={"query": "x"})).status_code == 401

    asyncio.run(go())


def test_the_admin_page_keeps_a_key_per_engine_out_of_view(tmp_path, monkeypatch):
    seen = []
    cfg, app, _ = setup(tmp_path, monkeypatch, seen)
    key = (tmp_path / "admin-key").read_text().strip()
    adm = {"Cookie": f"ferry_admin={key}", "X-Ferry-Admin": "1"}

    async def go():
        async with REAL(transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1") as c:
            s = (await c.put("/admin/api/settings", headers=adm, json={"search_engine": "tavily", "search_key": "tvly-123"})).json()
            assert s["search_engine"] == "tavily" and s["search_keys"]["tavily"] is True and "tvly-123" not in json.dumps(s)
            assert 'search_engine = "tavily"' in (tmp_path / "server.toml").read_text()
            s = (await c.put("/admin/api/settings", headers=adm, json={"search_engine": "", "search_key_for": "brave", "search_key": "b-1"})).json()
            assert s["search_keys"]["brave"] and s["search_keys"]["tavily"] and s["search_sources"] == ["DeepSeek 搜索", "Tavily", "Brave Search"]
            assert json.loads((tmp_path / "search-keys.json").read_text()) == {"tavily": "tvly-123", "brave": "b-1"}
            t = (await c.post("/admin/api/search/test", headers=adm, json={})).json()
            assert t["ok"] and {x["title"] for x in t["results"]} == {"D", "T", "B"} and t["sources"]["Tavily"] == "1 条"
            s = (await c.put("/admin/api/settings", headers=adm, json={"search_engine": "nope"})).json()
            assert s["search_engine"] == ""                             # unknown engines are ignored
            s = (await c.put("/admin/api/settings", headers=adm, json={"search_key_for": "brave", "search_key": ""})).json()
            assert not s["search_keys"]["brave"]

    asyncio.run(go())


def test_a_key_saved_before_keys_per_engine_still_counts(tmp_path, monkeypatch):
    cfg, _, _ = setup(tmp_path, monkeypatch, [])
    (tmp_path / "search-key").write_text("old-key")
    cfg.search_engine = "bocha"
    assert search.engine_key(cfg, "bocha") == "old-key" and not search.engine_key(cfg, "tavily")
    app_mod.create_app(cfg)                                            # moved into search-keys.json when the server starts
    assert not (tmp_path / "search-key").exists() and search.saved_keys(cfg) == {"bocha": "old-key"}


def test_a_model_searches_and_its_quotes_become_the_snippets(tmp_path, monkeypatch):
    from ferry_server.config import ModelConfig
    seen = []

    def handler(req: httpx.Request):
        seen.append(req)
        body = json.loads(req.content) if req.content else {}
        if req.url.host == "api.anthropic.com":
            assert body["tools"][0]["type"] == "web_search_20250305" and body["tools"][0]["allowed_domains"] == ["3gpp.org"]
            assert "quoted word for word" in body["messages"][0]["content"]
            return httpx.Response(200, json={"content": [
                {"type": "server_tool_use", "id": "s1", "name": "web_search", "input": {"query": "TS 38.300"}},
                {"type": "web_search_tool_result", "tool_use_id": "s1", "content": [
                    {"type": "web_search_result", "url": "https://www.3gpp.org/38300", "title": "TS 38.300",
                     "encrypted_content": "xyz", "page_age": "October 1, 2026"},
                    {"type": "web_search_result", "url": "https://www.3gpp.org/other", "title": "Other", "encrypted_content": "abc"}]},
                {"type": "text", "text": "1. https://www.3gpp.org/38300 ", "citations": None},
                {"type": "text", "text": "\"NR overall description\"\n", "citations": [{"type": "web_search_result_location", "url": "https://www.3gpp.org/38300",
                                                                                         "title": "TS 38.300", "cited_text": "NR overall description"}]},
                {"type": "text", "text": "2. https://www.3gpp.org/other — \"Another page about it.\""}]})
        if req.url.path.endswith("/responses"):
            assert body["tools"][0]["filters"] == {"blocked_domains": ["reddit.com"]}
            assert body["include"] == ["web_search_call.action.sources"]
            return httpx.Response(200, json={"output": [
                {"type": "web_search_call", "action": {"type": "search", "query": "q", "sources": [
                    {"type": "url", "url": "https://a.example/x"}, {"type": "url", "url": "https://b.example/y"}]}},
                {"type": "message", "content": [{"type": "output_text", "text": "Intro\n- \"Alpha beta gamma\" ([a.example](https://a.example/x))",
                                                 "annotations": [{"type": "url_citation", "url": "https://a.example/x",
                                                                  "title": "A", "start_index": 26, "end_index": 60}]}]}]})
        return httpx.Response(404)

    cfg, app, token = setup(tmp_path, monkeypatch, [])
    monkeypatch.setattr(app_mod.httpx, "AsyncClient", lambda **kw: REAL(transport=httpx.MockTransport(handler), **kw))
    cfg.models["claude"] = ModelConfig(id="claude", base_url="https://api.anthropic.com", model="claude-opus-5-5",
                                       api="anthropic", key_value="ka", provider="p")
    cfg.models["gpt"] = ModelConfig(id="gpt", base_url="https://api.openai.com/v1", model="gpt-6.1-sol",
                                    api="openai-responses", key_value="ko", provider="p")
    app = app_mod.create_app(cfg)
    hdr = {"Authorization": f"Bearer {token}"}
    assert search.search_model(cfg, "model:deepseek") is None          # a Chat Completions model cannot search itself

    async def go():
        async with REAL(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
            cfg.search_engine = "model:claude"
            assert search.sources(cfg) == ["deepseek", "model:claude"]
            r = (await c.post("/v1/ferry/search", headers=hdr, json={"query": "TS 38.300", "allowed_domains": ["https://3gpp.org/"]})).json()
            assert r["engine"] == "model:claude" and "deepseek" in r["failed"]   # DeepSeek's search answered 404 here
            assert r["results"][0] == {"title": "TS 38.300", "url": "https://www.3gpp.org/38300",
                                       "snippet": "NR overall description", "date": "October 1, 2026"}
            assert r["results"][1]["snippet"] == "Another page about it." and "encrypted" not in json.dumps(r)
            cfg.search_engine = "model:gpt"
            r = (await c.post("/v1/ferry/search", headers=hdr, json={"query": "q", "blocked_domains": ["reddit.com"]})).json()
            assert [x["url"] for x in r["results"]] == ["https://a.example/x", "https://b.example/y"]
            assert r["results"][0]["snippet"] == "Alpha beta gamma"

    asyncio.run(go())


def test_exa_free_search_reads_its_event_and_waits_once_when_busy(monkeypatch):
    calls = []

    def handler(req: httpx.Request):
        calls.append(json.loads(req.content))
        return httpx.Response(429) if len(calls) == 1 else exa_reply()

    async def no_wait(_):
        return None
    monkeypatch.setattr(search.asyncio, "sleep", no_wait)
    monkeypatch.delenv("FERRY_SEARCH_API_EXA", raising=False)

    async def go():
        async with REAL(transport=httpx.MockTransport(handler)) as c:
            rows = await search.exa_search(c, "agent memory", 5)
        assert calls[-1]["method"] == "tools/call" and calls[-1]["params"]["name"] == "web_search_exa"
        assert calls[-1]["params"]["arguments"]["numResults"] == 5 and len(calls) == 2
        assert rows[0]["title"] == "Exa page" and rows[0]["url"] == "https://www.d.example/" and rows[0]["date"] == "2026-10-06"
        assert "agent memory module" in rows[0]["text"] and rows[1]["title"] == "" and rows[1]["date"] == ""

    asyncio.run(go())


def test_lists_are_merged_by_rank_and_the_same_page_comes_once():
    a = [{"title": "A1", "url": "https://one.example/a"}, {"title": "A2", "url": "https://www.two.example/b/?utm_source=x#top"}]
    b = [{"title": "B1", "url": "http://two.example/b", "snippet": "from b"}, {"title": "B2", "url": "https://three.example/"}]
    merged = search.merge({"tavily": a, "exa": b}, "q", 8)
    assert [x["title"] for x in merged] == ["A2", "A1", "B2"]
    assert merged[0]["snippet"] == "from b" and merged[0]["engines"] == ["tavily", "exa"]
    # Chinese queries: Bocha's first result outranks another source's first
    zh = search.merge({"tavily": [{"title": "T", "url": "https://t.example"}], "bocha": [{"title": "C", "url": "https://c.example"}]}, "中文 问题", 8)
    assert zh[0]["title"] == "C"
    en = search.merge({"tavily": [{"title": "T", "url": "https://t.example"}], "bocha": [{"title": "C", "url": "https://c.example"}]}, "english", 8)
    assert en[0]["title"] == "T"
    rows = [{"url": "https://www.3gpp.org/ftp/x"}, {"url": "https://reddit.com/r"}, {"url": "https://other.org"}]
    assert [x["url"] for x in search.keep_domains(rows, ["3gpp.org/ftp"], [])] == ["https://www.3gpp.org/ftp/x"]
    assert len(search.keep_domains(rows, [], ["reddit.com"])) == 2


def test_passages_are_quoted_from_the_page_where_it_matches_the_query():
    page = "\n".join(["# Intro", "Ferries are boats.", "# Timer", "The T310 timer starts when the UE detects radio link problems.",
                      "# Other", "Nothing about it here at all."] + ["filler line"] * 50)
    got = search.pick_passages(page, "T310 timer radio link")
    assert got[0].startswith("# Timer\nThe T310 timer starts") and all("Ferries" not in p for p in got)
    zh = "# 安装\n先下载安装包。\n# 网络请求\nwx.request 发起 HTTPS 网络请求，最大并发限制是 10 个。\n# 其他\n与此无关的内容。"
    assert "最大并发" in search.pick_passages(zh, "wx.request 并发限制")[0]
    long = "x " * 300 + "the T310 timer value " + "y " * 300
    p = search.window(long, ["t310"], 100)
    assert p.startswith("…") and p.endswith("…") and "T310" in p and len(p) <= 102
    assert search.terms("TS 38.331 site:3gpp.org 的定时器") == {"ts", "38.331", "的定", "定时", "时器"}


def test_the_top_pages_are_read_for_passages_and_a_page_that_fails_uses_the_sources_text(tmp_path, monkeypatch):
    cfg, _, _ = setup(tmp_path, monkeypatch, [])
    monkeypatch.setattr(search, "deepseek_key", lambda cfg: "")

    def handler(req: httpx.Request):
        if req.url.host == "page.example":
            return httpx.Response(200, headers={"content-type": "text/html"}, text=(
                "<html><title>P</title><body><div class='cookie-banner'>We use cookies to improve the agent memory</div>"
                "<main><h1>Agent memory</h1>" + "<p>Agent memory stores notes between sessions.</p>" * 20 + "</main>"
                "<div id='comments'>agent memory is great says a commenter</div></body></html>"))
        return httpx.Response(500)
    results = [{"url": "https://page.example/a", "title": "A"},
               {"url": "https://down.example/b", "title": "B", "text": "Highlights: agent memory keeps notes."},
               {"url": "https://down.example/c", "title": "C"}, {"url": "https://later.example/d", "title": "D"}]
    cache = {}

    async def go():
        async with REAL(transport=httpx.MockTransport(handler)) as c:
            await search.add_passages(cfg, c, "agent memory", results, cache)
    asyncio.run(go())
    assert results[0]["passages"] and all("cookie" not in p and "commenter" not in p for p in results[0]["passages"])
    assert results[1]["passages"] == ["Highlights: agent memory keeps notes."]
    assert results[2]["passages"] == [] and "passages" not in results[3]
    assert "https://page.example/a" in cache                            # web_fetch of that page right after is free
    assert sum(len(p) for x in results for p in x.get("passages", [])) <= search.PASSAGES_TOTAL


def test_a_page_keeps_its_main_content_and_drops_what_is_around_it():
    html = ("<html><title>T</title><body><header><a href='/'>Site</a> Menu</header>"
            "<div class='sidebar left'>Popular posts</div><div id='cookie-consent'>Accept cookies</div>"
            "<article><h1>Title</h1>" + "<p>Real content sentence.</p>" * 40
            + "<section class='comments'><div><div>Nice post!</div></div></section></article>"
            "<aside>Related</aside><footer>Copyright</footer></body></html>")
    title, text = search.html_to_text(html, "https://x.example/")
    assert title == "T" and text.startswith("# Title") and "Real content sentence." in text
    assert not any(w in text for w in ("Menu", "Popular", "Accept cookies", "Nice post", "Related", "Copyright"))
    # one wrapper with a sidebar class around everything: dropping it would leave nothing, so it stays
    wrapped = "<html><body><div class='sidebar-layout'><p>" + "Words here. " * 50 + "</p></div></body></html>"
    assert "Words here." in search.html_to_text(wrapped, "https://x.example/")[1]
    # a short article (a teaser) is not taken for the whole page
    teaser = "<html><body><article>Teaser</article><div>" + "Body text. " * 80 + "</div></body></html>"
    assert "Body text." in search.html_to_text(teaser, "https://x.example/")[1]
    assert search.raw_github("https://github.com/o/r/blob/main/src/a.py#L3") == "https://raw.githubusercontent.com/o/r/main/src/a.py"
    assert search.raw_github("https://github.com/o/r") == "https://github.com/o/r"


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
    assert cfg.search_engine == "" and search.sources(cfg) == ["deepseek"]   # zero setup: the model's DeepSeek key
    monkeypatch.delenv("FERRY_SEARCH_EXA")
    assert search.sources(cfg) == ["deepseek", "exa"]                      # Exa's free search joins unless turned off
    monkeypatch.setenv("FERRY_SEARCH_EXA", "off")

    async def go():
        async with REAL(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
            assert "search" in (await c.get("/v1/ferry/models", headers=hdr)).json()["features"]
            r = (await c.post("/v1/ferry/search", headers=hdr, json={"query": "TS 38.300", "recent": "year",
                                                                      "allowed_domains": ["d.example"]})).json()
            assert r["engine"] == "deepseek"
            assert r["results"][0] == {"title": "D", "url": "https://d.example", "snippet": "DeepSeek summary",
                                       "date": "2026-10-05T00:00:00Z"}
            sent = json.loads(next(x for x in seen if x.url.path == "/v1/tools/search").content)
            assert sent["query"].startswith("TS 38.300 site:d.example after:") and len(sent["query"]) <= 128
            long = (await c.post("/v1/ferry/search", headers=hdr, json={"query": "x" * 200, "blocked_domains": ["a.com"]})).json()
            sent = json.loads([x for x in seen if x.url.path == "/v1/tools/search"][-1].content)
            assert long["engine"] == "deepseek" and len(sent["query"]) <= 128 and sent["query"].endswith(" -site:a.com")

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
            # a file's page on GitHub is read as the file itself
            await c.post("/v1/ferry/read", headers=hdr, json={"url": "https://github.com/o/r/blob/main/README.md"})
            assert json.loads([x for x in seen if x.url.path == "/v1/tools/fetch"][-1].content)["url"] == \
                "https://raw.githubusercontent.com/o/r/main/README.md"
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
