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


def make(tmp_path, monkeypatch, handler):
    for k in ("ANTHROPIC_API_KEY", "OPENAI_API_KEY", "DEEPSEEK_API_KEY", "FERRY_SESSION_STORE", "FERRY_TOKEN", "FERRY_SECRET"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("KEY_A", "ka")
    monkeypatch.setenv("KEY_B", "kb")
    monkeypatch.setenv("FERRY_SERVER_HOME", str(tmp_path))
    (tmp_path / "models.toml").write_text(MODELS, encoding="utf-8")
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


def test_judge_and_notify(tmp_path, monkeypatch):
    sent = []

    def handler(req: httpx.Request):
        if req.url.host == "api.day.app":
            sent.append(json.loads(req.content))
            return httpx.Response(200, json={"code": 200})
        text = json.loads(req.content)["messages"][-1]["content"]
        return answer("ALLOW: runs the tests" if "npm test" in text else "ASK: deletes files")

    cfg, app = make(tmp_path, monkeypatch, handler)
    token = (tmp_path / "token").read_text().strip()
    hdr = {"Authorization": f"Bearer {token}"}

    async def go():
        async with REAL(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
            a = (await c.post("/v1/ferry/judge", headers=hdr, json={"tool": "bash", "input": {"command": "npm test"}, "cwd": "D:/p"})).json()
            b = (await c.post("/v1/ferry/judge", headers=hdr, json={"tool": "bash", "input": {"command": "rm -rf build"}, "cwd": "D:/p"})).json()
            n0 = (await c.post("/v1/ferry/notify", headers=hdr, json={"title": "Ferry", "body": "goal done"})).json()
            cfg.bark_url = "https://api.day.app/KEY"
            n1 = (await c.post("/v1/ferry/notify", headers=hdr, json={"title": "Ferry", "body": "goal done"})).json()
            return a, b, n0, n1

    import ferry_server.notify as nt
    monkeypatch.setattr(nt.httpx, "AsyncClient", lambda **kw: REAL(transport=httpx.MockTransport(handler), **kw))
    a, b, n0, n1 = asyncio.run(go())
    assert a["verdict"] == "allow" and b["verdict"] == "ask"
    assert n0["ok"] is False and n1["ok"] is True and sent[0]["body"] == "goal done"
