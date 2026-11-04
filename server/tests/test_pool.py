import asyncio
import json

import httpx

import ferry_server.app as app_mod
from ferry_server.config import load_default
from ferry_server.pool import Pool, norm

REAL = httpx.AsyncClient

MODELS = """
[routing]
default = "gpt"
expose = true

[providers.a]
base_url = "https://a.example.com/v1"
api_key_env = "KEY_A"

[providers.b]
base_url = "https://b.example.com/v1"
api_key_env = "KEY_B"

[models.gpt]
provider = "a"
model = "gpt-6.1-sol"
context_window = 400000

[models.gpt-b]
provider = "b"
model = "openai/gpt-6.1-sol"
context_window = 300000

[models.other]
provider = "b"
model = "deepseek-flash"
"""


def make(tmp_path, monkeypatch, handler, extra=""):
    for k in ("ANTHROPIC_API_KEY", "OPENAI_API_KEY", "DEEPSEEK_API_KEY", "FERRY_SESSION_STORE", "FERRY_TOKEN", "FERRY_SECRET"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("KEY_A", "ka")
    monkeypatch.setenv("KEY_B", "kb")
    monkeypatch.setenv("FERRY_SERVER_HOME", str(tmp_path))
    (tmp_path / "models.toml").write_text(MODELS + extra, encoding="utf-8")
    monkeypatch.setattr(app_mod.httpx, "AsyncClient", lambda **kw: REAL(transport=httpx.MockTransport(handler), **kw))
    cfg = load_default()
    return cfg, app_mod.create_app(cfg)


def answer(text="hi"):
    return httpx.Response(200, json={"choices": [{"message": {"role": "assistant", "content": text}}],
                                     "usage": {"prompt_tokens": 10, "completion_tokens": 2}})


def test_names_match_across_providers():
    assert norm("openai/GPT-6.1-sol") == norm("gpt-6-1-sol") == "gpt-6-1-sol"
    assert norm("claude-opus-5.5") == norm("claude-opus-5-5")


def test_conversations_spread_stick_and_fail_over(tmp_path, monkeypatch):
    seen = []
    down = set()

    def handler(req: httpx.Request):
        host = req.url.host
        seen.append(host)
        if host in down:
            return httpx.Response(503, json={"error": {"message": "overloaded"}})
        return answer(host)

    cfg, app = make(tmp_path, monkeypatch, handler)
    token = (tmp_path / "token").read_text().strip()
    hdr = {"Authorization": f"Bearer {token}"}

    async def go():
        async with REAL(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
            listed = (await c.get("/v1/ferry/models", headers=hdr)).json()["models"]
            ids = [m["id"] for m in listed]
            assert ids == ["auto", "gpt", "other"]                      # one entry for the shared model
            assert listed[1]["providers"] == 2 and listed[1]["contextWindow"] == 300000

            async def ask(conv):
                for n in (1, 2):  # two turns of the same conversation
                    body = json.dumps({"append": [json.dumps({"role": "user", "content": f"{conv} {n}"})], "tools": None})
                    q = {"conv": conv, "base": 0, "base_hash": ""}
                    ack = (await c.post("/v1/ferry/commit", params=q, content=body, headers=hdr)).json()
                    r = await c.post("/v1/chat/completions", headers=hdr, json={
                        "model": "auto", "messages": [], "ferry": {"conv": conv, "count": ack["count"], "hash": ack["hash"]}})
                    assert r.status_code == 200
                return r.json()["choices"][0]["message"]["content"]

            # one at a time, conversations go to the requested provider first and stay there
            first = await ask("c1")
            assert first == "a.example.com" and seen == ["a.example.com"] * 2
            # provider a overloaded: the conversation moves to b and stays there afterwards
            down.add("a.example.com")
            seen.clear()
            assert await ask("c2") == "b.example.com"
            assert seen == ["a.example.com", "b.example.com", "b.example.com"]  # a tried once, then paused
            down.clear()
            seen.clear()
            await ask("c2")
            assert seen == ["b.example.com", "b.example.com"]

    asyncio.run(go())


def test_busy_provider_gets_the_next_conversation():
    class M:
        def __init__(self, i):
            self.id, self.api, self.model, self.ready = i, "openai", "gpt-6.1-sol", True

    class C:
        models = {"a": M("a"), "b": M("b")}

    p = Pool()
    p.start("a")  # a conversation is running on a
    assert p.order(C, C.models["a"], "new")[0].id == "b"
    p.served("new", "b")
    p.end("a")
    assert p.order(C, C.models["a"], "new")[0].id == "b"  # it stays on b
    assert p.order(C, C.models["a"], "fresh")[0].id == "a"


def test_a_conversation_too_big_for_the_model_is_sent_back_for_summarising(tmp_path, monkeypatch):
    cfg, app = make(tmp_path, monkeypatch, lambda req: answer())
    token = (tmp_path / "token").read_text().strip()

    async def go():
        async with REAL(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
            big = "word " * 160_000  # about 200k tokens; deepseek-flash here holds 128k
            r = await c.post("/v1/chat/completions", headers={"Authorization": f"Bearer {token}"},
                             json={"model": "other", "messages": [{"role": "user", "content": big}]})
            return r

    r = asyncio.run(go())
    assert r.status_code == 400 and "exceeds the context window" in r.json()["error"]["message"]


def test_messages_the_server_has_are_sent_as_references(tmp_path):
    from ferry_server.store import MissingBlobs, Store, sha
    st = Store(":memory:")
    a, b, c = '{"role":"system","content":"s"}', '{"role":"user","content":"long history"}', '{"role":"user","content":"new"}'
    st.commit("u\x1fconv1", 0, "", [a, b], None, owner="u", keep_blobs=True)
    assert sorted(st.have("u", [sha(a), sha(b), sha(c)])) == sorted([sha(a), sha(b)])
    assert st.have("other-user", [sha(a)]) == []                       # per user
    # after a restart the system prompt changed: a new conversation, old messages by reference
    a2 = '{"role":"system","content":"s2"}'
    count, h = st.commit("u\x1fconv2", 0, "", [a2, {"ref": sha(b)}, c], None, owner="u", keep_blobs=True)
    msgs, _ = st.load("u\x1fconv2", count, h, None)
    assert [m["content"] for m in msgs] == ["s2", "long history", "new"]
    try:
        st.commit("u\x1fconv3", 0, "", [{"ref": "0" * 64}], None, owner="u", keep_blobs=True)
        raise AssertionError("should fail")
    except MissingBlobs as e:
        assert e.missing == ["0" * 64]


def test_claude_behind_an_openai_relay_gets_cache_marks_unless_refused(tmp_path, monkeypatch):
    bodies = []
    refuse = {"on": False}

    def handler(req: httpx.Request):
        b = json.loads(req.content)
        bodies.append(b)
        if refuse["on"] and "cache_control" in req.content.decode():
            return httpx.Response(400, json={"error": {"message": "unknown field cache_control"}})
        return answer()

    cfg, app = make(tmp_path, monkeypatch, handler)
    (tmp_path / "models.toml").write_text(MODELS.replace('model = "deepseek-flash"', 'model = "claude-opus-5.5"'), encoding="utf-8")
    token = (tmp_path / "token").read_text().strip()

    async def ask():
        async with REAL(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
            return await c.post("/v1/chat/completions", headers={"Authorization": f"Bearer {token}"}, json={
                "model": "other", "messages": [{"role": "system", "content": "rules"}, {"role": "user", "content": "hi"}],
                "tools": [{"type": "function", "function": {"name": "read", "parameters": {}}}]})

    assert asyncio.run(ask()).status_code == 200
    sent = bodies[-1]
    assert sent["messages"][0]["content"][0]["cache_control"] == {"type": "ephemeral"}
    assert sent["messages"][-1]["content"][0]["cache_control"] and sent["tools"][-1]["cache_control"]
    refuse["on"] = True
    bodies.clear()
    assert asyncio.run(ask()).status_code == 200            # refused once, then sent plain
    assert len(bodies) == 2 and "cache_control" not in json.dumps(bodies[1])
    bodies.clear()
    assert asyncio.run(ask()).status_code == 200            # and not tried again
    assert len(bodies) == 1 and "cache_control" not in json.dumps(bodies[0])


def test_usage_from_a_claude_relay_counts_the_cache():
    from ferry_server.usage import normalize
    u = normalize({"prompt_tokens": 1000, "completion_tokens": 10, "cache_read_input_tokens": 900})
    assert u == {"input": 100, "cache_read": 900, "cache_write": 0, "output": 10}


def test_one_user_has_at_most_max_concurrent_model_calls(tmp_path, monkeypatch):
    state = {"now": 0, "max": 0}

    async def handler(req: httpx.Request):
        state["now"] += 1
        state["max"] = max(state["max"], state["now"])
        await asyncio.sleep(0.05)
        state["now"] -= 1
        return answer()

    cfg, app = make(tmp_path, monkeypatch, handler)
    cfg.max_concurrent = 2
    token = (tmp_path / "token").read_text().strip()

    async def go():
        async with REAL(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
            rs = await asyncio.gather(*[c.post("/v1/chat/completions", headers={"Authorization": f"Bearer {token}"},
                                               json={"model": "other", "messages": [{"role": "user", "content": f"hi {i}"}]})
                                        for i in range(6)])
            return [r.status_code for r in rs]

    assert asyncio.run(go()) == [200] * 6
    assert state["max"] == 2


def test_report_becomes_a_scrubbed_issue_and_notify(tmp_path, monkeypatch):
    sent, issues = [], []

    def handler(req: httpx.Request):
        if req.url.host == "api.day.app":
            sent.append(json.loads(req.content))
            return httpx.Response(200, json={"code": 200})
        if req.url.host == "api.github.com":
            issues.append((str(req.url), req.headers["authorization"], json.loads(req.content)))
            return httpx.Response(201, json={"html_url": "https://github.com/wvans123/ferry/issues/7"})
        return answer()

    monkeypatch.delenv("FERRY_GITHUB_TOKEN", raising=False)
    cfg, app = make(tmp_path, monkeypatch, handler)
    token = (tmp_path / "token").read_text().strip()
    hdr = {"Authorization": f"Bearer {token}"}
    rep = {"title": "web_fetch fails behind 10.1.2.3", "facts": {"ferry": "0.25.0", "os": "win32"},
           "body": "Reading C:\\Users\\zhang.san\\proj\\a.docx failed; mail me at zhang@corp.com"}

    async def go():
        async with REAL(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
            r0 = (await c.post("/v1/ferry/report", headers=hdr, json=rep)).json()
            monkeypatch.setenv("FERRY_GITHUB_TOKEN", "github_pat_test")
            r1 = (await c.post("/v1/ferry/report", headers=hdr, json=rep)).json()
            n0 = (await c.post("/v1/ferry/notify", headers=hdr, json={"title": "Ferry", "body": "goal done"})).json()
            cfg.bark_url = "https://api.day.app/KEY"
            n1 = (await c.post("/v1/ferry/notify", headers=hdr, json={"title": "Ferry", "body": "goal done"})).json()
            return r0, r1, n0, n1

    import ferry_server.notify as nt
    monkeypatch.setattr(nt.httpx, "AsyncClient", lambda **kw: REAL(transport=httpx.MockTransport(handler), **kw))
    r0, r1, n0, n1 = asyncio.run(go())
    # without a token the report is kept on the server and the client is told why it did not become an issue
    assert r0["ok"] is False and "GitHub token" in r0["error"] and (tmp_path / "data" / "reports" / f"{r0['id']}.json").exists()
    assert r1["ok"] is True and r1["issue"].endswith("/issues/7") and r1["hidden"] == 3
    url, auth, issue = issues[0]
    assert url == "https://api.github.com/repos/wvans123/ferry/issues" and auth == "Bearer github_pat_test"
    assert issue["title"] == "[report] web_fetch fails behind [hidden]"
    text = issue["title"] + issue["body"]
    assert "zhang" not in text and "10.1.2.3" not in text and "C:\\Users\\<user>\\proj" in text and "0.25.0" in text
    assert n0["ok"] is False and n1["ok"] is True and sent[0]["body"] == "goal done"


def test_a_busy_only_provider_is_asked_again_and_limited_to_its_slots(tmp_path, monkeypatch):
    state = {"calls": 0, "now": 0, "max": 0}

    async def handler(req: httpx.Request):
        state["calls"] += 1
        if req.url.host == "b.example.com" and state["calls"] <= 2:  # kiro-like: busy, answers 502 at once
            return httpx.Response(502, json={"error": {"message": "busy"}})
        state["now"] += 1
        state["max"] = max(state["max"], state["now"])
        await asyncio.sleep(0.05)
        state["now"] -= 1
        return answer()

    cfg, app = make(tmp_path, monkeypatch, handler)
    monkeypatch.setattr(app_mod, "retry_delay", lambda headers, attempt: 0.01)
    token = (tmp_path / "token").read_text().strip()

    async def one(i):
        async with REAL(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
            return (await c.post("/v1/chat/completions", headers={"Authorization": f"Bearer {token}"},
                                 json={"model": "other", "messages": [{"role": "user", "content": f"hi {i}"}]})).status_code

    assert asyncio.run(one(0)) == 200 and state["calls"] == 3  # 502, 502, then the answer: the client never saw the 502s
    cfg.providers["b"].max_concurrent = 1
    state.update(calls=10, max=0)

    async def many():
        return await asyncio.gather(*[one(i) for i in range(4)])

    assert asyncio.run(many()) == [200] * 4 and state["max"] == 1


def test_a_provider_that_keeps_failing_ends_in_one_clear_answer_the_client_does_not_retry(tmp_path, monkeypatch):
    import re
    calls = []

    async def handler(req: httpx.Request):
        if req.url.host == "b.example.com":
            calls.append(1)
            await asyncio.sleep(0.05)
            return httpx.Response(502, json={"error": {"message": "upstream overloaded, server error 502"}})
        return answer()

    cfg, app = make(tmp_path, monkeypatch, handler)
    monkeypatch.setattr(app_mod, "retry_delay", lambda headers, attempt: 0.2)
    monkeypatch.setattr(app_mod, "RETRY_WAIT_S", 1.0)
    token = (tmp_path / "token").read_text().strip()

    async def go():
        async with REAL(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
            return await c.post("/v1/chat/completions", headers={"Authorization": f"Bearer {token}"},
                                json={"model": "other", "messages": [{"role": "user", "content": "hi"}]})

    import time
    t = time.time()
    r = asyncio.run(go())
    took = time.time() - t
    assert r.status_code == 424 and r.json()["error"]["code"] == "ferry_gave_up"
    assert 2 <= len(calls) <= 6 and took < 2.5  # asked again within the budget, then stopped
    msg = r.json()["error"]["message"]
    assert "other" in msg and "5xx" in msg
    # nothing in it makes the client's engine (pi) send the request again: no status codes, no retry words
    pi_retry = re.compile(r"overloaded|rate.?limit|too many requests|(?<![a-z0-9])(?:429|500|502|503|504|520|524)(?![a-z0-9])|"
                          r"service.?unavailable|server.?error|internal.?error|timed? out|timeout|terminated|"
                          r"try your request again|please retry|retry delay", re.I)
    assert not pi_retry.search(f"424 {msg}"), pi_retry.search(f"424 {msg}")


def test_too_many_requests_cools_the_account_down_and_the_fallback_answers(tmp_path, monkeypatch):
    seen = []

    def handler(req: httpx.Request):
        seen.append(req.url.host)
        if req.url.host == "b.example.com":
            return httpx.Response(429, json={"error": {"message": "Too many requests"}}, headers={"retry-after": "1"})
        return answer(req.url.host)

    cfg, app = make(tmp_path, monkeypatch, handler)
    token = (tmp_path / "token").read_text().strip()
    hdr = {"Authorization": f"Bearer {token}"}
    cfg.providers["b"].fallback = "gpt"  # "other" (deepseek-flash on b) falls back to gpt on a

    async def ask():
        async with REAL(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
            r = await c.post("/v1/chat/completions", headers=hdr, json={"model": "other", "messages": [{"role": "user", "content": "hi"}]})
            ack = (await c.post("/v1/ferry/commit", params={"conv": "x", "base": 0, "base_hash": ""}, headers=hdr,
                                content=json.dumps({"append": [json.dumps({"role": "user", "content": "x"})], "tools": None}))).json()
            r2 = await c.post("/v1/chat/completions", headers=hdr, json={"model": "other", "messages": [{"role": "user", "content": "again"}]})
            return r, ack, r2

    r, ack, r2 = asyncio.run(ask())
    assert r.status_code == 200 and r.json()["choices"][0]["message"]["content"] == "a.example.com"
    notes = {o["model"]: o for o in ack["cooling"]}
    assert notes["other"]["fallback"] == "gpt" and notes["other"]["seconds"] >= 0  # the client can say so
    assert r2.json()["choices"][0]["message"]["content"] == "a.example.com" and seen == ["b.example.com", "a.example.com", "a.example.com"]


def test_without_a_fallback_the_request_waits_out_the_cool_down(tmp_path, monkeypatch):
    calls = []

    def handler(req: httpx.Request):
        calls.append(req.url.host)
        return httpx.Response(429, json={}, headers={"retry-after": "1"}) if len(calls) == 1 else answer("later")

    cfg, app = make(tmp_path, monkeypatch, handler)
    token = (tmp_path / "token").read_text().strip()

    async def ask():
        async with REAL(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
            return await c.post("/v1/chat/completions", headers={"Authorization": f"Bearer {token}"},
                                json={"model": "other", "messages": [{"role": "user", "content": "hi"}]})

    r = asyncio.run(ask())
    assert r.status_code == 200 and r.json()["choices"][0]["message"]["content"] == "later" and len(calls) == 2


CLAUDE = """
[providers.c]
base_url = "https://c.example.com"
api_key_env = "KEY_A"
api = "anthropic"
fallback = "gpt"

[models.kiro]
provider = "c"
model = "claude-opus-5.5"
"""


def test_a_fallback_of_the_other_api_is_asked_by_the_client(tmp_path, monkeypatch):
    calls = []

    def handler(req: httpx.Request):
        calls.append(req.url.host)
        if len(calls) == 1:
            return httpx.Response(429, json={"type": "error", "error": {"type": "rate_limit_error", "message": "slow down"}},
                                  headers={"retry-after": "1"})
        return httpx.Response(200, json={"id": "m", "type": "message", "role": "assistant", "model": "claude",
                                         "content": [{"type": "text", "text": "later"}], "stop_reason": "end_turn",
                                         "usage": {"input_tokens": 5, "output_tokens": 1}})

    cfg, app = make(tmp_path, monkeypatch, handler, CLAUDE)
    token = (tmp_path / "token").read_text().strip()
    hdr = {"Authorization": f"Bearer {token}", "x-ferry-reroute": "1"}
    body = {"model": "kiro", "max_tokens": 100, "messages": [{"role": "user", "content": "hi"}]}

    async def ask(h):
        async with REAL(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
            r = await c.post("/anthropic/v1/messages", headers=h, json=body)
            ack = (await c.post("/v1/ferry/commit", params={"conv": "y", "base": 0, "base_hash": ""}, headers=h,
                                content=json.dumps({"append": [json.dumps({"role": "user", "content": "x"})], "tools": None}))).json()
            r2 = await c.post("/anthropic/v1/messages", headers=h, json=body)
            return r, ack, r2

    r, ack, r2 = asyncio.run(ask(hdr))
    assert r.status_code == 422 and "ferry-reroute:gpt@openai" in r.text  # gpt speaks OpenAI's API: the client asks it
    kiro = {o["model"]: o for o in ack["cooling"]}["kiro"]
    assert kiro["fallback"] == "gpt" and kiro["switch"] is True
    assert r2.status_code == 422 and calls == ["c.example.com"]  # while it cools down: not asked at all


def test_an_older_client_waits_out_the_cool_down_instead(tmp_path, monkeypatch):
    calls = []

    def handler(req: httpx.Request):
        calls.append(req.url.host)
        if len(calls) == 1:
            return httpx.Response(429, json={}, headers={"retry-after": "1"})
        return httpx.Response(200, json={"id": "m", "type": "message", "role": "assistant", "model": "claude",
                                         "content": [{"type": "text", "text": "later"}], "stop_reason": "end_turn",
                                         "usage": {"input_tokens": 5, "output_tokens": 1}})

    cfg, app = make(tmp_path, monkeypatch, handler, CLAUDE)
    token = (tmp_path / "token").read_text().strip()

    async def ask():
        async with REAL(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
            return await c.post("/anthropic/v1/messages", headers={"Authorization": f"Bearer {token}"},
                                json={"model": "kiro", "max_tokens": 100, "messages": [{"role": "user", "content": "hi"}]})

    r = asyncio.run(ask())
    assert r.status_code == 200 and "later" in r.text and calls == ["c.example.com", "c.example.com"]


def test_a_model_switched_to_the_other_api_tells_the_client_to_resend_in_its_format(tmp_path, monkeypatch):
    cfg, app = make(tmp_path, monkeypatch, lambda req: answer())
    token = (tmp_path / "token").read_text().strip()
    cfg.models["other"].api = "anthropic"  # switched on the admin page while the client kept its model list
    hdr = {"Authorization": f"Bearer {token}"}

    async def go():
        async with REAL(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
            body = {"model": "other", "messages": [{"role": "user", "content": "hi"}]}
            new = await c.post("/v1/chat/completions", headers={**hdr, "x-ferry-reroute": "1"}, json=body)
            old = await c.post("/v1/chat/completions", headers=hdr, json=body)
            back = await c.post("/anthropic/v1/messages", headers={**hdr, "x-ferry-reroute": "1"},
                                json={"model": "gpt", "max_tokens": 10, "messages": [{"role": "user", "content": "hi"}]})
            return new, old, back

    new, old, back = asyncio.run(go())
    assert new.status_code == 422 and new.json()["error"]["message"].startswith("ferry-reroute:other@anthropic ")
    assert old.status_code == 400 and "ferry update" in old.json()["error"]["message"]
    assert back.status_code == 422 and back.json()["error"]["message"].startswith("ferry-reroute:gpt@openai ")
